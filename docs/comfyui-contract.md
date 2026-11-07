# ComfyUI backend contract (backend B)

Status: implementation contract for `dsh-super-image` 0.1.0, local ComfyUI backend.
Verified against the local install on 2026-11-07 with `test/comfy-probe.mjs` (static analysis of
the configured workflow plus one live submit → poll → download round trip).

Sources of truth:

| Source | What it fixes |
| --- | --- |
| `dsh-image-gen` 0.10.3, `D:\DSH\profiles\desktop\node_modules\dsh-image-gen\lib\index.js` — workflow module `7223–7317`, HTTP module `7345–7575`, defaults `5943–5952` | exact HTTP calls, polling, bounded reads, placeholder semantics |
| ComfyUI 0.41.0 server source, `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\server.py`, `execution.py`, `nodes.py` | `/prompt`, `/history`, `/view`, `/system_stats` wire shapes and error bodies |
| `D:\ComfyUI` read-only inspection + live probe | local workflow inventory, node ids, model, native resolution, measured behaviour |

The sibling adapter is the behavioural baseline. This contract keeps its transport rules
verbatim and extends two things it does not have: **API-vs-UI workflow detection** and
**explicit node-id mapping**. Both extensions are specified below, including their failure
messages.

---

## 1. Connectors

### 1.1 Base URL

- Setting: `comfyuiBaseURL`, default `http://127.0.0.1:8188`.
- Must parse as an absolute URL via `new URL()`, protocol `http:` or `https:` only, and is
  reduced to `url.origin` (trailing slash removed, path/query/hash dropped). Reject anything
  else before any request:
  `--base`/setting error: `ComfyUI URL must be an absolute http:// or https:// URL` /
  `ComfyUI URL must use http:// or https://` (sibling's wording, `runJob`).
- Loopback hosts are expected (`127.0.0.1`, `localhost`, `::1`). No auth headers, no cookies,
  no proxy configuration; no request may leave the machine for the default configuration.
- Every route is built as `${origin}/${route}` from the normalised origin. Route segments are
  never interpolated from user text except through `encodeURIComponent`.

### 1.2 `POST {base}/prompt`

Submit an API-format workflow object exactly as loaded (after node injection, §4):

```http
POST http://127.0.0.1:8188/prompt HTTP/1.1
content-type: application/json
accept: application/json
```

```json
{ "prompt": { "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "x.safetensors" } }, "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "a red apple", "clip": ["1", 1] } } } }
```

- Body is exactly `{"prompt": <api-workflow-object>}`. **No `client_id`, no `extra_data`, no
  `prompt_id`.** The sibling omits `client_id` too. `client_id` would only bind websocket
  progress events; polling `/history` needs nothing else. Omitting it also means the server
  mints the `prompt_id`, so the adapter cannot collide with itself.
- Success (`200`): `{"prompt_id": "<uuid string>", "number": <int>, "node_errors": {}}`.
  Empty `node_errors` means every output validated. `prompt_id` must be a non-empty string;
  anything else is `comfy.prompt.noPromptId`.
- Validation failure (`400`), from `server.py:1162` + `execution.py:1292–1299`:

```json
{
  "error": { "type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", "details": "<node message>: <details>\n…", "extra_info": {} },
  "node_errors": {
    "6": {
      "errors": [ { "type": "required_input_missing", "message": "Required input is missing", "details": "seed", "extra_info": {} } ],
      "class_type": "KSampler",
      "dependent_outputs": ["8"]
    }
  }
}
```

  Parse defensively: `error` and `node_errors` are both optional in practice. Render as
  `comfy.prompt.rejected` (see §6) and include up to the first 3 node errors.
- Other status codes: treat as `comfy.prompt.rejected` with the status in the message. Never
  retry a 4xx; a 5xx may be retried once (same workflow, same deadline).
- Read at most **4096 bytes** of any response body used for diagnostics (sibling `ERROR_LIMIT
  = 4096`); the success body is small, so the same cap applies.
- `redirect: "error"` on the fetch. A redirect means the endpoint is not the ComfyUI we think
  it is; fail instead of following it.
- Submit request timeout: `min(30_000, remainingDeadline)`.

### 1.3 `GET {base}/history/{prompt_id}`

```http
GET http://127.0.0.1:8188/history/533d29d9-6383-4cdd-8272-5ac37e76d59e HTTP/1.1
accept: application/json
```

`prompt_id` is `encodeURIComponent`-escaped. Response is a **map keyed by prompt_id**
(`prompt_queue.get_history`), `200` with `{}` while the entry does not exist yet — the server
does **not** 404 for unknown/queued ids:

```json
{
  "533d29d9-6383-4cdd-8272-5ac37e76d59e": {
    "prompt": [ 7, "533d29d9-…", { "1": { … } }, { "client_id": "" }, [] ],
    "outputs": {
      "8": { "images": [ { "filename": "dsh-image-gen_00001_.png", "subfolder": "", "type": "output" } ] }
    },
    "status": { "status_str": "success", "completed": true, "messages": [ ["execution_start", { … }], ["execution_success", { … }] ] }
  }
}
```

- Entry shape is exactly `{prompt, outputs, status}` (`execution.py:1354`).
  `status.status_str` is `"success"` or `"error"` (`execution.py:1335–1338`).
- `status.messages` is an array of `[eventName, data]` pairs: `execution_start`,
  `execution_cached`, `execution_success`, `execution_error`, `execution_interrupted`.
  On failure the useful text is `data.exception_message` / `data.exception_type` /
  `data.node_id` / `data.node_type` inside the `execution_error` message.
- Bound the read at **16 MB** (`MAX_HISTORY_BYTES = 16777216`); a bigger body is a hard error.
  Poll timeout per request: `min(30_000, remaining)`.
- `redirect: "error"`, `accept: application/json`.
- Treat `404`, `5xx`, transport errors as `comfy.history.failed` (retryable inside the
  generation deadline if it is a transient network error; do not retry a 404 in a loop).

### 1.4 `GET {base}/view?filename=..&subfolder=..&type=output`

Build with `URL` + `URLSearchParams` (filenames may contain spaces and non-ASCII; never string
concatenate):

```http
GET http://127.0.0.1:8188/view?filename=dsh-image-gen_00001_.png&subfolder=&type=output HTTP/1.1
```

- `filename` is required (server returns `400` when empty); the server rejects a filename that
  starts with `/` or contains `..` (`400`) and a `subfolder` that escapes the output root
  (`403`); unknown `type` → `400`; missing file → `404`. Map these to `comfy.download.failed`
  with the status code.
- `type` is always the descriptor's `type` after filtering to `output` (§5).
- Response is raw image bytes with `content-type` derived from the file extension
  (`image/png` for SaveImage). Do **not** trust the header alone: sniff magic bytes (§5.3).
- Bound the body at **64 MB**; `redirect: "error"`; timeout `min(60_000, remaining)`.
- The returned `filename` is untrusted input. It is never used as a local filesystem path; the
  plugin names its own file inside the session workspace.

### 1.5 `GET {base}/system_stats` (reachability only)

Cheap liveness check before a submit (`server.py:771`). Any `200` is enough; body is ignored
after a bounded read. Timeout 5 s. Failure produces the connection message in §6
(`comfy.connection.refused`). This call is what turns a multi-second failure into an immediate,
actionable one.

### 1.6 Transport rules shared by all routes

- One `AbortController` per generation (or `AbortSignal.timeout(...)` per request bounded by the
  generation deadline). Abort → `comfy.timeout` with the configured `timeoutMs`.
- `redirect: "error"` everywhere.
- All response bodies are read with a byte cap (`readBoundedBytes` / `readBoundedText`); an
  oversized body fails with `ComfyUI response exceeded the <n> byte limit` (sibling wording).
- Errors are reported once per generation; no silent fallback to another endpoint or workflow.
- No retries on `4xx`; at most one retry of `5xx` on `/prompt` while the deadline allows.

---

## 2. Polling rules

Settings: `pollMs` (default **1000**, clamp `250…5000`) and `timeoutMs` (default **300000**,
clamp `5000…1800000`). The sibling polls every `500 ms` with a `300000 ms` default; either is
safe. `test/comfy-probe.mjs` uses `1000 ms` and `180000 ms`.

Algorithm:

```
deadline = now + timeoutMs
submit once (bounded by min(30s, deadline))
loop:
  if now >= deadline: throw comfy.timeout
  GET /history/{promptId}
  entry = body[promptId]
  if entry is undefined:            # still queued/executing — server returns {}
      sleep(pollMs); continue
  if entry.status.status_str === "error":
      throw comfy.workflow.failed(with messages)
  image = first type=="output" image in entry.outputs
  if image: download and return it
  if entry.status.completed === true:
      throw comfy.completedNoOutput
  sleep(pollMs); continue
```

Terminal conditions, exhaustively:

| Observation | Action |
| --- | --- |
| History `200` with `{}` or without the key | keep polling |
| `status.status_str === "error"` | throw `comfy.workflow.failed`, include `messages` (clipped to 4096 chars, sibling behaviour) |
| `status.status_str === "success"` and an `images[]` entry with `type === "output"` exists | done — download that image |
| `status.completed === true` and no `output` image | throw `comfy.completedNoOutput` |
| deadline reached | throw `comfy.timeout` (`ComfyUI generation timed out after <timeoutMs> ms`) |
| `/history` non-2xx or invalid JSON | throw `comfy.history.failed` / `comfy.history.invalidJson` |
| download non-2xx | throw `comfy.download.failed` |

Additional constants:

- **Workflow cap 5 MB** (`5242880` bytes exactly, sibling `5242880`): reject files larger than
  this *before* parsing, and reject a serialized request body larger than the same cap.
- History read cap 16 MB, view cap 64 MB, diagnostic text cap 4096 B.
- Polling must stop the moment a terminal condition fires; no extra sleep before the terminal
  check, and no unbounded retry of a broken endpoint (fail after 3 consecutive transport
  failures, ~`3 × pollMs`).

---

## 3. Workflow format detection (API vs UI)

Run detection **after** the file is read and JSON-parsed, **before** any injection.

Definitions:

- **UI format** — a ComfyUI frontend export. Top level has a `nodes` array and/or a `links`
  array (usually alongside `last_node_id`, `last_link_id`, `groups`, `config`, `extra`,
  `version`). A top-level array is also treated as UI/invalid input rather than a workflow map.
- **API format** — a non-empty JSON object whose **values** are all node objects shaped
  `{"class_type": <non-empty string>, "inputs": <object>}`. Keys are node ids as strings
  (`"1"`, `"2"`, …; numeric-looking keys are fine). Node inputs may contain literals, link
  arrays `["<nodeId>", <outputIndex>]`, or placeholder strings.
- **Empty** — `{}`, `null`, a zero-length file, or an empty array.
- **Invalid** — anything else (e.g. `{"1": {"class_type": "KSampler"}}`, a node missing
  `inputs`, `inputs` not an object, a bare string).

Decision order and messages (rendered as two lines: 中文 first, English second; the probe
prints them joined by ` | ` on one line):

| Code | Condition | 中文 | English |
| --- | --- | --- | --- |
| `comfy.workflow.uiFormat` | UI export (`nodes`/`links` present) | `ComfyUI 工作流是 UI 导出格式，不是 API 格式。请在 ComfyUI 中打开该工作流，使用「工作流 → 导出（API）」保存，再重新导入。` | `This ComfyUI workflow is a UI-format export, not API format. Open it in ComfyUI and use Workflow → Export (API), then import the exported file again.` |
| `comfy.workflow.invalidJson` | `JSON.parse` throws | `ComfyUI 工作流文件不是有效的 JSON。请检查文件是否损坏。` | `ComfyUI workflow file is not valid JSON.` |
| `comfy.workflow.empty` | empty object/file | `ComfyUI 工作流为空。请导入 API 格式的工作流 JSON（导出 → API）。` | `ComfyUI workflow is empty. Import an API-format workflow JSON (Export → API).` |
| `comfy.workflow.notApi` | object, but some value is not `{class_type, inputs}` | `ComfyUI 工作流既不是 API 格式也不是可识别的 UI 格式：每个节点必须是包含 class_type 与 inputs 的对象。` | `ComfyUI workflow is neither API format nor a recognizable UI format: every node must be an object with class_type and inputs.` |

The sibling adapter has **no** UI detection: it accepts any non-empty object and then fails
later with `ComfyUI workflow must contain {{prompt}} (or %prompt%) in a text input`, which is
misleading for a UI export. `dsh-super-image` must detect UI format first and say so.

Tolerated details: a UTF-8 BOM is stripped before `JSON.parse` (PowerShell `Set-Content
-Encoding UTF8` writes one; the probe strips `\uFEFF` accordingly). Key order is irrelevant.

---

## 4. Node injection

A workflow always carries its graph in `inputs`; the adapter only writes **scalar leaf values**
(strings/numbers) into existing input keys. It must never create nodes, rewire links, or change
`class_type`. Injection deep-copies the parsed workflow (`structuredClone`) so the loaded JSON is
never mutated across generations.

### 4.1 Precedence

Three layers, resolved **per field** (`prompt`, `negative`, `seed`, `width`, `height`):

1. **Explicit node id** from settings (`promptNodeId`, `negativeNodeId`, `seedNodeId`,
   `widthNodeId`, `heightNodeId`, `outputNodeId`). Highest priority. Hard failure if the node
   is absent or the target input key is absent (§4.5). When a field has an explicit id, that
   field's placeholders are **not** substituted (preventing double writes).
2. **Placeholder substitution** in the workflow's string inputs (`{{prompt}}` / `%prompt%`,
   `{{negative}}` / `%negative%`, `{{seed}}` / `%seed%`, `{{width}}`, `{{height}}`). Used for
   fields without an explicit id. Sibling-compatible.
3. **Auto-detection** from the graph (§4.4) for fields that are neither mapped nor present as
   placeholders.

Missing negative support is not fatal (see §4.5 warning), because Flux-style workflows often
have no negative encoder. Missing positive support is fatal: a prompt with nowhere to go is a
bug, not a default.

`outputNodeId` only narrows output selection (§5); it never injects. When set, only that node's
`images[]` are considered.

### 4.2 Placeholder rules (layer 2)

- Placeholders are recognised only in **string** input values, at any depth inside the inputs
  object (sibling `replaceDeep`). Arrays (links, `["1", 0]`) and numbers are never touched.
- `prompt`: every occurrence of `{{prompt}}` and `%prompt%` inside a string is replaced with
  the prompt text; a string that is exactly a placeholder becomes exactly the prompt. All
  occurrences in all matching nodes are replaced (the sibling counts
  `promptReplacements`; require ≥1).
- `negative`: same for `{{negative}}` / `%negative%`; if the user gives no negative prompt, the
  placeholder collapses to `""` (do not leave the literal placeholder in the graph).
- `seed`: an input whose value is exactly `"{{seed}}"` / `"%seed%"` receives a **number**
  (`Math.floor(Math.random() * 4294967296)` when the caller does not supply one — sibling
  `randomSeed()`); embedded occurrences receive the decimal string.
- `width` / `height`: same numeric treatment for `{{width}}` / `{{height}}` /
  `%width%` / `%height%`. If only one of the two placeholders exists, the other dimension is
  left at its workflow value — this is logged as `comfy.mapping.partialSize` at warning level,
  not an error.
- Workflows with no prompt placeholder and no explicit mapping fall through to auto-detection;
  they never fail merely because the placeholder is absent.

### 4.3 Explicit mapping and input-key resolution

Each mapped field needs the input key to write. Resolution order:

1. Optional explicit key override from the node map (`promptInputKey`, `seedInputKey`,
   `widthInputKey`, `heightInputKey`) when provided.
2. Class-based default:

| Field | `class_type` | Default input key |
| --- | --- | --- |
| prompt / negative | `CLIPTextEncode`, `CLIPTextEncodeSDXL`, `T5TextEncode`, `TextEncodeQwenImageEdit`, anything matching `/TextEncode|Text$/i` | `text` (fallback `text_g`, `prompt`, `positive_prompt`) |
| seed | `KSampler`, `KSamplerAdvanced`, `SamplerCustom` | `seed` (fallback `noise_seed`) |
| width / height | `EmptyLatentImage`, `EmptySD3LatentImage`, `EmptyLatentSDXL` | `width` / `height` |
| output | `SaveImage`, `SaveAnimatedWEBP`, `SaveWEBM`, `Image Save` | `images` (read-only) |

If the mapped node does not match any known class, require an explicit input key; otherwise the
key is inferred by looking for exactly one of the known keys present in `node.inputs`. If zero
or more than one candidate exists and no override is set, fail with
`comfy.mapping.inputMissing`.

Seed and dimension writes must be numbers (`Number(value)`), not strings: ComfyUI validates
`INT` inputs and a string seed is rejected at `POST /prompt` time with a 400 that is much less
actionable than a local error.

### 4.4 Auto-detection (layer 3)

Only for fields not covered by layers 1–2, and only if at least one candidate exists.

- **Positive prompt**: follow the sampler's `inputs.positive` link `["<nodeId>", idx]` to a node
  with a text input; else the first node (in key order) whose `class_type` matches
  `/CLIPTextEncode|TextEncode/` and whose text is not the negative literal; else none.
- **Negative prompt**: follow `inputs.negative` to a distinct text node; else the second
  `/CLIPTextEncode/` node (sibling/workflow convention); else none.
- **Seed**: the sampler's `seed` (fallback `noise_seed`) input when numeric or placeholder; for
  multiple samplers use the one feeding the output (highest `steps` × `cfg` is *not* a rule —
  follow `latent_image` back from the output instead, or take the first sampler in key order).
- **Width/height**: a single node having **both** `width` and `height` numeric inputs
  (`EmptyLatentImage`, `EmptySD3LatentImage`, …). One node must supply both; never mix two
  different latent nodes.
- **Output**: first node whose `class_type` matches
  `/SaveImage|SaveAnimatedWEBP|SaveWEBM|ImageSave/i`, else a node whose `inputs.images` is an
  array (link), else the last node in key order.

Auto-detection is reported (node ids, class types) in the settings page / generation log so the
user can pin ids in §4.3 when a future workflow rename changes classes.

### 4.5 Validation errors

All are fatal unless marked warning:

| Code | Trigger | 中文 | English |
| --- | --- | --- | --- |
| `comfy.mapping.nodeMissing` | mapped id not present | `节点映射无效：工作流中找不到节点 <id>（<field>）。请检查设置中的节点 ID。` | `Invalid node mapping: node <id> for <field> was not found in the workflow. Check the node IDs in Settings.` |
| `comfy.mapping.inputMissing` | mapped node lacks the resolved input key | `节点 <id>（<class_type>）缺少输入「<key>」，无法注入 <field>。` | `Node <id> (<class_type>) has no input "<key>", so <field> cannot be injected.` |
| `comfy.mapping.partialSize` | only one of width/height placeholders or keys exists | `工作流只提供了 width 与 height 其中之一，尺寸按原始值保留另一维。` | `The workflow provides only one of width/height; the other dimension keeps its original value.` |
| `comfy.mapping.negativeMissing` | user supplied a negative prompt but no negative slot exists (auto mode) | `工作流中没有负面提示词节点，negative prompt 已忽略。` | `No negative-prompt node found in the workflow; the negative prompt was ignored.` |

`outputNodeId` pointing at a node with no `images` output fails with
`comfy.mapping.inputMissing` (`key = images`) before generation starts.

### 4.6 Worked example — the local NoobAI workflow

See §7/Appendix for the full JSON. Injection result at `prompt="a red apple"`,
`seed=1234567890`, `832×1216`, no negative override:

- node `"2"` (CLIPTextEncode, key `text`): `"a red apple"`
- node `"3"` (CLIPTextEncode, key `text`): unchanged negative literal
- node `"6"` (KSampler, key `seed`): number `1234567890`
- node `"5"` (EmptyLatentImage, keys `width`/`height`): `832` / `1216`
- node `"8"` (SaveImage): untouched.

Because `{{prompt}}` and `{{seed}}` placeholders exist, this workflow works with the sibling
adapter unchanged. Because node ids are stable, explicit mapping is also valid — and is the
recommended configuration (§8), since it survives placeholder removal.

---

## 5. Output selection

### 5.1 `outputs` traversal

`entry.outputs` is a map `nodeId → {images?: [...], ...}`. Only node entries with an `images`
array can yield files (SaveImage/PreviewImage). Iterate **in insertion order** (the order the
server appends node results) and collect every image descriptor:

```json
{ "filename": "dsh-image-gen_00001_.png", "subfolder": "", "type": "output" }
```

Requirements per descriptor (sibling `firstOutputImage`, `7460`):

- `filename` must be a non-empty string — otherwise skip the descriptor.
- `subfolder` must be a string, else `""`.
- `type` must be a string, else `"output"`; **keep only `type === "output"`**. `PreviewImage`
  writes `type: "temp"` and must be filtered out (it is often present while the real save is
  still finishing, and it is cleaned up by the server).
- If `outputNodeId` is configured, only that node's `images[]` participate.

### 5.2 Multiple images

One prompt can produce several output images: a `batch_size > 1` latent, several SaveImage
nodes, or `SaveImage` plus an animated saver. The adapter returns the **first** image in the
order above as the deliverable and may expose the rest as extras. With batch 1 (the default
`EmptyLatentImage.batch_size = 1`) exactly one image is expected; more than one is a warning,
not an error.

### 5.3 Media detection by magic bytes

Never trust `content-type` or the filename extension; sniff the first bytes of the downloaded
body (sibling `detectImageMediaType`, `6758`):

| Type | Magic |
| --- | --- |
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |
| GIF | ASCII `GIF87a` / `GIF89a` |
| WEBP | ASCII `RIFF` at 0 and `WEBP` at 8 |

- PNG dimensions: big-endian `uint32` at byte offset 16 (width) and 20 (height) of the `IHDR`
  chunk payload; validate `width > 0 && height > 0`.
- If no signature matches, try the `content-type` header, then the extension; if all three
  fail → `comfy.download.unsupported`.
- The plugin's deliverable is a PNG. If the workflow legitimately produces WebP/JPEG, save with
  the detected extension and report the media type instead of re-encoding.

### 5.4 Saving

Save into the session workspace under a generated name (`<prefix>-<timestamp>.<ext>`), never
using the server's `filename`/`subfolder` in a local path. Write bytes atomically (temp file then
rename) so a partial download cannot be mistaken for a deliverable. Report
`{file, bytes, width, height, mediaType, promptId}`.

---

## 6. Error taxonomy (exact user-facing strings)

Rendering rule: the UI shows 中文 on the first line and English on the second; the probe prints
`中文 | English` on one line. `{origin}` is the normalised origin, e.g.
`http://127.0.0.1:8188`. All strings contain the remediation, not just the failure.

| Code | Trigger | 中文 | English | Retry? |
| --- | --- | --- | --- | --- |
| `comfy.base.invalid` | base URL not absolute http(s) | `ComfyUI 地址必须是完整的 http:// 或 https:// URL。` | `ComfyUI URL must be an absolute http:// or https:// URL` | no (fix setting) |
| `comfy.connection.refused` | `/system_stats` or submit cannot connect | `无法连接 ComfyUI（{origin}），请先运行 comfyctl.ps1 -Action start。` | `Could not connect to ComfyUI at {origin} — start it with comfyctl.ps1 -Action start.` | no (server off) |
| `comfy.connection.submit` | connect error after reachability | `向 ComfyUI 提交时连接中断（{origin}）。` | `Could not connect to ComfyUI at {origin} while submitting the workflow` | once |
| `comfy.prompt.rejected` | `/prompt` non-2xx | `ComfyUI 拒绝了工作流（<status>）：<error.message>；节点 <id>（<class_type>）：<message>` | `ComfyUI rejected the workflow (<status>): <error.message>; node <id> (<class_type>): <message>` | no on 4xx |
| `comfy.prompt.invalidJson` | 2xx body unparsable | `ComfyUI /prompt 返回了无效 JSON。` | `ComfyUI /prompt returned invalid JSON` | no |
| `comfy.prompt.noPromptId` | 2xx without usable `prompt_id` | `ComfyUI /prompt 没有返回 prompt_id。` | `ComfyUI /prompt returned no prompt_id: <body>` | no |
| `comfy.history.failed` | history non-2xx | `ComfyUI 查询历史失败（<status>）。` | `ComfyUI history request failed (<status>): <body>` | transient only |
| `comfy.history.invalidJson` | history body unparsable | `ComfyUI 历史记录返回了无效 JSON。` | `ComfyUI history returned invalid JSON` | no |
| `comfy.workflow.failed` | `status_str === "error"` | `ComfyUI 工作流执行失败：<messages>` | `ComfyUI workflow failed: <messages>` | no |
| `comfy.timeout` | deadline reached | `ComfyUI 生成超时（<timeoutMs> ms）。` | `ComfyUI generation timed out after <timeoutMs> ms` | user may retry |
| `comfy.completedNoOutput` | completed, no `output` image | `ComfyUI 工作流已完成，但没有输出图片（请确认工作流包含 SaveImage）。` | `ComfyUI workflow completed without an output image` | no |
| `comfy.download.failed` | `/view` non-2xx | `ComfyUI 图片下载失败（<status>）。` | `ComfyUI image download failed (<status>)` | once on 5xx |
| `comfy.download.unsupported` | magic bytes unknown | `ComfyUI 返回了不支持的图片类型。` | `ComfyUI image download returned an unsupported content type` | no |
| `comfy.workflow.uiFormat` | UI export | §3 zh | §3 en | no |
| `comfy.workflow.invalidJson` | unparsable file | §3 zh | §3 en | no |
| `comfy.workflow.empty` | empty workflow | §3 zh | §3 en | no |
| `comfy.workflow.notApi` | malformed API shape | §3 zh | §3 en | no |
| `comfy.workflow.missing` | workflowPath unreadable | `找不到 ComfyUI 工作流文件。请在设置中填写 workflowPath 指向有效的 API 工作流 JSON。` | `ComfyUI workflow file not found. Point workflowPath in Settings at a valid API workflow JSON.` | no |
| `comfy.workflow.tooLarge` | > 5242880 bytes | `ComfyUI 工作流文件不能超过 5 MB。请精简工作流后重试。` | `ComfyUI workflow file must be no larger than 5 MB.` | no |
| `comfy.mapping.*` | §4.5 | §4.5 zh | §4.5 en | no |

Notes:

- The sibling's 400 message is `ComfyUI rejected the workflow (<status>): <text>`; it flattens
  `node_errors` into raw JSON. `dsh-super-image` should format per-node lines instead, keeping
  the first 3 nodes and clipping each message to 300 chars.
- `comfy.workflow.failed` must surface `exception_message` and `node_type` when present, e.g.
  `ComfyUI 工作流执行失败：KSampler (node 6): out of memory` — the raw `messages` dump is the
  fallback only.
- Every code above is stable; the probe uses a subset of the same strings so a probe failure
  and an in-app failure read the same.

---

## 7. Local environment findings (read-only inspection, 2026-11-07)

Install layout: `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI` (ComfyUI **0.41.0**, per
`comfyui_version.py`), Python embed in `python_embeded`, control scripts at
`D:\ComfyUI\{comfyctl.ps1, start-comfyui.vbs, run_comfyui_silent.bat}`, logs in
`D:\ComfyUI\logs\comfyui.log`.

Control script: `powershell -NoProfile -ExecutionPolicy Bypass -File D:\ComfyUI\comfyctl.ps1
-Action start|stop|status` (`-TimeoutSeconds` default 240, `-Port` 8188). `start` launches the
hidden launcher and polls the port every 3 s; `stop` force-kills matched processes; `status`
prints port state, processes and the last 5 log lines. The logon task `ComfyUI Server` is
intentionally disabled: ComfyUI is started on demand and stopped after use.

### 7.1 Workflow inventory

| Path | Bytes | Format | Notes |
| --- | --- | --- | --- |
| `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\user\default\workflows\noobai-xl-vpred-api.json` | 1405 | **API** | configured/active workflow; checkpoint installed; placeholders `{{prompt}}`, `{{seed}}`; literal negative text |
| `D:\ComfyUI\_download\flux-dev-t2i-api.json` | 1454 | **API** | needs `flux1-dev-fp8.safetensors`, `clip_l`, `t5xxl_fp8`, `ae` — **not installed**; unusable today |
| `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\user\default\workflows\` | — | — | no other workflow files |
| `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\workflows\` | — | — | empty |

Both existing files are API format (flat map of `{class_type, inputs}`); no UI-format export is
present locally. The profile config (`D:\DSH\profiles\desktop\cordis.patch.yml`, plugin
`image-gen`) embeds the same two workflows as YAML strings under
`comfyuiWorkflows` with `comfyuiActiveWorkflow: noobai-xl-vpred`, `comfyuiBaseURL:
http://127.0.0.1:8188`, `comfyuiTimeoutMs: 600000`; there is **no** external `workflowPath`
configured for the sibling — `dsh-super-image` should support both (file path and embedded JSON).

### 7.2 Best usable workflow — full mapping

`D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\user\default\workflows\noobai-xl-vpred-api.json`

| Role | Node id | `class_type` | Input key | Value / evidence |
| --- | --- | --- | --- | --- |
| checkpoint | `1` | `CheckpointLoaderSimple` | `ckpt_name` | `NoobAI-XL-Vpred-v1.0.safetensors` |
| positive prompt | `2` | `CLIPTextEncode` | `text` | `{{prompt}}` placeholder |
| negative prompt | `3` | `CLIPTextEncode` | `text` | literal `nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro` — **no placeholder** |
| sampling fix | `4` | `ModelSamplingDiscrete` | — | `v_prediction`, `zsnr: true` |
| width/height | `5` | `EmptyLatentImage` | `width`, `height`, `batch_size` | `832`, `1216`, `1` |
| seed / sampler | `6` | `KSampler` | `seed` | `{{seed}}`; `steps 28`, `cfg 5.0`, `euler`, `normal`, `denoise 1.0` |
| decode | `7` | `VAEDecode` | — | `samples ← 6:0`, `vae ← 1:2` |
| output | `8` | `SaveImage` | `images` | `filename_prefix: dsh-image-gen` |

- Native resolution: **832 × 1216** (SDXL portrait bucket, batch 1).
- Model: `NoobAI-XL-Vpred-v1.0.safetensors`; checkpoint file present at
  `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\models\checkpoints\NoobAI-XL-Vpred-v1.0.safetensors`
  (7,105,350,110 bytes).
- `test/comfy-probe.mjs` auto-detects exactly this mapping (see Appendix output), including the
  negative as the second `CLIPTextEncode` via the KSampler `negative` link.
- Live evidence (server started for the probe, then stopped): `POST /prompt` → `prompt_id
  533d29d9-6383-4cdd-8272-5ac37e76d59e`; first output `dsh-image-gen_00001_.png`, 813,310 bytes,
  832 × 1216, saved to `test/out/probe-2026-11-07T10-15-27-556Z.png`. The whole round trip
  finished well inside the 180 s probe budget with 1000 ms polling.

### 7.3 Notes for the adapter

- The negative prompt is **literal text**, so a user-supplied negative only takes effect through
  explicit `negativeNodeId` mapping (recommended) or by adding `{{negative}}` to the workflow.
- `832×1216` is the workflow's native bucket; when the settings page changes width/height, keep
  multiples of 8 (SDXL-friendly buckets: 832×1216, 1216×832, 1024×1024).
- `filename_prefix` is `dsh-image-gen`, i.e. the sibling adapter's prefix. `dsh-super-image`
  should either leave it alone (files are downloaded by descriptor, not scanned) or rewrite it
  through `outputNodeId` + an optional `filenamePrefix` input; do not depend on the prefix.
- `ComfyUI 0.41.0` writes history entries only after the prompt finishes; `PreviewImage`-style
  temp outputs never appear in `outputs` as `type: "output"`.

---

## 8. Recommended default settings

For the settings page, pre-filled for this machine:

| Setting | Recommended value | Notes |
| --- | --- | --- |
| `workflowPath` | `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\user\default\workflows\noobai-xl-vpred-api.json` | or empty when using embedded workflow JSON |
| `baseURL` | `http://127.0.0.1:8188` | normalised to origin |
| `promptNodeId` | `2` | key `text` (auto-resolved) |
| `negativeNodeId` | `3` | `3` exists; leave empty for Flux-style workflows |
| `seedNodeId` | `6` | key `seed` |
| `widthNodeId` | `5` | same node as height |
| `heightNodeId` | `5` | |
| `outputNodeId` | `8` | `SaveImage` |
| `timeoutMs` | `300000` (5 min) | profile currently uses `600000`; both are safe for 28-step SDXL at 832×1216 |
| `pollMs` | `1000` | clamp 250–5000; sibling uses 500 |
| `defaultWidth` / `defaultHeight` | `832` / `1216` | workflow native bucket |

Defaults must be schema-validated: `timeoutMs` clamp `5000…1800000`, `pollMs` clamp
`250…5000`, node ids as non-empty digit strings (or empty = auto), `workflowPath` absolute or
empty.

---

## 9. Top integration risks

1. **Negative prompt has no placeholder slot.** In the local workflow node `3` holds literal
   text. Without explicit `negativeNodeId`, a user negative is silently dropped (the sibling
   never injects negatives at all). Mitigation: map `negativeNodeId` by default, and emit the
   `comfy.mapping.negativeMissing` warning when auto mode finds no negative node.
2. **Node ids / class types are not portable across workflows.** Width/height live only on the
   latent node and must be written atomically; a stale `widthNodeId` would silently change the
   aspect ratio instead of failing. Mitigation: validate every mapped id and input key before
   `POST /prompt` (§4.5), fail closed, and surface the auto-detected mapping in the UI.
3. **History/output semantics are easy to get wrong.** While queued the server returns `200 {}`
   (not 404), error entries can exist with partial `outputs`, and PreviewImage entries are
   `type: "temp"`. Polling must key off `status_str` first, filter `type === "output"`, and treat
   `completed: true` without an output image as a failure rather than hanging until timeout.

Secondary: a UI-format export is accepted by the sibling and fails with a misleading
placeholder error — detect it (§3); and untrusted `filename` from `/view` must never be turned
into a local path.

---

## Appendix A — `test/comfy-probe.mjs` static analysis (real output)

```
workflow : D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\user\default\workflows\noobai-xl-vpred-api.json
format   : api
bytes    : 1405
model    : NoobAI-XL-Vpred-v1.0.safetensors (CheckpointLoaderSimple #1)
native   : 832x1216
placeholder: prompt={{prompt}} seed={{seed}}

nodes:
  #1 CheckpointLoaderSimple
  #2 CLIPTextEncode text[text]="{{prompt}}"
  #3 CLIPTextEncode text[text]="nsfw, worst quality, old, early, low quality, lowres, signature, user…"
  #4 ModelSamplingDiscrete
  #5 EmptyLatentImage
  #6 KSampler
  #7 VAEDecode
  #8 SaveImage

detected mapping:
{
  "workflow": "D:\\ComfyUI\\ComfyUI_windows_portable\\ComfyUI\\user\\default\\workflows\\noobai-xl-vpred-api.json",
  "format": "api",
  "bytes": 1405,
  "placeholders": { "prompt": ["{{prompt}}"], "seed": ["{{seed}}"], "width": [], "height": [] },
  "mapping": {
    "promptNodeId": "2", "promptClassType": "CLIPTextEncode", "promptInputKey": "text",
    "negativeNodeId": "3", "negativeClassType": "CLIPTextEncode",
    "seedNodeId": "6", "seedClassType": "KSampler", "seedInputKey": "seed",
    "widthNodeId": "5", "heightNodeId": "5", "latentClassType": "EmptyLatentImage",
    "outputNodeId": "8", "outputClassType": "SaveImage"
  },
  "nativeResolution": { "width": 832, "height": 1216 },
  "model": { "nodeId": "1", "loader": "CheckpointLoaderSimple", "name": "NoobAI-XL-Vpred-v1.0.safetensors" }
}
```

The `placeholders` object is shown compacted here; the probe prints it expanded. Exit code 0.

## Appendix B — probe `--submit` result (real output)

```
{"ok":true,"promptId":"533d29d9-6383-4cdd-8272-5ac37e76d59e","file":"E:\\ai cube\\DSH\\dsh-super-image\\test\\out\\probe-2026-11-07T10-15-27-556Z.png","bytes":813310,"width":832,"height":1216}
```

The probe performs `GET /system_stats`, `POST /prompt`, polls `GET /history/<id>` every 1000 ms
for at most 180 s, then downloads the first `type === "output"` image via `GET /view` and writes
it under `--out` (default `test/out`). On failure it prints `{"ok":false,"error":"…"}` and exits
1; static analysis exits 2 for UI/empty/invalid workflows. Hard wall clock cap ≈190 s.

## Appendix C — workflow JSON (noobai-xl-vpred-api.json, verbatim)

```json
{
  "1": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": {
      "ckpt_name": "NoobAI-XL-Vpred-v1.0.safetensors"
    }
  },
  "2": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{prompt}}",
      "clip": ["1", 1]
    }
  },
  "3": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro",
      "clip": ["1", 1]
    }
  },
  "4": {
    "class_type": "ModelSamplingDiscrete",
    "inputs": {
      "sampling": "v_prediction",
      "zsnr": true,
      "model": ["1", 0]
    }
  },
  "5": {
    "class_type": "EmptyLatentImage",
    "inputs": {
      "width": 832,
      "height": 1216,
      "batch_size": 1
    }
  },
  "6": {
    "class_type": "KSampler",
    "inputs": {
      "seed": "{{seed}}",
      "steps": 28,
      "cfg": 5.0,
      "sampler_name": "euler",
      "scheduler": "normal",
      "denoise": 1.0,
      "model": ["4", 0],
      "positive": ["2", 0],
      "negative": ["3", 0],
      "latent_image": ["5", 0]
    }
  },
  "7": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["6", 0],
      "vae": ["1", 2]
    }
  },
  "8": {
    "class_type": "SaveImage",
    "inputs": {
      "images": ["7", 0],
      "filename_prefix": "dsh-image-gen"
    }
  }
}
```


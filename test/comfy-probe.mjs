#!/usr/bin/env node
/**
 * comfy-probe.mjs — standalone ComfyUI workflow probe for dsh-super-image.
 *
 * Static analysis (default):
 *   node test/comfy-probe.mjs --workflow <path>
 *   Prints the format verdict (api/ui), every node with class_type + text snippet,
 *   the inferred prompt/negative/seed/width/height/output node ids, and a JSON
 *   mapping block. Exit 0 on API format, exit 2 with the UI-format error.
 *
 * Live probe (opt-in):
 *   node test/comfy-probe.mjs --workflow <path> --submit [--base http://127.0.0.1:8188]
 *                             [--prompt "a red apple"] [--out test/out]
 *   Requires a running ComfyUI. The probe never starts a server: start it with
 *   `powershell -NoProfile -ExecutionPolicy Bypass -File D:\ComfyUI\comfyctl.ps1 -Action start`
 *   and stop it afterwards with `-Action stop` (see $DSH_HOME/AGENTS.md).
 *   Hard ceiling: 190 s wall clock (180 s polling + 10 s submission/download).
 *
 * No dependencies: Node 22+ globals only (fetch, AbortController, fs/promises).
 * Never writes outside <out> and never touches D:\ComfyUI except through HTTP.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_MAX_BYTES = 5 * 1024 * 1024;
const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180_000;
const HARD_DEADLINE_MS = 190_000;
const REACHABILITY_TIMEOUT_MS = 5_000;
const DEFAULT_BASE = "http://127.0.0.1:8188";
const DEFAULT_PROMPT = "a red apple";
const DEFAULT_OUT = "test/out";

/* ------------------------------------------------------------------ */
/* Exact user-facing messages shared with docs/comfyui-contract.md    */
/* ------------------------------------------------------------------ */

const MSG_UI_FORMAT =
  "ComfyUI 工作流是 UI 导出格式，不是 API 格式。请在 ComfyUI 中打开该工作流，使用「工作流 → 导出（API）」保存，再重新导入。 | " +
  "This ComfyUI workflow is a UI-format export, not API format. Open it in ComfyUI and use Workflow → Export (API), then import the exported file again.";

const MSG_INVALID_JSON =
  "ComfyUI 工作流文件不是有效的 JSON。请检查文件是否损坏。 | ComfyUI workflow file is not valid JSON.";

const MSG_EMPTY_WORKFLOW =
  "ComfyUI 工作流为空。请导入 API 格式的工作流 JSON（导出 → API）。 | " +
  "ComfyUI workflow is empty. Import an API-format workflow JSON (Export → API).";

const MSG_NOT_API =
  "ComfyUI 工作流既不是 API 格式也不是可识别的 UI 格式：每个节点必须是包含 class_type 与 inputs 的对象。 | " +
  "ComfyUI workflow is neither API format nor a recognizable UI format: every node must be an object with class_type and inputs.";

const MSG_MISSING_FILE =
  "找不到 ComfyUI 工作流文件。请在设置中填写 workflowPath 指向有效的 API 工作流 JSON。 | " +
  "ComfyUI workflow file not found. Point workflowPath in Settings at a valid API workflow JSON.";

const MSG_TOO_LARGE =
  "ComfyUI 工作流文件不能超过 5 MB。请精简工作流后重试。 | ComfyUI workflow file must be no larger than 5 MB.";

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text, max = 100) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function linkTarget(value) {
  // ComfyUI links are ["<nodeId>", <outputIndex>] arrays.
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const id = value[0];
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function hasPlaceholder(value, placeholder) {
  return typeof value === "string" && value.includes(placeholder);
}

function findPlaceholderInput(node, placeholders) {
  for (const [key, value] of Object.entries(node.inputs ?? {})) {
    for (const placeholder of placeholders) {
      if (hasPlaceholder(value, placeholder)) return { key, value, placeholder };
    }
  }
  return undefined;
}

function randomSeed() {
  return Math.floor(Math.random() * 4_294_967_296);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    workflow: undefined,
    base: DEFAULT_BASE,
    prompt: DEFAULT_PROMPT,
    submit: false,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--workflow":
        args.workflow = argv[++i];
        break;
      case "--base":
        args.base = argv[++i] ?? DEFAULT_BASE;
        break;      case "--prompt":
        args.prompt = argv[++i] ?? DEFAULT_PROMPT;
        break;
      case "--out":
        args.out = argv[++i] ?? DEFAULT_OUT;
        break;
      case "--submit":
        args.submit = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (args.workflow === undefined && !args.help) throw new Error("Missing required --workflow <path>");
  let parsedBase;
  try {
    parsedBase = new URL(args.base);
  } catch {
    throw new Error(`--base must be an absolute URL, got: ${args.base}`);
  }
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
    throw new Error(`--base must use http:// or https://, got: ${args.base}`);
  }
  args.base = parsedBase.origin;
  return args;
}

const USAGE = `Usage:
  node test/comfy-probe.mjs --workflow <path> [--base http://127.0.0.1:8188]
                            [--prompt "a red apple"] [--submit] [--out test/out]

Default is static analysis only (no network, no server start).
--submit adds: reachability check, POST /prompt, poll /history, download /view.
Exit codes: 0 api-format static analysis ok; 2 ui/invalid workflow; 1 live-probe failure or read error.`;

/* ------------------------------------------------------------------ */
/* Format detection + parsing                                         */
/* ------------------------------------------------------------------ */

/**
 * "api"     — non-empty object whose every value is {class_type, inputs}
 * "ui"      — has a top-level nodes array and/or links array
 * "empty"   — empty object
 * "invalid" — anything else (array, scalar, mixed node shapes)
 */
function detectFormat(value) {
  if (Array.isArray(value)) return "ui";
  if (!isRecord(value)) return "invalid";
  if (Array.isArray(value.nodes) || Array.isArray(value.links)) return "ui";
  const entries = Object.entries(value);
  if (entries.length === 0) return "empty";
  const apiLike = entries.every(
    ([, node]) => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs),
  );
  return apiLike ? "api" : "invalid";
}

function formatError(format) {
  if (format === "ui") return MSG_UI_FORMAT;
  return MSG_NOT_API;
}

async function loadWorkflow(workflowPath) {
  let text;
  try {
    text = await readFile(workflowPath, "utf8");
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") throw Object.assign(new Error(MSG_MISSING_FILE), { probeExit: 1 });
    throw Object.assign(new Error(`无法读取工作流文件：${String(error?.message ?? error)}`), { probeExit: 1 });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > WORKFLOW_MAX_BYTES) throw Object.assign(new Error(MSG_TOO_LARGE), { probeExit: 1 });
  if (text.trim().length === 0) throw Object.assign(new Error(MSG_EMPTY_WORKFLOW), { probeExit: 2 });

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(MSG_INVALID_JSON), { probeExit: 2 });
  }
  const format = detectFormat(value);
  if (format !== "api") {
    const message = format === "empty" ? MSG_EMPTY_WORKFLOW : formatError(format);
    throw Object.assign(new Error(message), { probeExit: 2 });
  }
  return { text, value, bytes, format };
}

/* ------------------------------------------------------------------ */
/* Node inference                                                     */
/* ------------------------------------------------------------------ */

const POSITIVE_PLACEHOLDERS = ["{{prompt}}", "%prompt%"];
const SEED_PLACEHOLDERS = ["{{seed}}", "%seed%"];
const WIDTH_PLACEHOLDERS = ["{{width}}", "%width%"];
const HEIGHT_PLACEHOLDERS = ["{{height}}", "%height%"];

function isSamplerClass(classType) {
  return /KSampler|SamplerCustom|SamplerCustomAdvanced|KSamplerAdvanced/i.test(classType);
}

function isLatentClass(classType) {
  return /EmptyLatentImage|EmptySD3LatentImage|EmptyLatentAudio|LatentImage$/i.test(classType);
}

function isSaveClass(classType) {
  return /SaveImage|SaveAnimatedWEBP|SaveWEBM|ImageSave/i.test(classType);
}

function nodeText(node) {
  for (const [key, value] of Object.entries(node.inputs ?? {})) {
    if (key === "text" || key === "text_g" || key === "positive_prompt" || key === "prompt") {
      if (typeof value === "string") return { key, value };
    }
  }
  return undefined;
}

function inferMapping(workflow) {
  const nodes = Object.entries(workflow).map(([id, node]) => ({
    id,
    classType: node.class_type,
    inputs: node.inputs,
  }));

  const samplers = nodes.filter((node) => isSamplerClass(node.classType));
  const primarySampler = samplers[0];

  // --- prompt -------------------------------------------------------
  let promptNode;
  let promptInputKey;
  for (const node of nodes) {
    const hit = findPlaceholderInput(node, POSITIVE_PLACEHOLDERS);
    if (hit !== undefined) {
      promptNode = node;
      promptInputKey = hit.key;
      break;
    }
  }
  if (promptNode === undefined && primarySampler !== undefined) {
    const positiveId = linkTarget(primarySampler.inputs?.positive);
    if (positiveId !== undefined) {
      const candidate = nodes.find((node) => node.id === positiveId);
      if (candidate !== undefined && nodeText(candidate) !== undefined) {
        promptNode = candidate;
        promptInputKey = nodeText(candidate).key;
      }
    }
  }
  if (promptNode === undefined) {
    const textEncoders = nodes.filter((node) => node.classType === "CLIPTextEncode");
    if (textEncoders.length > 0) {
      promptNode = textEncoders[0];
      promptInputKey = nodeText(textEncoders[0])?.key ?? "text";
    }
  }

  // --- negative -----------------------------------------------------
  let negativeNode;
  if (primarySampler !== undefined) {
    const negativeId = linkTarget(primarySampler.inputs?.negative);
    if (negativeId !== undefined && negativeId !== promptNode?.id) {
      negativeNode = nodes.find((node) => node.id === negativeId);
    }
  }
  if (negativeNode === undefined) {
    const textEncoders = nodes.filter(
      (node) => node.classType === "CLIPTextEncode" && node.id !== promptNode?.id,
    );
    negativeNode = textEncoders[0];
  }

  // --- seed ---------------------------------------------------------
  let seedNode;
  let seedInputKey;
  for (const node of nodes) {
    const hit = findPlaceholderInput(node, SEED_PLACEHOLDERS);
    if (hit !== undefined) {
      seedNode = node;
      seedInputKey = hit.key;
      break;
    }
  }
  if (seedNode === undefined) {
    const seedCarrier =
      primarySampler ??
      nodes.find((node) => typeof node.inputs?.seed === "number" || typeof node.inputs?.noise_seed === "number");
    if (seedCarrier !== undefined) {
      if (typeof seedCarrier.inputs?.seed === "number" || typeof seedCarrier.inputs?.seed === "string") {
        seedNode = seedCarrier;
        seedInputKey = "seed";
      } else if (typeof seedCarrier.inputs?.noise_seed === "number") {
        seedNode = seedCarrier;
        seedInputKey = "noise_seed";
      }
    }
  }

  // --- width/height -------------------------------------------------
  let latentNode;
  for (const node of nodes) {
    if (node.inputs?.width !== undefined && node.inputs?.height !== undefined) {
      latentNode = node;
      break;
    }
  }
  if (latentNode === undefined) latentNode = nodes.find((node) => isLatentClass(node.classType));

  const width = typeof latentNode?.inputs?.width === "number" ? latentNode.inputs.width : undefined;
  const height = typeof latentNode?.inputs?.height === "number" ? latentNode.inputs.height : undefined;

  // --- output -------------------------------------------------------
  let outputNode = nodes.find((node) => isSaveClass(node.classType));
  if (outputNode === undefined) {
    outputNode = nodes.find((node) => Array.isArray(node.inputs?.images));
  }

  // --- model --------------------------------------------------------
  let model;
  const checkpoint = nodes.find((node) => node.classType === "CheckpointLoaderSimple");
  if (checkpoint !== undefined && typeof checkpoint.inputs?.ckpt_name === "string") {
    model = { nodeId: checkpoint.id, loader: "CheckpointLoaderSimple", name: checkpoint.inputs.ckpt_name };
  } else {
    const unet = nodes.find((node) => /UNETLoader/i.test(node.classType) && typeof node.inputs?.unet_name === "string");
    if (unet !== undefined) {
      model = { nodeId: unet.id, loader: unet.classType, name: unet.inputs.unet_name };
    }
  }

  return {
    nodes,
    mapping: {
      promptNodeId: promptNode?.id,
      promptClassType: promptNode?.classType,
      promptInputKey,
      negativeNodeId: negativeNode?.id,
      negativeClassType: negativeNode?.classType,
      seedNodeId: seedNode?.id,
      seedClassType: seedNode?.classType,
      seedInputKey,
      widthNodeId: latentNode?.id,
      heightNodeId: latentNode?.id,
      latentClassType: latentNode?.classType,
      outputNodeId: outputNode?.id,
      outputClassType: outputNode?.classType,
    },
    nativeResolution: { width, height },
    model,
  };
}

/* ------------------------------------------------------------------ */
/* Injection (mirrors docs/comfyui-contract.md §4)                    */
/* ------------------------------------------------------------------ */

function injectPrompt(workflow, prompt, seed) {
  const clone = structuredClone(workflow);
  let promptReplacements = 0;

  const replaceStrings = (value) => {
    if (typeof value === "string") {
      let next = value;
      if (POSITIVE_PLACEHOLDERS.some((placeholder) => next.includes(placeholder))) {
        promptReplacements += 1;
        for (const placeholder of POSITIVE_PLACEHOLDERS) next = next.split(placeholder).join(prompt);
      }
      if (SEED_PLACEHOLDERS.includes(next)) return seed;
      if (SEED_PLACEHOLDERS.some((placeholder) => next.includes(placeholder))) {
        for (const placeholder of SEED_PLACEHOLDERS) next = next.split(placeholder).join(String(seed));
      }
      return next;
    }
    if (Array.isArray(value)) return value.map(replaceStrings);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceStrings(child)]));
  };

  for (const [nodeId, node] of Object.entries(clone)) {
    if (isRecord(node) && isRecord(node.inputs)) clone[nodeId].inputs = replaceStrings(node.inputs);
  }

  if (promptReplacements === 0) {
    // Explicit mapping path: no placeholder in the file, so write the text input directly.
    const { mapping } = inferMapping(workflow);
    if (mapping.promptNodeId === undefined) {
      throw new Error(
        "无法注入提示词：工作流既没有 {{prompt}} 占位符，也无法自动识别提示词节点。请设置 promptNodeId。 | " +
          "Cannot inject the prompt: the workflow has no {{prompt}} placeholder and no prompt node could be detected. Set promptNodeId.",
      );
    }
    const node = clone[mapping.promptNodeId];
    const key = mapping.promptInputKey ?? "text";
    if (!isRecord(node?.inputs)) throw new Error(`promptNodeId ${mapping.promptNodeId} has no inputs`);
    node.inputs[key] = prompt;
  }

  return clone;
}

/* ------------------------------------------------------------------ */
/* Static analysis output                                             */
/* ------------------------------------------------------------------ */

function staticReport(workflowPath, loaded) {
  const { text, value, bytes, format } = loaded;
  const { nodes, mapping, nativeResolution, model } = inferMapping(value);
  const placeholders = {
    prompt: POSITIVE_PLACEHOLDERS.filter((placeholder) => text.includes(placeholder)),
    seed: SEED_PLACEHOLDERS.filter((placeholder) => text.includes(placeholder)),
    width: WIDTH_PLACEHOLDERS.filter((placeholder) => text.includes(placeholder)),
    height: HEIGHT_PLACEHOLDERS.filter((placeholder) => text.includes(placeholder)),
  };

  console.log(`workflow : ${path.resolve(workflowPath)}`);
  console.log(`format   : ${format}`);
  console.log(`bytes    : ${bytes}`);
  console.log(`model    : ${model === undefined ? "(not detected)" : `${model.name} (${model.loader} #${model.nodeId})`}`);
  console.log(
    `native   : ${nativeResolution.width ?? "?"}x${nativeResolution.height ?? "?"}`,
  );
  console.log(`placeholder: prompt=${placeholders.prompt.join("|") || "none"} seed=${placeholders.seed.join("|") || "none"}`);
  console.log("");
  console.log("nodes:");
  for (const node of nodes) {
    const textInput = nodeText(node);
    const snippet = textInput === undefined ? "" : ` text[${textInput.key}]=${JSON.stringify(clip(textInput.value, 70))}`;
    console.log(`  #${node.id} ${node.classType}${snippet}`);
  }
  console.log("");
  const detected = {
    workflow: path.resolve(workflowPath),
    format,
    bytes,
    placeholders,
    mapping,
    nativeResolution,
    model: model ?? null,
  };
  console.log("detected mapping:");
  console.log(JSON.stringify(detected, null, 2));
  return detected;
}

/* ------------------------------------------------------------------ */
/* Live probe                                                         */
/* ------------------------------------------------------------------ */

function endpoint(base, route) {
  return `${base.replace(/\/+$/, "")}/${route}`;
}

function originOf(base) {
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

async function readBoundedBytes(response, maxBytes) {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error(`ComfyUI response exceeded the ${maxBytes} byte limit`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readBoundedText(response, maxBytes = 4096) {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

function detectImageType(data) {
  const startsWith = (signature) => signature.every((byte, index) => data[index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: "image/png", extension: "png" };
  if (startsWith([0xff, 0xd8, 0xff])) return { mediaType: "image/jpeg", extension: "jpg" };
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { mediaType: "image/gif", extension: "gif" };
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return { mediaType: "image/webp", extension: "webp" };
  }
  return undefined;
}

/** PNG IHDR width/height; 0/0 when the file is not a PNG or is truncated. */
function pngSize(data) {
  if (data.byteLength < 24) return { width: 0, height: 0 };
  if (data[0] !== 0x89 || data[1] !== 0x50) return { width: 0, height: 0 };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function firstOutputImage(outputs) {
  if (!isRecord(outputs)) return undefined;
  for (const nodeOutput of Object.values(outputs)) {
    if (!isRecord(nodeOutput) || !Array.isArray(nodeOutput.images)) continue;
    for (const image of nodeOutput.images) {
      if (!isRecord(image) || typeof image.filename !== "string" || image.filename.length === 0) continue;
      const candidate = {
        filename: image.filename,
        subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
        type: typeof image.type === "string" ? image.type : "output",
      };
      // Saved results are type "output"; PreviewImage temps are type "temp" and must be skipped.
      if (candidate.type === "output") return candidate;
    }
  }
  return undefined;
}

function errorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      const parts = [];
      if (isRecord(parsed.error)) {
        parts.push(`${parsed.error.message ?? parsed.error.type ?? "error"}: ${parsed.error.details ?? ""}`);
      }
      if (isRecord(parsed.node_errors)) {
        for (const [nodeId, info] of Object.entries(parsed.node_errors)) {
          if (!isRecord(info) || !Array.isArray(info.errors)) continue;
          for (const item of info.errors) {
            if (isRecord(item)) {
              parts.push(`node ${nodeId} (${info.class_type ?? "?"}): ${item.message ?? ""} ${item.details ?? ""}`);
            }
          }
        }
      }
      if (parts.length > 0) return clip(parts.join(" | "), 2000);
    }
  } catch {
    /* fall through to raw text */
  }
  return clip(String(text), 2000);
}

async function submitAndDownload(base, workflow, prompt, outDir, deadline) {
  const remaining = () => deadline - Date.now();
  if (remaining() <= 0) throw new Error("probe hard deadline exceeded before submission");
  const origin = originOf(base);

  // 1. Reachability.
  let stats;
  try {
    stats = await fetch(endpoint(base, "system_stats"), {
      signal: AbortSignal.timeout(Math.min(REACHABILITY_TIMEOUT_MS, remaining())),
    });
  } catch {
    throw new Error(
      `Could not connect to ComfyUI at ${origin} — 无法连接 ComfyUI，请先运行 comfyctl.ps1 -Action start。 | ` +
        `Cannot reach ComfyUI at ${origin}; start it with comfyctl.ps1 -Action start.`,
    );
  }
  if (!stats.ok) throw new Error(`ComfyUI /system_stats failed (${stats.status})`);
  await stats.arrayBuffer().catch(() => undefined);

  // 2. Inject and submit.
  const seed = randomSeed();
  const injected = injectPrompt(workflow, prompt, seed);
  let submitted;
  try {
    submitted = await fetch(endpoint(base, "prompt"), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(30_000, remaining())),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ prompt: injected }),
    });
  } catch {
    throw new Error(`Could not connect to ComfyUI at ${origin} while submitting the workflow`);
  }
  const submitText = await readBoundedText(submitted);
  if (!submitted.ok) {
    throw new Error(`ComfyUI rejected the workflow (${submitted.status}): ${errorDetail(submitText)}`);
  }
  let submitPayload;
  try {
    submitPayload = JSON.parse(submitText);
  } catch {
    throw new Error(`ComfyUI /prompt returned invalid JSON: ${clip(submitText, 500)}`);
  }
  if (!isRecord(submitPayload) || typeof submitPayload.prompt_id !== "string" || submitPayload.prompt_id.length === 0) {
    throw new Error(`ComfyUI /prompt returned no prompt_id: ${clip(submitText, 500)}`);
  }
  const promptId = submitPayload.prompt_id;

  // 3. Poll /history.
  const pollDeadline = Math.min(deadline, Date.now() + POLL_TIMEOUT_MS);
  for (;;) {
    if (Date.now() >= pollDeadline) {
      throw new Error(`ComfyUI generation timed out after ${POLL_TIMEOUT_MS} ms (prompt_id ${promptId})`);
    }
    const response = await fetch(endpoint(base, `history/${encodeURIComponent(promptId)}`), {
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(30_000, Math.max(1, pollDeadline - Date.now()))),
    });
    const text = await readBoundedText(response, HISTORY_MAX_BYTES);
    if (!response.ok) {
      throw new Error(`ComfyUI history request failed (${response.status}): ${errorDetail(text)}`);
    }
    let history;
    try {
      history = JSON.parse(text);
    } catch {
      throw new Error(`ComfyUI history returned invalid JSON: ${clip(text, 500)}`);
    }
    const entry = isRecord(history) && isRecord(history[promptId]) ? history[promptId] : undefined;
    if (entry !== undefined) {
      const status = isRecord(entry.status) ? entry.status : undefined;
      if (status?.status_str === "error") {
        throw new Error(`ComfyUI workflow failed: ${clip(JSON.stringify(status.messages ?? status), 2000)}`);
      }
      const output = firstOutputImage(entry.outputs);
      if (output !== undefined) {
        // 4. Download /view.
        const url = new URL(endpoint(base, "view"));
        url.searchParams.set("filename", output.filename);
        url.searchParams.set("subfolder", output.subfolder);
        url.searchParams.set("type", output.type);
        const download = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(60_000, Math.max(1, deadline - Date.now()))),
        });
        if (!download.ok) throw new Error(`ComfyUI image download failed (${download.status})`);
        const data = await readBoundedBytes(download, 64 * 1024 * 1024);
        const detected = detectImageType(data);
        if (detected === undefined) {
          throw new Error("ComfyUI image download returned an unsupported content type 未知图片类型");
        }
        await mkdir(outDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = path.join(outDir, `probe-${stamp}.${detected.extension}`);
        await writeFile(file, data);
        const { width, height } = pngSize(data);
        return {
          ok: true,
          promptId,
          file: path.resolve(file),
          bytes: data.byteLength,
          width,
          height,
        };
      }
      if (status?.completed === true) {
        throw new Error("ComfyUI workflow completed without an output image (completed=true, no type=output image)");
      }
    }
    const wait = Math.min(POLL_INTERVAL_MS, Math.max(0, pollDeadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const workflowPath = path.resolve(args.workflow);
  let loaded;
  try {
    loaded = await loadWorkflow(workflowPath);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (args.submit) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(message);
    }
    return typeof error?.probeExit === "number" ? error.probeExit : 1;
  }

  staticReport(workflowPath, loaded);
  if (!args.submit) return 0;

  const started = Date.now();
  const deadline = started + HARD_DEADLINE_MS;
  try {
    const result = await submitAndDownload(args.base, loaded.value, args.prompt, args.out, deadline);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    console.log(JSON.stringify({ ok: false, error: message }));
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.log(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }));
    process.exit(1);
  });

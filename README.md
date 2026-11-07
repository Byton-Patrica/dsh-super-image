# dsh-super-image

Super Image for DeepSeek Harness: draw one request with **two independently configured image backends in parallel**, verify every result against an explicit requirement rubric, and fuse the best result into a single deliverable.

## Features

- Dedicated **Super Image** tab in the DSH settings dialog (`super-image` namespace).
- Backend A / Backend B, each either an **OpenAI-Images-compatible API** or a local **ComfyUI** server.
- API keys live in the DSH credential service only (`SUPER_IMAGE_A_API_KEY`, `SUPER_IMAGE_B_API_KEY` by default) — never in settings or the profile patch.
- Tool `super_image` (does not touch `generate_image` / `image_generate`) and slash command `/super-image <prompt>`.
- Composer-dock button inserts `/super-image ` into the message box.
- Pipeline: rubric extraction → `Promise.allSettled` dual-backend generation → per-image rubric verification (VLM when available, heuristic fallback) → fusion (`reference-edit` / `prompt-synthesis` / `side-by-side`).
- The comparison is a **requirement × image** table (pass / unmet / weak / needs-human) followed by a per-image **strengths / unmet-weak** table.
- Fusion on: the best original becomes the base and the final image gets its own verification note stating what was resolved and what still remains. Fusion off: the two originals and the table are returned side-by-side, and no third image is generated.
- Originals and final image are written to `<session workspace>/generate/super-image/` and returned as inline image blocks; nothing is deleted.
- One failed backend degrades to the other with an explicit note instead of failing the whole call.
- Local ComfyUI generations append a safety negative (`nsfw, nude, topless, …`) so anime-tuned checkpoints do not drift into adult content unasked.
- Fusion only runs when the visual verification actually produced scores; if no VLM is available, the tool returns the two originals side-by-side instead of guessing a base image.

## Settings

`Settings → Super Image`:

1. **Backend A / Backend B** — type (`api` / `comfyui`), endpoint, model, size, quality; for ComfyUI: server URL, **model/workflow picker** (reads the workflows stored in the running ComfyUI, e.g. NoobAI-XL and qwen image, and auto-fills the node mapping), optional output size, and advanced node ids / local workflow path / timeout / poll interval. Cards turn red when required fields or credentials are missing.
2. **Generation strategy** — images per backend (1–4), enable rubric verification, enable fusion, fusion mode.
3. **Advanced** — optional VLM provider/model used for verification; empty means auto-detect a host vision model.

ComfyUI runs on demand. When it is not running, the settings cards show an amber **未启动** state (not an error), keep showing the last model list from the local cache, and offer a **启动 ComfyUI** button. The host also starts it automatically before generation (`D:\ComfyUI\comfyctl.ps1 -Action start`, overridable with `DSH_COMFY_START_SCRIPT`) and reports a clear timeout if startup fails.

ComfyUI requires an **API-format** workflow exported from ComfyUI (`导出 API 格式`). The picker lists the workflows stored by the running server (`GET /userdata?dir=workflows`), detects the prompt/negative/seed/size/output nodes for each, and rejects UI-format exports (with `nodes`/`links`) with an explicit message. Picking a model clears the size so the workflow's native resolution is used; type a size such as `832x1216` to override.

## Layout

```
lib/index.js      host: tool, command, settings/credential routes, pipeline
lib/prompts.js    rubric extraction / verification / fusion prompts + tolerant parsers
lib/client.js     settings section + composer-dock entry
locale/           display metadata
cordis.patch.yml  bundle patch (entry id: super-image)
```

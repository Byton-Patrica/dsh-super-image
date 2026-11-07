/**
 * dsh-super-image — host half.
 *
 * Registers:
 *  - tool `super_image`: rubric extraction → two backends in parallel → rubric
 *    verification → fused delivery → workspace files + inline image blocks.
 *  - command `/super-image <prompt>`: same pipeline, text-only result.
 *  - web routes under /plugins/dsh-super-image/api/ used by the dedicated
 *    settings section (config, credentials, health).
 *
 * Persistence goes through the `settings` service (namespace = entry id
 * `super-image`) with a `configEditor` fallback; API keys never enter the
 * settings document and live in the credential service only.
 */
import Schema from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash, randomInt } from 'node:crypto'
import {
  buildRubricRequest,
  buildRubricFallback,
  parseRubric,
  buildVerifyRequest,
  parseVerify,
  buildFusionPrompt,
} from './prompts.js'

export const name = 'dsh-super-image'

const NS = 'super-image'
const PKG = 'dsh-super-image'
const ROUTE_BASE = '/plugins/dsh-super-image/api'
const FOLDER = 'generate/super-image'
const DEFAULT_REF = { a: 'SUPER_IMAGE_A_API_KEY', b: 'SUPER_IMAGE_B_API_KEY' }
const DEFAULT_BASE = { a: 'https://api.openai.com/v1', b: 'http://127.0.0.1:8188' }
const MAX_BODY = 1024 * 1024
const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const DEFAULT_COMFY_START_SCRIPT = 'D:\\ComfyUI\\comfyctl.ps1'
// ComfyUI checkpoints are often anime-tuned and drift toward adult content without
// being asked to; keep a safety floor in the negative prompt for local generations.
const SAFETY_NEGATIVE = 'nsfw, nude, topless, nipples, explicit, sexual content'

const BackendConfig = Schema.object({
  type: Schema.union(['api', 'comfyui']).default('api'),
  baseURL: Schema.string().default(''),
  model: Schema.string().default(''),
  size: Schema.string().default('1024x1024'),
  quality: Schema.string().default('auto'),
  apiKeyRef: Schema.string().default(''),
  comfyURL: Schema.string().default('http://127.0.0.1:8188'),
  workflowPath: Schema.string().default(''),
  workflowName: Schema.string().default(''),
  promptNodeId: Schema.string().default(''),
  negativeNodeId: Schema.string().default(''),
  seedNodeId: Schema.string().default(''),
  widthNodeId: Schema.string().default(''),
  heightNodeId: Schema.string().default(''),
  outputNodeId: Schema.string().default(''),
  timeoutMs: Schema.number().min(1000).max(3600000).default(300000),
  pollMs: Schema.number().min(100).max(60000).default(1000),
})

const Config = Schema.object({
  backendA: BackendConfig,
  backendB: BackendConfig,
  perBackendCount: Schema.number().min(1).max(4).default(1),
  enableVerify: Schema.boolean().default(true),
  enableFusion: Schema.boolean().default(true),
  fusionMode: Schema.union(['reference-edit', 'prompt-synthesis', 'side-by-side']).default('reference-edit'),
  vlmProvider: Schema.string().default(''),
  vlmModel: Schema.string().default(''),
})

export { Config }
export const inject = ['tools', 'webServer', 'credentials', 'attachments']

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function trimSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function extensionOf(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

function detectMediaType(data) {
  const head = data.subarray(0, 12)
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) return 'image/webp'
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif'
  return undefined
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(abortError(signal))
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function abortError(signal) {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : '操作已取消')
  error.name = 'AbortError'
  return error
}

function combineSignals(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

function errorMessage(error) {
  if (!error) return '未知错误'
  if (error.name === 'TimeoutError') return '请求超时'
  const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error)
  const cause = error.cause?.code ?? error.cause?.message
  return cause && !message.includes(cause) ? `${message}（${cause}）` : message
}

function normalizeBackend(raw, key) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const type = source.type === 'comfyui' ? 'comfyui' : 'api'
  return {
    type,
    baseURL: asString(source.baseURL, type === 'api' ? DEFAULT_BASE[key] : ''),
    model: asString(source.model),
    size: asString(source.size, '1024x1024'),
    quality: asString(source.quality, 'auto'),
    apiKeyRef: asString(source.apiKeyRef) || DEFAULT_REF[key],
    comfyURL: asString(source.comfyURL, DEFAULT_BASE[key]),
    workflowPath: asString(source.workflowPath),
    workflowName: asString(source.workflowName),
    promptNodeId: asString(source.promptNodeId),
    negativeNodeId: asString(source.negativeNodeId),
    seedNodeId: asString(source.seedNodeId),
    widthNodeId: asString(source.widthNodeId),
    heightNodeId: asString(source.heightNodeId),
    outputNodeId: asString(source.outputNodeId),
    timeoutMs: Math.min(3600000, Math.max(1000, asNumber(source.timeoutMs, 300000))),
    pollMs: Math.min(60000, Math.max(100, asNumber(source.pollMs, 1000))),
  }
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    backendA: normalizeBackend(source.backendA, 'a'),
    backendB: normalizeBackend(source.backendB, 'b'),
    perBackendCount: Math.min(4, Math.max(1, Math.round(asNumber(source.perBackendCount, 1)))),
    enableVerify: source.enableVerify !== false,
    enableFusion: source.enableFusion !== false,
    fusionMode: ['reference-edit', 'prompt-synthesis', 'side-by-side'].includes(source.fusionMode)
      ? source.fusionMode
      : 'reference-edit',
    vlmProvider: asString(source.vlmProvider),
    vlmModel: asString(source.vlmModel),
  }
}

function backendOf(cfg, key) {
  return key === 'a' ? cfg.backendA : cfg.backendB
}

function backendLabel(key) {
  return key === 'a' ? '后端 A' : '后端 B'
}

// ---------------------------------------------------------------------------
// credentials / persistence
// ---------------------------------------------------------------------------

function credentialService(ctx) {
  try {
    return ctx.get('credentials')
  } catch {
    return undefined
  }
}

async function credentialInfo(ctx, ref) {
  try {
    const service = credentialService(ctx)
    if (!service?.describe) return { configured: false, writable: false, source: undefined }
    const info = await service.describe(ref)
    return {
      configured: info?.configured === true,
      writable: info?.writable !== false,
      source: typeof info?.source === 'string' ? info.source : undefined,
    }
  } catch {
    return { configured: false, writable: false, source: undefined }
  }
}

async function credentialValue(ctx, ref) {
  try {
    const resolved = await credentialService(ctx)?.resolve?.(ref)
    if (!resolved) return undefined
    const value = typeof resolved === 'string' ? resolved : resolved.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function settingsService(ctx) {
  try {
    return ctx.get('settings')
  } catch {
    return undefined
  }
}

function configEditorService(ctx) {
  try {
    return ctx.get('configEditor')
  } catch {
    return undefined
  }
}

async function findSettingsDescriptor(settings) {
  try {
    const list = await settings?.describe?.({ redactSecrets: true })
    if (!Array.isArray(list)) return undefined
    return list.find((item) => item?.ns === NS)
  } catch {
    return undefined
  }
}

function findEditorEntry(editor) {
  try {
    const entries = editor?.entries?.()
    if (!Array.isArray(entries)) return undefined
    return entries.find((entry) => entry?.name === PKG || entry?.id === NS || entry?.options?.id === NS)
  } catch {
    return undefined
  }
}

/** Live config: settings document first, then configEditor entry, then apply() config. */
async function liveConfig(ctx, fallback) {
  try {
    const descriptor = await findSettingsDescriptor(settingsService(ctx))
    if (descriptor?.value && typeof descriptor.value === 'object') {
      return normalizeConfig(deepMerge(fallback, descriptor.value))
    }
  } catch {}
  try {
    const editor = configEditorService(ctx)
    const entry = findEditorEntry(editor)
    if (entry?.config && typeof entry.config === 'object') {
      return normalizeConfig(deepMerge(fallback, entry.config))
    }
  } catch {}
  return normalizeConfig(fallback)
}

async function persistConfig(ctx, patch) {
  const settings = settingsService(ctx)
  const descriptor = await findSettingsDescriptor(settings)
  if (descriptor && typeof settings?.update === 'function') {
    await settings.update(NS, patch, descriptor.revision)
    return
  }
  const editor = configEditorService(ctx)
  const entry = findEditorEntry(editor)
  if (entry && typeof editor?.edit === 'function') {
    await editor.edit(entry, (current) => deepMerge(current ?? {}, patch))
    return
  }
  throw new Error('配置服务不可用（settings / configEditor 均未就绪），无法保存')
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

async function backendHealth(ctx, cfg, key) {
  const backend = backendOf(cfg, key)
  const label = backendLabel(key)
  if (backend.type === 'api') {
    if (!backend.baseURL) return { ok: false, message: `${label}：未配置 Base URL` }
    if (!isHttpUrl(backend.baseURL)) return { ok: false, message: `${label}：Base URL 不是合法的 http(s) 地址` }
    if (!backend.model) return { ok: false, message: `${label}：未配置模型 id` }
    const info = await credentialInfo(ctx, backend.apiKeyRef)
    if (!info.configured) return { ok: false, message: `${label}：API Key 未配置（凭据 ${backend.apiKeyRef}）` }
    return { ok: true, message: `${label}：API ${backend.model} 已就绪` }
  }
  if (!backend.comfyURL) return { ok: false, message: `${label}：未配置 ComfyUI 地址` }
  if (!isHttpUrl(backend.comfyURL)) return { ok: false, message: `${label}：ComfyUI 地址不是合法的 http(s) 地址` }
  if (!backend.workflowName && !backend.workflowPath) {
    return { ok: false, message: `${label}：未选择模型/工作流（点选下方的模型或填写 workflow 路径）` }
  }
  if (!backend.workflowName) {
    const file = resolveFilePath(backend.workflowPath)
    if (!existsSync(file)) return { ok: false, message: `${label}：workflow 文件不存在：${file}` }
  }
  if (!(await comfyPing(backend.comfyURL))) {
    return { ok: false, level: 'warn', message: `${label}：ComfyUI 未启动（为 ${backend.comfyURL}，生成时会自动启动）` }
  }
  try {
    await loadComfyWorkflow(backend, AbortSignal.timeout(8000))
  } catch (error) {
    if (comfyConnectionError(error)) {
      return { ok: false, level: 'warn', message: `${label}：ComfyUI 未启动或无法连接（${backend.comfyURL}）` }
    }
    return { ok: false, message: `${label}：${errorMessage(error)}` }
  }
  return {
    ok: true,
    message: `${label}：ComfyUI ${backend.workflowName || backend.workflowPath.split(/[\\/]/).pop()} 已就绪`,
  }
}

async function healthSnapshot(ctx, cfg) {
  const [a, b] = await Promise.all([backendHealth(ctx, cfg, 'a'), backendHealth(ctx, cfg, 'b')])
  return { a, b }
}

async function credentialsSnapshot(ctx, cfg) {
  const [a, b] = await Promise.all([
    credentialInfo(ctx, cfg.backendA.apiKeyRef),
    credentialInfo(ctx, cfg.backendB.apiKeyRef),
  ])
  return { a, b }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function originAllowed(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const url = new URL(origin)
    const host = req.headers?.host
    return typeof host === 'string' && url.host === host
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  if (!originAllowed(req)) {
    const error = new Error('跨源请求被拒绝')
    error.statusCode = 403
    throw error
  }
  const contentType = String(req.headers?.['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) {
    const error = new Error('请求必须是 application/json')
    error.statusCode = 415
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('请求体过大')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be an object')
    }
    return value
  } catch {
    const error = new Error('请求体不是合法 JSON 对象')
    error.statusCode = 400
    throw error
  }
}

function sanitizeConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const allowedTop = ['perBackendCount', 'enableVerify', 'enableFusion', 'fusionMode', 'vlmProvider', 'vlmModel']
  const allowedBackend = [
    'type',
    'baseURL',
    'model',
    'size',
    'quality',
    'apiKeyRef',
    'comfyURL',
    'workflowPath',
    'workflowName',
    'promptNodeId',
    'negativeNodeId',
    'seedNodeId',
    'widthNodeId',
    'heightNodeId',
    'outputNodeId',
    'timeoutMs',
    'pollMs',
  ]
  const patch = {}
  for (const key of allowedTop) if (key in raw) patch[key] = raw[key]
  for (const side of ['backendA', 'backendB']) {
    if (!raw[side] || typeof raw[side] !== 'object' || Array.isArray(raw[side])) continue
    const inner = {}
    for (const key of allowedBackend) if (key in raw[side]) inner[key] = raw[side][key]
    patch[side] = inner
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

async function routeWorkflows(ctx, getConfig, req, res) {
  try {
    if (req.method !== 'GET') return jsonResponse(res, 405, { ok: false, error: 'Method not allowed' })
    if (!originAllowed(req)) return jsonResponse(res, 403, { ok: false, error: '跨源请求被拒绝' })
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const cfg = await liveConfig(ctx, getConfig())
    const side = query.get('side') === 'b' ? 'b' : 'a'
    const comfyURL = String(query.get('url') ?? '').trim() || backendOf(cfg, side).comfyURL
    const workflows = await listComfyWorkflows(comfyURL)
    return jsonResponse(res, 200, { ok: true, comfyURL, workflows })
  } catch (error) {
    return jsonResponse(res, error?.statusCode ?? 400, { ok: false, error: errorMessage(error) })
  }
}


async function routeComfyStart(ctx, getConfig, req, res) {
  try {
    if (req.method !== 'POST') return jsonResponse(res, 405, { ok: false, error: 'Method not allowed' })
    const body = await readJsonBody(req)
    const cfg = await liveConfig(ctx, getConfig())
    const comfyURL = String(body.url ?? '').trim() || backendOf(cfg, body.side === 'b' ? 'b' : 'a').comfyURL
    const result = await startLocalComfy(comfyURL)
    return jsonResponse(res, 200, { ok: true, ...result, comfyURL })
  } catch (error) {
    return jsonResponse(res, error?.statusCode ?? 400, { ok: false, error: errorMessage(error) })
  }
}


async function routeSettings(ctx, getConfig, req, res) {
  try {
    if (req.method === 'GET') {
      const cfg = await liveConfig(ctx, getConfig())
      return jsonResponse(res, 200, {
        ok: true,
        config: cfg,
        credentials: await credentialsSnapshot(ctx, cfg),
        health: await healthSnapshot(ctx, cfg),
      })
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req)
      const patch = sanitizeConfigPatch(body?.config)
      if (!patch) return jsonResponse(res, 400, { ok: false, error: 'config 必须是非空对象' })
      const before = await liveConfig(ctx, getConfig())
      const merged = normalizeConfig(deepMerge(before, patch))
      await persistConfig(ctx, merged)
      return jsonResponse(res, 200, {
        ok: true,
        config: merged,
        credentials: await credentialsSnapshot(ctx, merged),
        health: await healthSnapshot(ctx, merged),
      })
    }
    res.setHeader('allow', 'GET, PUT, POST')
    return jsonResponse(res, 405, { ok: false, error: '不支持的请求方法' })
  } catch (error) {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
    return jsonResponse(res, status, { ok: false, error: errorMessage(error) })
  }
}

async function routeCredential(ctx, getConfig, req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('allow', 'POST, DELETE')
      return jsonResponse(res, 405, { ok: false, error: '不支持的请求方法' })
    }
    const body = await readJsonBody(req)
    const side = body?.backend === 'a' || body?.backend === 'b' ? body.backend : undefined
    if (!side) return jsonResponse(res, 400, { ok: false, error: 'backend 必须是 "a" 或 "b"' })
    const cfg = await liveConfig(ctx, getConfig())
    const ref = backendOf(cfg, side).apiKeyRef || DEFAULT_REF[side]
    const service = credentialService(ctx)
    if (!service) return jsonResponse(res, 503, { ok: false, error: '凭据服务不可用' })
    if (req.method === 'DELETE') {
      await service.unset?.(ref)
    } else {
      const value = typeof body?.value === 'string' ? body.value.trim() : ''
      if (value.length === 0) return jsonResponse(res, 400, { ok: false, error: 'API Key 不能为空' })
      if (value.length > 8192) return jsonResponse(res, 400, { ok: false, error: 'API Key 过长' })
      await service.set(ref, value)
    }
    return jsonResponse(res, 200, {
      ok: true,
      credentials: await credentialsSnapshot(ctx, cfg),
      health: await healthSnapshot(ctx, cfg),
    })
  } catch (error) {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
    return jsonResponse(res, status, { ok: false, error: errorMessage(error) })
  }
}

// API backend (OpenAI Images compatible)
// ---------------------------------------------------------------------------

function resolveFilePath(value) {
  if (!value) return value
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value)
}

async function fetchImageBytes(url, signal) {
  const response = await fetch(url, { redirect: 'error', signal })
  if (!response.ok) throw new Error(`下载生成图片失败（${response.status}）`)
  const buffer = await response.arrayBuffer()
  const data = new Uint8Array(buffer)
  const mediaType = detectMediaType(data) ?? IMAGE_TYPES.find((t) => (response.headers.get('content-type') ?? '').includes(t))
  if (!mediaType) throw new Error('图片下载返回了不支持的格式')
  return { data, mediaType }
}

async function apiGenerate(ctx, cfg, key, request, signal) {
  const backend = backendOf(cfg, key)
  if (!backend.baseURL) throw new Error(`${backendLabel(key)} 未配置 Base URL`)
  if (!isHttpUrl(backend.baseURL)) throw new Error(`${backendLabel(key)} 的 Base URL 非法`)
  if (!backend.model) throw new Error(`${backendLabel(key)} 未配置模型 id`)
  const ref = backend.apiKeyRef
  const apiKey = await credentialValue(ctx, ref)
  if (!apiKey) {
    throw new Error(`${backendLabel(key)} 的 API Key 缺失（凭据 ${ref} 未配置）。已停止发送未认证请求。`)
  }
  const base = trimSlash(backend.baseURL)
  const body = {
    model: backend.model,
    prompt: request.prompt,
    n: request.count,
    size: backend.size || '1024x1024',
  }
  if (backend.quality && backend.quality !== 'auto') body.quality = backend.quality
  // gpt-image-1 always returns b64 and rejects response_format.
  if (!/^gpt-image/i.test(backend.model)) body.response_format = 'b64_json'

  const timeout = combineSignals(signal, backend.timeoutMs)
  let response
  try {
    response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      redirect: 'error',
      signal: timeout,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    if (error?.name === 'TimeoutError') throw new Error(`${backendLabel(key)} 请求超时（${backend.timeoutMs}ms）`)
    throw new Error(`无法连接 ${backendLabel(key)}（${base}）：${errorMessage(error)}`)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${backendLabel(key)} 生成失败（${response.status}）：${redactSecrets(text, apiKey).slice(0, 800)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${backendLabel(key)} 返回了非 JSON 响应（${redactSecrets(text, apiKey).slice(0, 300)}）`)
  }
  const items = Array.isArray(payload?.data) ? payload.data : []
  if (items.length === 0) throw new Error(`${backendLabel(key)} 未返回图片数据`)
  const images = []
  for (const item of items) {
    try {
      if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
        const data = new Uint8Array(Buffer.from(item.b64_json, 'base64'))
        images.push({ data, mediaType: detectMediaType(data) ?? 'image/png' })
      } else if (typeof item?.url === 'string' && item.url.length > 0) {
        images.push(await fetchImageBytes(item.url, timeout))
      } else if (typeof item?.image === 'string' && item.image.length > 0) {
        const data = new Uint8Array(Buffer.from(item.image, 'base64'))
        images.push({ data, mediaType: detectMediaType(data) ?? 'image/png' })
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      throw error
    }
  }
  if (images.length === 0) throw new Error(`${backendLabel(key)} 返回的数据中没有可解码的图片`)
  return images.slice(0, request.count)
}

function redactSecrets(text, secret) {
  let out = String(text ?? '')
  if (secret) out = out.split(secret).join('[REDACTED]')
  return out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
}

async function apiEdit(ctx, cfg, key, request, signal) {
  const backend = backendOf(cfg, key)
  if (!isHttpUrl(backend.baseURL)) throw new Error(`${backendLabel(key)} 的 Base URL 非法`)
  if (!backend.model) throw new Error(`${backendLabel(key)} 未配置模型 id`)
  const ref = backend.apiKeyRef
  const apiKey = await credentialValue(ctx, ref)
  if (!apiKey) throw new Error(`${backendLabel(key)} 的 API Key 缺失（凭据 ${ref}），无法执行参考图编辑`)
  const base = trimSlash(backend.baseURL)
  const form = new FormData()
  form.append('model', backend.model)
  form.append('prompt', request.prompt)
  if (backend.size) form.append('size', backend.size)
  const images = request.references ?? []
  if (images.length === 0) throw new Error('参考图编辑缺少参考图')
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    const name = `reference-${index + 1}.${extensionOf(image.mediaType)}`
    form.append(images.length > 1 ? 'image[]' : 'image', new Blob([image.data], { type: image.mediaType }), name)
  }
  const timeout = combineSignals(signal, backend.timeoutMs)
  let response
  try {
    response = await fetch(`${base}/images/edits`, {
      method: 'POST',
      redirect: 'error',
      signal: timeout,
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      body: form,
    })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    if (error?.name === 'TimeoutError') throw new Error(`${backendLabel(key)} 参考图编辑超时`)
    throw new Error(`无法连接 ${backendLabel(key)} 的编辑端点：${errorMessage(error)}`)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${backendLabel(key)} 参考图编辑失败（${response.status}）：${redactSecrets(text, apiKey).slice(0, 800)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${backendLabel(key)} 参考图编辑返回了非 JSON 响应`)
  }
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined
  if (typeof item?.b64_json === 'string') {
    const data = new Uint8Array(Buffer.from(item.b64_json, 'base64'))
    return { data, mediaType: detectMediaType(data) ?? 'image/png' }
  }
  if (typeof item?.url === 'string') return await fetchImageBytes(item.url, timeout)
  throw new Error(`${backendLabel(key)} 参考图编辑未返回图片`)
}

// ---------------------------------------------------------------------------
// ComfyUI backend
// ---------------------------------------------------------------------------

function apiWorkflowNode(value) {
  return value && typeof value === 'object' && typeof value.class_type === 'string' && value.inputs && typeof value.inputs === 'object'
}

async function fetchComfyText(url, label, signal) {
  let response
  try {
    response = await fetch(url, { redirect: 'error', signal })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    const code = error?.cause?.code ?? ''
    if (code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message ?? '')) {
      throw new Error(`无法连接 ComfyUI（${url.origin}）：请先启动本地服务（comfyctl.ps1 -Action start）`)
    }
    throw new Error(`${label} 请求失败（${errorMessage(error)}）`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`${label} 失败（${response.status}）：${text.slice(0, 500)}`)
  return text
}

async function loadComfyWorkflow(backend, signal) {
  let parsed
  if (backend.workflowName) {
    const base = comfyBase(backend)
    const target = endpoint(base, `userdata/workflows%2F${encodeURIComponent(backend.workflowName)}`)
    const text = await fetchComfyText(target, '读取 ComfyUI 工作流', signal)
    if (text.length > MAX_WORKFLOW_BYTES) throw new Error('workflow 超过 5MB 上限')
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`ComfyUI 工作流 ${backend.workflowName} 不是合法 JSON`)
    }
  } else {
    const file = resolveFilePath(backend.workflowPath)
    if (!existsSync(file)) throw new Error(`workflow 文件不存在：${file}`)
    const buffer = await readFile(file)
    if (buffer.byteLength > MAX_WORKFLOW_BYTES) throw new Error('workflow 文件超过 5MB 上限')
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch {
      throw new Error('workflow 文件不是合法 JSON')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('workflow 必须是非空 API 格式 JSON 对象')
  }
  if (Array.isArray(parsed.nodes) || Array.isArray(parsed.links)) {
    throw new Error('检测到 UI 格式 workflow（包含 nodes/links）。请在 ComfyUI 菜单中选择「导出 API 格式」，保存 workflow_api.json 后重试。')
  }
  const entries = Object.entries(parsed)
  if (!entries.every(([, node]) => apiWorkflowNode(node))) {
    throw new Error('workflow 不是 API 格式：每个节点应包含 {class_type, inputs}。请导出 API 格式。')
  }
  return parsed
}

function findNodes(workflow, pattern) {
  return Object.entries(workflow).filter(([, node]) => pattern.test(node.class_type))
}

function containsPlaceholder(value, name) {
  if (typeof value === 'string') return value.includes(`{{${name}}}`) || value.includes(`%${name}%`)
  if (Array.isArray(value)) return value.some((item) => containsPlaceholder(item, name))
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsPlaceholder(item, name))
  return false
}

function replacePlaceholder(value, name, replacement) {
  if (typeof value === 'string') return value.split(`{{${name}}}`).join(replacement).split(`%${name}%`).join(replacement)
  if (Array.isArray(value)) return value.map((item) => replacePlaceholder(item, name, replacement))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replacePlaceholder(child, name, replacement)]))
  }
  return value
}

const PROMPT_FIELDS = ['text', 'prompt', 'positive']

function textInputKey(node, preferred) {
  if (!node?.inputs) return undefined
  if (typeof preferred === 'string' && preferred.length > 0 && typeof node.inputs[preferred] === 'string') return preferred
  for (const key of PROMPT_FIELDS) {
    if (typeof node.inputs[key] === 'string') return key
  }
  if (typeof node.inputs.value === 'string') return 'value'
  return undefined
}

function negativeTextInputKey(node) {
  if (!node?.inputs) return undefined
  if (typeof node.inputs.negative_prompt === 'string') return 'negative_prompt'
  return textInputKey(node)
}

function setNodeText(workflow, nodeId, value) {
  const node = workflow[nodeId]
  if (!node) throw new Error(`workflow 中不存在节点 ${nodeId}`)
  const key = textInputKey(node)
  if (!key) throw new Error(`节点 ${nodeId}（${node.class_type}）没有 text/prompt 输入，无法注入提示词`)
  node.inputs[key] = value
  return key
}

function setNodeNegative(workflow, nodeId, value, promptNodeId) {
  const node = workflow[nodeId]
  if (!node) throw new Error(`workflow 中不存在节点 ${nodeId}`)
  const key = negativeTextInputKey(node)
  if (!key) throw new Error(`节点 ${nodeId}（${node.class_type}）没有负向提示词输入`)
  if (key === 'text' && nodeId === promptNodeId) {
    throw new Error(`负向节点 ${nodeId} 与提示词节点相同，且该节点只有 text 输入，无法同时写入正负提示词`)
  }
  node.inputs[key] = value
  return key
}

function prepareWorkflow(backend, source, request) {
  const workflow = clone(source)
  const info = { promptNode: null, negativeNode: null, seedNode: null, latentNode: null, outputNode: backend.outputNodeId || null }
  const clipNodes = findNodes(workflow, /CLIPTextEncode|TextEncode/i)
  const samplers = findNodes(workflow, /KSampler/i)
  const latents = findNodes(workflow, /EmptyLatentImage|Empty.*Latent/i)
  const saves = findNodes(workflow, /SaveImage/i)

  const promptValue = request.prompt
  const negativeValue = [request.negative, SAFETY_NEGATIVE].filter(Boolean).join(', ')
  let promptInjected = false

  if (backend.promptNodeId) {
    setNodeText(workflow, backend.promptNodeId, promptValue)
    info.promptNode = backend.promptNodeId
    promptInjected = true
  } else if (containsPlaceholder(workflow, 'prompt')) {
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (!node.inputs) continue
      node.inputs = replacePlaceholder(node.inputs, 'prompt', promptValue)
      if (containsPlaceholder(node.inputs, 'prompt') === false) info.promptNode ??= nodeId
    }
    promptInjected = true
  } else if (clipNodes.length > 0) {
    const [nodeId, node] = clipNodes[0]
    const key = textInputKey(node)
    if (!key) throw new Error(`自动识别的提示词节点 ${nodeId} 没有 text/prompt 输入，请显式设置提示词节点 ID`)
    node.inputs[key] = promptValue
    info.promptNode = nodeId
    promptInjected = true
  }
  if (!promptInjected) {
    throw new Error('workflow 中找不到提示词节点：请选择模型/工作流，或设置「提示词节点 ID」，或在 workflow 的文本输入中写入 {{prompt}} 占位符')
  }

  if (negativeValue) {
    if (backend.negativeNodeId) {
      const key = setNodeNegative(workflow, backend.negativeNodeId, negativeValue, info.promptNode)
      info.negativeNode = backend.negativeNodeId
      if (key === 'text' && backend.negativeNodeId === info.promptNode) info.negativeNode = null
    } else if (containsPlaceholder(workflow, 'negative')) {
      for (const node of Object.values(workflow)) {
        if (node.inputs) node.inputs = replacePlaceholder(node.inputs, 'negative', negativeValue)
      }
    } else {
      const sameNode = info.promptNode ? workflow[info.promptNode] : undefined
      if (sameNode?.inputs && typeof sameNode.inputs.negative_prompt === 'string') {
        sameNode.inputs.negative_prompt = negativeValue
        info.negativeNode = info.promptNode
      } else {
        const candidate = clipNodes.find(([nodeId]) => nodeId !== info.promptNode && negativeTextInputKey(workflow[nodeId]))
        if (candidate) {
          const [nodeId, node] = candidate
          node.inputs[negativeTextInputKey(node)] = negativeValue
          info.negativeNode = nodeId
        }
      }
    }
  }

  const seed = randomInt(0, 4294967295)
  if (backend.seedNodeId) {
    const node = workflow[backend.seedNodeId]
    if (!node?.inputs) throw new Error(`workflow 中不存在 seed 节点 ${backend.seedNodeId}`)
    node.inputs.seed = seed
    info.seedNode = backend.seedNodeId
  } else if (containsPlaceholder(workflow, 'seed')) {
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (!node.inputs) continue
      node.inputs = replacePlaceholder(node.inputs, 'seed', seed)
      info.seedNode ??= nodeId
    }
  } else if (samplers.length > 0) {
    const [nodeId, node] = samplers[0]
    if ('seed' in node.inputs) {
      node.inputs.seed = seed
      info.seedNode = nodeId
    } else if ('noise_seed' in node.inputs) {
      node.inputs.noise_seed = seed
      info.seedNode = nodeId
    }
  }

  if (request.width && request.height && latents.length > 0) {
    const [nodeId, node] = latents[0]
    if (backend.widthNodeId) {
      const target = workflow[backend.widthNodeId]
      if (target?.inputs) target.inputs.width = request.width
    } else {
      node.inputs.width = request.width
      info.latentNode = nodeId
    }
    if (backend.heightNodeId) {
      const target = workflow[backend.heightNodeId]
      if (target?.inputs) target.inputs.height = request.height
    } else {
      node.inputs.height = request.height
    }
  } else {
    if (backend.widthNodeId && request.width) {
      const target = workflow[backend.widthNodeId]
      if (target?.inputs) target.inputs.width = request.width
    }
    if (backend.heightNodeId && request.height) {
      const target = workflow[backend.heightNodeId]
      if (target?.inputs) target.inputs.height = request.height
    }
  }

  if (request.imageName) {
    let injected = false
    for (const node of Object.values(workflow)) {
      if (!node.inputs) continue
      if (node.inputs.image === '{{image}}' || node.inputs.image === '%image%') {
        node.inputs.image = request.imageName
        injected = true
      }
    }
    if (!injected) throw new Error('workflow 未声明 {{image}} 输入，无法执行 ComfyUI 参考图编辑')
  }

  if (info.outputNode && !workflow[info.outputNode]) {
    throw new Error(`workflow 中不存在输出节点 ${info.outputNode}`)
  }
  if (saves.length === 0 && !info.outputNode) {
    throw new Error('workflow 中找不到 SaveImage 输出节点，请设置输出节点 ID')
  }
  return { workflow, info }
}

function detectComfyWorkflow(workflow) {
  const entries = Object.entries(workflow)
  const clipNodes = entries.filter(([, node]) => /CLIPTextEncode|TextEncode/i.test(node.class_type))
  const samplers = entries.filter(([, node]) => /KSampler/i.test(node.class_type))
  const latents = entries.filter(([, node]) => /EmptyLatentImage|Empty.*Latent/i.test(node.class_type))
  const saves = entries.filter(([, node]) => /SaveImage|PreviewImage/i.test(node.class_type))
  const modelNode = entries.find(([, node]) => /CheckpointLoaderSimple|UNETLoader|DiffusionModelLoader/i.test(node.class_type))
  const modelName = modelNode?.[1]?.inputs?.ckpt_name ?? modelNode?.[1]?.inputs?.unet_name ?? ''

  let promptNodeId
  let promptField
  const placeholder = clipNodes.find(([, node]) => containsPlaceholder(node.inputs, 'prompt'))
  if (placeholder) {
    promptNodeId = placeholder[0]
    promptField = textInputKey(placeholder[1])
  } else {
    const candidate = clipNodes.find(([, node]) => textInputKey(node))
    if (candidate) {
      promptNodeId = candidate[0]
      promptField = textInputKey(candidate[1])
    }
  }

  let negativeNodeId
  let negativeField
  const negativePlaceholder = clipNodes.find(([, node]) => containsPlaceholder(node.inputs, 'negative'))
  if (negativePlaceholder) {
    negativeNodeId = negativePlaceholder[0]
    negativeField = negativeTextInputKey(negativePlaceholder[1])
  } else if (promptNodeId && typeof workflow[promptNodeId].inputs.negative_prompt === 'string') {
    negativeNodeId = promptNodeId
    negativeField = 'negative_prompt'
  } else {
    const candidate = clipNodes.find(([nodeId, node]) => nodeId !== promptNodeId && negativeTextInputKey(node))
    if (candidate) {
      negativeNodeId = candidate[0]
      negativeField = negativeTextInputKey(candidate[1])
    }
  }

  const sampler = samplers.find(([, node]) => node.inputs && ('seed' in node.inputs || 'noise_seed' in node.inputs))
  const latent = latents.find(([, node]) => node.inputs && 'width' in node.inputs && 'height' in node.inputs)
  const save = saves[0]
  return {
    model: String(modelName),
    promptNodeId: promptNodeId ?? '',
    promptField: promptField ?? '',
    negativeNodeId: negativeNodeId ?? '',
    negativeField: negativeField ?? '',
    seedNodeId: sampler?.[0] ?? '',
    seedField: sampler && 'seed' in sampler[1].inputs ? 'seed' : sampler && 'noise_seed' in sampler[1].inputs ? 'noise_seed' : '',
    widthNodeId: latent?.[0] ?? '',
    heightNodeId: latent?.[0] ?? '',
    outputNodeId: save?.[0] ?? '',
  }
}

async function listComfyWorkflows(comfyURL) {
  if (!isHttpUrl(comfyURL)) throw new Error('ComfyUI 地址必须是 http(s) URL')
  const base = comfyBase({ comfyURL })
  const listUrl = endpoint(base, 'userdata?dir=workflows&recurse=true')
  const text = await fetchComfyText(listUrl, '读取 ComfyUI 工作流列表')
  let names
  try {
    names = JSON.parse(text)
  } catch {
    throw new Error('ComfyUI 工作流列表不是合法 JSON')
  }
  if (!Array.isArray(names)) throw new Error('ComfyUI 工作流列表格式异常')
  const workflows = []
  for (const name of names.filter((item) => typeof item === 'string' && /\.json$/i.test(item)).slice(0, 24)) {
    try {
      const textContent = await fetchComfyText(endpoint(base, `userdata/workflows%2F${encodeURIComponent(name)}`), `读取工作流 ${name}`)
      const parsed = JSON.parse(textContent)
      if (Array.isArray(parsed?.nodes) || Array.isArray(parsed?.links)) {
        workflows.push({ name, valid: false, reason: 'UI 格式（请先在 ComfyUI 中导出 API 格式）' })
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0 || !Object.values(parsed).every(apiWorkflowNode)) {
        workflows.push({ name, valid: false, reason: '不是 API 格式 workflow' })
        continue
      }
      const mapping = detectComfyWorkflow(parsed)
      workflows.push({
        name,
        label: name.replace(/\.json$/i, ''),
        valid: true,
        model: mapping.model,
        mapping: {
          promptNodeId: mapping.promptNodeId,
          negativeNodeId: mapping.negativeNodeId,
          seedNodeId: mapping.seedNodeId,
          widthNodeId: mapping.widthNodeId,
          heightNodeId: mapping.heightNodeId,
          outputNodeId: mapping.outputNodeId,
        },
      })
    } catch (error) {
      workflows.push({ name, valid: false, reason: errorMessage(error) })
    }
  }
  return workflows
}

function comfyBase(backend) {
  if (!backend.comfyURL) throw new Error('ComfyUI 地址为空')
  if (!isHttpUrl(backend.comfyURL)) throw new Error('ComfyUI 地址必须是 http(s) URL')
  return new URL(backend.comfyURL.endsWith('/') ? backend.comfyURL : `${backend.comfyURL}/`)
}

function endpoint(base, pathname) {
  return new URL(pathname, base)
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

async function comfyPing(comfyURL, timeoutMs = 1500) {
  try {
    const base = comfyBase({ comfyURL })
    const response = await fetch(endpoint(base, 'system_stats'), { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

let comfyStartPromise = null

async function startLocalComfy(comfyURL, signal) {
  if (!isLoopbackUrl(comfyURL)) throw new Error('只能自动启动本机 ComfyUI（127.0.0.1 / localhost）')
  if (await comfyPing(comfyURL)) return { started: false }
  if (comfyStartPromise) return comfyStartPromise
  const script = process.env.DSH_COMFY_START_SCRIPT || DEFAULT_COMFY_START_SCRIPT
  if (!existsSync(script)) throw new Error(`未找到 ComfyUI 启动脚本：${script}（可用环境变量 DSH_COMFY_START_SCRIPT 指定）`)
  comfyStartPromise = (async () => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'start'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => {})
    } catch (error) {
      throw new Error(`无法执行启动脚本：${errorMessage(error)}`)
    }
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError(signal)
      if (await comfyPing(comfyURL, 2000)) return { started: true }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    throw new Error('ComfyUI 启动超时（120s），请查看 D:\\ComfyUI\\logs\\comfyui.log')
  })().finally(() => {
    comfyStartPromise = null
  })
  return comfyStartPromise
}

function comfyConnectionError(error) {
  const text = errorMessage(error)
  return /无法连接 ComfyUI|请求失败|fetch failed|ECONNREFUSED|请求超时/i.test(text)
}

async function comfyFetchJson(url, options, label, signal) {
  let response
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal })
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    if (error?.name === 'TimeoutError') throw new Error(`${label} 请求超时`)
    const code = error?.cause?.code ?? ''
    if (code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message ?? '')) {
      throw new Error(`无法连接 ComfyUI（${url.origin}）：请先启动本地服务（comfyctl.ps1 -Action start）`)
    }
    throw new Error(`${label} 请求失败（${errorMessage(error)}）`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`${label} 失败（${response.status}）：${text.slice(0, 800)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 返回了非 JSON 响应`)
  }
}

async function comfyUpload(base, image, signal) {
  const form = new FormData()
  form.append('image', new Blob([image.data], { type: image.mediaType }), `super-image-${Date.now()}.${extensionOf(image.mediaType)}`)
  const response = await fetch(endpoint(base, 'upload/image'), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { accept: 'application/json' },
    body: form,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`ComfyUI 上传参考图失败（${response.status}）：${text.slice(0, 400)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('ComfyUI /upload/image 返回了非 JSON')
  }
  if (typeof payload?.name !== 'string' || payload.name.length === 0) throw new Error('ComfyUI /upload/image 未返回文件名')
  const subfolder = typeof payload?.subfolder === 'string' ? payload.subfolder : ''
  return subfolder.length > 0 ? `${subfolder}/${payload.name}` : payload.name
}

function firstOutputImage(outputs) {
  if (!outputs || typeof outputs !== 'object') return undefined
  for (const nodeOutput of Object.values(outputs)) {
    const images = nodeOutput?.images
    if (!Array.isArray(images)) continue
    for (const image of images) {
      if (!image || typeof image.filename !== 'string' || image.filename.length === 0) continue
      const item = {
        filename: image.filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type: typeof image.type === 'string' ? image.type : 'output',
      }
      if (item.type === 'output') return item
    }
  }
  return undefined
}

async function comfyGenerate(ctx, cfg, key, request, signal) {
  const backend = backendOf(cfg, key)
  if (isLoopbackUrl(backend.comfyURL) && !(await comfyPing(backend.comfyURL))) {
    try {
      await startLocalComfy(backend.comfyURL, signal)
    } catch (error) {
      throw new Error(`ComfyUI 未启动，自动启动失败：${errorMessage(error)}`)
    }
  }
  const base = comfyBase(backend)
  const source = await loadComfyWorkflow(backend, signal)
  const prepared = prepareWorkflow(backend, source, request)
  const overall = combineSignals(signal, backend.timeoutMs)
  let imageName = request.imageName
  if (request.reference) imageName = await comfyUpload(base, request.reference, overall)
  if (imageName) {
    const withImage = prepareWorkflow(backend, source, { ...request, imageName })
    prepared.workflow = withImage.workflow
  }
  const submitted = await comfyFetchJson(
    endpoint(base, 'prompt'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ prompt: prepared.workflow }),
      signal: overall,
    },
    'ComfyUI /prompt',
    overall,
  )
  const promptId = submitted?.prompt_id
  if (typeof promptId !== 'string' || promptId.length === 0) throw new Error('ComfyUI /prompt 未返回 prompt_id')

  const deadline = Date.now() + backend.timeoutMs
  let entry
  while (Date.now() < deadline) {
    await sleep(Math.min(backend.pollMs, Math.max(0, deadline - Date.now())), overall)
    const history = await comfyFetchJson(
      endpoint(base, `history/${encodeURIComponent(promptId)}`),
      { headers: { accept: 'application/json' }, signal: overall },
      'ComfyUI /history',
      overall,
    )
    const candidate = history?.[promptId]
    if (!candidate) continue
    const status = candidate.status
    if (status?.status_str === 'error') {
      throw new Error(`ComfyUI 工作流执行失败：${JSON.stringify(status.messages ?? status).slice(0, 800)}`)
    }
    const output = firstOutputImage(candidate.outputs)
    if (output) {
      entry = { output, promptId }
      break
    }
    if (status?.completed === true) throw new Error('ComfyUI 工作流已完成但没有输出图片')
  }
  if (!entry) throw new Error(`ComfyUI 生成超时（${Math.round(backend.timeoutMs / 1000)}s）`)

  const view = endpoint(base, 'view')
  view.searchParams.set('filename', entry.output.filename)
  view.searchParams.set('subfolder', entry.output.subfolder)
  view.searchParams.set('type', entry.output.type)
  const image = await fetchImageBytes(view.toString(), overall)
  return { ...image, promptId: entry.promptId }
}

async function generateOnBackend(ctx, cfg, key, request, signal) {
  const backend = backendOf(cfg, key)
  const count = Math.max(1, request.count)
  if (backend.type === 'api') {
    const images = await apiGenerate(ctx, cfg, key, { ...request, count }, signal)
    return images.map((image, index) => ({ ...image, backend: key, index: index + 1 }))
  }
  const images = []
  for (let index = 0; index < count; index += 1) {
    const image = await comfyGenerate(ctx, cfg, key, request, signal)
    images.push({ ...image, backend: key, index: index + 1 })
  }
  return images
}

// ---------------------------------------------------------------------------
// LLM route discovery + rubric/verify
// ---------------------------------------------------------------------------

function llmService(ctx) {
  try {
    return ctx.get('llm')
  } catch {
    return undefined
  }
}

function providerId(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.id ?? value.name ?? value.provider
  return undefined
}

function modelId(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.id ?? value.model ?? value.name
  return undefined
}

function modelSupportsImage(model) {
  const modalities = model?.inputModalities ?? model?.modalities
  return Array.isArray(modalities) && modalities.includes('image')
}

async function discoverRoute(ctx, cfg, needsImage) {
  const llm = llmService(ctx)
  if (!llm?.stream) return undefined
  const preferred = (id) => /openai|azure|google|gemini|anthropic|claude|openrouter/i.test(id)
  if (cfg.vlmProvider && cfg.vlmModel) {
    if (needsImage) {
      try {
        const info = await llm.resolveModelInfo?.(cfg.vlmProvider, cfg.vlmModel)
        if (info?.inputModalities && !info.inputModalities.includes('image')) {
          return undefined
        }
      } catch {
        // Explicit user configuration wins: a provider may not expose model
        // discovery but still accept image input. The verification call itself
        // will surface a hard failure, so keep the explicit route.
      }
    }
    return { provider: cfg.vlmProvider, model: cfg.vlmModel }
  }
  if (cfg.vlmProvider) {
    try {
      const models = await llm.listModels?.(cfg.vlmProvider)
      if (Array.isArray(models)) {
        for (const model of models) {
          const id = modelId(model)
          if (!id) continue
          if (!needsImage || modelSupportsImage(model)) return { provider: cfg.vlmProvider, model: id }
        }
      }
    } catch {}
  }
  let providers = []
  try {
    providers = (await llm.listProviders?.()) ?? []
  } catch {
    return undefined
  }
  const ids = providers.map(providerId).filter(Boolean)
  ids.sort((left, right) => Number(preferred(right)) - Number(preferred(left)))
  for (const id of ids) {
    try {
      const models = await llm.listModels?.(id)
      if (!Array.isArray(models)) continue
      for (const model of models) {
        if (needsImage && !modelSupportsImage(model)) continue
        const mid = modelId(model)
        if (mid) return { provider: id, model: mid }
      }
    } catch {}
  }
  return undefined
}

async function llmText(ctx, route, request, signal) {
  const llm = llmService(ctx)
  if (!llm?.stream || !route) return undefined
  const limit = combineSignals(signal, 120000)
  const content = [{ type: 'text', text: request.user }]
  for (const attachment of request.images ?? []) content.push({ type: 'image', attachment })
  let text = ''
  let finish = null
  const blocks = []
  const stats = { textDeltas: 0, reasoningChars: 0, blockEnds: 0, otherTypes: [] }
  const options = {
    provider: route.provider,
    model: route.model,
    system: request.system,
    messages: [{ role: 'user', content }],
    temperature: request.temperature ?? 0.2,
    maxTokens: request.maxTokens ?? 3000,
    signal: limit,
    purpose: 'super-image',
  }
  if (request.reasoningEffort) options.reasoningEffort = request.reasoningEffort
  const stream = llm.stream(options)
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') { text += chunk.text ?? ''; stats.textDeltas += 1 }
    else if (chunk?.type === 'reasoning-delta') { stats.reasoningChars += (chunk.text ?? '').length }
    else if (chunk?.type === 'block-end') {
      stats.blockEnds += 1
      if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
    } else if (chunk?.type === 'finish') { finish = chunk.reason ?? chunk; break }
    else if (chunk?.type) { if (!stats.otherTypes.includes(chunk.type)) stats.otherTypes.push(chunk.type) }
  }
  if (text.trim().length === 0 && blocks.length > 0) text = blocks.join('')
  return text.trim().length > 0 ? text : undefined
}

async function extractRubric(ctx, cfg, prompt, signal) {
  const route = await discoverRoute(ctx, cfg, false)
  if (route) {
    try {
      const request = buildRubricRequest(prompt)
      const text = await llmText(ctx, route, { system: request.system, user: request.user, maxTokens: 16000 }, signal)
      if (text) {
        const rubric = parseRubric(text)
        if (Array.isArray(rubric.items) && rubric.items.length > 0) {
          return { rubric, source: 'model' }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
    }
  }
  return { rubric: buildRubricFallback(prompt), source: 'heuristic' }
}
function heuristicVerify(rubric, images, reason) {
  const perImage = images.map((image) => ({
    label: image.label,
    strengths: [],
    unmet: [],
    weak: [],
    overall: 0,
    needsHuman: true,
  }))
  const table = (rubric.items ?? []).map((item) => ({
    itemId: item.id,
    requirement: item.requirement,
    marks: Object.fromEntries(images.map((image) => [image.label, item.checkable === 'programmatic' ? 'unknown' : 'unknown'])),
  }))
  const why = reason ? `（${reason}）` : ''
  return {
    mode: 'heuristic',
    reason: reason || '',
    perImage,
    table,
    needsHuman: (rubric.items ?? []).map((item) => item.id),
    note: `未找到可用的视觉理解模型${why}，未做视觉打分；以下表格中的维度均需人工确认。`,
  }
}

async function verifyImages(ctx, cfg, rubric, images, signal) {
  const route = await discoverRoute(ctx, cfg, true)
  if (!route) return heuristicVerify(rubric, images, '未发现可用的视觉模型')
  const labels = images.map((image) => image.label)
  try {
    const request = buildVerifyRequest({ rubric, labels })
    const contentImages = images.map((image) => image.attachment)
    const text = await llmText(
      ctx,
      route,
      { system: request.system, user: request.user, images: contentImages, maxTokens: 16000, temperature: 0 },
      signal,
    )
    if (!text) return heuristicVerify(rubric, images, '视觉模型未返回文本')
    const parsed = parseVerify(text, labels)
    if (!parsed || !Array.isArray(parsed.perImage)) return heuristicVerify(rubric, images, '视觉模型返回内容无法解析')
    const scored = parsed.perImage.filter((entry) => entry.overall > 0 || entry.strengths.length > 0 || entry.unmet.length > 0)
    if (scored.length === 0) return heuristicVerify(rubric, images, '视觉模型未给出有效评分')
    return {
      mode: 'vlm',
      provider: route.provider,
      model: route.model,
      perImage: parsed.perImage,
      table: parsed.table,
      needsHuman: parsed.needsHuman ?? [],
      note: `已用视觉模型 ${route.provider}/${route.model} 按需求清单逐项校验。`,
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal)
    return { ...heuristicVerify(rubric, images, `视觉校验失败：${errorMessage(error)}`) }
  }
}

// ---------------------------------------------------------------------------
// workspace files
// ---------------------------------------------------------------------------

function workspaceRoot(ctx, exec) {
  const direct = exec?.agent?.session?.header?.cwd
  if (typeof direct === 'string' && direct.length > 0) return direct
  try {
    const wd = ctx.get('workingDirectory')
    if (wd?.get) {
      const value = wd.get(exec?.agent?.session ?? exec?.agent)
      if (typeof value === 'string' && value.length > 0) return value
    }
    if (typeof wd?.defaultDirectory === 'string') return wd.defaultDirectory
  } catch {}
  return process.cwd()
}

async function saveGenerated(ctx, exec, image, label) {
  const mediaType = IMAGE_TYPES.includes(image.mediaType) ? image.mediaType : detectMediaType(image.data) ?? 'image/png'
  const name = `${label}.${extensionOf(mediaType)}`
  let attachment
  let attachmentError
  try {
    attachment = await ctx.attachments.saveImage({ data: image.data, mediaType, name })
  } catch (error) {
    // Keep the real workspace file even when the attachment service is unavailable
    // (for example while a plugin fiber is being reloaded); the tool then returns
    // text plus the file path instead of failing the whole run.
    attachmentError = errorMessage(error)
  }
  const root = workspaceRoot(ctx, exec)
  const dir = path.join(root, FOLDER)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${stamp()}-${name}`)
  await writeFile(file, image.data)
  return { label, path: file, attachment, attachmentError, mediaType, bytes: image.data.byteLength, sha256: sha256(image.data) }
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

function parseSize(size) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(size ?? ''))
  if (!match) return {}
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {}
  return { width, height }
}

async function runBackend(ctx, cfg, key, request, signal) {
  return await generateOnBackend(ctx, cfg, key, request, signal)
}

function selectVlmRouteLabel(verification) {
  if (verification?.mode === 'vlm') return `${verification.provider}/${verification.model}`
  const reason = typeof verification?.reason === 'string' ? verification.reason.trim() : ''
  return reason ? `启发式（无 VLM：${reason.slice(0, 80)}）` : '启发式（无 VLM）'
}

function requirementById(rubric) {
  const map = new Map()
  for (const item of rubric.items ?? []) map.set(item.id, item)
  return map
}

function mergeScore(verification, label) {
  return verification?.perImage?.find((entry) => entry.label === label)?.overall ?? 0
}

function rubricName(itemMap, id) {
  const item = itemMap.get(id)
  const text = String(item?.requirement || id)
  return text.length > 28 ? `${text.slice(0, 27)}…` : text
}

async function noteForFinal(ctx, cfg, rubric, saved, base, verification, signal) {
  if (verification?.mode === 'vlm') {
    try {
      const finalCheck = await verifyImages(ctx, cfg, rubric, [{ label: saved.label, attachment: saved.attachment }], signal)
      const entry = finalCheck?.perImage?.find((item) => item.label === saved.label)
      const judged = entry && (entry.overall > 0 || (entry.strengths?.length ?? 0) > 0 || (entry.unmet?.length ?? 0) > 0)
      if (finalCheck?.mode === 'vlm' && judged) {
        const itemMap = requirementById(rubric)
        const baseEntry = base ? verification?.perImage?.find((item) => item.label === base.label) : undefined
        const finalUnmet = (entry.unmet ?? []).map((item) => item.itemId)
        const finalWeak = (entry.weak ?? []).map((item) => item.itemId)
        const baseUnmet = [...(baseEntry?.unmet ?? []), ...(baseEntry?.weak ?? [])].map((item) => item.itemId)
        const solved = [...new Set(baseUnmet)].filter((id) => !finalUnmet.includes(id) && !finalWeak.includes(id))
        const still = [...new Set([...finalUnmet, ...finalWeak])]
        const strengths = entry.strengths?.length ?? 0
        const sentences = [`最终图（${saved.label}）以 ${base ? base.label : '择优图'} 为 base 融合生成，保留 ${strengths} 项已复核强项`]
        if (solved.length) sentences.push(`视觉复核显示补足了 ${solved.length} 项原图未满足/弱项：${solved.map((id) => rubricName(itemMap, id)).join('、')}`)
        if (still.length) sentences.push(`最终图仍有 ${still.length} 项未满足/弱项：${still.map((id) => rubricName(itemMap, id)).join('、')}`)
        else if (!solved.length) sentences.push('最终图未确认补足原图的具体未满足项')
        return {
          note: `${sentences.join('；')}。说明来自最终图单独视觉复核，请以图片内容为准。`,
          verification: finalCheck,
        }
      }
    } catch {}
  }
  return {
    note: `最终图（${saved.label}）由择优 base 融合生成；比对表反映双后端原图的逐项结果，最终图未单独自动校验，请结合原图人工复核。`,
    verification: undefined,
  }
}

async function fuse(ctx, cfg, exec, input, images, verification, degraded, signal) {
  const fusionMode = input.fusionMode ?? cfg.fusionMode
  const enabled = input.enableFusion ?? cfg.enableFusion
  if (!enabled) {
    return {
      enabled: false,
      mode: fusionMode,
      used: 'side-by-side',
      note: '融合已关闭：已并排返回双后端原图与需求比对表，未生成第三张图。',
    }
  }
  if (images.length < 2) {
    return {
      enabled: true,
      mode: fusionMode,
      used: 'side-by-side',
      note: '可用原图不足两张（有后端降级），已直接返回现有结果，未生成融合图。',
    }
  }
  if (verification?.mode !== 'vlm') {
    return {
      enabled: true,
      mode: fusionMode,
      used: 'side-by-side',
      note: '视觉校验不可用，无法可靠地择优与融合；已并排返回双后端原图与比对表，未生成第三张图。请人工选择，或配置可用的视觉模型后重试。',
    }
  }
  const sorted = [...images].sort((left, right) => mergeScore(verification, right.label) - mergeScore(verification, left.label))
  const base = sorted[0]
  const others = sorted.slice(1)
  const rubricMap = requirementById(input.rubric)
  const fusionPrompt = buildFusionPrompt({
    rubric: input.rubric,
    base: { label: base.label, provider: base.backend },
    others: others.map((image) => ({ label: image.label, provider: image.backend })),
    verify: verification,
  })

  const preferredKey = base.backend === 'a' ? 'a' : 'b'
  const fallbackKey = preferredKey === 'a' ? 'b' : 'a'

  if (fusionMode === 'reference-edit') {
    for (const key of [preferredKey, fallbackKey]) {
      const backend = backendOf(cfg, key)
      if (backend.type !== 'api') continue
      try {
        const edited = await apiEdit(
          ctx,
          cfg,
          key,
          { prompt: fusionPrompt, references: [{ data: base.data, mediaType: base.mediaType }, ...others.slice(0, 1).map((image) => ({ data: image.data, mediaType: image.mediaType }))] },
          signal,
        )
        const saved = await saveGenerated(ctx, exec, edited, `${base.label}-fused`)
        const judged = await noteForFinal(ctx, cfg, input.rubric, saved, base, verification, signal)
        const note = judged.note
        const identical = saved.sha256 === base.sha256
        return {
          enabled: true,
          mode: fusionMode,
          used: 'reference-edit',
          backend: key,
          final: saved,
          note: identical ? `${note}（注意：编辑后端返回的图片与 base 字节一致，可能未按指令修改）` : note,
          verification: judged.verification,
          identicalToBase: identical,
          prompt: fusionPrompt,
        }
      } catch (error) {
        if (signal?.aborted) throw abortError(signal)
        degraded.push({ backend: backendLabel(key), reason: `参考图编辑失败（${errorMessage(error)}）` })
      }
    }
  }

  const synthesisKey = [preferredKey, fallbackKey].find((key) => images.some((image) => image.backend === key))
  if (fusionMode === 'reference-edit' || fusionMode === 'prompt-synthesis') {
    if (synthesisKey) {
      try {
        const backend = backendOf(cfg, synthesisKey)
        const generated = await generateOnBackend(
          ctx,
          cfg,
          synthesisKey,
          {
            prompt: fusionPrompt,
            negative: (input.rubric.negative ?? []).join(', '),
            count: 1,
            width: parseSize(backend.size).width,
            height: parseSize(backend.size).height,
          },
          signal,
        )
        const saved = await saveGenerated(ctx, exec, generated[0], `${base.label}-synthesized`)
        const judged = await noteForFinal(ctx, cfg, input.rubric, saved, base, verification, signal)
        return {
          enabled: true,
          mode: fusionMode,
          used: 'prompt-synthesis',
          backend: synthesisKey,
          final: saved,
          note: judged.note,
          verification: judged.verification,
          prompt: fusionPrompt,
        }
      } catch (error) {
        if (signal?.aborted) throw abortError(signal)
        degraded.push({ backend: backendLabel(synthesisKey), reason: `融合重生成失败：${errorMessage(error)}` })
      }
    }
  }

  return {
    enabled: true,
    mode: fusionMode,
    used: 'side-by-side',
    note: '两个后端都无法承接融合编辑，已并排返回原图与需求比对表，请人工选择或指定以哪张的哪个维度为主。',
    preferredBase: base.label,
  }
}

function buildTableMarkdown(rubric, verification) {
  const labels = verification?.perImage?.map((entry) => entry.label) ?? []
  if (labels.length === 0 || !verification?.table) return ''
  const marks = { pass: '✅', fail: '❌', weak: '⚠️', unknown: '❓' }
  const map = requirementById(rubric)
  const lines = [`| 需求 | ${labels.join(' | ')} |`, `| --- | ${labels.map(() => '---').join(' | ')} |`]
  for (const row of verification.table) {
    const text = (map.get(row.itemId)?.requirement ?? row.requirement ?? row.itemId).replace(/\|/g, '\\|')
    const cells = labels.map((label) => marks[row.marks?.[label]] ?? '❓')
    lines.push(`| ${text} | ${cells.join(' | ')} |`)
  }
  lines.push('', '| 图片 | 强项 | 未满足 / 弱项 |', '| --- | --- | --- |')
  for (const entry of verification.perImage ?? []) {
    const strengths = (entry.strengths ?? []).map((item) => item.note || item.itemId).filter(Boolean)
    const gaps = [...(entry.unmet ?? []), ...(entry.weak ?? [])]
      .map((item) => item.note || item.itemId)
      .filter(Boolean)
    lines.push(
      `| ${entry.label} | ${strengths.length > 0 ? strengths.slice(0, 3).join('、') : '无'} | ${gaps.length > 0 ? gaps.slice(0, 3).join('、') : '无'} |`,
    )
  }
  return lines.join('\n')
}

function strengthSummary(verification, label) {
  const entry = verification?.perImage?.find((item) => item.label === label)
  if (!entry) return '无'
  const names = entry.strengths.slice(0, 3).map((item) => item.note || item.itemId)
  return names.length > 0 ? names.join('、') : '无'
}

function unmetSummary(verification, label) {
  const entry = verification?.perImage?.find((item) => item.label === label)
  if (!entry) return '无'
  const names = entry.unmet.slice(0, 3).map((item) => item.note || item.itemId)
  return names.length > 0 ? names.join('、') : '无'
}

// JSON-safe projection for the tool return value: the host validates that a tool
// result is lossless JSON, which rejects explicit undefined fields and
// non-finite numbers (NaN/Infinity). Drop undefined, coerce non-finite to null.
function jsonSafe(value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return undefined
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const safe = jsonSafe(item)
      if (safe !== undefined) out.push(safe)
    }
    return out
  }
  if (type === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return undefined
}

async function runPipeline(ctx, exec, input) {
  const cfg = await liveConfig(ctx, input.pluginConfig)
  const prompt = String(input.prompt ?? '').trim()
  if (prompt.length === 0) throw new Error('绘图需求为空：请提供要画的内容')
  const signal = input.signal ?? exec?.signal
  const count = Math.min(4, Math.max(1, Math.round(asNumber(input.count ?? cfg.perBackendCount, 1))))
  const rubricResult = await extractRubric(ctx, cfg, prompt, signal)

  const degraded = []
  const requestFor = (key) => {
    const size = parseSize(backendOf(cfg, key).size)
    return { prompt, negative: (rubricResult.rubric.negative ?? []).join(', '), count, width: size.width, height: size.height }
  }
  const settled = await Promise.allSettled([
    runBackend(ctx, cfg, 'a', requestFor('a'), signal),
    runBackend(ctx, cfg, 'b', requestFor('b'), signal),
  ])

  const raw = { a: [], b: [] }
  settled.forEach((result, index) => {
    const key = index === 0 ? 'a' : 'b'
    if (result.status === 'fulfilled') raw[key] = result.value
    else {
      const reason = errorMessage(result.reason)
      degraded.push({ backend: backendLabel(key), reason })
    }
  })
  if (raw.a.length === 0 && raw.b.length === 0) {
    throw new Error(`两个画图后端均未生成图片（${degraded.map((entry) => `${entry.backend}: ${entry.reason}`).join('；')}）`)
  }

  const images = []
  for (const key of ['a', 'b']) {
    for (let index = 0; index < raw[key].length; index += 1) {
      const image = raw[key][index]
      const label = `${key.toUpperCase()}${index + 1}`
      const saved = await saveGenerated(ctx, exec, image, label)
      images.push({ ...saved, backend: key, data: image.data })
    }
  }

  const verification = cfg.enableVerify
    ? await verifyImages(ctx, cfg, rubricResult.rubric, images, signal)
    : { mode: 'off', perImage: [], table: [], needsHuman: [], note: '需求校验已关闭。' }

  const fusion = await fuse(
    ctx,
    cfg,
    exec,
    {
      rubric: rubricResult.rubric,
      ...input,
      fusionMode: input.fusionMode ?? cfg.fusionMode,
      enableFusion: input.enableFusion ?? cfg.enableFusion,
    },
    images,
    verification,
    degraded,
    signal,
  )

  const publicImages = images.map((image) => ({
    label: image.label,
    path: image.path,
    attachment: image.attachment,
    bytes: image.bytes,
    backend: image.backend,
    score: mergeScore(verification, image.label),
    strengths: strengthSummary(verification, image.label),
    unmet: unmetSummary(verification, image.label),
  }))

  return jsonSafe({
    prompt,
    rubric: rubricResult.rubric,
    rubricSource: rubricResult.source,
    count,
    perBackendCount: count,
    backends: {
      a: {
        type: backendOf(cfg, 'a').type,
        model: backendOf(cfg, 'a').type === 'api' ? backendOf(cfg, 'a').model : 'comfyui',
        status: raw.a.length > 0 ? 'ok' : 'error',
        images: publicImages.filter((image) => image.backend === 'a'),
        error: degraded.find((entry) => entry.backend === '后端 A')?.reason,
      },
      b: {
        type: backendOf(cfg, 'b').type,
        model: backendOf(cfg, 'b').type === 'api' ? backendOf(cfg, 'b').model : 'comfyui',
        status: raw.b.length > 0 ? 'ok' : 'error',
        images: publicImages.filter((image) => image.backend === 'b'),
        error: degraded.find((entry) => entry.backend === '后端 B')?.reason,
      },
    },
    verification: {
      mode: verification.mode,
      provider: verification.provider,
      model: verification.model,
      note: verification.note,
      table: verification.table,
      perImage: verification.perImage,
      needsHuman: verification.needsHuman,
    },
    tableMarkdown: buildTableMarkdown(rubricResult.rubric, verification),
    fusion: {
      enabled: fusion.enabled,
      mode: fusion.mode,
      used: fusion.used,
      note: fusion.note,
      final: fusion.final ?? undefined,
      identicalToBase: fusion.identicalToBase ?? false,
    },
    degraded,
    images: publicImages,
    files: publicImages.map((image) => image.path).concat(fusion.final ? [fusion.final.path] : []),
    verificationLabel: selectVlmRouteLabel(verification),
  })
}

function renderResultText(value) {
  const lines = []
  lines.push(`Super Image 已完成：后端 A ${value.backends.a.status === 'ok' ? `${value.backends.a.images.length} 张` : '未参与'}，后端 B ${value.backends.b.status === 'ok' ? `${value.backends.b.images.length} 张` : '未参与'}。`)
  lines.push(`需求清单：${value.rubric.items?.length ?? 0} 项（提取方式：${value.rubricSource === 'model' ? '模型结构化' : '启发式'}）；校验方式：${value.verificationLabel}。`)
  if (value.degraded.length > 0) {
    lines.push(`降级说明：${value.degraded.map((entry) => `${entry.backend} 未参与（${entry.reason}）`).join('；')}。`)
  }
  if (value.tableMarkdown) {
    lines.push('', '需求 × 图片比对表（✅ 满足 / ❌ 未满足 / ⚠️ 弱项 / ❓ 需人工确认）：', '', value.tableMarkdown)
  }
  if (value.fusion.enabled && value.fusion.final) {
    lines.push('', `融合方式：${value.fusion.used}。${value.fusion.note}`)
  } else {
    lines.push('', value.fusion.note)
  }
  if (value.images.length > 0) {
    lines.push('', '原图文件（保留可追溯，未删除）：')
    for (const image of value.images) lines.push(`- ${image.label}：${image.path}（强项：${image.strengths}；未满足：${image.unmet}）`)
  }
  if (value.fusion.final) lines.push(`- 最终图：${value.fusion.final.path}`)
  lines.push('', '图片已作为附件返回；请直接回复用户，不要读取或搜索这些文件。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// tool / command definitions
// ---------------------------------------------------------------------------

function toolDefinition(ctx, getConfig) {
  return {
    name: 'super_image',
    description:
      'Draw one image request with TWO independently configured image backends in parallel (API model and/or local ComfyUI), verify every result against an explicit requirement rubric, and optionally fuse the best result into one final deliverable. Use this when the user says "用 super image 画…", asks for dual-backend/parallel drawing, rubric-checked or fused image delivery, or compares two image backends. Do not use it for simple single-image requests that the normal image tool already covers. The tool writes every original plus the final image into generate/super-image under the session workspace and returns inline image blocks.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete drawing request, verbatim from the user, including all visual requirements, text to render, negatives and aspect ratio.',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Images per backend (defaults to the configured value).',
        },
        enableFusion: {
          type: 'boolean',
          description: 'Override the configured fusion switch for this call.',
        },
        fusionMode: {
          type: 'string',
          enum: ['reference-edit', 'prompt-synthesis', 'side-by-side'],
          description: 'Override the configured fusion mode for this call.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          rubric: { type: 'object' },
          rubricSource: { type: 'string' },
          tableMarkdown: { type: 'string' },
          images: { type: 'array' },
          fusion: { type: 'object' },
          degraded: { type: 'array' },
          files: { type: 'array' },
          verification: { type: 'object' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        const content = [{ type: 'text', text: renderResultText(value) }]
        const inline = []
        for (const image of value.images ?? []) {
          if (image.backend === 'a' && image.label.endsWith('1')) inline.push(image)
          if (image.backend === 'b' && image.label.endsWith('1')) inline.push(image)
        }
        if (value.fusion?.final) inline.push(value.fusion.final)
        for (const image of inline.slice(0, 8)) {
          if (image.attachment?.attachmentId) content.push({ type: 'image', attachment: image.attachment })
        }
        return content
      },
      presentationMeta(_args, value) {
        const attachments = []
        for (const image of value.images ?? []) {
          if (image.attachment) attachments.push({ attachmentId: String(image.attachment.attachmentId), label: image.label, path: image.path })
        }
        if (value.fusion?.final?.attachment) {
          attachments.push({ attachmentId: String(value.fusion.final.attachment.attachmentId), label: value.fusion.final.label, path: value.fusion.final.path })
        }
        return { kind: 'dsh-super-image', attachments, degraded: value.degraded, fusion: value.fusion?.used }
      },
    },
    timeoutMs: 900000,
    isConcurrencySafe: false,
    async execute(args, exec) {
      const result = await runPipeline(ctx, exec, {
        prompt: args?.prompt,
        count: args?.count,
        enableFusion: args?.enableFusion,
        fusionMode: args?.fusionMode,
        pluginConfig: getConfig(),
        signal: exec?.signal,
      })
      return result
    },
  }
}

function commandDefinition(ctx, getConfig) {
  return {
    name: 'super-image',
    description: '双后端并行画图：同一提示词交给后端 A、B 并行生成，按需求清单校验并融合交付。',
    input: { hint: '<绘画需求，例如：一只橘猫坐在窗台，水彩，16:9，不要文字>' },
    recordInput: true,
    async handler(invocation) {
      const prompt = String(invocation?.rawInput ?? '').trim()
      if (prompt.length === 0) {
        return { kind: 'error', text: '请在 /super-image 后面写上绘画需求，例如：/super-image 一只橘猫坐在窗台，水彩，16:9' }
      }
      try {
        const value = await runPipeline(ctx, { agent: invocation.agent, signal: invocation.signal }, {
          prompt,
          pluginConfig: getConfig(),
          signal: invocation.signal,
        })
        return { kind: 'success', text: renderResultText(value) }
      } catch (error) {
        return { kind: 'error', text: `Super Image 失败：${errorMessage(error)}` }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const pluginConfig = normalizeConfig(config)
  const getConfig = () => pluginConfig

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/settings`,
        handler: (req, res) => routeSettings(ctx, getConfig, req, res),
      }),
    'dsh-super-image: settings route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/comfyui/start`,
        handler: (req, res) => routeComfyStart(ctx, getConfig, req, res),
      }),
    'dsh-super-image: comfy start route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/workflows`,
        handler: (req, res) => routeWorkflows(ctx, getConfig, req, res),
      }),
    'dsh-super-image: workflows route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/credential`,
        handler: (req, res) => routeCredential(ctx, getConfig, req, res),
      }),
    'dsh-super-image: credential route',
  )

  ctx.effect(() => ctx.tools.register(toolDefinition(ctx, getConfig)), 'dsh-super-image: super_image tool')

  try {
    const commands = ctx.get('commands')
    if (commands?.register) {
      ctx.effect(() => commands.register(commandDefinition(ctx, getConfig)), 'dsh-super-image: slash command')
    }
  } catch {}
}

// Headless smoke harness: loads the real host plugin with a fake Cordis context and
// runs the full super_image pipeline (API backend + ComfyUI backend, verify, fusion).
//
// Usage: node test/harness.mjs "<prompt>"
// Requires: local mock OpenAI Images server on 127.0.0.1:8791 and ComfyUI on 8188.

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const workspace = path.resolve(pkgRoot, '..', 'smoke-super-image')

const workflowPath = 'D:\\ComfyUI\\ComfyUI_windows_portable\\ComfyUI\\user\\default\\workflows\\noobai-xl-vpred-api.json'

const registrations = []
const attachments = new Map()
let sequence = 0

const ctx = {
  effect(run) {
    const dispose = run()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  get(name) {
    if (name === 'credentials') {
      return {
        async resolve(ref) {
          return { value: `sk-harness-${ref.toLowerCase()}`, source: 'harness' }
        },
        async describe() {
          return { configured: true, writable: true, source: 'harness' }
        },
        async set() {},
        async unset() {},
      }
    }
    if (name === 'workingDirectory') {
      return { get: () => workspace, defaultDirectory: workspace }
    }
    if (name === 'commands') {
      return { register: () => () => {} }
    }
    return undefined
  },
  webServer: { register: () => () => {} },
  tools: {
    register(definition) {
      registrations.push(definition)
      return () => {}
    },
  },
  attachments: {
    async saveImage(input) {
      const id = `harness-${++sequence}`
      const record = { attachmentId: id, mediaType: input.mediaType, bytes: input.data.length, width: 512, height: 512, name: input.name }
      attachments.set(id, { ...record, data: input.data })
      return record
    },
    async readImage(ref) {
      const record = attachments.get(ref.attachmentId)
      if (!record) throw new Error(`missing attachment ${ref.attachmentId}`)
      return { data: record.data, mediaType: record.mediaType }
    },
  },
}

const { apply } = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'index.js')).href)

apply(ctx, {
  perBackendCount: 1,
  enableVerify: true,
  enableFusion: true,
  fusionMode: 'reference-edit',
  backendA: {
    type: 'api',
    baseURL: 'http://127.0.0.1:8791/v1',
    model: 'mock-image-1',
    size: '512x512',
    quality: 'auto',
  },
  backendB: {
    type: 'comfyui',
    comfyURL: 'http://127.0.0.1:8188',
    workflowPath,
    promptNodeId: '2',
    negativeNodeId: '3',
    seedNodeId: '6',
    widthNodeId: '5',
    heightNodeId: '5',
    outputNodeId: '8',
    timeoutMs: 180000,
    pollMs: 1000,
  },
})

const tool = registrations.find((item) => item.name === 'super_image')
if (!tool) throw new Error('super_image was not registered')

await mkdir(workspace, { recursive: true })

const started = Date.now()
const value = await tool.execute(
  {
    prompt: process.argv[2] ?? '一只红苹果放在木桌上，水彩风格，柔和自然光，正方形构图',
    count: 1,
  },
  {
    signal: AbortSignal.timeout(600000),
    agent: { session: { header: { cwd: workspace } } },
  },
)

const render = tool.output.render({}, value)
const summary = {
  elapsedMs: Date.now() - started,
  rubricSource: value.rubricSource,
  rubricItems: value.rubric?.items?.length ?? 0,
  degraded: value.degraded,
  verificationSource: value.verification?.source,
  tableHasStrengths: /强项/.test(value.tableMarkdown ?? ''),
  fusionUsed: value.fusion?.used,
  fusionFinalPath: value.fusion?.final?.path,
  files: value.files,
  images: (value.images ?? []).map((image) => ({ label: image.label, backend: image.backend, path: image.path, bytes: image.attachment?.bytes })),
  renderBlocks: render.map((block) => block.type),
  renderImages: render.filter((block) => block.type === 'image').length,
  presentationMeta: tool.output.presentationMeta?.({}, value),
}

console.log(JSON.stringify(summary, null, 2))
console.log('--- table ---')
console.log(value.tableMarkdown)
console.log('--- perImage ---')
console.log(JSON.stringify(value.verification?.perImage, null, 2))

let allExist = true
for (const file of value.files ?? []) {
  try {
    const bytes = await readFile(file)
    if (bytes.length === 0) allExist = false
  } catch {
    allExist = false
  }
}
console.log(`allFilesExist=${allExist}`)

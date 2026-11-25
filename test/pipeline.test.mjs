import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGP8n+zOQApgIkk1w6gG4gATkergYFQDMYDkUAIAR1EByQ++Oa0AAAAASUVORK5CYII='
const pixel = { b64_json: PNG }

async function fixture(t, { config = {}, respond, llm, failAttachment = false, movedWorkspace = false } = {}) {
  const routes = new Map()
  const requests = []
  let tool
  let command
  let sequence = 0
  let stored = {}
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (routes.has(url.pathname)) return routes.get(url.pathname)(req, res)
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url, body })
    const value = respond?.(url, body, res)
    if (res.writableEnded) return
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value ?? { data: [pixel] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const workspace = await mkdtemp(path.join(tmpdir(), 'super-image-'))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(workspace, { recursive: true, force: true })
  })
  apply({
    effect: (callback) => callback(),
    tools: { register: (definition) => { tool = definition } },
    webServer: { register: (route) => routes.set(route.path, route.handler) },
    attachments: {
      async saveImage(input) {
        if (failAttachment) throw new Error('attachment unavailable')
        return { attachmentId: `image-${++sequence}`, mediaType: input.mediaType }
      },
    },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'workingDirectory' && movedWorkspace) return { get: () => path.join(workspace, 'active') }
      if (name === 'commands') return { register: (definition) => { command = definition } }
      if (name === 'credentials') return {
        resolve: () => ({ value: 'sk-local-test' }),
        describe: () => ({ configured: true, writable: true }),
      }
      if (name === 'settings') return {
        describe: () => [{ ns: 'super-image', value: stored }],
        update(_namespace, patch) {
          const { backendA, backendB, ...rest } = patch
          stored = { ...stored, ...rest }
          if (backendA) stored.backendA = { ...stored.backendA, ...backendA }
          if (backendB) stored.backendB = { ...stored.backendB, ...backendB }
        },
      }
    },
  }, {
    enableVerify: false,
    ...config,
    backendA: { baseURL: `${base}/a`, comfyURL: base, model: 'mock-a', ...config.backendA },
    backendB: { baseURL: `${base}/b`, comfyURL: base, model: 'mock-b', ...config.backendB },
  })
  const agent = { session: { header: { cwd: workspace } } }
  return {
    tool, command, agent, requests,
    run: (args = {}, signal) => tool.execute({ prompt: 'A watercolor apple, no lettering', ...args }, { agent, signal }),
    async request(endpoint, method = 'GET', body) {
      const response = await fetch(`${base}/plugins/dsh-super-image/api/${endpoint}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 200)
      return response.json()
    },
  }
}

test('draft checks do not save or generate, and sparse settings apply to both entry points', async (t) => {
  const host = await fixture(t)
  const diagnosis = await host.request('backend/check', 'POST', { backend: 'a', config: { baseURL: 'wrong' } })
  assert.equal(diagnosis.health.ok, false)
  const before = await host.request('settings')
  assert.equal(before.config.backendA.enabled, true)
  assert.equal(before.health.a.ok, true)
  assert.equal(host.requests.length, 0)

  const saved = await host.request('settings', 'PUT', { config: { backendB: { enabled: false }, fusionMode: 'side-by-side' } })
  assert.equal(saved.config.backendB.model, 'mock-b')
  assert.equal(saved.health.b.level, 'off')
  const result = await host.run()
  assert.equal(result.backends.b.status, 'disabled')
  assert.equal(result.verificationLabel, '已关闭')
  assert.deepEqual(result.degraded, [])
  assert.equal(host.tool.output.render({}, result).filter((block) => block.type === 'image').length, 1)
  const command = await host.command.handler({ rawInput: ' A watercolor apple', agent: host.agent })
  assert.equal(command.kind, 'success')
  assert.match(command.text, /后端 B 已停用/)
  assert.deepEqual(host.requests.map(({ url }) => url.pathname), ['/a/images/generations', '/a/images/generations'])

  await host.request('settings', 'PUT', { config: { backendA: { enabled: false } } })
  await assert.rejects(host.run(), /启用至少一个后端/)
  assert.equal(host.requests.length, 2)
})

test('API keeps usable batch images and same-workspace runs use unique files', async (t) => {
  const host = await fixture(t, {
    movedWorkspace: true,
    config: { backendB: { enabled: false } },
    respond: () => ({ data: [pixel, { b64_json: 'invalid' }, pixel] }),
  })
  const [first, second] = await Promise.all([host.run({ count: 3 }), host.run({ count: 3 })])
  assert.equal(first.backends.a.status, 'partial')
  assert.equal(first.degraded[0].stage, 'generation')
  assert.deepEqual(first.images.map(({ label }) => label), ['A1', 'A2'])
  assert.equal(new Set([...first.files, ...second.files]).size, 4)
  assert.ok(first.files[0].startsWith(path.join(host.agent.session.header.cwd, 'active', 'generate', 'super-image')))
  assert.equal((await readFile(first.files[0])).toString('base64'), PNG)
  assert.equal(host.tool.output.render({}, first).filter((block) => block.type === 'image').length, 2)
})

test('ComfyUI uses the selected output node and keeps an image when the next job fails', async (t) => {
  let submitted = 0
  const workflow = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    2: { class_type: 'SaveImage', inputs: {} },
    3: { class_type: 'PreviewImage', inputs: {} },
    4: { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 0 } },
  }
  const host = await fixture(t, {
    config: {
      backendA: { type: 'comfyui', workflowName: 'draft.json', outputNodeId: '3', seedNodeId: '4', pollMs: 100 },
      backendB: { enabled: false },
    },
    respond(url, body, res) {
      if (url.pathname === '/userdata') return ['draft.json', 'ui.json']
      if (url.pathname.endsWith('draft.json')) return workflow
      if (url.pathname.endsWith('ui.json')) return { nodes: [], links: [] }
      if (url.pathname === '/prompt') return { prompt_id: String(++submitted) }
      if (url.pathname === '/history/1') return { 1: { outputs: {
        2: { images: [{ filename: 'wrong.png', type: 'output' }] },
        3: { images: [{ filename: 'selected.png', type: 'temp' }] },
      } } }
      if (url.pathname === '/history/2') return { 2: { status: { status_str: 'error' } } }
      if (url.pathname === '/view') return res.end(Buffer.from(PNG, 'base64'))
      return {}
    },
  })
  const settings = await host.request('settings')
  const list = await host.request('workflows?side=a')
  assert.deepEqual(list.workflows.map(({ valid }) => valid), [true, false])
  const check = await host.request('backend/check', 'POST', { backend: 'a', config: { outputNodeId: '9' } })
  assert.match(check.health.message, /节点 9/)
  assert.equal(settings.config.backendA.outputNodeId, '3')
  const result = await host.run({ count: 2 })
  const view = host.requests.find(({ url }) => url.pathname === '/view').url
  assert.equal(view.searchParams.get('filename'), 'selected.png')
  assert.equal(view.searchParams.get('type'), 'temp')
  const inputs = JSON.parse(host.requests.find(({ url }) => url.pathname === '/prompt').body).prompt[4].inputs
  assert.equal(typeof inputs.noise_seed, 'number')
  assert.equal('seed' in inputs, false)
  assert.equal(result.backends.a.status, 'partial')
  assert.equal(result.files.length, 1)
  assert.match(result.degraded[0].reason, /工作流执行失败/)
})

test('side-by-side skips editing and reference-edit previews all eight originals plus the final', async (t) => {
  const llm = {
    async *stream({ messages }) {
      const content = messages[0].content
      const labels = content[0].text.match(/position 1, the 2nd label is the image at position 2, and so on\): ([^\n]+)/)?.[1]
      const images = labels?.split(', ').map((label) => ({ label, overall: 80 }))
      yield { type: 'text-delta', text: JSON.stringify({ images }) }
    },
  }
  const host = await fixture(t, {
    config: { enableVerify: true, vlmProvider: 'mock', vlmModel: 'vision' },
    llm,
    respond: (url) => ({ data: url.pathname.endsWith('/edits') ? [pixel] : Array(4).fill(pixel) }),
  })
  const comparison = await host.run({ count: 4, fusionMode: 'side-by-side' })
  assert.equal(comparison.verification.mode, 'vlm')
  assert.equal(comparison.verification.table.length, comparison.rubric.items.length)
  assert.equal(comparison.files.length, 8)
  assert.equal(host.requests.some(({ url }) => url.pathname.endsWith('/edits')), false)
  const edit = await host.run({ count: 4 })
  assert.equal(edit.fusion.used, 'reference-edit')
  assert.equal(edit.files.length, 9)
  assert.equal(host.tool.output.render({}, edit).filter((block) => block.type === 'image').length, 9)
})

test('an unavailable attachment service leaves a usable file, and cancellation avoids backend calls', async (t) => {
  const host = await fixture(t, { failAttachment: true, config: { enableVerify: true, backendB: { enabled: false } } })
  await assert.rejects(host.run({}, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(host.requests.length, 0)
  const result = await host.run()
  assert.equal(result.verification.mode, 'heuristic')
  assert.equal(host.tool.output.presentationMeta({}, result).attachments.length, 0)
  assert.equal((await readFile(result.files[0])).toString('base64'), PNG)
})

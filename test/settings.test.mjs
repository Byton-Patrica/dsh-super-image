import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const config = {
  backendA: { type: 'api', baseURL: 'https://example.test/v1', model: 'saved-model' },
  backendB: { type: 'comfyui', comfyURL: 'http://127.0.0.1:8188' },
  perBackendCount: 1,
}
const credentials = { a: { configured: true, writable: true } }
const snapshot = { config, credentials, canStartComfy: true }

function deferred() {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { resolve, promise }
}

async function settings(t, respond) {
  let Settings
  const storage = new Map()
  runInNewContext(source, {
    AbortController, URL, clearTimeout,
    setTimeout: (callback) => setTimeout(callback, 0),
    async fetch(rawURL, options) {
      const url = new URL(rawURL, 'http://test.local')
      const value = await respond(url, options)
      return { ok: !value?.error, status: value?.error ? 400 : 200, json: async () => ({ ok: true, ...value }) }
    },
    window: {
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      __ModuleLoader__: {
        load({ factory }) {
          const plugin = factory(() => React)
          plugin.apply({ slots: {
            inject: (_name, callback) => callback(),
            register(slot, component) { if (slot.name === 'settings.section') Settings = component },
          } })
        },
      },
    },
  })
  let view
  await act(async () => { view = TestRenderer.create(React.createElement(Settings)) })
  await act(async () => { await pause(10) })
  t.after(() => act(() => view.unmount()))
  return view
}

function button(view, text) {
  return view.root.findAllByType('button').find((item) => item.children.includes(text))
}

function edit(view, placeholder, value) {
  const input = view.root.findAllByType('input').find((item) => item.props.placeholder === placeholder)
  input.props.onChange({ target: { value } })
}

test('starting ComfyUI preserves the draft, and saving rebases edits made while the request is pending', async (t) => {
  let started = false
  let submitted
  const pendingSave = deferred()
  const view = await settings(t, (url, options) => {
    if (url.pathname.endsWith('/workflows')) return started ? { workflows: [] } : { error: 'offline' }
    if (url.pathname.endsWith('/comfyui/start')) { started = true; return {} }
    if (url.pathname.endsWith('/backend/check')) return { health: { ok: true, message: 'checked' } }
    if (options.method === 'PUT') {
      submitted = JSON.parse(options.body).config
      return pendingSave.promise
    }
    return snapshot
  })
  await act(async () => { edit(view, 'gpt-image-1', 'first-edit') })
  await act(async () => { button(view, '启动 ComfyUI').props.onClick() })
  assert.equal(started, true)
  assert.equal(button(view, '保存').props.disabled, false)
  await act(async () => { button(view, '保存').props.onClick() })
  assert.deepEqual(submitted, { backendA: { model: 'first-edit' } })
  await act(async () => { edit(view, 'gpt-image-1', 'second-edit') })
  await act(async () => { pendingSave.resolve({ ...snapshot, config: {
    ...config, backendA: { ...config.backendA, model: 'first-edit' },
  } }) })
  assert.equal(button(view, '保存').props.disabled, false)
  assert.equal(view.root.findAllByType('input').find((item) => item.props.placeholder === 'gpt-image-1').props.value, 'second-edit')
  await act(async () => { button(view, '撤销未保存更改').props.onClick() })
  assert.equal(view.root.findAllByType('input').find((item) => item.props.placeholder === 'gpt-image-1').props.value, 'first-edit')
  assert.equal(button(view, '保存').props.disabled, true)
})

test('outdated workflow requests cannot replace the current server list', async (t) => {
  const old = deferred()
  let oldSignal
  const view = await settings(t, (url, options) => {
    if (!url.pathname.endsWith('/workflows')) return snapshot
    if (url.searchParams.get('url').endsWith(':8188')) {
      oldSignal = options.signal
      return old.promise
    }
    return { workflows: [
      { valid: true, name: 'new.json', model: 'New' },
      { valid: false, name: 'unsupported.json', reason: 'UI 格式' },
    ] }
  })
  assert.equal(oldSignal.aborted, false)
  await act(async () => { edit(view, 'http://127.0.0.1:8188', 'http://localhost:9999') })
  await act(async () => { await pause(10) })
  assert.equal(oldSignal.aborted, true)
  await act(async () => { old.resolve({ workflows: [{ valid: true, name: 'old.json' }] }) })
  assert.deepEqual(view.root.findAllByType('option').map((item) => item.props.value), ['', 'new.json'])
  assert.equal(view.root.findAllByType('li').some((item) => item.children.includes('unsupported.json：UI 格式')), true)
})

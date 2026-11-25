window.__ModuleLoader__.load({
  id: 'dsh-super-image',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const SETTINGS_PATH = '/plugins/dsh-super-image/api/settings'
    const CREDENTIAL_PATH = '/plugins/dsh-super-image/api/credential'
    const WORKFLOWS_PATH = '/plugins/dsh-super-image/api/workflows'
    const START_PATH = '/plugins/dsh-super-image/api/comfyui/start'
    const CHECK_PATH = '/plugins/dsh-super-image/api/backend/check'
    const STYLE_ID = 'dsh-super-image-style'

    const FUSION_MODES = [
      { value: 'reference-edit', label: '参考图编辑' },
      { value: 'prompt-synthesis', label: '提示词合成' },
      { value: 'side-by-side', label: '并排返回供人工选择' },
    ]

    // [configKey, label, placeholder, wide]
    const COMFY_TEXT_FIELDS = [
      ['comfyURL', 'ComfyUI 地址', 'http://127.0.0.1:8188', true],
    ]

    const COMFY_ADVANCED_FIELDS = [
      ['workflowPath', '本地 workflow_api.json 路径', 'E:\\ComfyUI\\workflows\\workflow_api.json', true],
      ['promptNodeId', '提示词节点 ID', '6', false],
      ['negativeNodeId', '负向提示词节点 ID', '7', false],
      ['seedNodeId', 'seed 节点 ID', '3', false],
      ['widthNodeId', '宽度节点 ID', '5', false],
      ['heightNodeId', '高度节点 ID', '5', false],
      ['outputNodeId', '输出节点 ID', '9', false],
    ]

    const STYLE_TEXT = `
.dsh-si-root{display:flex;flex-direction:column;gap:14px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-si-root,.dsh-si-root *{box-sizing:border-box}
.dsh-si-header{display:flex;flex-direction:column;gap:4px;padding-top:2px}
.dsh-si-title{margin:0;font:inherit;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-si-subtitle{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-si-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;align-items:start}
.dsh-si-card{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-si-card.is-invalid{border-color:var(--dsw-alias-state-error-primary)}
.dsh-si-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dsh-si-card-ident{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-si-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-si-card-head-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-si-badge{display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;font-size:12px;font-weight:600}
.dsh-si-badge.is-a{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dsh-si-badge.is-b{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.dsh-si-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;line-height:1;white-space:nowrap}
.dsh-si-chip.is-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dsh-si-chip.is-bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dsh-si-chip.is-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.dsh-si-chip.is-muted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dsh-si-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.dsh-si-seg-btn{height:24px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsh-si-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.dsh-si-seg-btn.is-active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,0.1)}
.dsh-si-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dsh-si-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-si-field.is-wide{grid-column:1/-1}
.dsh-si-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-si-input{width:100%;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dsh-si-input:hover{border-color:var(--dsw-alias-border-l2)}
.dsh-si-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-si-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dsh-si-hint{display:block;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-si-field-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dsh-si-health{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-si-health.is-bad{color:var(--dsw-alias-state-error-primary)}
.dsh-si-health.is-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-si-cred{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-si-cred-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-si-cred-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-si-cred-row .dsh-si-input{flex:1 1 140px;min-width:0}
.dsh-si-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.dsh-si-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay)}
.dsh-si-btn:disabled{opacity:.55;cursor:default}
.dsh-si-btn.is-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dsh-si-btn.is-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,transparent)}
.dsh-si-btn.is-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsh-si-btn.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dsh-si-strategy{gap:14px}
.dsh-si-strategy-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:14px;align-items:start}
.dsh-si-toggles{display:flex;flex-direction:column;gap:8px}
.dsh-si-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-si-toggle-label{font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-si-switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font:inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.dsh-si-switch.is-on{border-color:transparent;background:var(--dsw-alias-brand-primary)}
.dsh-si-switch:disabled{opacity:.55;cursor:default}
.dsh-si-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s ease}
.dsh-si-switch.is-on .dsh-si-knob{transform:translateX(14px)}
.dsh-si-fusion{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-si-radio{display:flex;flex-wrap:wrap;gap:8px 16px}
.dsh-si-radio.is-disabled{opacity:.5}
.dsh-si-radio-option{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-si-radio-option input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.dsh-si-subsection{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-si-loading{display:flex;align-items:center;gap:8px;padding:14px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-si-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:dsh-si-pulse 1.1s ease-in-out infinite}
@keyframes dsh-si-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.dsh-si-error-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.dsh-si-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;padding:12px 2px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-si-footer-status{display:flex;align-items:center;gap:10px;min-height:20px;font-size:12px;flex-wrap:wrap}
.dsh-si-footer-actions{display:flex;align-items:center;gap:8px}
.dsh-si-saved{color:var(--dsw-alias-state-success-primary)}
.dsh-si-dirty{color:var(--dsw-alias-state-warn-primary)}
.dsh-si-save-error{color:var(--dsw-alias-state-error-primary)}
.dsh-si-dock{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.dsh-si-dock:hover{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dsh-si-dock:active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dsh-si-dock:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);outline-offset:1px}
.dsh-si-dock-icon{width:14px;height:14px;flex:none;color:var(--dsw-alias-brand-primary)}
.dsh-si-dock-label{white-space:nowrap}
.dsh-si-select{width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dsh-si-select:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-si-picker-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-si-workflow-errors{margin:4px 0;padding-inline-start:20px;overflow-wrap:anywhere}
.dsh-si-advanced{grid-column:1/-1}
.dsh-si-advanced{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dsh-si-advanced>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none}
.dsh-si-advanced[open]>summary{color:var(--dsw-alias-label-primary);margin-bottom:10px}
.dsh-si-advanced .dsh-si-fields{margin-top:2px}
@media (max-width:560px){.dsh-si-strategy-grid{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.dsh-si-dot{animation:none}.dsh-si-knob,.dsh-si-switch{transition:none}}
`

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
    }

    function hasText(value) {
      return typeof value === 'string' && value.trim() !== ''
    }

    function textOf(value) {
      return value === undefined || value === null ? '' : String(value)
    }

    function clampInt(value, min, max, fallback) {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    }

    async function apiRequest(method, path, body, signal) {
      const init = {
        method: method,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal,
      }
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' && payload.error
          ? payload.error
          : '请求失败（HTTP ' + response.status + '）'
        throw new Error(message)
      }
      if (!payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' && payload.error
          ? payload.error
          : '响应格式不正确'
        throw new Error(message)
      }
      return payload
    }

    function normalizeBackend(backend) {
      const next = Object.assign({}, backend || {})
      next.enabled = next.enabled !== false
      next.type = next.type === 'comfyui' ? 'comfyui' : 'api'
      ;['baseURL', 'model', 'size', 'quality', 'comfyURL', 'workflowPath', 'workflowName', 'promptNodeId', 'negativeNodeId', 'seedNodeId', 'widthNodeId', 'heightNodeId', 'outputNodeId'].forEach(function (key) {
        if (!hasText(next[key])) next[key] = ''
      })
      if (next.type === 'api' && !hasText(next.size)) next.size = '1024x1024'
      ;['timeoutMs', 'pollMs'].forEach(function (key) {
        if (typeof next[key] !== 'number' || !Number.isFinite(next[key])) next[key] = undefined
      })
      return next
    }

    function normalizeConfig(config) {
      const source = config && typeof config === 'object' ? config : {}
      const next = Object.assign({}, source)
      next.backendA = normalizeBackend(source.backendA)
      next.backendB = normalizeBackend(source.backendB)
      next.perBackendCount = clampInt(source.perBackendCount, 1, 4, 1)
      next.enableVerify = source.enableVerify !== false
      next.enableFusion = source.enableFusion !== false
      next.fusionMode = source.fusionMode === 'prompt-synthesis' || source.fusionMode === 'side-by-side'
        ? source.fusionMode
        : 'reference-edit'
      next.vlmProvider = hasText(source.vlmProvider) ? source.vlmProvider : ''
      next.vlmModel = hasText(source.vlmModel) ? source.vlmModel : ''
      return next
    }

    function backendIssues(config, credential) {
      const issues = []
      if (!config.enabled) return issues
      if (config.type === 'comfyui') {
        if (!httpUrl(config.comfyURL)) issues.push('请填写有效的 ComfyUI HTTP(S) 地址')
        if (!hasText(config.workflowName) && !hasText(config.workflowPath)) issues.push('请选择模型/工作流')
        return issues
      }
      if (!httpUrl(config.baseURL)) issues.push('请填写有效的 API Base URL')
      if (!hasText(config.model)) issues.push('需要填写模型 ID')
      if (!credential || credential.configured !== true) issues.push('需要配置 API Key')
      return issues
    }

    function changedFields(previous, next) {
      return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== previous[key]))
    }

    function configPatch(previous, next) {
      const { backendA, backendB, ...patch } = changedFields(previous, next)
      for (const [key, backend] of Object.entries({ backendA, backendB })) {
        if (!backend) continue
        const changes = changedFields(previous[key], backend)
        if (Object.keys(changes).length) patch[key] = changes
      }
      return patch
    }

    function applyDraftPatch(config, patch) {
      const next = { ...config, ...patch }
      for (const key of ['backendA', 'backendB']) {
        if (patch[key]) next[key] = { ...config[key], ...patch[key] }
      }
      return next
    }

    function httpUrl(value) {
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) ? url : null
      } catch {
        return null
      }
    }

    function TextInput(props) {
      return h('input', {
        type: props.type || 'text',
        className: 'dsh-si-input' + (props.className ? ' ' + props.className : ''),
        value: textOf(props.value),
        placeholder: props.placeholder || '',
        spellCheck: false,
        autoComplete: props.autoComplete || 'off',
        onChange: function (event) {
          props.onChange(event.target.value)
        },
      })
    }

    function NumberInput(props) {
      const [text, setText] = useState(textOf(props.value))
      const min = typeof props.min === 'number' ? props.min : 0
      const max = typeof props.max === 'number' ? props.max : 999999999

      useEffect(function () {
        setText(textOf(props.value))
      }, [props.value])

      return h('input', {
        type: 'number',
        className: 'dsh-si-input',
        min: min,
        max: max,
        step: props.step || 1,
        value: text,
        placeholder: props.placeholder || '',
        onChange: function (event) {
          const raw = event.target.value
          setText(raw)
          if (raw.trim() === '') return
          const n = Number(raw)
          if (!Number.isFinite(n)) return
          const rounded = Math.round(n)
          if (rounded >= min && rounded <= max) props.onCommit(rounded)
        },
        onBlur: function () {
          const raw = text.trim()
          if (raw === '') {
            setText(textOf(props.value))
            return
          }
          const n = Number(raw)
          const rounded = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min
          setText(String(rounded))
          props.onCommit(rounded)
        },
      })
    }

    function Field(props) {
      return h('label', { className: 'dsh-si-field' + (props.wide ? ' is-wide' : '') },
        h('span', { className: 'dsh-si-label' }, props.label),
        props.children)
    }

    function Segmented(props) {
      return h('div', { className: 'dsh-si-seg', role: 'group', 'aria-label': props.ariaLabel || '' },
        props.options.map(function (option) {
          const active = props.value === option.value
          return h('button', {
            key: option.value,
            type: 'button',
            className: 'dsh-si-seg-btn' + (active ? ' is-active' : ''),
            'aria-pressed': active ? 'true' : 'false',
            onClick: function () {
              props.onChange(option.value)
            },
          }, option.label)
        }))
    }

    function Switch(props) {
      const checked = props.checked === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': props.label || '',
        className: 'dsh-si-switch' + (checked ? ' is-on' : ''),
        disabled: props.disabled === true,
        onClick: function () {
          if (props.disabled) return
          props.onChange(!checked)
        },
      }, h('span', { className: 'dsh-si-knob' }))
    }

    function ToggleRow(props) {
      return h('div', { className: 'dsh-si-toggle' },
        h('span', { className: 'dsh-si-toggle-label' }, props.label),
        h(Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange,
        }))
    }

    function CredentialRow(props) {
      const credential = props.credential || {}
      const configured = credential.configured === true
      const source = hasText(credential.source) ? credential.source : ''
      const writable = credential.writable !== false
      const keyLabel = '后端 ' + props.side.toUpperCase() + ' API Key'

      return h('div', { className: 'dsh-si-cred' },
        h('div', { className: 'dsh-si-cred-head' },
          h('span', { className: 'dsh-si-label' }, 'API Key'),
          h('span', { className: 'dsh-si-chip ' + (configured ? 'is-ok' : 'is-bad') },
            configured ? ('已配置' + (source ? ' (' + source + ')' : '')) : '未配置')),
        writable ? h('div', { className: 'dsh-si-cred-row' },
          h('input', {
            type: 'password',
            className: 'dsh-si-input',
            value: props.value,
            placeholder: 'sk-...',
            autoComplete: 'new-password',
            spellCheck: false,
            'aria-label': keyLabel,
            disabled: props.busy === true,
            onChange: function (event) {
              props.onChange(event.target.value)
            },
          }),
          h('button', {
            type: 'button',
            className: 'dsh-si-btn',
            disabled: props.busy === true || !hasText(props.value),
            onClick: props.onSave,
          }, props.busy ? '保存中…' : '保存密钥'),
          configured ? h('button', {
            type: 'button',
            className: 'dsh-si-btn is-danger',
            disabled: props.busy === true,
            onClick: props.onClear,
          }, '清除') : null) : h('div', { className: 'dsh-si-hint' }, '请在 DSH 凭据服务中管理此密钥。'),
        hasText(props.error) ? h('div', { className: 'dsh-si-field-error', role: 'alert' }, props.error) : null)
    }

    function ComfyPicker(props) {
      const config = props.config || {}
      const [state, setState] = useState(null)
      const [refresh, setRefresh] = useState(0)
      const [start, setStart] = useState(null)
      const url = textOf(config.comfyURL).trim()
      const parsedURL = httpUrl(url)
      const local = parsedURL && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedURL.hostname)
      const current = state?.url === url ? state : null
      const starting = start?.url === url && start.pending

      function cacheKey(target) {
        return 'dsh-super-image.workflows:' + target
      }

      function readCache(target) {
        try {
          const raw = window.localStorage.getItem(cacheKey(target))
          if (!raw) return []
          const parsed = JSON.parse(raw)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      }

      useEffect(function () {
        if (!httpUrl(url)) return undefined
        const controller = new AbortController()
        setState({ url, status: 'loading', list: readCache(url) })
        const timer = setTimeout(async function () {
          try {
            const response = await apiRequest('GET', WORKFLOWS_PATH + '?url=' + encodeURIComponent(url), undefined, controller.signal)
            if (controller.signal.aborted) return
            const list = Array.isArray(response.workflows) ? response.workflows : []
            try { window.localStorage.setItem(cacheKey(url), JSON.stringify(list)) } catch {}
            setState({ url, status: 'ok', list })
          } catch (error) {
            if (controller.signal.aborted) return
            setState({ url, status: 'error', list: readCache(url), error: error.message })
          }
        }, 400)
        return function () {
          clearTimeout(timer)
          controller.abort()
        }
      }, [url, refresh])

      useEffect(function () {
        if (!start?.done) return
        setStart(null)
        if (start.url !== url) return
        setRefresh((previous) => previous + 1)
        props.onStarted()
      }, [start, url, props.onStarted])

      async function startServer() {
        if (!local || start?.pending) return
        setStart({ url, pending: true })
        try {
          await apiRequest('POST', START_PATH, { url })
          setStart({ url, done: true })
        } catch (error) {
          setStart({ url, pending: false, error: error.message })
        }
      }

      const list = current?.list ?? []
      const validList = list.filter((item) => item?.valid === true)
      const invalidList = list.filter((item) => item?.valid === false)
      const selected = textOf(config.workflowName)
      const selectedMissing = selected && !validList.some((item) => item.name === selected)

      function choose(name) {
        if (!name) {
          props.onChange({ workflowName: '' })
          return
        }
        const found = validList.find((item) => item.name === name)
        if (!found) return
        const mapping = found.mapping || {}
        props.onChange({
          workflowName: name,
          workflowPath: '',
          model: hasText(found.model) ? found.model : found.label,
          promptNodeId: mapping.promptNodeId || '',
          negativeNodeId: mapping.negativeNodeId || '',
          seedNodeId: mapping.seedNodeId || '',
          widthNodeId: mapping.widthNodeId || '',
          heightNodeId: mapping.heightNodeId || '',
          outputNodeId: mapping.outputNodeId || '',
        })
      }

      return h('div', { className: 'dsh-si-field is-wide' },
        h(Field, { label: '模型 / 工作流' },
          h('select', {
            className: 'dsh-si-select',
            value: selected,
            onChange: (event) => choose(event.target.value),
          },
          h('option', { value: '' }, config.workflowPath ? '使用高级设置中的本地文件' : '选择工作流，或在高级设置中填写本地路径'),
          selectedMissing ? h('option', { value: selected }, selected + '（当前选择）') : null,
          validList.map((item) => h('option', { key: item.name, value: item.name },
            item.name + (item.model ? ' · ' + item.model : ''))))),
        h('div', { className: 'dsh-si-picker-row' },
          h('button', {
            type: 'button',
            className: 'dsh-si-btn',
            disabled: !parsedURL || current?.status === 'loading',
            onClick: () => setRefresh((previous) => previous + 1),
          }, current?.status === 'loading' ? '读取中…' : '刷新列表'),
          local && props.canStart && (current?.status === 'error' || starting)
            ? h('button', {
              type: 'button',
              className: 'dsh-si-btn is-primary',
              disabled: start?.pending === true,
              onClick: startServer,
            }, starting ? '启动中…' : '启动 ComfyUI')
            : null),
        h('div', { className: 'dsh-si-hint', role: 'status' },
          current?.error ? '读取失败：' + current.error + (validList.length ? '。列表来自上次成功读取。' : '') : null,
          current?.status === 'ok' && !validList.length ? '未找到可用工作流。请在 ComfyUI 导出 API 格式。' : null,
          start?.url === url && start.error ? h('div', { className: 'dsh-si-field-error' }, start.error) : null),
        invalidList.length > 0 ? h('details', { className: 'dsh-si-advanced' },
          h('summary', null, invalidList.length + ' 个工作流无法使用'),
          h('ul', { className: 'dsh-si-workflow-errors' }, invalidList.map((item) =>
            h('li', { key: item.name }, item.name + '：' + item.reason)))) : null)
    }


    function BackendCard(props) {
      const config = props.config || {}
      const credential = props.credential || null
      const [check, setCheck] = useState(null)
      const [checkRequest, setCheckRequest] = useState(null)
      const currentCheck = check?.config === config && check.credential === credential ? check : null
      const health = config.enabled ? currentCheck?.health || props.health || null : null
      const checking = checkRequest?.config === config && checkRequest.credential === credential && !currentCheck
      const isAPI = config.type !== 'comfyui'
      const issues = backendIssues(config, credential)
      const healthWarn = health !== null && health.level === 'warn'
      const healthBad = health !== null && health.ok === false && !healthWarn
      const invalid = issues.length > 0 || healthBad
      const side = props.side
      const accent = side === 'a' ? ' is-a' : ' is-b'
      const chipText = !config.enabled ? '已停用' : invalid ? '需修正' : healthWarn ? '连接异常' : health ? '已检查' : '待检查'
      const chipStyle = !config.enabled ? 'is-muted' : invalid ? 'is-bad' : healthWarn ? 'is-warn' : health ? 'is-ok' : 'is-muted'

      useEffect(function () {
        if (!checkRequest || checkRequest.config !== config || checkRequest.credential !== credential) return undefined
        const controller = new AbortController()
        apiRequest('POST', CHECK_PATH, { backend: side, config }, controller.signal).then(function (response) {
          if (!controller.signal.aborted) setCheck({ config, credential, health: response.health })
        }).catch(function (error) {
          if (!controller.signal.aborted) setCheck({ config, credential, health: { ok: false, message: error.message } })
        })
        return () => controller.abort()
      }, [checkRequest, config, credential, side])

      const checkDraft = useCallback(function () {
        setCheck(null)
        setCheckRequest({ config, credential })
      }, [config, credential])

      function change(patch) {
        props.onChange(patch)
      }

      let fields = null
      if (isAPI) {
        fields = h('div', { className: 'dsh-si-fields' },
          h(Field, { label: 'Base URL', wide: true },
            h(TextInput, {
              value: config.baseURL,
              placeholder: 'https://api.openai.com/v1',
              onChange: function (value) { change({ baseURL: value }) },
            })),
          h(Field, { label: '模型 ID' },
            h(TextInput, {
              value: config.model,
              placeholder: 'gpt-image-1',
              onChange: function (value) { change({ model: value }) },
            })),
          h(Field, { label: '尺寸' },
            h(TextInput, {
              value: config.size,
              placeholder: '1024x1024',
              onChange: function (value) { change({ size: value }) },
            })),
          h(Field, { label: '质量' },
            h(TextInput, {
              value: config.quality,
              placeholder: 'high',
              onChange: function (value) { change({ quality: value }) },
            })),
          h('div', { className: 'dsh-si-field is-wide' },
            h(CredentialRow, {
              side,
              credential: credential,
              value: props.credValue,
              busy: props.credBusy === true,
              error: props.credError,
              onChange: props.onCredentialChange,
              onSave: props.onSaveCredential,
              onClear: props.onClearCredential,
            })))
      } else {
        fields = h('div', { className: 'dsh-si-fields' },
          COMFY_TEXT_FIELDS.map(function (entry) {
            return h(Field, { key: entry[0], label: entry[1], wide: entry[3] === true },
              h(TextInput, {
                value: config[entry[0]],
                placeholder: entry[2],
                onChange: function (value) {
                  const patch = {}
                  patch[entry[0]] = value
                  change(patch)
                },
              }))
          }),
          h(ComfyPicker, {
            config,
            canStart: props.canStart,
            onChange: change,
            onStarted: checkDraft,
          }),
          h(Field, { label: '输出尺寸（宽x高）', wide: true },
            h(TextInput, {
              value: config.size,
              placeholder: '留空使用工作流尺寸，如 832x1216',
              onChange: function (value) { change({ size: value }) },
            })),
          h('details', { className: 'dsh-si-advanced' },
            h('summary', null, '高级：本地 workflow / 节点 ID / 超时'),
            h('div', { className: 'dsh-si-fields' },
              COMFY_ADVANCED_FIELDS.map(function (entry) {
                return h(Field, { key: entry[0], label: entry[1], wide: entry[3] === true },
                  h(TextInput, {
                    value: config[entry[0]],
                    placeholder: entry[2],
                    onChange: function (value) {
                      const patch = {}
                      patch[entry[0]] = value
                      change(patch)
                    },
                  }))
              }),
              h(Field, { label: '超时 ms' },
                h(NumberInput, {
                  value: config.timeoutMs,
                  min: 1000,
                  max: 3600000,
                  placeholder: '300000',
                  onCommit: function (value) { change({ timeoutMs: value }) },
                })),
              h(Field, { label: '轮询 ms' },
                h(NumberInput, {
                  value: config.pollMs,
                  min: 100,
                  max: 60000,
                  placeholder: '1000',
                  onCommit: function (value) { change({ pollMs: value }) },
                })),
              h('div', { className: 'dsh-si-field is-wide' },
                h('span', { className: 'dsh-si-hint' }, '优先使用所选模型/工作流；填写本地路径时直接读取文件。仅接受 API 格式，UI 格式会明确报错。')))))
      }

      return h('section', { className: 'dsh-si-card' + (invalid ? ' is-invalid' : '') },
        h('div', { className: 'dsh-si-card-head' },
          h('div', { className: 'dsh-si-card-ident' },
            h('span', { className: 'dsh-si-badge' + accent }, side.toUpperCase()),
            h('span', { className: 'dsh-si-card-title' }, '后端 ' + side.toUpperCase())),
          h('div', { className: 'dsh-si-card-head-right' },
            h('span', { className: 'dsh-si-chip ' + chipStyle }, chipText),
            h(Switch, {
              checked: config.enabled,
              label: '启用后端 ' + side.toUpperCase(),
              onChange: (enabled) => change({ enabled }),
            })),
          config.enabled ? h(Segmented, {
              value: isAPI ? 'api' : 'comfyui',
              ariaLabel: '后端 ' + side.toUpperCase() + ' 类型',
              options: [
                { value: 'api', label: 'API' },
                { value: 'comfyui', label: 'ComfyUI' },
              ],
              onChange: function (value) {
                if (value === config.type) return
                const size = value === 'comfyui' && config.size === '1024x1024' ? '' : config.size
                change({ type: value, size })
              },
            }) : null),
        config.enabled ? fields : null,
        issues.length > 0
          ? h('div', { className: 'dsh-si-field-error' }, issues.join('；'))
          : null,
        config.enabled ? h('div', { className: 'dsh-si-picker-row' },
          h('button', { type: 'button', className: 'dsh-si-btn', disabled: checking, onClick: checkDraft },
            checking ? '检查中…' : '检查配置'),
          h('div', { role: 'status', className: 'dsh-si-health' + (healthWarn ? ' is-warn' : (healthBad ? ' is-bad' : '')) },
            checking ? '' : health?.message)) : null)
    }

    function StrategySection(props) {
      const config = props.config
      const update = props.onChange
      const fusionOn = config.enableFusion !== false

      return h('section', { className: 'dsh-si-card dsh-si-strategy' },
        h('div', { className: 'dsh-si-card-head' },
          h('div', { className: 'dsh-si-card-ident' },
            h('span', { className: 'dsh-si-card-title' }, '策略'))),
        h('div', { className: 'dsh-si-strategy-grid' },
          h(Field, { label: '每个启用后端的生成数量' },
            h(NumberInput, {
              value: config.perBackendCount,
              min: 1,
              max: 4,
              onCommit: function (value) { update({ perBackendCount: value }) },
            }),
            h('span', { className: 'dsh-si-hint' }, '1–4 张，默认 1 张。')),
          h('div', { className: 'dsh-si-toggles' },
            h(ToggleRow, {
              label: '启用需求校验',
              checked: config.enableVerify !== false,
              onChange: function (value) { update({ enableVerify: value }) },
            }),
            h(ToggleRow, {
              label: '启用融合交付',
              checked: fusionOn,
              onChange: function (value) { update({ enableFusion: value }) },
            }))),
        h('div', { className: 'dsh-si-fusion' },
          h('span', { className: 'dsh-si-hint' }, '生成融合图需要启用需求校验、可用的视觉模型和至少两张候选图。'),
          h('span', { className: 'dsh-si-label' }, '融合方式'),
          h('div', {
            className: 'dsh-si-radio' + (fusionOn ? '' : ' is-disabled'),
            role: 'radiogroup',
            'aria-label': '融合方式',
          },
            FUSION_MODES.map(function (mode) {
              return h('label', { key: mode.value, className: 'dsh-si-radio-option' },
                h('input', {
                  type: 'radio',
                  name: 'dsh-si-fusion-mode',
                  value: mode.value,
                  checked: config.fusionMode === mode.value,
                  disabled: !fusionOn,
                  onChange: function () { update({ fusionMode: mode.value }) },
                }),
                h('span', null, mode.label))
            }))),
        h('details', { className: 'dsh-si-advanced' },
          h('summary', null, '高级：视觉模型（留空自动探测）'),
          h('div', { className: 'dsh-si-fields' },
            h(Field, { label: 'provider' },
              h(TextInput, {
                value: config.vlmProvider,
                placeholder: '留空自动探测',
                onChange: function (value) { update({ vlmProvider: value }) },
              })),
            h(Field, { label: 'model' },
              h(TextInput, {
                value: config.vlmModel,
                placeholder: '留空自动探测',
                onChange: function (value) { update({ vlmModel: value }) },
              }))),
          h('span', { className: 'dsh-si-hint' }, '留空则使用宿主机自动探测的视觉模型执行需求校验与融合。')))
    }

    function SettingsHeader() {
      return h('div', { className: 'dsh-si-header' },
        h('h2', { className: 'dsh-si-title' }, 'Super Image'),
        h('p', { className: 'dsh-si-subtitle' }, '启用并配置至少一个后端。保存后，在聊天中输入 /super-image 加上绘画需求。'))
    }

    function SuperImageSettings() {
      const [status, setStatus] = useState('loading')
      const [loadError, setLoadError] = useState(null)
      const [payload, setPayload] = useState(null)
      const [draft, setDraft] = useState(null)
      const [base, setBase] = useState(null)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [saved, setSaved] = useState(false)
      const [credValue, setCredValue] = useState({ a: '', b: '' })
      const [credBusy, setCredBusy] = useState({ a: false, b: false })
      const [credError, setCredError] = useState({ a: null, b: null })
      const alive = useRef(true)

      useEffect(function () {
        alive.current = true
        ensureStyle()
        return function () {
          alive.current = false
        }
      }, [])

      const load = useCallback(function () {
        setStatus('loading')
        setLoadError(null)
        apiRequest('GET', SETTINGS_PATH).then(function (response) {
          if (!alive.current) return
          const normalized = normalizeConfig(response.config)
          setPayload(Object.assign({}, response, { config: normalized }))
          setDraft(normalized)
          setBase(normalized)
          setSaved(false)
          setSaveError(null)
          setStatus('ready')
        }).catch(function (error) {
          if (!alive.current) return
          setLoadError(error && error.message ? error.message : '加载设置失败')
          setStatus('error')
        })
      }, [])

      useEffect(function () {
        load()
      }, [load])

      const updateConfig = useCallback(function (patch) {
        setDraft(function (prev) {
          if (!prev) return prev
          return Object.assign({}, prev, patch)
        })
        setSaved(false)
        setSaveError(null)
      }, [])

      const updateBackend = useCallback(function (side, patch) {
        const key = side === 'a' ? 'backendA' : 'backendB'
        setDraft(function (prev) {
          if (!prev) return prev
          const current = prev[key] || {}
          const merged = Object.assign({}, current, patch)
          const next = Object.assign({}, prev)
          next[key] = merged
          return next
        })
        setSaved(false)
        setSaveError(null)
      }, [])

      const patch = useMemo(() => draft && base ? configPatch(base, draft) : {}, [base, draft])
      const dirty = Object.keys(patch).length > 0
      const editingCredential = credBusy.a || credBusy.b

      const save = useCallback(function () {
        if (saving || !dirty || editingCredential) return
        setSaving(true)
        setSaveError(null)
        apiRequest('PUT', SETTINGS_PATH, { config: patch }).then(function (response) {
          if (!alive.current) return
          const nextConfig = normalizeConfig(response.config)
          setPayload(Object.assign({}, response, { config: nextConfig }))
          setDraft((current) => current === draft ? nextConfig : applyDraftPatch(nextConfig, configPatch(draft, current)))
          setBase(nextConfig)
          setSaved(true)
          setSaving(false)
        }).catch(function (error) {
          if (!alive.current) return
          setSaveError(error && error.message ? error.message : '保存失败')
          setSaving(false)
        })
      }, [draft, patch, dirty, saving, editingCredential])

      function discardChanges() {
        setDraft(base)
        setSaved(false)
        setSaveError(null)
      }

      const changeCredential = useCallback(function (side, value) {
        setCredValue(function (prev) {
          const next = Object.assign({}, prev)
          next[side] = value
          return next
        })
        setCredError(function (prev) {
          const next = Object.assign({}, prev)
          next[side] = null
          return next
        })
      }, [])

      const setCredBusyFor = function (side, busy) {
        setCredBusy(function (prev) {
          const next = Object.assign({}, prev)
          next[side] = busy
          return next
        })
      }

      const setCredErrorFor = function (side, message) {
        setCredError(function (prev) {
          const next = Object.assign({}, prev)
          next[side] = message
          return next
        })
      }

      const saveCredential = useCallback(function (side) {
        const value = (credValue[side] || '').trim()
        if (!value || saving || editingCredential) return
        setCredBusyFor(side, true)
        setCredErrorFor(side, null)
        apiRequest('POST', CREDENTIAL_PATH, { backend: side, value: value }).then(function (response) {
          if (!alive.current) return
          setPayload(function (prev) {
            if (!prev) return prev
            return Object.assign({}, prev, {
              credentials: response.credentials || prev.credentials,
              health: response.health || prev.health,
            })
          })
          setCredValue(function (prev) {
            const next = Object.assign({}, prev)
            next[side] = ''
            return next
          })
          setCredBusyFor(side, false)
        }).catch(function (error) {
          if (!alive.current) return
          setCredBusyFor(side, false)
          setCredErrorFor(side, error && error.message ? error.message : '密钥保存失败')
        })
      }, [credValue, saving, editingCredential])

      const clearCredential = useCallback(function (side) {
        if (saving || editingCredential) return
        setCredBusyFor(side, true)
        setCredErrorFor(side, null)
        apiRequest('DELETE', CREDENTIAL_PATH, { backend: side }).then(function (response) {
          if (!alive.current) return
          setPayload(function (prev) {
            if (!prev) return prev
            return Object.assign({}, prev, {
              credentials: response.credentials || prev.credentials,
              health: response.health || prev.health,
            })
          })
          setCredValue(function (prev) {
            const next = Object.assign({}, prev)
            next[side] = ''
            return next
          })
          setCredBusyFor(side, false)
        }).catch(function (error) {
          if (!alive.current) return
          setCredBusyFor(side, false)
          setCredErrorFor(side, error && error.message ? error.message : '密钥清除失败')
        })
      }, [saving, editingCredential])

      if (status === 'loading') {
        return h('div', { className: 'dsh-si-root' },
          h(SettingsHeader),
          h('div', { className: 'dsh-si-loading' },
            h('span', { className: 'dsh-si-dot' }),
            h('span', null, '正在加载设置…')))
      }

      if (status === 'error') {
        return h('div', { className: 'dsh-si-root' },
          h(SettingsHeader),
          h('div', { className: 'dsh-si-error-banner' },
            h('span', null, '加载失败：' + (loadError || '未知错误')),
            h('button', {
              type: 'button',
              className: 'dsh-si-btn',
              onClick: load,
            }, '重试')))
      }

      if (!draft) {
        return h('div', { className: 'dsh-si-root' }, h(SettingsHeader))
      }

      const credentials = payload && payload.credentials ? payload.credentials : {}
      const health = payload && payload.health ? payload.health : {}

      return h('div', { className: 'dsh-si-root' },
        h(SettingsHeader),
        h('div', { className: 'dsh-si-grid' },
          h(BackendCard, {
            side: 'a',
            config: draft.backendA,
            credential: credentials.a,
            health: draft.backendA === base.backendA ? health.a : null,
            credValue: credValue.a,
            credBusy: saving || editingCredential,
            credError: credError.a,
            onChange: function (patch) { updateBackend('a', patch) },
            onCredentialChange: function (value) { changeCredential('a', value) },
            onSaveCredential: function () { saveCredential('a') },
            onClearCredential: function () { clearCredential('a') },
            canStart: payload?.canStartComfy !== false,
          }),
          h(BackendCard, {
            side: 'b',
            config: draft.backendB,
            credential: credentials.b,
            health: draft.backendB === base.backendB ? health.b : null,
            credValue: credValue.b,
            credBusy: saving || editingCredential,
            credError: credError.b,
            onChange: function (patch) { updateBackend('b', patch) },
            onCredentialChange: function (value) { changeCredential('b', value) },
            onSaveCredential: function () { saveCredential('b') },
            onClearCredential: function () { clearCredential('b') },
            canStart: payload?.canStartComfy !== false,
          })),
        h(StrategySection, { config: draft, onChange: updateConfig }),
        !draft.backendA.enabled && !draft.backendB.enabled
          ? h('div', { className: 'dsh-si-hint', role: 'status' }, '当前两个后端都已停用。启用至少一个后端后即可生成。') : null,
        h('div', { className: 'dsh-si-footer' },
          h('div', { className: 'dsh-si-footer-status', role: 'status' },
            saveError ? h('span', { className: 'dsh-si-save-error' }, '保存失败：' + saveError) : null,
            saved && !dirty ? h('span', { className: 'dsh-si-saved' }, '已保存并生效') : null,
            dirty ? h('span', { className: 'dsh-si-dirty' }, '有未保存的更改') : null),
          h('div', { className: 'dsh-si-footer-actions' },
            h('button', {
              type: 'button', className: 'dsh-si-btn', disabled: saving || !dirty, onClick: discardChanges,
            }, '撤销未保存更改'),
            h('button', {
              type: 'button',
              className: 'dsh-si-btn is-primary',
              disabled: saving || !dirty || editingCredential,
              onClick: save,
            }, saving ? '保存中…' : '保存'))))
    }

    function SuperImageDockButton(props) {
      useEffect(function () {
        ensureStyle()
      }, [])

      const inputActions = props ? props.inputActions : null

      const handleClick = useCallback(function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (!inputActions || typeof inputActions.insertText !== 'function') return
        let insertion
        if (typeof inputActions.captureInsertion === 'function') {
          try {
            insertion = inputActions.captureInsertion()
          } catch (error) {
            insertion = undefined
          }
        }
        inputActions.insertText('/super-image ', insertion)
      }, [inputActions])

      return h('button', {
        type: 'button',
        className: 'dsh-si-dock',
        title: '插入 /super-image 绘画命令',
        'aria-label': 'Super Image',
        onClick: handleClick,
      },
        h('svg', {
          className: 'dsh-si-dock-icon',
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          focusable: 'false',
        },
          h('path', {
            d: 'M8 1.2 9.45 5.05 13.3 6.5 9.45 7.95 8 11.8 6.55 7.95 2.7 6.5 6.55 5.05Z',
            fill: 'currentColor',
          }),
          h('path', {
            d: 'M12.4 10.1 12.95 11.55 14.4 12.1 12.95 12.65 12.4 14.1 11.85 12.65 10.4 12.1 11.85 11.55Z',
            fill: 'currentColor',
          })),
        h('span', { className: 'dsh-si-dock-label' }, 'Super Image'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'super-image', order: 35, label: 'Super Image',
        }, SuperImageSettings))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'super-image', order: 2, label: 'Super Image',
        }, SuperImageDockButton))
      },
    }
  },
})

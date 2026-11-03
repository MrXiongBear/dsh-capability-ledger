/**
 * Client half of dsh-capability-ledger.
 *
 * Registers:
 *   - a "台账" action beside Settings (`sidebar.footer.action`)
 *   - the ledger page in the main column (`main` keyed entry), opened from it
 *
 * Read-only by design: the page fetches JSON from this bundle's Host half and renders
 * it. It never mutates the profile, never writes config, and never auto-removes
 * anything — a red finding comes with a copyable command and a human decides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-capability-ledger',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'capability-ledger'
    const REPORT_URL = 'api/capability-ledger/report'
    const AUDIT_URL = 'api/capability-ledger/audit'
    const CANDIDATE_URL = 'api/capability-ledger/candidate'
    const EXPORT_URL = 'api/capability-ledger/export'

    const GATE_COMMAND = 'node scripts/audit-cli.mjs   # 在插件目录下运行'
    const BACKUP_COMMAND =
      'Copy-Item <profile>\\package.json <profile>\\package.json.bak -Force; Copy-Item <profile>\\cordis.patch.yml <profile>\\cordis.patch.yml.bak -Force'

    const CSS = `
.dsh-ledger-root{box-sizing:border-box;flex:1 1 auto;height:100%;min-height:0;overflow:auto;padding-top:var(--dsh-frame-top-clearance,0px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.5}
.dsh-ledger-inner{box-sizing:border-box;max-width:1120px;margin:0 auto;padding:32px 36px 64px;display:flex;flex-direction:column;gap:16px}
.dsh-ledger-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dsh-ledger-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.01em}
.dsh-ledger-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-all}
.dsh-ledger-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-ledger-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease}
.dsh-ledger-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ledger-btn[disabled]{opacity:.55;cursor:default}
.dsh-ledger-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-ledger-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dsh-ledger-tab{border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dsh-ledger-tab[data-active="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-ledger-tab-count{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:4px}
.dsh-ledger-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.dsh-ledger-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-ledger-card-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ledger-card-value{font-size:22px;font-weight:600;line-height:1.2;word-break:break-word}
.dsh-ledger-card-hint{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-ledger-card[data-tone="warn"] .dsh-ledger-card-value{color:var(--dsw-alias-state-warn-primary)}
.dsh-ledger-card[data-tone="error"] .dsh-ledger-card-value{color:var(--dsw-alias-state-error-primary)}
.dsh-ledger-card[data-tone="success"] .dsh-ledger-card-value{color:var(--dsw-alias-state-success-primary)}
.dsh-ledger-panel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-ledger-panel-title{margin:0;font-size:14px;font-weight:600}
.dsh-ledger-panel-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ledger-muted{color:var(--dsw-alias-label-secondary)}
.dsh-ledger-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dsh-ledger-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.dsh-ledger-chip[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-ledger-input{box-sizing:border-box;flex:1 1 320px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:7px 10px}
.dsh-ledger-table-wrap{box-sizing:border-box;overflow:auto;max-height:min(56vh,640px);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.dsh-ledger-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dsh-ledger-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsh-ledger-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.dsh-ledger-table tr:last-child td{border-bottom:none}
.dsh-ledger-table td[data-num="true"],.dsh-ledger-table th[data-num="true"]{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-ledger-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-ledger-badge{display:inline-block;box-sizing:border-box;border-radius:999px;padding:1px 8px;font-size:11px;white-space:nowrap;border:1px solid transparent}
.dsh-ledger-badge[data-tone="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-ledger-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsh-ledger-badge[data-tone="success"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsh-ledger-badge[data-tone="muted"]{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.dsh-ledger-badge[data-tone="brand"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-ledger-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dsh-ledger-item{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-base)}
.dsh-ledger-item-text{flex:1 1 auto;min-width:0;font-size:12.5px;word-break:break-word}
.dsh-ledger-item[data-level="problem"]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-ledger-item[data-level="risk"]{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-ledger-banner{box-sizing:border-box;border-radius:10px;padding:10px 12px;font-size:13px;display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.dsh-ledger-banner[data-tone="error"]{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-ledger-banner[data-tone="warn"]{border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsh-ledger-banner[data-tone="muted"]{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsh-ledger-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:18px 0;text-align:center}
.dsh-ledger-kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:12.5px}
.dsh-ledger-kv dt{color:var(--dsw-alias-label-secondary)}
.dsh-ledger-kv dd{margin:0;min-width:0;word-break:break-all}
.dsh-ledger-copied{color:var(--dsw-alias-state-success-primary)}
.dsh-ledger-foot{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;display:flex;flex-direction:column;gap:4px}
.dsh-ledger-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dsh-ledger-spin{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-ledger-spin .8s linear infinite;vertical-align:-1px}
@keyframes dsh-ledger-spin{to{transform:rotate(360deg)}}
.dsh-ledger-trigger{display:inline-flex;align-items:center;gap:6px;border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:6px}
.dsh-ledger-trigger:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
`

    // --- formatting ------------------------------------------------------------

    function fmtInt(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return number.toLocaleString('zh-CN')
    }

    function fmtBytes(bytes) {
      const number = Number(bytes)
      if (!Number.isFinite(number) || number <= 0) return '0 B'
      if (number < 1024) return `${Math.round(number)} B`
      if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`
      return `${(number / 1024 / 1024).toFixed(2)} MB`
    }

    function fmtTime(ms) {
      const number = Number(ms)
      if (!Number.isFinite(number) || number <= 0) return '—'
      const date = new Date(number)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fmtAgo(ms) {
      const number = Number(ms)
      if (!Number.isFinite(number) || number <= 0) return '—'
      const delta = Date.now() - number
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`
      if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`
      return `${Math.round(delta / 86_400_000)} 天前`
    }

    function textOf(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      return String(error.message ?? error)
    }

    function skillVerdict(row) {
      if (row.verdict === 'unused') return { label: '零使用', tone: 'error' }
      if (row.verdict === 'watch') return { label: '观察', tone: 'warn' }
      return { label: '保留', tone: 'success' }
    }

    function toolVerdict(row) {
      if (row.verdict === 'unused') return { label: '零调用', tone: 'warn' }
      if (row.verdict === 'rare') return { label: '少量', tone: 'muted' }
      return { label: '常用', tone: 'success' }
    }

    function candidateTone(verdict) {
      if (verdict === 'fail') return 'error'
      if (verdict === 'warn') return 'warn'
      return 'success'
    }

    function candidateLabel(verdict) {
      if (verdict === 'fail') return '不可用'
      if (verdict === 'warn') return '有条件'
      return '通过'
    }

    function findingTone(level) {
      if (level === 'problem') return 'error'
      if (level === 'risk') return 'warn'
      return 'muted'
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          const element = document.createElement('style')
          element.setAttribute('data-dsh-capability-ledger', '')
          element.textContent = CSS
          ;(document.head || document.documentElement).appendChild(element)
          return () => element.remove()
        }, 'capability-ledger: styles')

        // --- small pieces -----------------------------------------------------

        function Badge(props) {
          return h('span', { className: 'dsh-ledger-badge', 'data-tone': props.tone ?? 'muted' }, props.children)
        }

        function CopyButton(props) {
          const [copied, setCopied] = React.useState(false)
          const timer = React.useRef(null)
          React.useEffect(() => () => {
            if (timer.current !== null) clearTimeout(timer.current)
          }, [])
          const copy = React.useCallback(() => {
            const text = props.text
            const done = () => {
              setCopied(true)
              if (timer.current !== null) clearTimeout(timer.current)
              timer.current = setTimeout(() => setCopied(false), 1400)
            }
            try {
              if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done))
                return
              }
            } catch {
              /* fall through to the DOM copy */
            }
            fallbackCopy(text, done)
          }, [props.text])
          return h(
            'button',
            { type: 'button', className: 'dsh-ledger-btn', onClick: copy, title: props.text },
            copied ? h('span', { className: 'dsh-ledger-copied' }, '已复制') : props.label ?? '复制',
          )
        }

        function fallbackCopy(text, done) {
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            document.body.removeChild(area)
            done()
          } catch {
            /* clipboard unavailable — the command stays visible for manual copy */
          }
        }

        function Stat(props) {
          return h(
            'div',
            { className: 'dsh-ledger-card', 'data-tone': props.tone ?? 'plain' },
            h('div', { className: 'dsh-ledger-card-label' }, props.label),
            h('div', { className: 'dsh-ledger-card-value' }, props.value),
            props.hint ? h('div', { className: 'dsh-ledger-card-hint' }, props.hint) : null,
          )
        }

        function Panel(props) {
          return h(
            'section',
            { className: 'dsh-ledger-panel' },
            props.title ? h('h3', { className: 'dsh-ledger-panel-title' }, props.title) : null,
            props.hint ? h('p', { className: 'dsh-ledger-panel-hint' }, props.hint) : null,
            props.actions,
            props.children,
          )
        }

        function Empty(props) {
          return h('div', { className: 'dsh-ledger-empty' }, props.children ?? '没有数据')
        }

        function FindList(props) {
          const rows = props.rows ?? []
          if (rows.length === 0) return h(Empty, null, props.emptyText ?? '没有条目')
          return h(
            'ul',
            { className: 'dsh-ledger-list' },
            rows.map((row, index) =>
              h(
                'li',
                { className: 'dsh-ledger-item', 'data-level': row.level ?? 'note', key: `${props.idPrefix ?? 'row'}-${index}` },
                h('div', { className: 'dsh-ledger-item-text' }, row.text),
                h(CopyButton, { text: row.text, label: '复制' }),
              ),
            ),
          )
        }

        function Table(props) {
          const columns = props.columns
          const rows = props.rows ?? []
          return h(
            'div',
            { className: 'dsh-ledger-table-wrap' },
            h(
              'table',
              { className: 'dsh-ledger-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  columns.map((column) =>
                    h('th', { key: column.key, 'data-num': column.num ? 'true' : 'false' }, column.label),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: rowIndex },
                    columns.map((column) =>
                      h('td', { key: column.key, 'data-num': column.num ? 'true' : 'false' }, column.render(row, rowIndex)),
                    ),
                  ),
                ),
              ),
            ),
          )
        }

        // --- data ------------------------------------------------------------

        function useReport() {
          const [win, setWin] = React.useState('all')
          const [state, setState] = React.useState({ status: 'loading', data: null, error: '' })
          const load = React.useCallback((force, windowId) => {
            setState((current) => ({ ...current, status: current.data === null ? 'loading' : 'refreshing', error: '' }))
            const params = new URLSearchParams()
            if (force) params.set('refresh', '1')
            if (windowId !== undefined && windowId !== 'all') params.set('window', windowId)
            const query = params.toString()
            const url = query ? `${REPORT_URL}?${query}` : REPORT_URL
            fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
              .then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
              .then(({ ok, payload }) => {
                if (!ok || payload?.ok === false) {
                  setState({ status: 'error', data: null, error: textOf(payload?.error ?? '请求失败') })
                  return
                }
                setState({ status: 'ready', data: payload, error: '' })
              })
              .catch((error) => setState({ status: 'error', data: null, error: textOf(error) }))
          }, [])
          React.useEffect(() => {
            load(false, win)
          }, [load, win])
          return { state, load, win, setWin }
        }

        function CandidatePanel() {
          const [spec, setSpec] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          const [result, setResult] = React.useState(null)
          const scan = React.useCallback(() => {
            const value = spec.trim()
            if (value.length === 0) return
            setBusy(true)
            setError('')
            fetch(CANDIDATE_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ spec: value }),
            })
              .then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
              .then(({ ok, payload }) => {
                if (!ok || payload?.ok === false) {
                  setError(textOf(payload?.error ?? '预检失败'))
                  setResult(null)
                } else {
                  setResult(payload.candidate ?? null)
                }
              })
              .catch((caught) => setError(textOf(caught)))
              .finally(() => setBusy(false))
          }, [spec])

          return h(
            Panel,
            {
              title: '候选预检',
              hint: '装之前先看：本地路径做完整静态扫描（会把客户端产物真实 materialize 一遍）；npm 包名只取元数据（npm view --json），不下 tarball，看不到源码。',
            },
            h(
              'div',
              { className: 'dsh-ledger-chips' },
              h('input', {
                className: 'dsh-ledger-input',
                value: spec,
                placeholder: 'npm 包名（如 dsh-skill-scoreboard）或本地插件目录（如 plugins/my-plugin）',
                onChange: (event) => setSpec(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') scan()
                },
              }),
              h('button', { type: 'button', className: 'dsh-ledger-btn dsh-ledger-btn-primary', onClick: scan, disabled: busy }, busy ? '扫描中…' : '扫描'),
            ),
            error ? h('div', { className: 'dsh-ledger-banner', 'data-tone': 'error' }, error) : null,
            result === null
              ? h(Empty, null, '还没有预检结果')
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'dsh-ledger-chips' },
                    h(Badge, { tone: candidateTone(result.verdict) }, candidateLabel(result.verdict)),
                    h('span', { className: 'dsh-ledger-panel-hint' }, `${result.kind === 'local' ? '本地目录' : result.kind === 'npm' ? 'npm 元数据' : '未知来源'} · ${result.spec}`),
                  ),
                  h(FindList, {
                    idPrefix: 'candidate',
                    rows: (result.findings ?? []).map((finding) => ({ level: finding.level, text: finding.text })),
                    emptyText: '没有发现',
                  }),
                  result.limits ? h('p', { className: 'dsh-ledger-panel-hint' }, `口径限制：${result.limits}`) : null,
                  result.name
                    ? h(
                        'dl',
                        { className: 'dsh-ledger-kv' },
                        h('dt', null, '包'),
                        h('dd', { className: 'dsh-ledger-mono' }, `${result.name}@${result.version || '?'}`),
                        result.dependencies ? h('dt', null, '依赖数') : null,
                        result.dependencies ? h('dd', null, fmtInt(result.dependencies.length)) : null,
                        result.bundlePatch ? h('dt', null, 'bundle patch') : null,
                        result.bundlePatch ? h('dd', { className: 'dsh-ledger-mono' }, result.bundlePatch) : null,
                      )
                    : null,
                ),
          )
        }

        function LedgerPanel() {
          const { state, load, win, setWin } = useReport()
          const [tab, setTab] = React.useState('overview')
          const [skillFilter, setSkillFilter] = React.useState('all')
          const [toolFilter, setToolFilter] = React.useState('all')
          const [exporting, setExporting] = React.useState(false)
          const [exportNote, setExportNote] = React.useState('')

          const exportReport = React.useCallback(() => {
            setExporting(true)
            setExportNote('')
            const url = win === 'all' ? EXPORT_URL : `${EXPORT_URL}?window=${win}`
            fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({}),
            })
              .then((response) => response.json())
              .then((payload) => {
                if (payload?.ok === false) setExportNote(textOf(payload.error))
                else setExportNote(`已写入 ${(payload?.written ?? []).length} 个文件：${(payload?.written ?? []).join('、')}`)
              })
              .catch((error) => setExportNote(textOf(error)))
              .finally(() => setExporting(false))
          }, [])

          if (state.status === 'loading') {
            return h(
              'div',
              { className: 'dsh-ledger-root' },
              h(
                'div',
                { className: 'dsh-ledger-inner' },
                h('div', { className: 'dsh-ledger-panel' }, h('span', { className: 'dsh-ledger-spin' }), ' 首次扫描中：读会话日志 + 体检已装插件，通常几秒钟。'),
              ),
            )
          }

          if (state.status === 'error') {
            return h(
              'div',
              { className: 'dsh-ledger-root' },
              h(
                'div',
                { className: 'dsh-ledger-inner' },
                h('h2', { className: 'dsh-ledger-title' }, '能力台账'),
                h(
                  'div',
                  { className: 'dsh-ledger-banner', 'data-tone': 'error' },
                  h('span', null, `扫描失败：${state.error}`),
                  h('button', { type: 'button', className: 'dsh-ledger-btn', onClick: () => load(true) }, '重试'),
                ),
              ),
            )
          }

          const data = state.data
          const ledger = data.ledger ?? {}
          const audit = data.audit ?? {}
          const diff = data.diff ?? null
          const sessions = ledger.sessions ?? {}
          const skills = ledger.skills ?? {}
          const tools = ledger.tools ?? {}
          const schema = ledger.schema ?? {}
          const windowInfo = ledger.window ?? data.window ?? {}
          const meta = data.meta ?? {}
          const warnings = [...new Set([...(ledger.scan?.warnings ?? []), ...(meta.warnings ?? [])])]
          const problemCount = (audit.problems ?? []).length
          const riskCount = (audit.risks ?? []).length

          const skillRows = (skills.rows ?? []).filter((row) => {
            if (skillFilter === 'unused') return row.verdict === 'unused'
            if (skillFilter === 'watch') return row.verdict === 'watch'
            if (skillFilter === 'keep') return row.verdict === 'keep'
            if (skillFilter === 'stale') return !row.inCatalog || row.truncatedInIndex
            return true
          })

          const toolRows = (tools.rows ?? []).filter((row) => {
            if (toolFilter === 'unused') return row.verdict === 'unused'
            if (toolFilter === 'rare') return row.verdict === 'rare'
            if (toolFilter === 'used') return row.verdict === 'used'
            return true
          })

          const tabs = [
            { id: 'overview', label: '总览' },
            { id: 'skills', label: '技能台账', count: skills.unused ? `${skills.unused} 零使用` : '' },
            { id: 'tools', label: '工具台账', count: tools.unused ? `${tools.unused} 零调用` : '' },
            { id: 'audit', label: '安全体检', count: problemCount > 0 ? `${problemCount} 红` : riskCount > 0 ? `${riskCount} 黄` : '' },
            { id: 'candidate', label: '候选预检' },
          ]

          // The archivable lists are plain text on purpose: the panel never deletes anything,
          // it hands you a paste-ready list you can act on yourself.
          const unusedSkills = (skills.rows ?? []).filter((row) => row.verdict === 'unused')
          const skillArchiveText = [
            `# 零使用技能（${unusedSkills.length} 个，加载 0 次）— ${fmtTime(data.generatedAt)}`,
            ...unusedSkills.map((row) => `${row.name}\t${row.source || ''}\t${row.inCatalog ? '在目录' : '不在目录'}${row.catalogObserved ? `\t模型可见 ${row.catalogChars} 字` : ''}`),
          ].join('\n')
          const unusedTools = (tools.rows ?? []).filter((row) => row.verdict === 'unused')
          const toolArchiveText = [
            `# 零调用工具（${unusedTools.length} 个，0 次真实调用）— ${fmtTime(data.generatedAt)}`,
            ...unusedTools.map((row) => `${row.name}\t${row.kind === 'mcp' ? `MCP: ${row.mcpServer}` : row.kind === 'plugin' ? row.owner || '插件' : '内置/动态'}\t${row.schemaBytes} B`),
          ].join('\n')

          return h(
            'div',
            { className: 'dsh-ledger-root' },
            h(
              'div',
              { className: 'dsh-ledger-inner' },
              h(
                'div',
                { className: 'dsh-ledger-head' },
                h(
                  'div',
                  { style: { minWidth: 0 } },
                  h('h2', { className: 'dsh-ledger-title' }, '能力台账 · 插件体检'),
                  h('p', { className: 'dsh-ledger-sub' }, `profile ${data.profile} · 生成于 ${fmtTime(data.generatedAt)}（${fmtAgo(data.generatedAt)}）· 只读${meta.scanMs ? ` · 扫描 ${fmtInt(meta.scanMs)} ms（新读 ${fmtInt(meta.scannedSessions)} 个会话，其余走缓存）` : ''}`),
                ),
                h(
                  'div',
                  { className: 'dsh-ledger-actions' },
                  exportNote ? h('span', { className: 'dsh-ledger-panel-hint', style: { maxWidth: '320px' } }, exportNote) : null,
                  h(
                    'button',
                    { type: 'button', className: 'dsh-ledger-btn', onClick: exportReport, disabled: exporting || state.status === 'refreshing' },
                    exporting ? '导出中…' : '导出报告',
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsh-ledger-btn dsh-ledger-btn-primary', onClick: () => load(true), disabled: state.status === 'refreshing' },
                    state.status === 'refreshing' ? '扫描中…' : '重新扫描',
                  ),
                ),
              ),

              problemCount > 0
                ? h(
                    'div',
                    { className: 'dsh-ledger-banner', 'data-tone': 'error' },
                    h('span', null, `体检发现 ${problemCount} 个红项：当前 profile 不应重启。`),
                    h('button', { type: 'button', className: 'dsh-ledger-btn', onClick: () => setTab('audit') }, '去体检页'),
                  )
                : null,
              h(
                'div',
                { className: 'dsh-ledger-chips', style: { marginTop: '4px' } },
                h('span', { className: 'dsh-ledger-panel-hint', style: { marginRight: '6px' } }, '统计窗口'),
                [
                  { id: 'all', label: `全部历史（${fmtInt(windowInfo.available ?? sessions.total)} 会话）` },
                  { id: '90', label: '最近 90 天' },
                  { id: '30', label: '最近 30 天' },
                ].map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      className: 'dsh-ledger-chip',
                      'data-active': win === item.id ? 'true' : 'false',
                      onClick: () => setWin(item.id),
                      disabled: state.status === 'refreshing',
                    },
                    item.label,
                  ),
                ),
                win === 'all'
                  ? null
                  : h('span', { className: 'dsh-ledger-panel-hint', style: { marginLeft: '6px' } }, `只看窗口内 ${fmtInt(windowInfo.covered ?? sessions.total)} 个会话；与「全部历史」的数字不可直接比较，也不做跨窗口 diff`),
              ),
              state.status === 'refreshing'
                ? h('div', { className: 'dsh-ledger-banner', 'data-tone': 'muted' }, h('span', null, h('span', { className: 'dsh-ledger-spin' }), ' 重新扫描中，下面是上一次的结果'))
                : null,

              h(
                'div',
                { className: 'dsh-ledger-tabs' },
                tabs.map((item) =>
                  h(
                    'button',
                    { key: item.id, type: 'button', className: 'dsh-ledger-tab', 'data-active': tab === item.id ? 'true' : 'false', onClick: () => setTab(item.id) },
                    item.label,
                    item.count ? h('span', { className: 'dsh-ledger-tab-count' }, item.count) : null,
                  ),
                ),
              ),

              tab === 'overview'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'dsh-ledger-grid' },
                      h(Stat, { label: '会话 / 轮次', value: `${fmtInt(sessions.total)} / ${fmtInt(sessions.turns)}`, hint: `子代理会话 ${fmtInt(sessions.subagent)} · 请求 ${fmtInt(sessions.requests)}` }),
                      h(Stat, { label: '工具调用', value: fmtInt(tools.calls), hint: `失败 ${fmtInt(tools.errors)} · 注册工具 ${fmtInt(tools.registered || tools.total)}` }),
                      h(Stat, {
                        label: '每请求注入（历史实测）',
                        value: fmtBytes(schema.bytesPerRequest),
                        hint: `≈${fmtInt(schema.tokensPerRequest)} token/请求 · 均值 ${fmtInt(schema.toolsPerRequest)} 工具 · 实测 ${fmtInt(schema.requestsMeasured)} 次请求`,
                        tone: 'warn',
                      }),
                      h(Stat, {
                        label: '当前注册表（下次请求）',
                        value: fmtBytes(schema.registryBytes),
                        hint: `≈${fmtInt(schema.registryTokens)} token · ${fmtInt(schema.registryTools)} 个工具${schema.bytesPerRequest ? ` · 历史均值的 ${Math.round(((schema.registryBytes ?? 0) / Math.max(1, schema.bytesPerRequest)) * 100)}%` : ''}`,
                        tone: 'muted',
                      }),
                      h(Stat, {
                        label: '技能零使用',
                        value: `${fmtInt(skills.unused)} / ${fmtInt(skills.total)}`,
                        hint: `观察 ${fmtInt(skills.watch)} · 保留 ${fmtInt(skills.keep)} · 加载事件 ${fmtInt(skills.loadEvents)}`,
                        tone: skills.unused > 0 ? 'warn' : 'success',
                      }),
                      h(Stat, {
                        label: '体检红项',
                        value: fmtInt(problemCount),
                        hint: `黄项 ${fmtInt(riskCount)} · ${audit.ok === false ? '不可重启' : '可重启'}`,
                        tone: problemCount > 0 ? 'error' : 'success',
                      }),
                    ),
                    h(
                      Panel,
                      { title: '固定成本按「能不能摘」分档（当前注册表）' },
                      (schema.byTier ?? []).length === 0
                        ? h(Empty, null, '没有注册表数据')
                        : h(Table, {
                            columns: [
                              { key: 'label', label: '来源', render: (row) => h('span', null, row.label, row.removable ? h(Badge, { tone: 'warn' }, '可摘') : h(Badge, { tone: 'muted' }, '不可动')) },
                              { key: 'bytes', label: '字节', num: true, render: (row) => fmtBytes(row.bytes) },
                              { key: 'tokens', label: '≈token', num: true, render: (row) => fmtInt(Math.round(row.bytes / (schema.bytesPerToken || 3.5))) },
                              { key: 'tools', label: '工具数', num: true, render: (row) => fmtInt(row.tools) },
                              { key: 'calls', label: '真实调用', num: true, render: (row) => fmtInt(row.calls) },
                            ],
                            rows: schema.byTier ?? [],
                          }),
                      h('p', { className: 'dsh-ledger-panel-hint' }, '「可摘」= 第三方插件或 MCP 服务，停用它们能真省掉这部分固定 schema；「不可动」是宿主与内置工具，摘不掉，只作为分母。成本按当前注册表算，与上面的历史实测是两个数。'),
                    ),
                    h(
                      Panel,
                      { title: '成本分布（当前注册表，按归属 bundle / MCP）' },
                      (schema.byBundle ?? []).length === 0
                        ? h(Empty, null, '没有归属数据')
                        : h(Table, {
                            columns: [
                              { key: 'bundle', label: 'bundle', render: (row) => h('span', { className: 'dsh-ledger-mono' }, row.bundle) },
                              { key: 'bytes', label: '字节', num: true, render: (row) => fmtBytes(row.bytes) },
                              { key: 'tools', label: '工具数', num: true, render: (row) => fmtInt(row.tools) },
                              { key: 'calls', label: '真实调用', num: true, render: (row) => fmtInt(row.calls) },
                              { key: 'share', label: '占比', num: true, render: (row) => `${schema.registryBytes ? Math.round((row.bytes / Math.max(1, schema.registryBytes)) * 100) : 0}%` },
                            ],
                            rows: schema.byBundle ?? [],
                          }),
                      h('p', { className: 'dsh-ledger-panel-hint' }, `归属口径：bundle 源码里出现该工具名（引号字面量）即归属之，覆盖率 ${meta.attribution ? meta.attribution.coverage : 0}%，扫了 ${meta.attribution ? fmtInt(meta.attribution.scannedFiles) : 0} 个文件；MCP 工具按 server 名单独成行，剩下的是内置/动态注册。`),
                    ),
                    diff !== null && diff !== undefined
                      ? h(
                          Panel,
                          { title: `与上次快照对比（${fmtTime(diff.since)}）` },
                          h(
                            'ul',
                            { className: 'dsh-ledger-list' },
                            h('li', { className: 'dsh-ledger-item' }, h('div', { className: 'dsh-ledger-item-text' }, `会话 ${diff.sessionsDelta >= 0 ? '+' : ''}${fmtInt(diff.sessionsDelta)} · 每请求字节 ${diff.bytesPerRequestDelta >= 0 ? '+' : ''}${fmtInt(diff.bytesPerRequestDelta)}`)),
                            (diff.newProblems ?? []).map((text, index) => h('li', { className: 'dsh-ledger-item', 'data-level': 'problem', key: `new-${index}` }, h('div', { className: 'dsh-ledger-item-text' }, `新增红项：${text}`))),
                            (diff.fixedProblems ?? []).map((text, index) => h('li', { className: 'dsh-ledger-item', key: `fix-${index}` }, h('div', { className: 'dsh-ledger-item-text' }, `已消失红项：${text}`))),
                            (diff.skillDeltas ?? []).map((row, index) => h('li', { className: 'dsh-ledger-item', key: `delta-${index}` }, h('div', { className: 'dsh-ledger-item-text' }, `技能加载 ${row.name}：${row.from} → ${row.to}`))),
                          ),
                        )
                      : h(Panel, { title: '与上次快照对比' }, h(Empty, null, '还没有上次快照；第一次「重新扫描」或「导出报告」后会开始积累对比。')),
                    warnings.length > 0
                      ? h(FindList, { idPrefix: 'warn', rows: warnings.map((text) => ({ level: 'note', text })), emptyText: '' })
                      : null,
                    h(
                      'div',
                      { className: 'dsh-ledger-foot' },
                      h('div', null, '口径：技能/工具的真实使用取自会话日志（skill 调用按 callId 配对成功结果）；每请求固定成本取自 request/header 注入的工具 schema 字节数，token 按 3.5 B/token 估算，只用于比较，不是账单。'),
                      h('div', null, '判定规则：0 加载且无 UI 依赖 → 建议删/归档；加载会话 <2 → 观察；≥2 → 保留。工具 0 调用 → 零调用，<3 → 少量，否则常用。判定是提示，不是自动动作。'),
                      h('div', null, '隐私：只读本机会话日志与 profile 清单，不上传任何会话内容；候选预检里只有「npm 包名」这一路会联网查元数据。'),
                    ),
                  )
                : null,

              tab === 'skills'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'dsh-ledger-chips' },
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': skillFilter === 'all' ? 'true' : 'false', onClick: () => setSkillFilter('all') }, `全部 ${skills.total ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': skillFilter === 'unused' ? 'true' : 'false', onClick: () => setSkillFilter('unused') }, `零使用 ${skills.unused ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': skillFilter === 'watch' ? 'true' : 'false', onClick: () => setSkillFilter('watch') }, `观察 ${skills.watch ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': skillFilter === 'keep' ? 'true' : 'false', onClick: () => setSkillFilter('keep') }, `保留 ${skills.keep ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': skillFilter === 'stale' ? 'true' : 'false', onClick: () => setSkillFilter('stale') }, `目录/截断 ${(skills.notInCatalog ?? 0) + (skills.truncatedInIndex ?? 0)}`),
                      h('span', { style: { flex: 1 } }),
                      unusedSkills.length > 0 ? h(CopyButton, { text: skillArchiveText, label: `复制零使用清单（${unusedSkills.length}）` }) : null,
                    ),
                    skillRows.length === 0
                      ? h(Empty, null, '该筛选下没有技能')
                      : h(Table, {
                          columns: [
                            { key: 'name', label: '技能', render: (row) => h('span', { className: 'dsh-ledger-mono' }, row.name) },
                            { key: 'loads', label: '加载', num: true, render: (row) => (row.slashLoads ? h('span', { title: `其中斜杠调用 ${row.slashLoads} 次` }, `${fmtInt(row.loads)} (斜杠 ${row.slashLoads})`) : fmtInt(row.loads)) },
                            { key: 'sessions', label: '会话', num: true, render: (row) => fmtInt(row.sessions) },
                            { key: 'attempts', label: '尝试', num: true, render: (row) => `${fmtInt(row.attempts)}${row.failures ? ` (失败 ${row.failures})` : ''}` },
                            { key: 'desc', label: '描述字数', num: true, render: (row) => {
                              if (row.catalogObserved && !row.descriptionKnown) {
                                return h('span', { title: '完整描述在 agent preset 层，宿主插件看不到；这里只能用模型可见字数判断是否顶到上限' }, `可见 ${fmtInt(row.catalogChars)}`, row.truncationEvidence === 'suspected' ? h(Badge, { tone: 'warn' }, '疑似截断') : null)
                              }
                              if (row.catalogObserved) {
                                return h('span', { title: '注入目录里可见的字数 / 完整字数' }, row.truncatedInIndex ? h(Badge, { tone: 'warn' }, `${row.catalogChars}/${row.descriptionChars}`) : `${row.catalogChars}/${row.descriptionChars}`)
                              }
                              return row.truncatedInIndex ? h(Badge, { tone: 'warn' }, `${row.descriptionChars} 超上限`) : fmtInt(row.descriptionChars)
                            } },
                            { key: 'catalog', label: '目录', render: (row) => (row.inCatalog ? h(Badge, { tone: 'muted' }, row.source || '在') : h(Badge, { tone: 'warn' }, '不在目录')) },
                            { key: 'last', label: '最后加载', render: (row) => (row.lastAt ? h('span', { title: fmtTime(row.lastAt) }, fmtAgo(row.lastAt)) : '—') },
                            { key: 'verdict', label: '判定', render: (row) => h(Badge, { tone: skillVerdict(row).tone }, skillVerdict(row).label) },
                          ],
                          rows: skillRows,
                        }),
                    h('p', { className: 'dsh-ledger-panel-hint' }, '「描述字数」的 a/b 是「模型实际看到的字数 / 完整字数」，取自会话里 skill-catalog 注入事件，所以截断是真观测到的。若完整描述不可得（技能注册在 agent preset 层），只显示「可见 N」，顶到 500 上限的标「疑似截断」——不猜成确定结论。'),
                  )
                : null,

              tab === 'tools'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'dsh-ledger-chips' },
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': toolFilter === 'all' ? 'true' : 'false', onClick: () => setToolFilter('all') }, `全部 ${tools.total ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': toolFilter === 'unused' ? 'true' : 'false', onClick: () => setToolFilter('unused') }, `零调用 ${tools.unused ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': toolFilter === 'rare' ? 'true' : 'false', onClick: () => setToolFilter('rare') }, `少量 ${tools.rare ?? 0}`),
                      h('button', { type: 'button', className: 'dsh-ledger-chip', 'data-active': toolFilter === 'used' ? 'true' : 'false', onClick: () => setToolFilter('used') }, `常用 ${tools.used ?? 0}`),
                      h('span', { style: { flex: 1 } }),
                      unusedTools.length > 0 ? h(CopyButton, { text: toolArchiveText, label: `复制零调用清单（${unusedTools.length}）` }) : null,
                    ),
                    toolRows.length === 0
                      ? h(Empty, null, '该筛选下没有工具')
                      : h(Table, {
                          columns: [
                            { key: 'name', label: '工具', render: (row) => h('span', { className: 'dsh-ledger-mono' }, row.name) },
                            { key: 'calls', label: '调用', num: true, render: (row) => fmtInt(row.calls) },
                            { key: 'errors', label: '失败', num: true, render: (row) => (row.errors ? h(Badge, { tone: 'error' }, fmtInt(row.errors)) : '0') },
                            { key: 'schema', label: 'schema', num: true, render: (row) => fmtBytes(row.schemaBytes) },
                            { key: 'injected', label: '注入', render: (row) => (row.injected ? h(Badge, { tone: 'muted' }, '是') : '—') },
                            { key: 'kind', label: '来源', render: (row) => (row.kind === 'mcp' ? h(Badge, { tone: 'warn' }, `MCP: ${row.mcpServer}`) : row.kind === 'plugin' ? h(Badge, { tone: 'muted' }, '插件') : h('span', { className: 'dsh-ledger-muted' }, '内置/动态')) },
                            { key: 'owner', label: '归属', render: (row) => h('span', { className: 'dsh-ledger-mono' }, row.owner || (row.kind === 'mcp' ? `MCP: ${row.mcpServer}` : '—')) },
                            { key: 'verdict', label: '判定', render: (row) => h(Badge, { tone: toolVerdict(row).tone }, toolVerdict(row).label) },
                          ],
                          rows: toolRows,
                        }),
                    h(Table, {
                      columns: [
                        { key: 'bundle', label: 'bundle', render: (row) => h('span', { className: 'dsh-ledger-mono' }, row.bundle) },
                        { key: 'bytes', label: '固定字节', num: true, render: (row) => fmtBytes(row.bytes) },
                        { key: 'tokens', label: '≈token', num: true, render: (row) => fmtInt(Math.round(row.bytes / (schema.bytesPerToken || 3.5))) },
                        { key: 'tools', label: '工具数', num: true, render: (row) => fmtInt(row.tools) },
                        { key: 'calls', label: '真实调用', num: true, render: (row) => fmtInt(row.calls) },
                      ],
                      rows: schema.byBundle ?? [],
                    }),
                  )
                : null,

              tab === 'audit'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'dsh-ledger-grid' },
                      h(Stat, { label: '结论', value: audit.ok === false ? '不可重启' : '可重启', hint: `bundles ${fmtInt(audit.bundles)} · deps ${fmtInt(audit.deps)} · patch ${fmtInt(audit.patch?.lines)} 行`, tone: audit.ok === false ? 'error' : 'success' }),
                      h(Stat, { label: '应用版本', value: audit.appVersion ? audit.appVersion : '未识别', hint: audit.appVersion ? `内置副本对比对象${audit.appRoot ? ` · ${audit.appRoot}` : ''}` : '找不到应用自带副本，版本漂移未检查', tone: audit.appVersion ? 'success' : 'warn' }),
                      h(Stat, { label: '红项', value: fmtInt(problemCount), hint: '会拦重启', tone: problemCount > 0 ? 'error' : 'success' }),
                      h(Stat, { label: '黄项', value: fmtInt(riskCount), hint: '形态风险，当前不失败', tone: riskCount > 0 ? 'warn' : 'success' }),
                      h(Stat, { label: '体检时间', value: audit.scannedAt ? fmtAgo(audit.scannedAt) : '—', hint: `扫描于 ${fmtTime(audit.scannedAt)}${meta.scanMs ? ` · 台账扫描 ${fmtInt(meta.scanMs)} ms` : ''}` }),
                    ),
                    h(
                      Panel,
                      { title: '处置命令（复制后自己跑，插件不会替你改配置）' },
                      h(
                        'ul',
                        { className: 'dsh-ledger-list' },
                        [
                          { label: '重启前闸门（红项非零则不重启）', text: GATE_COMMAND },
                          { label: '改 profile 前先备份', text: BACKUP_COMMAND },
                        ].map((item, index) =>
                          h(
                            'li',
                            { className: 'dsh-ledger-item', key: `cmd-${index}` },
                            h(
                              'div',
                              { className: 'dsh-ledger-item-text' },
                              h('div', { className: 'dsh-ledger-panel-hint' }, item.label),
                              h('div', { className: 'dsh-ledger-mono' }, item.text),
                            ),
                            h(CopyButton, { text: item.text, label: '复制命令' }),
                          ),
                        ),
                      ),
                    ),
                    problemCount > 0
                      ? h(Panel, { title: `红项 ${problemCount}` }, h(FindList, { idPrefix: 'problem', rows: (audit.problems ?? []).map((text) => ({ level: 'problem', text })) }))
                      : h(Panel, { title: '红项' }, h(Empty, null, '没有红项')),
                    riskCount > 0 ? h(Panel, { title: `黄项 ${riskCount}` }, h(FindList, { idPrefix: 'risk', rows: (audit.risks ?? []).map((text) => ({ level: 'risk', text })) })) : null,
                    (audit.versionDrift ?? []).length > 0
                      ? h(Panel, { title: '版本漂移（@deepseek-ai 副本 vs 应用内置）' }, h(FindList, { idPrefix: 'drift', rows: (audit.versionDrift ?? []).map((row) => ({ level: 'risk', text: `${row.package}: profile ${row.profile} / app ${row.app}` })) }))
                      : null,
                    h(
                      Panel,
                      { title: '逐 bundle 明细', hint: `${(audit.rows ?? []).length} 个条目 · client 一列是把产物真实 materialize 的结果` },
                      h(Table, {
                        columns: [
                          { key: 'id', label: 'bundle', render: (row) => h('span', { className: 'dsh-ledger-mono' }, row.id) },
                          { key: 'present', label: '安装', render: (row) => (row.present ? '是' : h(Badge, { tone: 'error' }, '缺失')) },
                          { key: 'status', label: '状态', render: (row) => (row.status === 'ok' || row.status === 'builtin' ? h(Badge, { tone: 'muted' }, row.status) : h(Badge, { tone: 'warn' }, row.status)) },
                          { key: 'client', label: 'client', render: (row) => (row.client === 'ok' ? h(Badge, { tone: 'success' }, 'ok') : h('span', { className: 'dsh-ledger-mono' }, row.client)) },
                          { key: 'bytes', label: '字节', num: true, render: (row) => (row.clientBytes === undefined ? '' : fmtBytes(row.clientBytes)) },
                          { key: 'version', label: '版本', render: (row) => row.version || '' },
                          { key: 'peers', label: '非可选 peer', num: true, render: (row) => fmtInt((row.requiredPeers ?? []).length) },
                          { key: 'scripts', label: '安装脚本', render: (row) => ((row.installScripts ?? []).length > 0 ? h(Badge, { tone: 'warn' }, row.installScripts.join(',')) : '') },
                        ],
                        rows: audit.rows ?? [],
                      }),
                    ),
                    (audit.notes ?? []).length > 0
                      ? h(
                          'details',
                          { className: 'dsh-ledger-details' },
                          h('summary', null, `说明 ${(audit.notes ?? []).length} 条（信息性，无需动作）`),
                          h(FindList, { idPrefix: 'note', rows: (audit.notes ?? []).map((text) => ({ level: 'note', text })) }),
                        )
                      : null,
                    h(
                      'div',
                      { className: 'dsh-ledger-foot' },
                      h('div', null, '体检口径：读 profile 的 package.json / cordis.patch.yml 与每个已装 bundle；客户端产物用 window shim 真实执行一次（和加载器同一契约），只跑 factory 不跑业务代码；不安装、不停用、不改任何配置。'),
                      h('div', null, '红项 = 现在就会连坐启动（client 无法 materialize / bundle 未安装 / 入口缺失 / 明文凭据）；黄项 = 曾经导致崩溃的形态或升级后容易过期，当前不失败。'),
                    ),
                  )
                : null,

              tab === 'candidate' ? h(CandidatePanel, null) : null,
            ),
          )
        }

        function TriggerAction() {
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-ledger-trigger',
              title: '打开能力台账：技能/工具真实使用 + 已装插件体检（只读）',
              onClick: () => {
                try {
                  ctx.layout.selectPanel(PANEL_ID)
                } catch {
                  /* nothing selected means the panel is not registered yet */
                }
              },
            },
            '台账',
          )
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'capability-ledger-action',
              order: 1,
              label: () => '台账',
            },
            TriggerAction,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            LedgerPanel,
          ),
        )
      },
    }
  },
})

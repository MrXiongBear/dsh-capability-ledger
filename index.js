/**
 * dsh-capability-ledger — Host half.
 *
 * One scan answers two questions that usually need two different tools:
 *
 *   1. LEDGER   What is actually used? Skill loads and tool calls are folded out of the
 *               session log (the only place where "the model really loaded this" is
 *               recorded), and the fixed per-request schema bill is measured from the
 *               tool schemas each `request/header` injected.
 *   2. AUDIT    Is what we installed safe to boot? Every bundle's client artifact is
 *               materialized against the same window shim the loader uses; non-optional
 *               host peers, install scripts, plaintext credentials, version drift and
 *               deps-without-bundles are reported.
 *
 * Read-only. Nothing here installs, disables, removes or rewrites a plugin: a red finding
 * comes with a copyable command and a human decides. The only writes are report snapshots
 * under the report directory.
 *
 * Attribution note: the runtime does not expose which bundle registered a tool, so the
 * per-bundle schema cost is a static heuristic (see lib/owners.mjs) and is labelled as
 * such in the payload.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { buildLedger, diffLedgers, summarizeSession } from './lib/ledger.mjs'
import { auditProfile } from './lib/audit.mjs'
import { buildToolOwners } from './lib/owners.mjs'
import { checkCandidate } from './lib/candidate.mjs'
import { renderMarkdown } from './lib/report.mjs'

export const name = 'dsh-capability-ledger'
export const inject = ['connection', 'sessionPersistence']

const ROUTE_ROOT = '/api/capability-ledger'
const REPORT_PATH = `${ROUTE_ROOT}/report`
const AUDIT_PATH = `${ROUTE_ROOT}/audit`
const CANDIDATE_PATH = `${ROUTE_ROOT}/candidate`
const EXPORT_PATH = `${ROUTE_ROOT}/export`

const CHUNK_EVENTS = 1_000
const MAX_EVENTS_PER_SESSION = 200_000
const MAX_SESSIONS = 400
const SCAN_CONCURRENCY = 4
const DAY_MS = 86_400_000
const MAX_WINDOW_DAYS = 3_650

const LEDGER_TTL_MS = 30_000
const AUDIT_TTL_MS = 60_000
const OWNERS_TTL_MS = 10 * 60_000
const AUTOSAVE_TTL_MS = 60_000

const BODY_LIMIT = 8 * 1024
const SPEC_LIMIT = 300

const LATEST_FILE = 'capability-ledger-latest.json'

const DEFAULT_DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const DEFAULT_PROFILE_DIR = path.join(DEFAULT_DSH_HOME, 'profiles', process.env.DSH_PROFILE_NAME ?? 'default')
const DEFAULT_REPORT_DIR = path.join(process.env.DSH_WORKSPACE ?? process.cwd(), 'reports')

export function apply(ctx) {
  const profileDir = resolveDirectory(process.env.DSH_PROFILE_DIR, DEFAULT_PROFILE_DIR)
  const reportDir = resolveDirectory(process.env.DSH_CAPABILITY_LEDGER_DIR, DEFAULT_REPORT_DIR)

  const state = {
    /** window key -> { ledger, meta, at, promise } */
    ledgers: new Map(),
    audit: null,
    auditAt: 0,
    auditPromise: null,
    owners: null,
    ownersAt: 0,
    ownersPromise: null,
    /** session id -> { revision, summary } — shared by every window, revisions are truth */
    sessions: new Map(),
    /** last snapshot this process produced, used for the diff */
    snapshot: null,
    /** last snapshot read back from disk, used before the first scan of a fresh process */
    fileSnapshot: null,
    fileSnapshotLoaded: false,
    autosaveAt: 0,
  }

  // A finished turn (or a brand new session) means the usage numbers moved. Drop the
  // ledger age rather than the value: the next read rescans once and callers keep their
  // last good answer while that happens.
  ctx.on('turn/end', () => {
    invalidate()
  })
  ctx.on('session/event', (_session, event) => {
    if (event !== null && typeof event === 'object' && (event.type === 'session' || event.type === 'turn/end')) invalidate()
  })

  // --- scan --------------------------------------------------------------

  function invalidate() {
    for (const entry of state.ledgers.values()) entry.at = 0
    state.auditAt = 0
  }

  async function ensureLedger(force, sinceDays) {
    const key = windowKey(sinceDays)
    const cached = state.ledgers.get(key)
    if (cached !== undefined) {
      if (!force && cached.ledger !== null && Date.now() - cached.at < LEDGER_TTL_MS) return cached
      if (cached.promise !== null) return cached.promise
    }
    const entry = cached ?? { ledger: null, meta: null, at: 0, promise: null }
    state.ledgers.set(key, entry)
    entry.promise = (async () => {
      try {
        const result = await scanLedger(sinceDays)
        entry.ledger = result.ledger
        entry.meta = result.meta
        entry.at = Date.now()
        return entry
      } finally {
        entry.promise = null
      }
    })()
    return entry.promise
  }

  async function ensureAudit(force) {
    if (!force && state.audit !== null && Date.now() - state.auditAt < AUDIT_TTL_MS) return state.audit
    if (state.auditPromise !== null) return state.auditPromise
    state.auditPromise = (async () => {
      try {
        const report = await auditProfile(profileDir)
        state.audit = report
        state.auditAt = Date.now()
        return report
      } finally {
        state.auditPromise = null
      }
    })()
    return state.auditPromise
  }

  async function ensureOwners(bundleIds, toolNames) {
    const key = `${bundleIds.length}:${toolNames.length}`
    if (state.owners !== null && state.owners.key === key && Date.now() - state.ownersAt < OWNERS_TTL_MS) return state.owners.value
    if (state.ownersPromise !== null) return state.ownersPromise
    state.ownersPromise = (async () => {
      try {
        const value = await buildToolOwners({ profileDir, bundleIds, toolNames })
        state.owners = { key, value }
        state.ownersAt = Date.now()
        return value
      } finally {
        state.ownersPromise = null
      }
    })()
    return state.ownersPromise
  }

  async function scanLedger(sinceDays) {
    const persistence = service(ctx, 'sessionPersistence')
    if (persistence === null) throw new Error('sessionPersistence 服务不可用：无法读取会话日志')

    const startedAt = Date.now()
    const warnings = []
    const snapshots = await listSessions(persistence)
    const all = snapshots
      .filter((snapshot) => snapshot !== null && typeof snapshot === 'object' && snapshot.header && typeof snapshot.header.id === 'string')
      .filter((snapshot) => snapshot.formatStatus === undefined || snapshot.formatStatus === 'current')
      .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))

    // A bounded window is a different question ("what is live now"), not a cheaper way to ask
    // the same one, so the window rides along in the payload and the panel says which it shows.
    const since = sinceDays === null ? null : startedAt - sinceDays * DAY_MS
    const inWindow = since === null ? all : all.filter((snapshot) => (snapshot.header.createdAt ?? 0) >= since)
    const usable = inWindow.slice(0, MAX_SESSIONS)
    if (inWindow.length > MAX_SESSIONS) warnings.push(`窗口内 ${inWindow.length} 个会话超过上限 ${MAX_SESSIONS}，只统计最近 ${MAX_SESSIONS} 个`)

    const cached = state.sessions
    const keepIds = new Set(usable.map((snapshot) => snapshot.header.id))
    for (const id of [...cached.keys()]) if (!keepIds.has(id)) cached.delete(id)

    let freshSessions = 0
    const summaries = await mapLimit(usable, SCAN_CONCURRENCY, async (snapshot) => {
      const id = snapshot.header.id
      const hit = cached.get(id)
      if (hit !== undefined && hit.revision === snapshot.revision) return hit.summary
      freshSessions += 1
      try {
        const events = await readSessionEvents(persistence, id)
        const summary = summarizeSession(snapshot, events)
        cached.set(id, { revision: snapshot.revision, summary })
        return summary
      } catch (error) {
        warnings.push(`会话 ${id} 读取失败：${describe(error)}`)
        const summary = summarizeSession(snapshot, [])
        cached.set(id, { revision: snapshot.revision, summary })
        return summary
      }
    })

    const skills = await listSkillCatalog(summaries, warnings)
    const schemas = listToolSchemas(ctx, warnings)

    const profileManifest = readProfileManifest()
    const bundleIds = Array.isArray(profileManifest?.dsh?.profile?.bundles) ? profileManifest.dsh.profile.bundles : []
    const toolNames = new Set(schemas.map((schema) => schema.name))
    let attribution = { owners: {}, coverage: 0, scannedFiles: 0, scannedBytes: 0 }
    if (bundleIds.length > 0 && toolNames.size > 0) {
      attribution = await ensureOwners(bundleIds, [...toolNames])
    } else if (bundleIds.length === 0) {
      warnings.push('profile package.json 里没有 dsh.profile.bundles：跳过工具→bundle 归属')
    }

    const window = {
      sinceDays: sinceDays === null ? null : sinceDays,
      since,
      covered: summaries.length,
      available: all.length,
    }

    const ledger = buildLedger({
      sessions: summaries.filter((summary) => summary !== null),
      skills,
      tools: schemas,
      toolOwners: attribution.owners ?? {},
      generatedAt: Date.now(),
      profile: profileDir,
      window,
    })

    // The host registry only carries the layers this plugin can see; bundled skills register
    // in the agent-preset layer, so their full description is out of reach. Say so instead of
    // silently rendering a 0-length "full" text.
    const missingDescriptions = ledger.skills.total - ledger.skills.descriptionKnown
    if (missingDescriptions > 0) {
      warnings.push(
        `完整描述只拿到 ${ledger.skills.descriptionKnown}/${ledger.skills.total} 个技能（其余注册在 agent preset 层，宿主插件看不到全文）：这些技能的截断只标「疑似」，按模型可见字数是否顶到 500 上限判断`,
      )
    }

    return {
      ledger,
      meta: {
        scanMs: Date.now() - startedAt,
        scannedSessions: summaries.length,
        reusedSessions: summaries.length - freshSessions,
        window,
        attribution: {
          coverage: attribution.coverage ?? 0,
          scannedFiles: attribution.scannedFiles ?? 0,
          scannedBytes: attribution.scannedBytes ?? 0,
          method: '静态归属：某 bundle 源码里出现该工具名的引号字面量即归属之；运行时 API 不暴露 owner。',
        },
        warnings,
      },
    }
  }

  async function listSessions(persistence) {
    const list = persistence.list.bind(persistence)
    const result = await list()
    return Array.isArray(result) ? result : []
  }

  async function readSessionEvents(persistence, id) {
    const handle = await persistence.open(id, 'read')
    try {
      const inherited = Number(handle?.inheritedEventCount) || 0
      const events = []
      let offset = 0
      for (;;) {
        const chunk = await handle.read(offset, CHUNK_EVENTS)
        const batch = Array.isArray(chunk) ? chunk : Array.isArray(chunk?.events) ? chunk.events : []
        if (batch.length === 0) break
        for (const event of batch) {
          const seq = Number(event?.seq)
          if (Number.isFinite(seq) && seq < inherited) continue
          events.push(event)
        }
        offset += batch.length
        if (batch.length < CHUNK_EVENTS) break
        if (events.length >= MAX_EVENTS_PER_SESSION) break
      }
      return events
    } finally {
      try {
        await handle.close()
      } catch {
        /* a read-only handle that is already gone needs no further cleanup */
      }
    }
  }

  async function listSkillCatalog(summaries, warnings) {
    const skills = service(ctx, 'skills')
    if (skills === null || typeof skills.list !== 'function') {
      warnings.push('skills 服务不可用：技能目录为空，只能看到历史加载记录')
      return []
    }
    const cwds = []
    for (const summary of summaries) {
      const cwd = summary?.cwd
      if (typeof cwd === 'string' && cwd.length > 0 && !cwds.includes(cwd)) cwds.push(cwd)
      if (cwds.length >= 5) break
    }
    const byName = new Map()
    const attempts = [{}, ...cwds.map((cwd) => ({ cwd }))]
    for (const options of attempts) {
      try {
        const list = await skills.list(options)
        for (const item of Array.isArray(list) ? list : []) {
          if (item === null || typeof item !== 'object' || typeof item.name !== 'string') continue
          if (!byName.has(item.name)) byName.set(item.name, item)
        }
      } catch (error) {
        warnings.push(`技能目录读取失败（${options.cwd ?? '默认 cwd'}）：${describe(error)}`)
      }
    }
    return [...byName.values()]
  }

  function listToolSchemas(context, warnings) {
    const tools = service(context, 'tools')
    if (tools === null || typeof tools.schemas !== 'function') {
      warnings.push('tools 服务不可用：注册表为空，固定 schema 成本记为 0')
      return []
    }
    try {
      const schemas = tools.schemas()
      return Array.isArray(schemas) ? schemas : []
    } catch (error) {
      warnings.push(`工具 schema 读取失败：${describe(error)}`)
      return []
    }
  }

  function readProfileManifest() {
    try {
      return JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    } catch {
      return null
    }
  }

  // --- snapshot ----------------------------------------------------------

  async function buildSnapshot(force, sinceDays) {
    const [ledgerResult, audit] = await Promise.all([ensureLedger(force, sinceDays), ensureAudit(force)])
    const previous = await previousSnapshot()
    const window = ledgerResult.ledger?.window ?? { sinceDays: sinceDays ?? null, since: null, covered: 0, available: 0 }
    const snapshot = {
      generatedAt: Date.now(),
      profile: profileDir,
      reportDir,
      window,
      ledger: ledgerResult.ledger,
      audit,
      meta: {
        ...ledgerResult.meta,
        ledgerAgeMs: Date.now() - ledgerResult.at,
        auditAgeMs: Date.now() - state.auditAt,
        cachedSessions: state.sessions.size,
      },
    }
    // A diff only means something between two snapshots of the same window; comparing a
    // 30-day cut against the all-history baseline would read as "94 sessions disappeared".
    const comparable = previous !== null && windowSince(previous) === windowSince(snapshot)
    snapshot.diff = comparable ? diffLedgers(previous, snapshot) : null
    state.snapshot = snapshot
    // Only the unbounded scan is the baseline of record; a windowed view must not overwrite it.
    if (window.sinceDays === null) await autosave(snapshot)
    return snapshot
  }

  async function previousSnapshot() {
    if (state.snapshot !== null) return state.snapshot
    if (state.fileSnapshotLoaded) return state.fileSnapshot
    state.fileSnapshotLoaded = true
    try {
      const text = await readFile(path.join(reportDir, LATEST_FILE), 'utf8')
      const parsed = JSON.parse(text)
      state.fileSnapshot = parsed !== null && typeof parsed === 'object' ? parsed : null
      return state.fileSnapshot
    } catch {
      state.fileSnapshot = null
      return null
    }
  }

  async function autosave(snapshot) {
    if (Date.now() - state.autosaveAt < AUTOSAVE_TTL_MS) return
    try {
      await mkdir(reportDir, { recursive: true })
      await writeFile(path.join(reportDir, LATEST_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      state.autosaveAt = Date.now()
      state.fileSnapshot = snapshot
      state.fileSnapshotLoaded = true
    } catch (error) {
      snapshot.meta.warnings = [...(snapshot.meta?.warnings ?? []), `快照写入失败：${describe(error)}`]
    }
  }

  // --- routes ------------------------------------------------------------

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: REPORT_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guarded('report', async (request) => {
        const force = isForce(request)
        const snapshot = await buildSnapshot(force, parseWindow(request))
        return jsonResponse(200, {
          ok: true,
          generatedAt: snapshot.generatedAt,
          profile: snapshot.profile,
          reportDir: snapshot.reportDir,
          ledger: snapshot.ledger,
          audit: snapshot.audit,
          diff: snapshot.diff,
          meta: snapshot.meta,
        })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: AUDIT_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guarded('audit', async (request) => {
        const report = await ensureAudit(isForce(request))
        return jsonResponse(200, { ok: true, generatedAt: Date.now(), profile: profileDir, report })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: CANDIDATE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guarded('candidate', async (request) => {
        const body = await readJsonBody(request)
        const spec = typeof body?.spec === 'string' ? body.spec.trim() : ''
        if (spec.length === 0) throw new HttpError(400, 'spec 不能为空')
        if (spec.length > SPEC_LIMIT) throw new HttpError(400, `spec 过长（上限 ${SPEC_LIMIT} 字符）`)
        const candidate = await checkCandidate({ spec })
        return jsonResponse(200, { ok: true, candidate })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: EXPORT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guarded('export', async (request) => {
        await readJsonBody(request)
        invalidate()
        const snapshot = await buildSnapshot(true, parseWindow(request))
        const stamp = timestamp(snapshot.generatedAt)
        const suffix = snapshot.window?.sinceDays === null ? '' : `-${snapshot.window?.sinceDays}d`
        const jsonPath = path.join(reportDir, `capability-ledger-${stamp}${suffix}.json`)
        const markdownPath = path.join(reportDir, `capability-ledger-${stamp}${suffix}.md`)
        await mkdir(reportDir, { recursive: true })
        await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
        await writeFile(markdownPath, `${renderMarkdown(snapshot)}\n`, 'utf8')
        return jsonResponse(200, { ok: true, written: [jsonPath, markdownPath] })
      }),
    }),
  )

  function guarded(label, handler) {
    return async (request) => {
      try {
        return await handler(request)
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        return jsonResponse(status, {
          ok: false,
          error: `${label}: ${describe(error)}`,
        })
      }
    }
  }
}

// --- helpers -------------------------------------------------------------

function service(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name) ?? null
    const value = ctx[name]
    return value === undefined ? null : value
  } catch {
    return null
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    }),
  )
  return results
}

function isForce(request) {
  try {
    return new URL(request.url).searchParams.get('refresh') === '1'
  } catch {
    return false
  }
}

/** `?window=all` (default) or `?window=<days>`; anything else falls back to the full history. */
function parseWindow(request) {
  let raw = null
  try {
    raw = new URL(request.url).searchParams.get('window')
  } catch {
    return null
  }
  if (raw === null || raw === '' || raw === 'all') return null
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 1) return null
  return Math.min(Math.floor(days), MAX_WINDOW_DAYS)
}

function windowKey(sinceDays) {
  return sinceDays === null ? 'all' : `d${sinceDays}`
}

function windowSince(snapshot) {
  const value = snapshot?.window?.sinceDays
  return value === undefined || value === null ? null : value
}

async function readJsonBody(request) {
  const header = typeof request.headers?.get === 'function' ? request.headers.get('content-length') : null
  const declared = header === null ? 0 : Number(header)
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new HttpError(413, '请求体过大')
  const text = await request.text()
  if (typeof text !== 'string' || text.length === 0) return {}
  if (text.length > BODY_LIMIT) throw new HttpError(413, '请求体过大')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function resolveDirectory(value, fallback) {
  const raw = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  return path.resolve(raw)
}

function timestamp(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function describe(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

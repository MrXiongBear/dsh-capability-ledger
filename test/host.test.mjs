import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Seam test for the host half.
 *
 * Unlike the lib tests this drives the real `apply(ctx)`: routes are captured from
 * `ctx.connection.fetch.register` and then called with real `Request` objects, so the
 * JSON envelope, the audit wiring and the snapshot writes are exercised the way the
 * running shell will exercise them. Services the shell would provide are stubbed.
 */

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPORTS = mkdtempSync(join(tmpdir(), 'ledger-host-'))
process.env.DSH_CAPABILITY_LEDGER_DIR = REPORTS

const candidateProfiles = [process.env.DSH_PROFILE_DIR, 'D:\\dsh\\profiles\\desktop'].filter(Boolean)
const PROFILE = candidateProfiles.find((dir) => existsSync(join(dir, 'package.json')))

const host = await import('../index.js')

function makeContext({ snapshots = [] } = {}) {
  const routes = new Map()
  const listeners = []
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      return {
        async list() {
          return snapshots
        },
        async open() {
          throw new Error('open() is not expected for these fixtures')
        },
      }
    },
  }
  return { ctx, routes, listeners }
}

test('apply() registers the four read-only routes and the invalidation listeners', () => {
  const { ctx, routes, listeners } = makeContext()
  host.apply(ctx)
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/capability-ledger/audit',
    '/api/capability-ledger/candidate',
    '/api/capability-ledger/export',
    '/api/capability-ledger/report',
  ])
  for (const route of routes.values()) {
    assert.ok(route.methods.includes('GET') || route.methods.includes('POST'))
    assert.equal(typeof route.fetch, 'function')
  }
  assert.ok(listeners.some((entry) => entry.event === 'turn/end'))
  assert.ok(listeners.some((entry) => entry.event === 'session/event'))
})

test('the report route answers the panel envelope (no sessions yet, real profile audit)', { skip: PROFILE === undefined, timeout: 60_000 }, async () => {
  const { ctx, routes } = makeContext()
  host.apply(ctx)
  const route = routes.get('/api/capability-ledger/report')
  const response = await route.fetch(new Request('http://127.0.0.1/api/capability-ledger/report'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.ledger.sessions.total, 0)
  assert.equal(payload.ledger.skills.rows.length, 0)
  assert.equal(typeof payload.audit.ok, 'boolean')
  assert.ok(Array.isArray(payload.audit.rows))
  assert.ok(Array.isArray(payload.meta.warnings))
  assert.equal(typeof payload.meta.scanMs, 'number')
  assert.ok(payload.meta.scanMs >= 0)
  assert.equal(payload.meta.scannedSessions, payload.ledger.sessions.total)
  assert.equal(payload.meta.attribution.method.includes('静态归属'), true)
  assert.equal(payload.profile, PROFILE)
  // First scan with no previous snapshot on disk: diff stays null instead of inventing one.
  assert.equal(payload.diff, null)
})

test('the audit route answers without the ledger', { skip: PROFILE === undefined, timeout: 60_000 }, async () => {
  const { ctx, routes } = makeContext()
  host.apply(ctx)
  const response = await routes.get('/api/capability-ledger/audit').fetch(new Request('http://127.0.0.1/api/capability-ledger/audit'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.ok(payload.report.problems.every((problem) => typeof problem === 'string'))
})

test('the candidate route checks a local plugin before it is ever installed', async () => {
  const { ctx, routes } = makeContext()
  host.apply(ctx)
  const route = routes.get('/api/capability-ledger/candidate')
  const response = await route.fetch(
    new Request('http://127.0.0.1/api/capability-ledger/candidate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: PLUGIN_DIR }),
    }),
  )
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.candidate.kind, 'local')
  assert.notEqual(payload.candidate.verdict, 'fail')
})

test('the candidate route rejects an empty spec and a malformed body', async () => {
  const { ctx, routes } = makeContext()
  host.apply(ctx)
  const route = routes.get('/api/capability-ledger/candidate')

  const empty = await route.fetch(
    new Request('http://127.0.0.1/api/capability-ledger/candidate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: '   ' }),
    }),
  )
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).ok, false)

  const malformed = await route.fetch(
    new Request('http://127.0.0.1/api/capability-ledger/candidate', { method: 'POST', body: '{not json' }),
  )
  assert.equal(malformed.status, 400)
})

test('the export route writes a timestamped JSON and Markdown pair into the report dir', { skip: PROFILE === undefined, timeout: 60_000 }, async () => {
  const { ctx, routes } = makeContext()
  host.apply(ctx)
  const response = await routes.get('/api/capability-ledger/export').fetch(
    new Request('http://127.0.0.1/api/capability-ledger/export', { method: 'POST', body: '{}' }),
  )
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.written.length, 2)
  for (const file of payload.written) assert.equal(existsSync(file), true, file)
  assert.ok(payload.written.some((file) => file.endsWith('.json')))
  assert.ok(payload.written.some((file) => file.endsWith('.md')))
})

test('?window=N narrows the session set and says so in the payload', { skip: PROFILE === undefined, timeout: 60_000 }, async () => {
  const now = Date.now()
  const day = 86_400_000
  const snapshots = [
    { header: { id: 'a', createdAt: now - 1 * day, isSeeded: false, version: 1 }, revision: 1, formatStatus: 'current' },
    { header: { id: 'b', createdAt: now - 10 * day, isSeeded: false, version: 1 }, revision: 1, formatStatus: 'current' },
    { header: { id: 'c', createdAt: now - 40 * day, isSeeded: false, version: 1 }, revision: 1, formatStatus: 'current' },
  ]
  const { ctx, routes } = makeContext({ snapshots })
  host.apply(ctx)
  const route = routes.get('/api/capability-ledger/report')

  const all = await (await route.fetch(new Request('http://127.0.0.1/api/capability-ledger/report'))).json()
  assert.equal(all.ledger.window.sinceDays, null)
  assert.equal(all.ledger.window.available, 3)
  assert.equal(all.ledger.sessions.total, 3)
  assert.equal(all.meta.window.available, 3)

  const month = await (await route.fetch(new Request('http://127.0.0.1/api/capability-ledger/report?window=30'))).json()
  assert.equal(month.ledger.window.sinceDays, 30)
  assert.equal(month.ledger.sessions.total, 2)
  assert.equal(month.ledger.window.available, 3)
  // A windowed view never diffs against the all-history baseline: it would read as losses.
  assert.equal(month.diff, null)

  const week = await (await route.fetch(new Request('http://127.0.0.1/api/capability-ledger/report?window=7'))).json()
  assert.equal(week.ledger.sessions.total, 1)

  const nonsense = await (await route.fetch(new Request('http://127.0.0.1/api/capability-ledger/report?window=abc'))).json()
  assert.equal(nonsense.ledger.window.sinceDays, null)
  assert.equal(nonsense.ledger.sessions.total, 3)
})

test('a failing ledger scan is reported as an error envelope, not a thrown route', async () => {
  const brokenRoutes = new Map()
  host.apply({
    effect(factory) {
      factory()
      return () => {}
    },
    on() {
      return () => {}
    },
    get: () => ({
      async list() {
        throw new Error('session store unavailable')
      },
    }),
    connection: {
      fetch: {
        register(route) {
          brokenRoutes.set(route.path, route)
          return () => {}
        },
      },
    },
  })
  const response = await brokenRoutes.get('/api/capability-ledger/report').fetch(new Request('http://127.0.0.1/api/capability-ledger/report'))
  assert.equal(response.status, 500)
  const payload = await response.json()
  assert.equal(payload.ok, false)
  assert.ok(payload.error.includes('session store unavailable'), payload.error)
})

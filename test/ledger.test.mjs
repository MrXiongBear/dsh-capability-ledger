import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildLedger, diffLedgers, parseSkillName, schemaBytes, summarizeSession } from '../lib/ledger.mjs'

const TOOLS = [
  { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'skill', description: 'load a skill', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
]

function session(id, events, createdAt = 1) {
  return { header: { id, createdAt, cwd: 'D:\\ws', version: 4 }, revision: `${id}-r1`, formatStatus: 'current', events }
}

function skillLoad(callId, name, { ok = true, time = 10 } = {}) {
  const call = {
    seq: 1,
    time,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'skill', arguments: JSON.stringify({ name }) },
  }
  const result = {
    seq: 2,
    time: time + 1,
    type: 'tool/result',
    data: ok
      ? { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: `<skill_content name="${name}">` }] } }
      : { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, isError: true }, error: { name: 'Error', code: 'skill/not-found' } },
  }
  return [call, result]
}

test('parseSkillName reads the JSON-encoded arguments of a skill call', () => {
  assert.equal(parseSkillName('{"name": "task-intake"}'), 'task-intake')
  assert.equal(parseSkillName(JSON.stringify({ name: 'office' })), 'office')
  assert.equal(parseSkillName('not json'), null)
  assert.equal(parseSkillName(undefined), null)
})

test('summarizeSession folds skill loads, tool calls and per-request schema bytes', () => {
  const events = [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time: 3, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' }, tools: TOOLS }, reason: 'initial' } },
    ...skillLoad('call_a', 'task-intake', { time: 10 }),
    { seq: 5, time: 20, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_b', name: 'read', arguments: '{"path":"x"}' } },
    { seq: 6, time: 21, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_b', content: [{ type: 'text', text: 'ok' }] } } },
    { seq: 7, time: 22, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_c', name: 'read', arguments: '{"path":"missing"}' } },
    { seq: 8, time: 23, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_c', isError: true }, error: { name: 'Error', code: 'fs/not-found' } } },
    { seq: 9, time: 24, type: 'assistant/message', data: { turn: 1, step: 1 } },
  ]

  const summary = summarizeSession(session('s1', events), events)
  assert.equal(summary.turns, 1)
  assert.equal(summary.steps, 1)
  assert.equal(summary.assistantMessages, 1)
  assert.equal(summary.requests, 1)
  assert.equal(summary.toolCalls, 3)
  assert.equal(summary.toolResults, 3)
  assert.equal(summary.toolErrors, 1)
  assert.equal(summary.tools.read.calls, 2)
  assert.equal(summary.tools.read.errors, 1)
  assert.equal(summary.skillEvents.length, 1)
  assert.deepEqual(
    { name: summary.skillEvents[0].name, ok: summary.skillEvents[0].ok },
    { name: 'task-intake', ok: true },
  )
  assert.equal(summary.injectedBytes, TOOLS.reduce((sum, tool) => sum + schemaBytes(tool), 0))
})

test('summary keeps a call whose result never landed visible instead of hiding it', () => {
  const events = [{ seq: 1, time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_z', name: 'read', arguments: '{}' } }]
  const summary = summarizeSession(session('s1', events), events)
  assert.equal(summary.pendingCalls.length, 1)
  assert.equal(summary.pendingCalls[0].name, 'read')
})

test('buildLedger separates never-loaded skills from skills loaded in two sessions', () => {
  const sessions = [
    summarizeSession(
      session('s1', []),
      [
        ...skillLoad('c1', 'task-intake', { time: 10 }),
        { seq: 3, time: 11, type: 'request/header', data: { header: { tools: TOOLS } } },
        { seq: 4, time: 12, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{}' } },
        { seq: 5, time: 13, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c9', content: [] } } },
      ],
    ),
    summarizeSession(session('s2', []), skillLoad('c2', 'task-intake', { time: 40 })),
  ]

  const ledger = buildLedger({
    sessions,
    skills: [
      { name: 'task-intake', description: 'intake pass', source: 'user-dsh' },
      { name: 'office', description: 'office docs', source: 'bundled' },
    ],
    tools: TOOLS,
    toolOwners: { read: 'dsh-tool-fs' },
    generatedAt: 1_000,
    profile: 'D:\\dsh\\profiles\\desktop',
  })

  const byName = new Map(ledger.skills.rows.map((row) => [row.name, row]))
  assert.equal(byName.get('task-intake').loads, 2)
  assert.equal(byName.get('task-intake').sessions, 2)
  assert.equal(byName.get('task-intake').verdict, 'keep')
  assert.equal(byName.get('office').loads, 0)
  assert.equal(byName.get('office').verdict, 'unused')
  assert.equal(ledger.skills.unused, 1)
  assert.equal(ledger.skills.keep, 1)

  const toolByName = new Map(ledger.tools.rows.map((row) => [row.name, row]))
  assert.equal(toolByName.get('read').calls, 1)
  assert.equal(toolByName.get('read').verdict, 'rare')
  assert.equal(toolByName.get('read').owner, 'dsh-tool-fs')
  // The `skill` tool itself was called twice (by the two skill loads), so it is "rare",
  // not "unused" — the ledger counts the tool as invoked even though it is the loader.
  assert.equal(toolByName.get('skill').calls, 2)
  assert.equal(toolByName.get('skill').verdict, 'rare')
  assert.equal(toolByName.get('skill').owner, '')

  assert.equal(ledger.schema.byBundle.find((row) => row.bundle === 'dsh-tool-fs').tools, 1)
  assert.equal(ledger.schema.byBundle.find((row) => row.bundle === '(内置/动态)').tools, 1)
  assert.ok(ledger.schema.bytesPerRequest > 0)
})

test('a skill whose index entry exceeds the cap is flagged as truncated', () => {
  const ledger = buildLedger({
    sessions: [],
    skills: [{ name: 'long', description: 'x'.repeat(600), source: 'user-dsh' }],
    tools: [],
    generatedAt: 1,
    profile: 'p',
  })
  assert.equal(ledger.skills.rows[0].truncatedInIndex, true)
  assert.equal(ledger.skills.truncatedInIndex, 1)
})

test('the injected skill-catalog event is the source of truth for truncation', () => {
  // The model saw 20 chars of a 600 char description, so it WAS truncated — and the row
  // must say so from evidence, not from the 500-char guess.
  const events = [
    {
      seq: 1,
      time: 1,
      type: 'user/message',
      data: {
        source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'long', description: 'x'.repeat(20) }, { name: 'short', description: 'ok' }] },
        message: { role: 'user', content: [{ type: 'text', text: 'catalog' }] },
      },
    },
  ]
  const summary = summarizeSession(session('s1', events), events)
  assert.equal(summary.catalogEvents, 1)
  assert.equal(summary.catalog.long.length, 20)

  const ledger = buildLedger({
    sessions: [summary],
    skills: [
      { name: 'long', description: 'x'.repeat(600), source: 'user-dsh' },
      { name: 'short', description: 'ok', source: 'bundled' },
    ],
    tools: [],
    generatedAt: 1,
    profile: 'p',
  })
  const byName = new Map(ledger.skills.rows.map((row) => [row.name, row]))
  assert.equal(byName.get('long').catalogObserved, true)
  assert.equal(byName.get('long').catalogChars, 20)
  assert.equal(byName.get('long').descriptionChars, 600)
  assert.equal(byName.get('long').truncatedInIndex, true)
  assert.equal(byName.get('short').truncatedInIndex, false)
  assert.equal(ledger.skills.catalogObserved, 2)
})

test('tools are classified into removable tiers: plugin, MCP server, builtin', () => {
  const tools = [
    { name: 'vision_ocr', description: 'd', parameters: {} },
    { name: 'mcp__openviking__search', description: 'ddd', parameters: {} },
    { name: 'pwsh', description: 'dd', parameters: {} },
  ]
  const ledger = buildLedger({
    sessions: [],
    skills: [],
    tools,
    toolOwners: { vision_ocr: 'dsh-vision-router' },
    generatedAt: 1,
    profile: 'p',
  })
  const byName = new Map(ledger.tools.rows.map((row) => [row.name, row]))
  assert.equal(byName.get('vision_ocr').kind, 'plugin')
  assert.equal(byName.get('mcp__openviking__search').kind, 'mcp')
  assert.equal(byName.get('mcp__openviking__search').mcpServer, 'openviking')
  assert.equal(byName.get('pwsh').kind, 'builtin')

  const tiers = new Map(ledger.schema.byTier.map((row) => [row.kind, row]))
  assert.equal(tiers.get('plugin').removable, true)
  assert.equal(tiers.get('mcp').removable, true)
  assert.equal(tiers.get('builtin').removable, false)
  assert.ok(tiers.get('builtin').bytes > 0)
  assert.equal(
    ledger.schema.registryBytes,
    ledger.schema.byTier.reduce((sum, row) => sum + row.bytes, 0),
  )
  assert.equal(ledger.tools.registered, 3)
})

test('a skill counted against the cap without full text is only "suspected" truncated', () => {
  const events = [
    { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'skill-catalog', entries: [{ name: 'bundled-one', description: 'y'.repeat(500) }] } } },
  ]
  const ledger = buildLedger({ sessions: [summarizeSession(session('s1', events), events)], skills: [], tools: [], generatedAt: 1, profile: 'p' })
  const row = ledger.skills.rows.find((entry) => entry.name === 'bundled-one')
  assert.equal(row.descriptionKnown, false)
  assert.equal(row.truncatedInIndex, true)
  assert.equal(row.truncationEvidence, 'suspected')
  assert.equal(ledger.skills.truncatedSuspected, 1)
  assert.equal(ledger.skills.truncatedMeasured, 0)
})

test('a bundled skill below the cap is not reported as truncated', () => {
  const events = [
    { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'skill-catalog', entries: [{ name: 'short-bundled', description: 'z'.repeat(120) }] } } },
  ]
  const ledger = buildLedger({ sessions: [summarizeSession(session('s1', events), events)], skills: [], tools: [], generatedAt: 1, profile: 'p' })
  const row = ledger.skills.rows.find((entry) => entry.name === 'short-bundled')
  assert.equal(row.truncationEvidence, 'none')
  assert.equal(row.truncatedInIndex, false)
})

test('a skill only known from the injected catalog still gets a row', () => {
  const events = [
    { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'skill-catalog', entries: [{ name: 'ghost', description: 'seen only in the prompt' }] } } },
  ]
  const ledger = buildLedger({ sessions: [summarizeSession(session('s1', events), events)], skills: [], tools: [], generatedAt: 1, profile: 'p' })
  const row = ledger.skills.rows.find((entry) => entry.name === 'ghost')
  assert.ok(row)
  assert.equal(row.inCatalog, true)
  assert.equal(row.loads, 0)
  assert.equal(row.verdict, 'unused')
})

test('slash invocations count as skill loads with via:slash', () => {
  const events = [
    { seq: 1, time: 5, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'task-intake' } } },
  ]
  const summary = summarizeSession(session('s1', events), events)
  assert.equal(summary.skillEvents.length, 1)
  assert.equal(summary.skillEvents[0].via, 'slash')

  const ledger = buildLedger({ sessions: [summary], skills: [], tools: [], generatedAt: 1, profile: 'p' })
  const row = ledger.skills.rows[0]
  assert.equal(row.loads, 1)
  assert.equal(row.slashLoads, 1)
  assert.equal(ledger.skills.slashLoads, 1)
  assert.equal(row.verdict, 'watch')
})

test('diffLedgers reports new problems and skill load movement', () => {
  const previous = {
    generatedAt: 10,
    audit: { problems: ['a: CLIENT threw-factory', 'b: CLIENT threw-factory'] },
    ledger: {
      sessions: { total: 3 },
      schema: { bytesPerRequest: 100 },
      skills: { rows: [{ name: 'office', loads: 0 }] },
    },
  }
  const next = {
    generatedAt: 20,
    audit: { problems: ['b: CLIENT threw-factory'] },
    ledger: {
      sessions: { total: 4 },
      schema: { bytesPerRequest: 140 },
      skills: { rows: [{ name: 'office', loads: 2 }] },
    },
  }
  const diff = diffLedgers(previous, next)
  assert.deepEqual(diff.newProblems, [])
  assert.deepEqual(diff.fixedProblems, ['a: CLIENT threw-factory'])
  assert.equal(diff.sessionsDelta, 1)
  assert.equal(diff.bytesPerRequestDelta, 40)
  assert.deepEqual(diff.skillDeltas, [{ name: 'office', from: 0, to: 2 }])
  assert.equal(diffLedgers(null, next), null)
})

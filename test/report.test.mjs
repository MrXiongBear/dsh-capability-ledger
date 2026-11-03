import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown } from '../lib/report.mjs'

test('renderMarkdown writes the ledger and audit headline without calling any service', () => {
  const snapshot = {
    generatedAt: Date.UTC(2026, 9, 29, 10, 0, 0),
    profile: 'D:\\dsh\\profiles\\desktop',
    ledger: {
      sessions: { total: 91, subagent: 12, turns: 523, steps: 900, assistantMessages: 500, requests: 400 },
      skills: {
        total: 14,
        unused: 9,
        watch: 4,
        keep: 1,
        notInCatalog: 0,
        truncatedInIndex: 1,
        loadEvents: 4,
        rows: [{ name: 'task-intake', loads: 4, sessions: 4, attempts: 4, failures: 0, inCatalog: true, descriptionChars: 120, verdict: 'keep', lastAt: 0 }],
      },
      tools: {
        total: 100,
        unused: 60,
        rare: 20,
        used: 20,
        calls: 15447,
        errors: 12,
        rows: [{ name: 'read', calls: 1000, errors: 1, schemaBytes: 800, injected: true, owner: 'dsh-tool-fs', verdict: 'used' }],
      },
      schema: { bytesPerRequest: 50900, tokensPerRequest: 14543, requestsMeasured: 90, toolsPerRequest: 100, bytesPerToken: 3.5, byBundle: [{ bundle: 'dsh-tool-fs', bytes: 800, tools: 1, calls: 1000 }] },
    },
    audit: {
      ok: true,
      bundles: 14,
      deps: 8,
      patch: { lines: 42, entries: ['capability-ledger'] },
      problems: [],
      risks: ['x: 2 non-optional peer(s) — a, b'],
      notes: ['y: built-in bundle resolved from the app'],
      rows: [{ id: 'goodpkg', present: true, status: 'ok', client: 'ok', clientBytes: 1024, version: '1.0.0', requiredPeers: [], installScripts: [] }],
      versionDrift: [],
    },
    diff: { since: 1, newProblems: ['z: CLIENT threw-factory'], fixedProblems: [], skillDeltas: [], sessionsDelta: 2, bytesPerRequestDelta: 100 },
  }

  const markdown = renderMarkdown(snapshot)
  assert.ok(markdown.startsWith('# DSH 能力台账 + 插件体检'))
  assert.ok(markdown.includes('会话 91'))
  assert.ok(markdown.includes('零使用 9'))
  assert.ok(markdown.includes('50.9 KB') || markdown.includes('49.7 KB'), markdown.split('\n').slice(0, 12).join('\n'))
  assert.ok(markdown.includes('task-intake'))
  assert.ok(markdown.includes('新增红项'))
  assert.ok(markdown.includes('z: CLIENT threw-factory'))
  assert.ok(markdown.includes('黄项 1'))
  assert.equal(renderMarkdown({}).startsWith('# DSH 能力台账'), true)
})

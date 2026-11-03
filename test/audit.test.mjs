import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditPackage, auditProfile, formatAuditReport } from '../lib/audit.mjs'

function makePackage(root, name, { files = {}, manifest = {} } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...manifest }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), files['index.js'] ?? 'export const apply = () => {}\n', 'utf8')
  for (const [rel, content] of Object.entries(files)) {
    if (rel === 'index.js') continue
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return dir
}

const GOOD_CLIENT = `window.__ModuleLoader__.load({ id: 'goodpkg', factory() { return { inject: ['slots'], apply() {} } } })\n`

function envelopeClient(id, body) {
  return `window.__ModuleLoader__.load({ id: '${id}', factory() { ${body} return { apply() {} } } })\n`
}

test('a healthy bundle passes: client artifact materializes with the expected id', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-audit-'))
  const dir = makePackage(root, 'goodpkg', { files: { 'client.js': GOOD_CLIENT } })
  const report = auditPackage(dir)
  assert.equal(report.verdict, 'pass', JSON.stringify(report.findings))
  assert.equal(report.client.state, 'ok')
  assert.equal(report.name, 'goodpkg')
  assert.equal(report.mainExists, true)
})

test('a client artifact that requires its own unregistered module is a hard problem', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-audit-'))
  const dir = makePackage(root, 'badpkg', {
    files: { 'client.js': `window.__ModuleLoader__.load({ id: 'badpkg', factory(require) { require('./strip-prefs.js'); return { apply() {} } } })\n` },
  })
  const report = auditPackage(dir)
  assert.equal(report.verdict, 'fail')
  assert.equal(report.client.state, 'threw-factory')
  assert.ok(report.findings.some((finding) => finding.level === 'problem' && finding.text.includes('CLIENT')))
})

test('a client artifact that announces the wrong module id is a hard problem', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-audit-'))
  const dir = makePackage(root, 'wrongid', { files: { 'client.js': envelopeClient('someone-else', '') } })
  const report = auditPackage(dir)
  assert.equal(report.verdict, 'fail')
  assert.equal(report.client.state, 'id-mismatch')
})

test('a bare-specifier client is a platform external, not a failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-audit-'))
  const dir = makePackage(root, 'extpkg', {
    files: { 'client.js': `window.__ModuleLoader__.load({ id: 'extpkg', factory(require) { const React = require('react'); return { apply() {} } } })\n` },
  })
  const report = auditPackage(dir)
  assert.equal(report.verdict, 'pass', JSON.stringify(report.findings))
  assert.equal(report.client.state, 'external-in-node')
})

test('install-time scripts and non-optional host peers are reported as risks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-audit-'))
  const dir = makePackage(root, 'risky', {
    manifest: {
      scripts: { postinstall: 'node setup.js' },
      peerDependencies: { '@deepseek-ai/dsh-client-ui-sidebar': '^1.0.0', react: '^18.0.0' },
      peerDependenciesMeta: { react: { optional: true } },
    },
  })
  const report = auditPackage(dir)
  assert.equal(report.verdict, 'warn', JSON.stringify(report.findings))
  assert.deepEqual(report.installScripts, ['postinstall'])
  assert.deepEqual(report.requiredPeers, ['@deepseek-ai/dsh-client-ui-sidebar'])
})

test('a plaintext credential literal is reported by path, never by value', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-audit-'))
  const secret = `sk-${'a'.repeat(32)}`
  const dir = makePackage(root, 'leaky', { files: { 'index.js': `export const key = '${secret}'\n` } })
  const report = auditPackage(dir)
  assert.equal(report.verdict, 'fail')
  const finding = report.findings.find((item) => item.text.includes('plaintext credential'))
  assert.ok(finding, JSON.stringify(report.findings))
  assert.equal(finding.text.includes(secret), false, 'the value must never be echoed')
})

test('auditProfile reports a bundle that is listed but not installed, and a dep with no bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-profile-'))
  const profile = join(root, 'profile')
  const good = makePackage(join(root, 'modules'), 'goodpkg', { files: { 'client.js': GOOD_CLIENT } })
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  // node_modules/goodpkg -> a real directory, just placed by hand (no symlink needed here)
  mkdirSync(join(profile, 'node_modules', 'goodpkg'), { recursive: true })
  writeFileSync(join(profile, 'node_modules', 'goodpkg', 'package.json'), JSON.stringify({ name: 'goodpkg', version: '1.0.0', main: 'index.js' }), 'utf8')
  writeFileSync(join(profile, 'node_modules', 'goodpkg', 'index.js'), 'export const apply = () => {}\n', 'utf8')
  writeFileSync(join(profile, 'node_modules', 'goodpkg', 'client.js'), `window.__ModuleLoader__.load({ id: 'goodpkg', factory() { return { apply() {} } } })\n`, 'utf8')
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'synthetic-profile',
        dependencies: { goodpkg: `link:${good.replace(/\\/g, '/')}`, ghostpkg: '1.0.0' },
        dsh: { profile: { bundles: ['goodpkg', 'never-installed'] } },
      },
      null,
      2,
    ),
    'utf8',
  )

  const report = auditProfile(profile)
  assert.equal(report.bundles, 2)
  assert.equal(report.ok, false)
  assert.ok(report.problems.some((problem) => problem.includes('never-installed') && problem.includes('MISSING-PACKAGE')))
  assert.ok(report.depsNotInBundles.includes('ghostpkg'), JSON.stringify(report.depsNotInBundles))
  const goodRow = report.rows.find((row) => row.id === 'goodpkg')
  assert.equal(goodRow.client, 'ok')

  const text = formatAuditReport(report)
  assert.ok(text.includes('never-installed'))
})

test('auditProfile fails closed when the profile manifest itself is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-profile-'))
  const report = auditProfile(join(root, 'nope'))
  assert.equal(report.ok, false)
  assert.equal(report.fatal.length, 1)
})

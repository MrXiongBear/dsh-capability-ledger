/**
 * The drift check is the audit's whole reason for existing after a nightly upgrade,
 * and it silently reported "no drift" whenever the app copy could not be located —
 * a green light with the check skipped. These tests pin the two fixes:
 *
 *  1. the app's own copy is found from `DSH_APP_ASAR` through a real asar archive
 *     (whose `offset` fields are decimal STRINGS, which used to be dropped as
 *     "not a number" and turned the whole comparison into an empty list);
 *  2. an unresolved app copy is reported as a yellow risk instead of silence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditProfile, resetAppDiscovery, setAppCandidatesForTest } from '../lib/audit.mjs'

const PREAMBLE = 16

/** Build a minimal, real asar archive: 16-byte preamble, JSON header, then payload. */
function writeAsar(file, entries) {
  const files = {}
  const blobs = []
  let cursor = 0
  for (const [innerPath, content] of Object.entries(entries)) {
    const parts = innerPath.split('/').filter(Boolean)
    const buf = Buffer.from(content, 'utf8')
    blobs.push({ offset: cursor, buf })
    // asar stores offsets as decimal strings; keep that shape so the test exercises it.
    let node = files
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} }
      node = node[part].files
    }
    node[parts[parts.length - 1]] = { size: buf.length, offset: String(cursor) }
    cursor += buf.length
  }
  const header = Buffer.from(JSON.stringify({ files }), 'utf8')
  const preamble = Buffer.alloc(PREAMBLE)
  preamble.writeUInt32LE(header.length, 12)
  writeFileSync(file, Buffer.concat([preamble, header, ...blobs.map((blob) => blob.buf)]))
}

function makeProfile(root, copies) {
  const profile = join(root, 'profile')
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai'), { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ name: 'p', dependencies: Object.fromEntries(copies.map((name) => [name, '1.0.0'])), dsh: { profile: { bundles: copies } } }),
  )
  for (const name of copies) {
    const dir = join(profile, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.2.1-rc.3', main: 'index.js' }))
    writeFileSync(join(dir, 'index.js'), 'export const name = 1\n')
  }
  return profile
}

test('asar string offsets: drift between the profile copy and the app copy is reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-asar-'))
  try {
    const asar = join(root, 'app.asar')
    writeAsar(asar, {
      'dsh/package.json': JSON.stringify({ name: 'dsh', version: '9.9.9' }),
      'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json': JSON.stringify({ name: 'dsh-app-boot', version: '9.9.9' }),
      'dsh/node_modules/@deepseek-ai/dsh-util-values/package.json': JSON.stringify({ name: 'dsh-util-values', version: '9.9.9' }),
    })
    const profile = makeProfile(root, ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-util-values'])

    process.env.DSH_APP_ASAR = asar
    resetAppDiscovery()
    const report = auditProfile(profile)

    assert.equal(report.appVersion, '9.9.9')
    assert.equal(report.appRoot, asar)
    assert.deepEqual(
      report.versionDrift.map((row) => [row.package, row.profile, row.app]),
      [
        ['@deepseek-ai/dsh-app-boot', '0.2.1-rc.3', '9.9.9'],
        ['@deepseek-ai/dsh-util-values', '0.2.1-rc.3', '9.9.9'],
      ],
    )
    // One collapsed risk line, not one per package.
    assert.equal(report.risks.filter((text) => text.includes('behind the app')).length, 1)
    // Drift is a warning, not a boot blocker.
    assert.equal(report.ok, true)
  } finally {
    delete process.env.DSH_APP_ASAR
    resetAppDiscovery()
    rmSync(root, { recursive: true, force: true })
  }
})

test('matching versions produce no drift rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-asar-same-'))
  try {
    const asar = join(root, 'app.asar')
    writeAsar(asar, {
      'dsh/package.json': JSON.stringify({ name: 'dsh', version: '0.2.1-rc.3' }),
      'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json': JSON.stringify({ name: 'dsh-app-boot', version: '0.2.1-rc.3' }),
    })
    const profile = makeProfile(root, ['@deepseek-ai/dsh-app-boot'])

    process.env.DSH_APP_ASAR = asar
    resetAppDiscovery()
    const report = auditProfile(profile)

    assert.equal(report.appVersion, '0.2.1-rc.3')
    assert.deepEqual(report.versionDrift, [])
    assert.equal(report.risks.filter((text) => text.includes('behind the app')).length, 0)
  } finally {
    delete process.env.DSH_APP_ASAR
    resetAppDiscovery()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable app archive is a reported risk, never a silent pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-asar-bad-'))
  try {
    const bogus = join(root, 'app.asar')
    writeFileSync(bogus, 'not an archive at all')
    const profile = makeProfile(root, ['@deepseek-ai/dsh-app-boot'])

    // Model a machine where that broken path is the only place to look, so the
    // fallback cannot quietly substitute a real installation.
    setAppCandidatesForTest([bogus])
    const report = auditProfile(profile)

    assert.equal(report.appVersion, null)
    assert.deepEqual(report.versionDrift, [])
    assert.equal(
      report.risks.filter((text) => text.includes('version drift was NOT checked')).length,
      1,
      'the skipped check must show up as a risk',
    )
  } finally {
    setAppCandidatesForTest(null)
    resetAppDiscovery()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable explicit archive falls back to the installed app when one exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-asar-fallback-'))
  try {
    const bogus = join(root, 'app.asar')
    writeFileSync(bogus, 'not an archive at all')
    const real = join(root, 'real.asar')
    writeAsar(real, {
      'dsh/package.json': JSON.stringify({ name: 'dsh', version: '1.2.3' }),
      'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json': JSON.stringify({ name: 'dsh-app-boot', version: '1.2.3' }),
    })
    const profile = makeProfile(root, ['@deepseek-ai/dsh-app-boot'])

    setAppCandidatesForTest([bogus, real])
    const report = auditProfile(profile)

    assert.equal(report.appVersion, '1.2.3', 'a broken candidate must not hide a readable one')
    assert.deepEqual(
      report.versionDrift.map((row) => [row.package, row.app]),
      [['@deepseek-ai/dsh-app-boot', '1.2.3']],
      'the fallback archive must be the one compared against',
    )
  } finally {
    setAppCandidatesForTest(null)
    resetAppDiscovery()
    rmSync(root, { recursive: true, force: true })
  }
})

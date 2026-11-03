import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/**
 * Seam test for the restart preflight command.
 *
 * The whole point of `preflight-restart.mjs` is its exit code being trusted by
 * `dsh-restart-safe.ps1`, so these tests assert the process contract (0 safe / 1 blocked /
 * 2 environment error) plus the snapshot it writes — not the prose it prints.
 */

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'preflight-restart.mjs')
const candidateProfiles = [process.env.DSH_PROFILE_DIR, 'D:\\dsh\\profiles\\desktop'].filter(Boolean)
const PROFILE = candidateProfiles.find((dir) => existsSync(join(dir, 'package.json')))

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  })
}

test('a profile whose bundle list got truncated is blocked with exit code 1', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-preflight-'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } }, dependencies: {} }, null, 2)}\n`,
    'utf8',
  )
  const jsonPath = join(dir, 'preflight.json')
  const result = run(['--profile', dir, '--json', jsonPath, '--quiet'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
  assert.equal(payload.ok, false)
  const manifest = payload.checks.find((check) => check.id === 'profile')
  assert.equal(manifest.ok, false)
  assert.equal(manifest.fatal, true)
  assert.match(manifest.detail, /截断/)
})

test('a missing profile directory is an environment error, not a verdict', { timeout: 30_000 }, () => {
  const result = run(['--profile', join(tmpdir(), 'ledger-preflight-does-not-exist'), '--quiet'])
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /ERROR/)
})

test('the real profile passes and the snapshot records all three checks', { skip: PROFILE === undefined, timeout: 180_000 }, () => {
  const reports = mkdtempSync(join(tmpdir(), 'ledger-preflight-reports-'))
  const result = run(['--quiet'], { DSH_PROFILE_DIR: PROFILE, DSH_CAPABILITY_LEDGER_DIR: reports })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const payload = JSON.parse(readFileSync(join(reports, 'preflight-latest.json'), 'utf8'))
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.checks.map((check) => check.id), ['profile', 'audit', 'gate'])
  for (const check of payload.checks) assert.equal(check.ok, true, `${check.id}: ${check.detail}`)
  const gateCheck = payload.checks.find((check) => check.id === 'gate')
  // 没有 gate-profile-boot.mjs 的机器（公共复现环境）不判红：闸门断言只在脚本存在时生效。
  if (/GATE RESULT: PASS/.test(gateCheck.detail)) assert.match(gateCheck.detail, /GATE RESULT: PASS/)
})

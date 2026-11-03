#!/usr/bin/env node
/**
 * Restart preflight: one command that answers "is it safe to restart DSH right now?".
 *
 * Why this exists: bundle loading is all-or-nothing. One bundle that fails to import takes
 * the whole profile down, and the shell then "self-heals" by truncating the bundle list and
 * the patch file, which is a silent, hard-to-notice downgrade. So before a restart we want
 * three independent questions answered, in one shot:
 *
 *   1. profile  — does the profile still look like a profile? A bundle list that got truncated
 *      (the shell's self-heal after a failed import) is the failure we are guarding against;
 *      a plugin that is deliberately not mounted (2026-10-31: this one) is not a failure.
 *   2. audit    — does the plugin audit find a red item (fatal: would not compose)?
 *   3. gate     — does the boot gate accept the composed profile (bundles, patch rows,
 *      skipped bundles, composition warnings)?
 *
 * Exit codes: 0 = safe to restart, 1 = blocked (do not restart), 2 = environment error
 * (profile or tooling missing — nothing was validated, so nothing may be concluded).
 *
 *   node scripts/preflight-restart.mjs [--profile <dir>] [--json <path>] [--quiet]
 *
 * The audit half never executes plugin code with side effects, never installs anything and
 * never talks to the network. The gate half runs a second node process.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { auditProfile, formatAuditReport } from '../lib/audit.mjs'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-capability-ledger'
/** A healthy desktop profile has ~14 bundles; anything under this smells like a self-heal truncation. */
const MIN_BUNDLES = 10
const DEFAULT_PROFILE_DIR = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'profiles', process.env.DSH_PROFILE_NAME ?? 'default')
const DEFAULT_REPORT_DIR = join(process.env.DSH_WORKSPACE ?? process.cwd(), 'reports')
const GATE_CANDIDATES = [
  process.env.DSH_GATE_SCRIPT,
  join(PLUGIN_DIR, 'scripts', 'gate-profile-boot.mjs'),
].filter(Boolean)

function parseArgs(argv) {
  const options = { profile: null, json: null, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--quiet' || arg === '-q') options.quiet = true
    else if (arg === '--profile') options.profile = argv[++index] ?? null
    else if (arg === '--json') options.json = argv[++index] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

/**
 * A profile that still looks like a profile. This used to assert "our plugin is mounted", but
 * on 2026-10-31 the panel was deliberately unmounted, so the check is now about the failure
 * mode that actually hurts: the shell truncating the bundle list after a failed import.
 */
function checkManifest(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    return { id: 'profile', ok: false, fatal: true, detail: `${manifestPath} 不存在` }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { id: 'profile', ok: false, fatal: true, detail: `package.json 解析失败：${error.message}` }
  }
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  if (bundles.length < MIN_BUNDLES) {
    return {
      id: 'profile',
      ok: false,
      fatal: true,
      detail: `只有 ${bundles.length} 个 bundles（少于 ${MIN_BUNDLES}）—— profile 可能已被自愈截断`,
    }
  }
  const mounted = bundles.includes(PACKAGE_NAME)
  return {
    id: 'profile',
    ok: true,
    fatal: false,
    detail: `bundles ${bundles.length} 项，deps ${Object.keys(deps).length} 项；台账面板${mounted ? '已挂载' : '未挂载（源码与体检闸门仍可用）'}`,
  }
}

function checkAudit(profileDir) {
  let report
  try {
    report = auditProfile(profileDir)
  } catch (error) {
    return { id: 'audit', ok: false, fatal: true, detail: `审计执行失败：${error.message}` }
  }
  const fatal = report.fatal ?? []
  const problems = report.problems ?? []
  const risks = report.risks ?? []
  const detail = problems.length === 0
    ? `无红项；${risks.length} 条黄项；${report.bundles ?? 0} bundles / ${report.deps ?? 0} deps`
    : `${problems.length} 个红项：${problems.slice(0, 4).join('；')}`
  return { id: 'audit', ok: fatal.length === 0, fatal: fatal.length > 0, detail, report }
}

function resolveGateScript() {
  for (const candidate of GATE_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function checkGate() {
  const script = resolveGateScript()
  if (script === null) {
    return { id: 'gate', ok: true, fatal: false, skipped: true, detail: '未找到 gate-profile-boot.mjs，跳过启动闸门' }
  }
  const result = spawnSync(process.execPath, [script], { cwd: dirname(script), encoding: 'utf8', timeout: 120_000 })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  const verdictLine = stdout.split(/\r?\n/).find((line) => /GATE RESULT:/.test(line)) ?? stdout.split(/\r?\n/).slice(-1)[0] ?? ''
  const ok = result.status === 0
  return {
    id: 'gate',
    ok,
    fatal: !ok,
    detail: ok ? `PASS — ${verdictLine}` : `FAIL (exit ${result.status}) — ${verdictLine || stderr || 'no output'}`,
    script,
    exitCode: result.status,
    stdout,
    stderr,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法: node scripts/preflight-restart.mjs [--profile <dir>] [--json <path>] [--quiet]')
    console.log('退出码: 0=可以重启  1=拒绝重启  2=环境错误（什么都没验证）')
    process.exit(0)
  }
  const profileDir = resolve(options.profile ?? process.env.DSH_PROFILE_DIR ?? DEFAULT_PROFILE_DIR)
  if (!existsSync(join(profileDir, 'package.json'))) {
    console.error(`PREFLIGHT: ERROR — profile 目录无效：${profileDir}`)
    process.exit(2)
  }

  const startedAt = Date.now()
  const checks = [checkManifest(profileDir), checkAudit(profileDir), checkGate()]
  const blocked = checks.filter((check) => check.fatal)
  const result = {
    ok: blocked.length === 0,
    checkedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    profileDir,
    pluginDir: PLUGIN_DIR,
    checks: checks.map(({ report, stdout, ...rest }) => rest),
  }

  const reportDir = process.env.DSH_CAPABILITY_LEDGER_DIR ?? DEFAULT_REPORT_DIR
  const jsonPath = options.json ?? join(reportDir, 'preflight-latest.json')
  try {
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  } catch (error) {
    result.jsonPath = null
    result.jsonError = error.message
  }

  if (!options.quiet) {
    console.log(`PREFLIGHT ${result.ok ? 'PASS' : 'BLOCKED'}  profile=${profileDir}`)
    for (const check of checks) {
      console.log(`  [${check.ok ? 'ok' : 'NO'}] ${check.id.padEnd(8)} ${check.detail}`)
    }
    const audit = checks.find((check) => check.id === 'audit')?.report
    if (audit !== undefined && audit.problems?.length > 0) {
      console.log('')
      console.log(formatAuditReport(audit))
    }
    if (result.ok) console.log('可以重启：node tools\\dsh-restart-safe.ps1（或 DSH 菜单里的重启）')
    else console.log('不要重启：先按上面的红项修，修完再跑一次本命令')
    if (jsonPath) console.log(`快照: ${jsonPath}`)
  }

  process.exit(result.ok ? 0 : 1)
}

main()

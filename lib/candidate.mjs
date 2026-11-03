/**
 * Candidate pre-check: judge a plugin before it is installed.
 *
 * Two input kinds, two different depths, and the depth is always stated in the result:
 *
 *   local path — full static scan of the package directory (entry, client artifact
 *                materialized with a window shim, peers, install scripts, credentials);
 *   npm name   — METADATA ONLY via `npm view --json`. No tarball is downloaded, so
 *                this cannot see the code it would run; it only sees the declarations
 *                that are already enough to catch the shapes that broke this profile
 *                before (non-optional host peers, install-time scripts, no exports).
 *
 * Nothing here installs, resolves peer trees, or writes to the profile.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { auditPackage } from './audit.mjs'

/** Strict enough that the spec is safe to place inside a shell command line. */
const NPM_SPEC_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[A-Za-z0-9][\w.^~<>=*|-]*)?$/
const NPM_TIMEOUT_MS = 20_000

const HOST_OWNED = /^@deepseek-ai\/(dsh($|[-/])|cordis$|schemastery$|cosmokit$)/
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

export function looksLikeLocalPath(spec) {
  const value = String(spec ?? '').trim()
  if (value.length === 0) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('.') || value.startsWith('\\\\') || value.startsWith('/')) return true
  return existsSync(value)
}

/**
 * @param {{ spec: string, timeoutMs?: number }} input
 * @returns {object} candidate report
 */
export function checkCandidate({ spec, timeoutMs = NPM_TIMEOUT_MS }) {
  const value = String(spec ?? '').trim()
  if (value.length === 0) {
    return { kind: 'none', spec: value, verdict: 'fail', findings: [{ level: 'problem', text: 'empty candidate' }], checkedAt: Date.now() }
  }
  if (looksLikeLocalPath(value)) return checkLocalPath(value)
  if (!NPM_SPEC_RE.test(value)) {
    return {
      kind: 'invalid',
      spec: value,
      verdict: 'fail',
      checkedAt: Date.now(),
      findings: [{ level: 'problem', text: 'not a local path and not a valid npm package spec' }],
    }
  }
  return checkNpmSpec(value, timeoutMs)
}

function checkLocalPath(spec) {
  const checkedAt = Date.now()
  if (!existsSync(spec)) {
    return { kind: 'local', spec, checkedAt, verdict: 'fail', findings: [{ level: 'problem', text: `path does not exist: ${spec}` }] }
  }
  const report = auditPackage(spec)
  return {
    ...report,
    kind: 'local',
    spec,
    checkedAt,
    limits: 'local path: static scan + client artifact materialization; the package is not run',
  }
}

function checkNpmSpec(spec, timeoutMs) {
  const checkedAt = Date.now()
  const result = runNpmView(spec, timeoutMs)
  if (result.error !== null) {
    return {
      kind: 'npm',
      spec,
      checkedAt,
      verdict: 'fail',
      findings: [{ level: 'problem', text: result.error }],
      limits: 'npm metadata only',
    }
  }
  const meta = result.meta
  const findings = []
  const deps = Object.keys(meta.dependencies ?? {})
  const peers = meta.peerDependencies ?? {}
  const peerMeta = meta.peerDependenciesMeta ?? {}
  const requiredPeers = Object.keys(peers).filter((name) => peerMeta[name]?.optional !== true)
  const hostPeers = requiredPeers.filter((name) => HOST_OWNED.test(name))
  const scripts = meta.scripts ?? {}
  const installScripts = INSTALL_SCRIPTS.filter((name) => typeof scripts[name] === 'string')

  findings.push({ level: 'note', text: `publishes ${meta.name}@${meta.version}${meta.license ? ` (${meta.license})` : ''}` })
  if (typeof meta.description === 'string' && meta.description.length > 0) findings.push({ level: 'note', text: meta.description.slice(0, 240) })

  if (meta.deprecated === true) findings.push({ level: 'problem', text: 'package is deprecated' })
  if (typeof meta.deprecated === 'string') findings.push({ level: 'problem', text: `deprecated: ${meta.deprecated.slice(0, 200)}` })
  if (deps.length > 0) findings.push({ level: 'note', text: `${deps.length} runtime dependenc${deps.length === 1 ? 'y' : 'ies'}: ${deps.slice(0, 12).join(', ')}${deps.length > 12 ? ', …' : ''}` })
  if (hostPeers.length > 0) {
    findings.push({
      level: 'risk',
      text: `host-owned peers not optional (${hostPeers.join(', ')}) — the shape that can shadow the app's own @deepseek-ai copies`,
    })
  } else if (requiredPeers.length > 0) {
    findings.push({ level: 'risk', text: `${requiredPeers.length} non-optional peer(s): ${requiredPeers.join(', ')}` })
  }
  for (const name of installScripts) findings.push({ level: 'risk', text: `runs code at install time — ${name}: ${scripts[name]}` })
  if (meta.dsh === undefined) findings.push({ level: 'note', text: 'no "dsh" field in the published manifest — it may be a library rather than a bundle' })
  if (typeof meta.scripts?.build === 'string') findings.push({ level: 'note', text: `has a build script: ${meta.scripts.build}` })

  return {
    kind: 'npm',
    spec,
    checkedAt,
    // Flattened so the panel can render npm and local candidates with the same block.
    name: typeof meta.name === 'string' ? meta.name : '',
    version: typeof meta.version === 'string' ? meta.version : '',
    dependencies: deps,
    requiredPeers,
    installScripts,
    bundlePatch: typeof meta.dsh?.bundle?.patch === 'string' ? meta.dsh.bundle.patch : '',
    verdict: findings.some((item) => item.level === 'problem') ? 'fail' : findings.some((item) => item.level === 'risk') ? 'warn' : 'pass',
    findings,
    limits: 'npm metadata only (`npm view --json`): the tarball is not downloaded, so its code is NOT inspected',
    data: {
      name: typeof meta.name === 'string' ? meta.name : '',
      version: typeof meta.version === 'string' ? meta.version : '',
      license: typeof meta.license === 'string' ? meta.license : '',
      repository: typeof meta.repository?.url === 'string' ? meta.repository.url : typeof meta.repository === 'string' ? meta.repository : '',
      homepage: typeof meta.homepage === 'string' ? meta.homepage : '',
      dependencies: deps,
      requiredPeers,
      installScripts,
      dsh: meta.dsh ?? null,
      distTarball: typeof meta.dist?.tarball === 'string' ? meta.dist.tarball : '',
    },
  }
}

function runNpmView(spec, timeoutMs) {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm view ${spec} --json --fetch-timeout=${timeoutMs} --fetch-retries=0`]
    : ['view', spec, '--json', `--fetch-timeout=${timeoutMs}`, '--fetch-retries=0']
  const child = spawnSync(command, args, {
    timeout: timeoutMs + 5_000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
  })
  if (child.error) return { error: `npm view failed to start: ${String(child.error.message ?? child.error)}`, meta: null }
  const stdout = typeof child.stdout === 'string' ? child.stdout.trim() : ''
  if (stdout.length === 0) {
    const stderr = typeof child.stderr === 'string' ? child.stderr.trim().split('\n').slice(-3).join(' | ') : ''
    return { error: `npm view returned nothing (exit ${child.status ?? 'null'})${stderr ? ` — ${stderr}` : ''}`, meta: null }
  }
  try {
    const parsed = JSON.parse(stdout)
    const meta = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
    if (meta === null || typeof meta !== 'object') return { error: 'npm view returned no usable metadata', meta: null }
    return { error: null, meta }
  } catch (error) {
    return { error: `npm view returned unparsable JSON: ${String(error?.message ?? error)}`, meta: null }
  }
}

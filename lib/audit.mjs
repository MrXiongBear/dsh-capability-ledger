/**
 * Read-only safety audit of a DSH profile.
 *
 * This is the ledger's "顺便体检" half, and it is the same check that already caught
 * a real crash on this machine (a client module missing from a hand-rolled bundler's
 * MODULES table). It never mutates the profile, never installs anything and never
 * runs a package's own code as a side effect: a client artifact is evaluated with a
 * `window` shim only, which is exactly what the shell does when it materializes it.
 *
 * Ported from a standalone gate script and
 * turned into a pure function returning a report, so the panel, the tests and the
 * CLI all share one implementation.
 *
 * Findings are grouped by severity:
 *   problems — things that are broken right now (or will break the next boot);
 *   risks    — shapes that broke boot before but are currently only latent;
 *   notes    — informational, no action implied.
 */
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'

/** @deepseek-ai packages the app loads from its own module graph at boot. */
const HOST_OWNED = /^@deepseek-ai\/(dsh($|[-/])|cordis$|schemastery$|cosmokit$)/

/** Package.json lifecycle scripts that run code at install time. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/** Obvious credential literals. Reporting the path only — never the value. */
const SECRET_PATTERNS = [
  { label: 'OpenAI-compatible key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]

/**
 * Scan ceiling for client/server artifacts. This check only proves "the file is
 * readable and parseable", not "the file is small"; it was 512 KiB until
 * 2026-11-02, when dsh-deepy-whale's 20-sheet client bundle (~555 KB) tripped it
 * with a false red. 1 MiB keeps the readability guarantee without the false
 * negative on legitimately big self-built bundles.
 */
const MAX_SCAN_BYTES = 1024 * 1024

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readTextCapped(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Client artifact resolution mirrors dsh-client-modules. */
function findClientFile(entry) {
  const pkg = entry.pkg ?? {}
  const exportsField = pkg.exports
  let clientRel = null
  if (typeof exportsField === 'string') clientRel = exportsField
  else if (exportsField && typeof exportsField === 'object' && typeof exportsField['./client'] === 'string') {
    clientRel = exportsField['./client']
  }
  const candidates = [clientRel, 'lib/client.js', 'client.js', 'lib/client.mjs'].filter((item) => typeof item === 'string')
  for (const rel of candidates) {
    const abs = join(entry.dir, rel)
    if (existsSync(abs)) return abs
  }
  return null
}

/** Evaluate the client artifact the way the shell does and run its factory. */
function materialize(entry, shellRequire) {
  const file = findClientFile(entry)
  if (file === null) return { state: 'none' }
  const source = readTextCapped(file)
  if (source === null) return { state: 'unreadable', file }
  let captured = null
  const windowShim = {
    __ModuleLoader__: {
      load(envelope) {
        if (captured !== null) throw new Error('load() called twice')
        captured = envelope
      },
    },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'localStorage', source)(windowShim, undefined, undefined)
  } catch (error) {
    return { state: 'threw-eval', file, error: firstLine(error) }
  }
  if (captured === null) return { state: 'no-envelope', file }
  if (captured.id !== (entry.pkg ?? {}).name) {
    return { state: 'id-mismatch', file, error: `${captured.id} != ${entry.pkg?.name}` }
  }
  try {
    const mod = captured.factory(shellRequire)
    return {
      state: 'ok',
      file,
      bytes: statSync(file).size,
      hasApply: typeof mod?.apply === 'function',
      inject: Array.isArray(mod?.inject) ? mod.inject : [],
    }
  } catch (error) {
    const message = firstLine(error)
    const miss = /Cannot find module '([^']+)'/.exec(String(error?.message ?? error))
    // A relative specifier belongs to the plugin itself: if the artifact's internal
    // table lacks it, the shell cannot supply it either, and the whole entry fails
    // to import (this is the 2026-10-29 crash). A bare specifier is a platform
    // external the running shell hands out, which Node here cannot resolve.
    const own = miss !== null && miss[1].startsWith('.')
    return { state: own ? 'threw-factory' : 'external-in-node', file, missing: miss?.[1], error: message }
  }
}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0]
}

/** Byte layout of an asar archive: a 16-byte preamble, then the JSON header. */
const ASAR_PREAMBLE = 16
const ASAR_MAX_HEADER = 64 * 1024 * 1024

/** The Harness packages live under this directory inside the app archive. */
const APP_DSH_INNER = 'dsh'

let asarCache = null
let appVariantsCache
/** Test seam: when set, replaces the whole install-directory probe. */
let appCandidatesOverride

function parseAsar(file) {
  if (asarCache !== null && asarCache.file === file) return asarCache
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(ASAR_PREAMBLE)
    readSync(fd, head, 0, ASAR_PREAMBLE, 0)
    const headerSize = head.readUInt32LE(12)
    if (!Number.isFinite(headerSize) || headerSize <= 0 || headerSize > ASAR_MAX_HEADER) {
      throw new Error(`unreadable asar header: ${file}`)
    }
    const buf = Buffer.alloc(headerSize)
    readSync(fd, buf, 0, headerSize, ASAR_PREAMBLE)
    asarCache = { file, base: ASAR_PREAMBLE + headerSize, header: JSON.parse(buf.toString('utf8')) }
    return asarCache
  } finally {
    closeSync(fd)
  }
}

function asarNode(file, innerPath) {
  let node = parseAsar(file).header
  for (const part of innerPath.split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (!node) return null
  }
  return node?.files ? null : node
}

function readAsarText(file, innerPath) {
  const node = asarNode(file, innerPath)
  // asar stores `offset` as a decimal STRING (it can exceed 2^32), so coerce before use.
  const offset = node === null ? Number.NaN : Number(node.offset)
  const size = node === null ? Number.NaN : Number(node.size)
  if (!Number.isFinite(offset) || !Number.isFinite(size) || size < 0 || size > MAX_SCAN_BYTES) return null
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, parseAsar(file).base + offset)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Where the Windows uninstaller recorded the app, when a registry hive is readable. */
function uninstallInstallLocations() {
  if (process.platform !== 'win32') return []
  const found = []
  const hives = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const hive of hives) {
    try {
      const text = execFileSync('reg', ['query', hive, '/s', '/f', 'DeepSeek Harness', '/d'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const match of text.matchAll(/InstallLocation\s+REG_SZ\s+(.+)/g)) found.push(match[1].trim())
    } catch {
      // Missing hive, no match, or reg.exe unavailable — the other sources still apply.
    }
  }
  return found
}

/** Install directories worth probing for the running app's own Harness packages. */
function appCandidates() {
  if (appCandidatesOverride !== undefined) return appCandidatesOverride
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) candidates.push(value.trim())
  }
  push(process.env.DSH_APP_ASAR)
  push(process.env.DSH_APP_ROOT)
  push(process.env.DSH_INSTALL_DIR)
  // In Electron this points at <install>/resources, so its parent is the install root.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) push(dirname(process.resourcesPath))
  for (const location of uninstallInstallLocations()) push(location)
  if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  if (process.env.ProgramFiles) push(join(process.env.ProgramFiles, 'DeepSeek Harness'))
  if (process.env['ProgramFiles(x86)']) push(join(process.env['ProgramFiles(x86)'], 'DeepSeek Harness'))
  return [...new Set(candidates)]
}

/**
 * The app's own copy of the Harness, as an archive or an unpacked directory.
 *
 * Inside the running shell this resolves through `process.resourcesPath`; under a
 * plain `node` CLI that value does not exist, so the uninstaller's InstallLocation and
 * the usual install directories are tried next. Returning an empty list is a reportable
 * state, not a silent one: without an app copy the drift check cannot run at all.
 */
function appVariants() {
  if (appVariantsCache !== undefined) return appVariantsCache
  const variants = []
  const seen = new Set()
  const add = (variant) => {
    const key = variant.kind === 'asar' ? `asar:${variant.file}` : `dir:${variant.root}`
    if (seen.has(key)) return
    seen.add(key)
    variants.push(variant)
  }
  for (const candidate of appCandidates()) {
    const asar = /\.asar$/i.test(candidate) ? candidate : join(candidate, 'resources', 'app.asar')
    if (existsSync(asar)) {
      try {
        if (readAsarText(asar, `${APP_DSH_INNER}/package.json`) !== null) add({ kind: 'asar', file: asar })
      } catch {
        // Not a readable archive: fall through to the directory shapes.
      }
    }
    const innerDir = join(candidate, APP_DSH_INNER)
    if (existsSync(join(innerDir, 'package.json'))) add({ kind: 'dir', root: innerDir })
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'node_modules'))) {
      add({ kind: 'dir', root: candidate })
    }
  }
  appVariantsCache = variants
  return variants
}

/** Read a file relative to the app's dsh directory, from whichever shape resolved. */
function readAppText(innerPath) {
  const posixPath = innerPath.split('\\').join('/')
  for (const variant of appVariants()) {
    if (variant.kind === 'asar') {
      const text = readAsarText(variant.file, `${APP_DSH_INNER}/${posixPath}`)
      if (text !== null) return text
      continue
    }
    const file = join(variant.root, innerPath)
    if (existsSync(file)) {
      const text = readTextCapped(file)
      if (text !== null) return text
    }
  }
  return null
}

function appPackageVersion(name) {
  const text = readAppText(join('node_modules', name, 'package.json'))
  if (text === null) return null
  try {
    const pkg = JSON.parse(text)
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** Version and location of the app copy, so a report can say what it compared against. */
function appIdentity() {
  const variants = appVariants()
  const text = readAppText('package.json')
  let version = null
  if (text !== null) {
    try {
      const pkg = JSON.parse(text)
      version = typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      version = null
    }
  }
  const first = variants[0] ?? null
  return {
    appVersion: version,
    appRoot: first === null ? null : first.kind === 'asar' ? first.file : first.root,
    resolved: variants.length > 0,
  }
}

/** Files of one installed bundle that could carry a tool registration or a secret. */
function hostEntryFiles(entry) {
  const pkg = entry.pkg ?? {}
  const files = []
  const push = (relative) => {
    const abs = join(entry.dir, relative)
    if (existsSync(abs) && statSync(abs).isFile()) files.push(abs)
  }
  push(pkg.main ?? 'index.js')
  push('index.js')
  push('lib/index.js')
  push('lib/index.mjs')
  push('package.json')
  return [...new Set(files)]
}

/**
 * Audit one profile directory.
 * @param {string} profileDir absolute profile path (the directory holding package.json)
 * @returns {object} report
 */
export function auditProfile(profileDir) {
  const pkgJsonPath = join(profileDir, 'package.json')
  const manifest = readJson(pkgJsonPath)
  if (manifest === null) {
    return {
      scannedAt: Date.now(),
      profile: profileDir,
      ok: false,
      error: `no readable package.json in ${profileDir}`,
      problems: [`profile package.json is missing or invalid: ${pkgJsonPath}`],
      risks: [],
      notes: [],
      fatal: [`profile package.json is missing or invalid: ${pkgJsonPath}`],
      bundles: 0,
      deps: 0,
      rows: [],
      shadowedHostPackages: [],
      versionDrift: [],
      depsNotInBundles: [],
      patch: { lines: 0, entries: [] },
    }
  }

  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = manifest.dependencies ?? {}
  const devDeps = manifest.devDependencies ?? {}
  let shellRequire = null
  try {
    shellRequire = createRequire(pkgJsonPath)
  } catch {
    shellRequire = createRequire(import.meta.url)
  }

  const problems = []
  const risks = []
  const notes = []
  const rows = []

  for (const id of bundles) {
    const dir = join(profileDir, 'node_modules', id)
    const present = existsSync(dir)
    const inDeps = Object.prototype.hasOwnProperty.call(deps, id)
    const inDevDeps = Object.prototype.hasOwnProperty.call(devDeps, id)
    const row = { id, present, inDeps, inDevDeps, status: 'ok', client: 'none' }

    if (!present) {
      if (id.startsWith('@deepseek-ai/')) {
        row.status = 'builtin'
        notes.push(`${id}: not in profile node_modules — built-in bundle resolved from the app`)
      } else {
        row.status = 'MISSING-PACKAGE'
        problems.push(`${id}: MISSING-PACKAGE — listed in dsh.profile.bundles but not installed in node_modules`)
      }
      rows.push(row)
      continue
    }

    const pkg = readJson(join(dir, 'package.json')) ?? {}
    const entry = { id, dir, pkg, present }
    if (!inDeps && !inDevDeps) {
      row.status = 'NOT-IN-DEPS'
      notes.push(`${id}: bundle without a dependency entry (installed by another package?)`)
    }

    const mainRel = pkg.main ?? 'index.js'
    row.hostMain = mainRel
    row.hostMainExists = existsSync(join(dir, mainRel))
    if (!row.hostMainExists) problems.push(`${id}: main "${mainRel}" does not exist`)
    row.version = typeof pkg.version === 'string' ? pkg.version : ''

    const client = materialize(entry, shellRequire)
    row.client = client.state
    if (client.state === 'ok') {
      row.clientBytes = client.bytes
      row.clientInjects = client.inject
      if (client.hasApply !== true) notes.push(`${id}: client bundle has no apply()`)
    } else if (client.state === 'external-in-node') {
      notes.push(`${id}: client needs platform external ${client.missing} (expected outside the shell)`)
    } else if (client.state !== 'none') {
      problems.push(`${id}: CLIENT ${client.state} — ${client.error ?? ''}`)
    }

    // Non-optional host peers make pnpm materialize a physical copy inside the
    // profile, which then shadows the app's own copy at boot.
    const peers = pkg.peerDependencies ?? {}
    const peerMeta = pkg.peerDependenciesMeta ?? {}
    const requiredPeers = Object.keys(peers).filter((name) => peerMeta[name]?.optional !== true)
    row.requiredPeers = requiredPeers
    if (requiredPeers.length > 0) {
      risks.push(
        `${id}: ${requiredPeers.length} non-optional peer(s) — ${requiredPeers.slice(0, 6).join(', ')}${requiredPeers.length > 6 ? ', …' : ''}`,
      )
      const shadowing = requiredPeers.filter(
        (name) =>
          HOST_OWNED.test(name) &&
          name !== '@deepseek-ai/schemastery' &&
          name !== '@deepseek-ai/cosmokit' &&
          existsSync(join(profileDir, 'node_modules', name)),
      )
      if (shadowing.length > 0) {
        problems.push(`${id}: required host peer(s) physically present in the profile (shadowing risk): ${shadowing.join(', ')}`)
      }
    }

    // Install-time scripts and credential literals are the two cheap "is this
    // package behaving?" checks that do not need its source tree.
    const scripts = pkg.scripts ?? {}
    const installScripts = INSTALL_SCRIPTS.filter((name) => typeof scripts[name] === 'string')
    row.installScripts = installScripts
    if (installScripts.length > 0) {
      risks.push(`${id}: runs code at install time — ${installScripts.map((name) => `${name}: ${scripts[name]}`).join(' | ')}`)
    }

    const secretHits = []
    for (const file of hostEntryFiles(entry)) {
      const text = readTextCapped(file)
      if (text === null) continue
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) secretHits.push(`${pattern.label} in ${file}`)
      }
    }
    row.secrets = secretHits
    if (secretHits.length > 0) problems.push(`${id}: possible plaintext credential — ${secretHits.join('; ')}`)
    rows.push(row)
  }

  // Host package copies inside the profile (the dsh-tools crash vector) plus a
  // version comparison against the app's own copy (the nightly-upgrade vector).
  const shadowedHostPackages = []
  const versionDrift = []
  const app = appIdentity()
  if (!app.resolved) {
    risks.push(
      'could not locate the running app\'s own @deepseek-ai packages, so version drift was NOT checked — set DSH_APP_ROOT to the install directory (or DSH_APP_ASAR to app.asar) and rerun',
    )
  }
  const scopeDir = join(profileDir, 'node_modules', '@deepseek-ai')
  if (existsSync(scopeDir)) {
    for (const name of safeReaddir(scopeDir)) {
      const dir = join(scopeDir, name)
      let isDir = false
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      const pkg = readJson(join(dir, 'package.json'))
      const copyName = `@deepseek-ai/${name}`
      const version = pkg?.version ?? '?'
      shadowedHostPackages.push(`${copyName}@${version}`)
      const appVersion = appPackageVersion(copyName)
      if (appVersion !== null && appVersion !== version) {
        versionDrift.push({ package: copyName, profile: version, app: appVersion })
      }
    }
  }
  if (versionDrift.length > 0) {
    const behind = [...new Set(versionDrift.map((row) => row.profile))].join(', ')
    const shipped = [...new Set(versionDrift.map((row) => row.app))].join(', ')
    risks.push(
      `${versionDrift.length} profile copy/copies of @deepseek-ai packages are behind the app (profile ${behind} vs app ${shipped}): ${versionDrift
        .map((row) => row.package.replace('@deepseek-ai/', ''))
        .join(', ')} — they stay pinned by the market bundle's own version, and the market UI can break once the app stops honouring the old shape`,
    )
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  let patchLines = 0
  let patchIds = []
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    patchLines = text.split('\n').length
    patchIds = [...text.matchAll(/^-\s*id:\s*([\w@/.-]+)\s*$/gm)].map((match) => match[1])
  } else {
    notes.push('no cordis.patch.yml in the profile — every bundle comes from dsh.profile.bundles alone')
  }

  const depsNotInBundles = Object.keys(deps).filter((name) => !bundles.includes(name))

  // A client artifact that cannot materialize, a missing package, or a missing host
  // entry is fatal: the profile loader is all-or-nothing, so any of these turns the
  // next boot into a self-repair cycle.
  const fatal = problems.filter(
    (problem) => problem.includes('CLIENT') || problem.includes('MISSING-PACKAGE') || problem.includes('does not exist') || problem.includes('plaintext credential'),
  )

  return {
    scannedAt: Date.now(),
    profile: profileDir,
    ok: fatal.length === 0,
    appVersion: app.appVersion,
    appRoot: app.appRoot,
    bundles: bundles.length,
    deps: Object.keys(deps).length,
    patch: { lines: patchLines, entries: patchIds },
    shadowedHostPackages,
    versionDrift,
    depsNotInBundles,
    problems,
    risks,
    notes,
    fatal,
    rows,
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Inspect one candidate plugin directory before it is installed anywhere.
 *
 * A candidate is not part of a profile yet, so there is no bundle list to walk: this
 * checks the package contract instead — host entry present, client artifact
 * materializes, non-optional host peers, install-time scripts, credential literals.
 */
export function auditPackage(pkgDir) {
  const pkgJsonPath = join(pkgDir, 'package.json')
  const pkg = readJson(pkgJsonPath)
  const findings = []
  if (pkg === null) {
    return {
      kind: 'package',
      dir: pkgDir,
      name: '',
      version: '',
      verdict: 'fail',
      findings: [{ level: 'problem', text: `no readable package.json in ${pkgDir}` }],
    }
  }

  let shellRequire = null
  try {
    shellRequire = createRequire(pkgJsonPath)
  } catch {
    shellRequire = createRequire(import.meta.url)
  }

  const mainRel = pkg.main ?? 'index.js'
  const mainExists = existsSync(join(pkgDir, mainRel))
  if (!mainExists) findings.push({ level: 'problem', text: `main "${mainRel}" does not exist` })

  const entry = { dir: pkgDir, pkg, present: true }
  const client = materialize(entry, shellRequire)
  if (client.state === 'none') {
    findings.push({ level: 'note', text: 'no client artifact — host-only plugin' })
  } else if (client.state === 'external-in-node') {
    findings.push({ level: 'note', text: `client needs platform external ${client.missing} (expected outside the shell)` })
  } else if (client.state === 'ok') {
    findings.push({ level: 'note', text: `client artifact materializes (${client.bytes}B, id ok, apply ${client.hasApply ? 'present' : 'MISSING'})` })
    if (client.hasApply !== true) findings.push({ level: 'risk', text: 'client bundle has no apply()' })
  } else {
    findings.push({ level: 'problem', text: `CLIENT ${client.state} — ${client.error ?? ''}` })
  }

  const peers = pkg.peerDependencies ?? {}
  const peerMeta = pkg.peerDependenciesMeta ?? {}
  const requiredPeers = Object.keys(peers).filter((name) => peerMeta[name]?.optional !== true)
  if (requiredPeers.length > 0) {
    findings.push({ level: 'risk', text: `${requiredPeers.length} non-optional peer(s): ${requiredPeers.join(', ')}` })
    const hostPeers = requiredPeers.filter((name) => HOST_OWNED.test(name))
    if (hostPeers.length > 0) {
      findings.push({
        level: 'risk',
        text: `declares host-owned peers (${hostPeers.join(', ')}) — with autoInstallPeers:false they are hoisted, but enabling it would shadow the app's own copies`,
      })
    }
  }

  const scripts = pkg.scripts ?? {}
  const installScripts = INSTALL_SCRIPTS.filter((name) => typeof scripts[name] === 'string')
  for (const name of installScripts) {
    findings.push({ level: 'risk', text: `runs code at install time — ${name}: ${scripts[name]}` })
  }

  const secretHits = []
  for (const file of hostEntryFiles(entry)) {
    const text = readTextCapped(file)
    if (text === null) continue
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(text)) secretHits.push(`${pattern.label} in ${file}`)
    }
  }
  for (const hit of secretHits) findings.push({ level: 'problem', text: `possible plaintext credential — ${hit}` })

  const dsh = pkg.dsh ?? {}
  findClientFile(entry)
  return {
    kind: 'package',
    dir: pkgDir,
    name: typeof pkg.name === 'string' ? pkg.name : '',
    version: typeof pkg.version === 'string' ? pkg.version : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    license: typeof pkg.license === 'string' ? pkg.license : '',
    dependencies: Object.keys(pkg.dependencies ?? {}),
    requiredPeers,
    installScripts,
    bundlePatch: typeof dsh?.bundle?.patch === 'string' ? dsh.bundle.patch : '',
    clientPlatform: typeof dsh?.client?.platform === 'string' ? dsh.client.platform : '',
    mainExists,
    client: { state: client.state, bytes: client.bytes ?? 0, inject: client.inject ?? [] },
    verdict: findings.some((item) => item.level === 'problem') ? 'fail' : findings.some((item) => item.level === 'risk') ? 'warn' : 'pass',
    findings,
  }
}

/**
 * Test seam: forget the memoized app-archive discovery so a test can point
 * DSH_APP_ASAR at its own fixture between runs.
 */
export function resetAppDiscovery() {
  asarCache = null
  appVariantsCache = undefined
  appCandidatesOverride = undefined
}

/**
 * Test seam: replace the install-directory probe with an explicit list, so the
 * "no app copy anywhere" branch can be exercised on a machine that has the app.
 * Pass `null` to model "nowhere to look".
 */
export function setAppCandidatesForTest(candidates) {
  appCandidatesOverride = Array.isArray(candidates) ? [...candidates] : []
  appVariantsCache = undefined
}

/** Human-readable one-shot report, used by the CLI and the exported snapshot. */export function formatAuditReport(report) {
  const lines = []
  lines.push(`profile: ${report.profile}`)
  lines.push(`scanned: ${new Date(report.scannedAt).toISOString()}   bundles: ${report.bundles}   deps: ${report.deps}`)
  if (report.appVersion !== undefined) {
    lines.push(
      report.appVersion === null
        ? 'app: version unknown — the app\'s own @deepseek-ai packages were not found, so drift is unchecked'
        : `app: ${report.appVersion}${report.appRoot ? ` (${report.appRoot})` : ''}`,
    )
  }
  if (report.patch) lines.push(`cordis.patch.yml: ${report.patch.lines} lines / ${report.patch.entries.length} entries`)
  lines.push('')
  for (const row of report.rows ?? []) {
    lines.push(
      [
        String(row.id).padEnd(44),
        row.present ? 'inst ' : 'MISS ',
        row.client.padEnd(17),
        row.clientBytes === undefined ? '' : `${row.clientBytes}B`,
      ].join(' '),
    )
  }
  lines.push('')
  lines.push(`shadowed @deepseek-ai copies: ${report.shadowedHostPackages.length}`)
  for (const copy of report.shadowedHostPackages) lines.push(`  ${copy}`)
  const drift = report.versionDrift ?? []
  lines.push(`version drift vs the app: ${drift.length}`)
  for (const row of drift) lines.push(`  ${row.package}: profile ${row.profile} -> app ${row.app}`)
  if ((report.depsNotInBundles ?? []).length > 0) lines.push(`deps not in bundles: ${report.depsNotInBundles.join(', ')}`)
  lines.push('')
  if ((report.problems ?? []).length === 0) lines.push('PROBLEMS: none')
  else {
    lines.push('PROBLEMS:')
    for (const problem of report.problems) lines.push(`  ! ${problem}`)
  }
  if ((report.risks ?? []).length > 0) {
    lines.push('')
    lines.push('RISKS:')
    for (const risk of report.risks) lines.push(`  ~ ${risk}`)
  }
  if ((report.notes ?? []).length > 0) {
    lines.push('')
    lines.push('NOTES:')
    for (const note of report.notes) lines.push(`  - ${note}`)
  }
  return lines.join('\n')
}

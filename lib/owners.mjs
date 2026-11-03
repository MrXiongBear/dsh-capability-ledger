/**
 * Best-effort attribution: which installed bundle registers a given tool.
 *
 * The Host `tools` service deliberately does not expose an owner, so attribution is
 * a static heuristic: a bundle "owns" a tool name when one of its JavaScript files
 * contains that name as a quoted identifier. That is enough to answer "which bundle
 * costs me these schema bytes", and the report always says how much of the tool set
 * it could attribute, so nobody mistakes it for registry truth.
 *
 * Bounded on purpose: per-file 256 KB, 120 files per bundle, 900 files / 48 MB total.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, extname, basename } from 'node:path'

const MAX_FILE_BYTES = 256 * 1024
const MAX_FILES_PER_BUNDLE = 120
const MAX_FILES_TOTAL = 900
const MAX_BYTES_TOTAL = 48 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'fixtures', 'coverage'])
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs'])
const TOKEN_RE = /['"`]([A-Za-z_][\w.-]*)['"`]/g

function walk(dir, depth, budget) {
  if (depth > 5 || budget.files >= MAX_FILES_PER_BUNDLE || budget.bytes >= budget.maxBytes) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const files = []
  const dirs = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) dirs.push(join(dir, entry.name))
    } else if (entry.isFile() && CODE_EXTS.has(extname(entry.name))) {
      files.push(join(dir, entry.name))
    }
  }
  // Entry-point-looking files first so a truncated walk still sees the registrations.
  files.sort((a, b) => score(b) - score(a))
  for (const file of files) {
    if (budget.files >= MAX_FILES_PER_BUNDLE || budget.bytes >= budget.maxBytes) return
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue
    budget.files += 1
    budget.bytes += size
    budget.onFile(file)
  }
  for (const child of dirs) walk(child, depth + 1, budget)
}

function score(file) {
  const name = basename(file).toLowerCase()
  if (name === 'index.js' || name === 'index.mjs' || name === 'index.cjs') return 3
  if (name.startsWith('tool') || name.includes('register')) return 2
  return 1
}

function bundleDir(profileDir, id, shellRequire) {
  try {
    return dirname(shellRequire.resolve(`${id}/package.json`))
  } catch {
    const fallback = join(profileDir, 'node_modules', id)
    return existsSync(fallback) ? fallback : null
  }
}

/**
 * @param {{ profileDir: string, bundleIds: string[], toolNames: string[] }} input
 * @returns {{ owners: Record<string, string>, coverage: number, scannedFiles: number, scannedBytes: number }}
 */
export function buildToolOwners({ profileDir, bundleIds = [], toolNames = [] }) {
  const wanted = new Set(toolNames.filter((name) => typeof name === 'string' && name.length > 0))
  const owners = {}
  if (wanted.size === 0) return { owners, coverage: 0, scannedFiles: 0, scannedBytes: 0 }

  let shellRequire = null
  try {
    shellRequire = createRequire(join(profileDir, 'package.json'))
  } catch {
    shellRequire = createRequire(import.meta.url)
  }

  const totals = { files: 0, bytes: 0 }
  for (const id of bundleIds) {
    const remainingBefore = wanted.size
    if (remainingBefore === 0 || totals.files >= MAX_FILES_TOTAL) break
    const dir = bundleDir(profileDir, id, shellRequire)
    if (dir === null) continue
    const budget = {
      files: 0,
      bytes: 0,
      maxBytes: Math.min(MAX_FILE_BYTES * 20, MAX_BYTES_TOTAL - totals.bytes),
      onFile(file) {
        const text = readText(file)
        if (text === null) return
        TOKEN_RE.lastIndex = 0
        let match
        while ((match = TOKEN_RE.exec(text)) !== null) {
          const token = match[1]
          if (owners[token] === undefined && wanted.has(token)) {
            owners[token] = id
            wanted.delete(token)
          }
        }
      },
    }
    walk(dir, 0, budget)
    totals.files += budget.files
    totals.bytes += budget.bytes
  }

  const attributed = Object.keys(owners).length
  return {
    owners,
    coverage: toolNames.length === 0 ? 0 : Math.round((attributed / toolNames.length) * 100),
    scannedFiles: totals.files,
    scannedBytes: totals.bytes,
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

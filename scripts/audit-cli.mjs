#!/usr/bin/env node
/**
 * Standalone audit runner — the same audit the panel shows, usable as a restart gate.
 *
 * Usage:
 *   node scripts/audit-cli.mjs [profileDir] [--json <path>] [--quiet]
 *
 * Exits non-zero when a fatal finding is present (client artifact cannot materialize,
 * a listed bundle is not installed, a host entry is missing, a credential literal is
 * present), so it can gate a restart:
 *
 *   node plugins/dsh-capability-ledger/scripts/audit-cli.mjs && <restart>
 *
 * Machine-specific default profile is overridable by DSH_PROFILE_DIR.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditProfile, formatAuditReport } from '../lib/audit.mjs'

const args = process.argv.slice(2)
let profile = process.env.DSH_PROFILE_DIR ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'profiles', process.env.DSH_PROFILE_NAME ?? 'default')
let jsonOut = null
let quiet = false
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--json') {
    jsonOut = args[index + 1]
    index += 1
  } else if (arg === '--quiet') {
    quiet = true
  } else if (!arg.startsWith('--')) {
    profile = arg
  }
}

const report = auditProfile(profile)
if (!quiet) console.log(formatAuditReport(report))
if (jsonOut !== null) {
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (!quiet) console.log(`\njson: ${jsonOut}`)
}
process.exit(report.ok ? 0 : 1)

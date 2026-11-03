import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { checkCandidate, looksLikeLocalPath } from '../lib/candidate.mjs'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

test('local paths are recognised, bare package names are not', () => {
  assert.equal(looksLikeLocalPath('D:\\ws\\plugins\\dsh-capability-ledger'), true)
  assert.equal(looksLikeLocalPath('D:\\ws\\plugins\\other'), true)
  assert.equal(looksLikeLocalPath('./plugins/x'), true)
  assert.equal(looksLikeLocalPath('dsh-skill-scoreboard'), false)
  assert.equal(looksLikeLocalPath('@scope/name'), false)
  assert.equal(looksLikeLocalPath(''), false)
})

test('a missing local path fails without spawning anything', () => {
  const result = checkCandidate({ spec: 'D:\\ws\\plugins\\definitely-not-here' })
  assert.equal(result.kind, 'local')
  assert.equal(result.verdict, 'fail')
  assert.ok(result.findings[0].text.includes('does not exist'))
})

test('a spec that is neither a path nor a plausible npm name is rejected before any shell use', () => {
  const result = checkCandidate({ spec: 'foo; rm -rf /' })
  assert.equal(result.verdict, 'fail')
  assert.equal(result.kind, 'invalid')
})

test('this plugin scans as a local candidate: platform externals are tolerated, no problems', () => {
  const result = checkCandidate({ spec: PLUGIN_DIR })
  assert.equal(result.kind, 'local')
  assert.equal(result.spec, PLUGIN_DIR)
  assert.equal(result.verdict, 'pass', JSON.stringify(result.findings))
  assert.equal(result.client.state, 'external-in-node')
  assert.equal(result.bundlePatch, './cordis.patch.yml')
  assert.equal(result.kind === 'local' && typeof result.limits, 'string')
})

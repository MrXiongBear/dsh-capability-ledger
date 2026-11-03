#!/usr/bin/env node
/**
 * Install-state verification for dsh-capability-ledger.
 *
 *     node scripts/verify-install.mjs
 *
 * The plugin has two supported states and this script proves the profile is in exactly one of
 * them, cleanly — never half-mounted:
 *
 *   mounted   — manifest lists it as a dependency AND a bundle, the profile node_modules entry
 *               points at this working copy, and the shell answers /api/capability-ledger/report.
 *   unmounted — manifest lists neither, and no stale junction is left behind. This is the state
 *               since 2026-10-31 (the panel is not mounted on purpose); the CLI audit and the
 *               restart preflight still work from this directory.
 *
 * A half-state (dependency without bundle, bundle without dependency, dangling junction) is a
 * failure: that is what a self-healed profile looks like.
 *
 * Exit code 0 means "the profile is in one intended state". Anything else prints what to look at.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-capability-ledger'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'profiles', process.env.DSH_PROFILE_NAME ?? 'default')
const BASE_URL = (process.env.DSH_WEB_URL || 'http://127.0.0.1:62352').replace(/\/+$/, '')

const problems = []
let apiChecked = false

function fail(message) {
  problems.push(message)
  console.log(`FAIL ${message}`)
}

function note(message) {
  console.log(`  ok ${message}`)
}

// 1. manifest — read once, decide the state from it
let manifest
try {
  manifest = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'))
} catch (error) {
  fail(`读不了 profile manifest：${error.message}`)
  console.log('')
  console.log('VERIFY: FAIL (1 problem)')
  process.exit(1)
}
const bundles = manifest.dsh?.profile?.bundles ?? []
const deps = manifest.dependencies ?? {}
const inBundles = bundles.includes(PKG_NAME)
const inDeps = Object.hasOwn(deps, PKG_NAME)

if (inBundles !== inDeps) {
  fail(`半挂载状态：dependencies=${inDeps}，bundles=${inBundles}（要么都登记，要么都不登记）`)
}
const mounted = inBundles && inDeps
if (mounted) note(`mounted：manifest 已登记（bundles ${bundles.length} 项 / deps ${Object.keys(deps).length} 项）`)
else note(`unmounted：manifest 未登记（bundles ${bundles.length} 项 / deps ${Object.keys(deps).length} 项）`)

// 2. node_modules 入口 — must match the state above
const installed = join(PROFILE_DIR, 'node_modules', PKG_NAME)
if (mounted) {
  if (!existsSync(installed)) {
    fail(`mounted 但 profile node_modules 里没有 ${PKG_NAME}（跑一次 pnpm install）`)
  } else {
    try {
      const target = realpathSync(installed)
      const expected = realpathSync(PLUGIN_DIR)
      if (target.toLowerCase() === expected.toLowerCase()) note(`node_modules 链接指向 ${target}`)
      else fail(`node_modules 链接指向 ${target}，期望 ${expected}`)
    } catch (error) {
      fail(`链接解析失败：${error.message}`)
    }
  }
} else if (existsSync(installed)) {
  fail(`unmounted 但 node_modules 里还留着 ${PKG_NAME}（cmd /c rmdir "${installed}" 可清掉）`)
} else {
  note('node_modules 里没有残留（unmounted 状态的正确形状）')
}

// 3. 运行中的壳 — only meaningful when mounted.
//
// The shell gates /api/* behind a signed browser-session cookie that only the page gets
// (opening the URL printed by `dsh web` mints it). A plain terminal fetch therefore gets 401
// even when the plugin is perfectly loaded — expected, not a failure. What we can still prove
// from here: the shell is up and the manifest/junction survived the boot.
async function probeApi() {
  const url = `${BASE_URL}/api/capability-ledger/report`
  let response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    fail(`连不上 ${url}：${error.message}（壳没起？）`)
    return
  }
  if (response.status === 401) {
    console.log('')
    console.log('  --  GET /report → 401（壳要求浏览器会话 cookie，终端拿不到；正常）')
    console.log('      真正要看的是界面：左下角「台账」按钮 → 打开面板，能出数就说明链路通了。')
    return
  }
  if (response.status !== 200) {
    fail(`GET ${url} → HTTP ${response.status}`)
    return
  }
  apiChecked = true
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    fail(`响应不是 JSON：${error.message}`)
    return
  }
  if (payload?.ok !== true) {
    fail(`响应信封 ok!==true：${JSON.stringify(payload).slice(0, 300)}`)
    return
  }
  note(`GET /report 200（profile=${payload.profile}）`)
  const sessions = payload.ledger?.sessions ?? {}
  const skills = payload.ledger?.skills ?? {}
  const tools = payload.ledger?.tools ?? {}
  const schema = payload.ledger?.schema ?? {}
  console.log('')
  console.log(`  会话：${sessions.total ?? 0} 个（turn ${sessions.turns ?? 0} / tool 调用 ${sessions.toolCalls ?? tools.calls ?? 0}）`)
  console.log(`  技能：${skills.total ?? 0} 个目录内 / 加载事件 ${skills.loadEvents ?? 0} 次 / 未用 ${skills.unused ?? 0} / 观察 ${skills.watch ?? 0}`)
  console.log(`  工具：${tools.total ?? 0} 个注册 / 每请求 ${schema.tokensPerRequest ?? 0} tokens（${schema.bytesPerRequest ?? 0} 字节）`)
  console.log(`  体检：${payload.audit?.ok ? 'PASS' : 'FAIL'} — 红项 ${payload.audit?.problems?.length ?? 0} / 黄项 ${payload.audit?.risks?.length ?? 0}`)
  if (!sessions.total) fail('台账里一个会话都没有——历史回填没成功？')
  if (!skills.total) fail('技能目录是空的——skills 服务没取到？')
  if (!tools.total) fail('工具清单是空的——tools 服务没取到？')
  for (const warning of payload.meta?.warnings ?? []) console.log(`  warn ${warning}`)
}

console.log(`plugin:  ${PLUGIN_DIR}`)
console.log(`profile: ${PROFILE_DIR}`)
console.log(`shell:   ${BASE_URL}`)
console.log('')

if (mounted) await probeApi()
else console.log('  --  未挂载：跳过 /api 探测。台账面板不可用，体检走 node scripts\\audit-cli.mjs 与 preflight-restart.mjs。')

if (problems.length > 0) {
  console.log('')
  console.log(`VERIFY: FAIL (${problems.length} problem(s))`)
  process.exit(1)
}
console.log('')
console.log(
  mounted
    ? apiChecked
      ? 'VERIFY: PASS — 面板数据链路是通的'
      : 'VERIFY: PASS（静态部分）— 面板请到界面里点开确认'
    : 'VERIFY: PASS — unmounted 状态的正确形状（无半挂载、无残留）',
)

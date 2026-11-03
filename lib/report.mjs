/**
 * Markdown rendering of one ledger snapshot.
 *
 * The panel is the primary surface; this file exists because a paper trail that can
 * be diffed in git and read without the app running is the whole point of a ledger.
 * It renders only what the snapshot already contains — no service calls.
 */

const MAX_ROWS = 200

function kb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function when(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

function table(headers, rows) {
  const lines = []
  lines.push(`| ${headers.join(' | ')} |`)
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const row of rows.slice(0, MAX_ROWS)) lines.push(`| ${row.join(' | ')} |`)
  if (rows.length > MAX_ROWS) lines.push(`| … ${rows.length - MAX_ROWS} more rows |`)
  return lines
}

/** @param {object} snapshot {generatedAt, profile, ledger, audit, diff} */
export function renderMarkdown(snapshot) {
  const ledger = snapshot?.ledger ?? {}
  const audit = snapshot?.audit ?? {}
  const diff = snapshot?.diff ?? null
  const sessions = ledger.sessions ?? {}
  const skills = ledger.skills ?? {}
  const tools = ledger.tools ?? {}
  const schema = ledger.schema ?? {}
  const lines = []

  lines.push('# DSH 能力台账 + 插件体检')
  lines.push('')
  lines.push(`- 生成时间：${when(snapshot?.generatedAt)}`)
  lines.push(`- profile：\`${snapshot?.profile ?? '?'}\``)
  lines.push(`- 口径：会话日志折叠真实加载/调用；固定 schema 成本取自每条 \`request/header\` 注入的工具 schema 字节数，token 估算按 ${schema.bytesPerToken ?? 3.5} B/token。只读，不改任何配置。`)
  lines.push('')

  lines.push('## 总览')
  lines.push('')
  lines.push(`- 会话 ${sessions.total ?? 0}（其中子代理 ${sessions.subagent ?? 0}）· 轮次 ${sessions.turns ?? 0} · 工具调用 ${tools.calls ?? 0}（失败 ${tools.errors ?? 0}）`)
  lines.push(`- 技能 ${skills.total ?? 0}：零使用 ${skills.unused ?? 0} · 观察（<2 会话）${skills.watch ?? 0} · 保留 ${skills.keep ?? 0} · 索引超 ${500} 字 ${skills.truncatedInIndex ?? 0}`)
  lines.push(`- 工具 ${tools.total ?? 0}：零调用 ${tools.unused ?? 0} · 少量 ${tools.rare ?? 0} · 常用 ${tools.used ?? 0}`)
  lines.push(`- 每请求固定注入 ${kb(schema.bytesPerRequest ?? 0)}（≈${schema.tokensPerRequest ?? 0} token，${schema.toolsPerRequest ?? 0} 个工具，实测 ${schema.requestsMeasured ?? 0} 个会话）`)
  lines.push(`- 体检：红项 ${(audit.problems ?? []).length} · 黄项 ${(audit.risks ?? []).length} · 说明 ${(audit.notes ?? []).length} → ${audit.ok === false ? '**不可重启**' : '可重启'}`)
  lines.push('')

  if (diff !== null && diff !== undefined) {
    lines.push('## 与上次快照对比')
    lines.push('')
    lines.push(`- 距上次：${when(diff.since)} · 会话变化 ${sign(diff.sessionsDelta)} · 每请求字节变化 ${sign(diff.bytesPerRequestDelta)}`)
    if ((diff.newProblems ?? []).length > 0) {
      lines.push('- 新增红项：')
      for (const problem of diff.newProblems) lines.push(`  - ${problem}`)
    }
    if ((diff.fixedProblems ?? []).length > 0) {
      lines.push('- 已消失红项：')
      for (const problem of diff.fixedProblems) lines.push(`  - ${problem}`)
    }
    if ((diff.skillDeltas ?? []).length > 0) {
      lines.push(`- 技能加载变化：${diff.skillDeltas.map((row) => `${row.name} ${row.from}→${row.to}`).join('，')}`)
    }
    lines.push('')
  }

  lines.push('## 技能台账')
  lines.push('')
  const skillRows = (skills.rows ?? []).map((row) => [
    row.name,
    row.loads,
    row.sessions,
    row.attempts,
    row.descriptionChars,
    row.truncatedInIndex ? '是' : '否',
    row.inCatalog ? '在' : '**不在目录**',
    verdictLabel(row.verdict),
    when(row.lastAt),
  ])
  if (skillRows.length === 0) lines.push('_没有技能记录_')
  else lines.push(...table(['技能', '加载', '会话', '尝试', '描述字数', '索引截断', '目录', '判定', '最后加载'], skillRows))
  lines.push('')

  lines.push('## 工具台账（按 schema 字节降序）')
  lines.push('')
  const toolRows = (tools.rows ?? []).map((row) => [
    row.name,
    row.calls,
    row.errors,
    kb(row.schemaBytes),
    row.injected ? '是' : '否',
    row.owner || '未归属',
    verdictLabel(row.verdict),
  ])
  if (toolRows.length === 0) lines.push('_没有工具记录_')
  else lines.push(...table(['工具', '调用', '失败', 'schema', '最近请求注入', '归属 bundle', '判定'], toolRows))
  lines.push('')

  lines.push('## 每请求固定 schema 成本（按 bundle）')
  lines.push('')
  const bundleRows = (schema.byBundle ?? []).map((row) => [row.bundle, kb(row.bytes), row.tools, row.calls])
  if (bundleRows.length === 0) lines.push('_未归属到任何 bundle_')
  else lines.push(...table(['bundle', '字节', '工具数', '调用数'], bundleRows))
  lines.push('')

  lines.push('## 体检')
  lines.push('')
  lines.push(`- profile：\`${audit.profile ?? '?'}\` · bundles ${audit.bundles ?? 0} · deps ${audit.deps ?? 0} · patch ${audit.patch?.lines ?? 0} 行 / ${audit.patch?.entries?.length ?? 0} 条`)
  if ((audit.problems ?? []).length > 0) {
    lines.push('')
    lines.push('**红项（会拦重启）**')
    for (const problem of audit.problems) lines.push(`- ${problem}`)
  } else {
    lines.push('- 红项：无')
  }
  if ((audit.risks ?? []).length > 0) {
    lines.push('')
    lines.push('**黄项（形态风险，当前不失败）**')
    for (const risk of audit.risks) lines.push(`- ${risk}`)
  }
  if ((audit.notes ?? []).length > 0) {
    lines.push('')
    lines.push('**说明**')
    for (const note of audit.notes) lines.push(`- ${note}`)
  }
  if ((audit.rows ?? []).length > 0) {
    lines.push('')
    lines.push(...table(['bundle', '安装', 'client', '字节', '版本'], (audit.rows ?? []).map((row) => [
      row.id,
      row.present ? '是' : '**缺失**',
      row.client ?? 'none',
      row.clientBytes === undefined ? '' : kb(row.clientBytes),
      row.version || '',
    ])))
  }
  lines.push('')

  const warnings = [...(snapshot?.ledger?.scan?.warnings ?? []), ...(snapshot?.meta?.warnings ?? [])]
  if (warnings.length > 0) {
    lines.push('## 本次扫描告警')
    lines.push('')
    for (const warning of [...new Set(warnings)]) lines.push(`- ${warning}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function sign(value) {
  if (!Number.isFinite(value) || value === 0) return '0'
  return value > 0 ? `+${value}` : String(value)
}

function verdictLabel(verdict) {
  if (verdict === 'unused') return '零使用 → 建议删/归档'
  if (verdict === 'watch') return '观察'
  if (verdict === 'rare') return '少量'
  if (verdict === 'keep' || verdict === 'used') return '保留'
  return String(verdict ?? '')
}

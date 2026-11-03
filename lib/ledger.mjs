/**
 * Pure ledger math for dsh-capability-ledger.
 *
 * Everything here is a plain function over data: no filesystem, no host services,
 * no timers. The Host half feeds it session events plus the current skill/tool
 * catalogs; the tests feed it hand-written events.
 *
 * Two things are counted per session, from the durable session log:
 *
 *  - tool usage: every `tool/call`, paired with its `tool/result` by callId, so a
 *    call that never returned is visible as "call without result" instead of a
 *    silent success;
 *  - skill loads: a `skill` tool call whose result came back without `isError` and
 *    without a transport error. The skill name comes from the call's arguments
 *    JSON (`{ "name": "task-intake" }`), NOT from the result text;
 *  - slash loads: a `user/message` event whose `data.source.kind` is
 *    `skill-invocation` (the `/skill` path), which never becomes a `skill` tool call.
 *
 * The skill catalog is taken from the `user/message` events whose
 * `data.source.kind === 'skill-catalog'`: those carry `entries: [{ name, description }]`,
 * i.e. the exact text the model was shown, so truncation is observed instead of guessed.
 *
 * The fixed per-request cost is read from the `request/header` event, which
 * carries the exact tool schemas the host injected for that request. That is the
 * model-facing cost, so it is measured where it is paid instead of guessed from
 * today's registry.
 */

/**
 * Default catalog description cap of the skill index. The profile can raise it
 * (`@deepseek-ai/dsh-tool-skill` reads `catalogDescriptionMaxLength`, this machine pins 900),
 * so this number is only the fallback when no injected catalog was observed.
 */
export const SKILL_DESCRIPTION_CAP = 500

/** Event data.source.kind values this plugin reads. */
const CATALOG_SOURCE = 'skill-catalog'
const SLASH_SOURCE = 'skill-invocation'

/** A skill loaded in this many distinct sessions or more is "keep". */
export const KEEP_MIN_SESSIONS = 2

/** A tool called at least this many times is "used" rather than "rare". */
export const USED_MIN_CALLS = 3

/** Rough bytes-per-token for English JSON; every token estimate is labelled with it. */
export const BYTES_PER_TOKEN = 3.5

const SKILL_TOOL = 'skill'

/** UTF-8 byte length of the model-facing form of one tool schema. */
export function schemaBytes(schema) {
  if (schema === null || typeof schema !== 'object') return 0
  const projection = {
    name: schema.name ?? '',
    description: schema.description ?? '',
    parameters: schema.parameters ?? {},
  }
  return Buffer.byteLength(JSON.stringify(projection), 'utf8')
}

export function bytesToTokens(bytes) {
  return Math.round(bytes / BYTES_PER_TOKEN)
}

/** Parse the `{"name": "..."}` arguments of a `skill` tool call. Never throws. */
export function parseSkillName(rawArguments) {
  if (typeof rawArguments !== 'string') {
    if (rawArguments !== null && typeof rawArguments === 'object') return stringOrNull(rawArguments.name)
    return null
  }
  try {
    const parsed = JSON.parse(rawArguments)
    return stringOrNull(parsed?.name)
  } catch {
    return null
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Fold one session's events into a small summary.
 * `snapshot` is the sessionPersistence snapshot: only header/revision are used.
 */
export function summarizeSession(snapshot, events) {
  const header = snapshot?.header ?? {}
  const summary = {
    id: header.id ?? snapshot?.id ?? '',
    createdAt: header.createdAt ?? 0,
    cwd: header.cwd ?? '',
    origin: header.origin ?? '',
    agentPreset: header.agentPreset ?? '',
    isSubagent: header.origin === 'subagent',
    revision: snapshot?.revision,
    events: Array.isArray(events) ? events.length : 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    assistantMessages: 0,
    userMessages: 0,
    requests: 0,
    /** Last injected tool list of the session: [{ name, bytes }] */
    injectedTools: [],
    injectedBytes: 0,
    /** tool name -> { calls, errors } */
    tools: {},
    /** [{ name, ok, via, time }] — via is 'tool' or 'slash' */
    skillEvents: [],
    /** name -> description as injected into the prompt (the model-facing text) */
    catalog: {},
    catalogEvents: 0,
    /** callId -> { name, args, time } for calls still waiting for a result */
    pendingCalls: [],
  }

  const pending = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'turn/start') {
      summary.turns += 1
    } else if (type === 'step/start') {
      summary.steps += 1
    } else if (type === 'user/message') {
      summary.userMessages += 1
      const source = data?.source
      const kind = typeof source?.kind === 'string' ? source.kind : ''
      if (kind === CATALOG_SOURCE) {
        summary.catalogEvents += 1
        const entries = Array.isArray(source.entries) ? source.entries : []
        for (const entry of entries) {
          if (typeof entry?.name !== 'string' || entry.name.length === 0) continue
          const description = typeof entry.description === 'string' ? entry.description : ''
          // Keep the longest rendering: the same catalog is re-injected per request and a
          // later request can carry the same skill with more (or less) text.
          const known = summary.catalog[entry.name]
          if (known === undefined || description.length > known.length) summary.catalog[entry.name] = description
        }
      } else if (kind === SLASH_SOURCE) {
        const name = stringOrNull(source?.name) ?? stringOrNull(source?.skill)
        if (name !== null) {
          summary.skillEvents.push({ name, ok: true, via: 'slash', time: event.time ?? 0 })
        }
      }
    } else if (type === 'assistant/message') {
      summary.assistantMessages += 1
    } else if (type === 'request/header') {
      summary.requests += 1
      const injected = data?.header?.tools
      if (Array.isArray(injected) && injected.length > 0) {
        const seen = new Set()
        const tools = []
        for (const schema of injected) {
          const name = typeof schema?.name === 'string' ? schema.name : null
          if (name === null || seen.has(name)) continue
          seen.add(name)
          tools.push({ name, bytes: schemaBytes(schema) })
        }
        summary.injectedTools = tools
        summary.injectedBytes = tools.reduce((sum, tool) => sum + tool.bytes, 0)
      }
    } else if (type === 'tool/call') {
      summary.toolCalls += 1
      const name = typeof data.name === 'string' ? data.name : ''
      bump(summary.tools, name, 'calls')
      pending.set(data.callId, { name, args: data.arguments, time: event.time ?? 0 })
    } else if (type === 'tool/result') {
      summary.toolResults += 1
      const message = data.message ?? {}
      const callId = message.toolCallId ?? message.source?.callId
      const failed = data.error !== undefined && data.error !== null ? true : message.isError === true
      const call = callId === undefined ? undefined : pending.get(callId)
      if (callId !== undefined) pending.delete(callId)
      const name = call?.name ?? (typeof message.source?.toolName === 'string' ? message.source.toolName : '')
      if (failed) {
        summary.toolErrors += 1
        if (name) bump(summary.tools, name, 'errors')
      }
      if (name === SKILL_TOOL) {
        summary.skillEvents.push({
          name: parseSkillName(call?.args),
          ok: failed === false,
          via: 'tool',
          time: event.time ?? 0,
        })
      }
    }
  }

  // A call whose result never landed inside this session window is kept visible:
  // sessions can end with the last tool still running.
  for (const [callId, call] of pending) {
    summary.pendingCalls.push({ callId, name: call.name })
  }
  return summary
}

function bump(map, key, field) {
  if (!key) return
  const row = map[key] ?? (map[key] = { calls: 0, errors: 0 })
  row[field] += 1
}

function verdictForSkill(row) {
  if (row.loads === 0) return 'unused'
  if (row.sessions < KEEP_MIN_SESSIONS) return 'watch'
  return 'keep'
}

function verdictForTool(row) {
  if (row.calls === 0) return 'unused'
  if (row.calls < USED_MIN_CALLS) return 'rare'
  return 'used'
}

/**
 * Join per-session summaries with the current catalogs.
 *
 * `skills` is what `ctx.skills.list()` returned (name/description/whenToUse/source),
 * `tools` is what `ctx.tools.schemas()` returned, `toolOwners` maps a tool name to
 * the installed bundle that most likely registers it (heuristic, see owners.mjs).
 */
export function buildLedger({ sessions, skills = [], tools = [], toolOwners = {}, generatedAt = Date.now(), profile = '', window = null }) {
  const skillRows = new Map()
  const toolRows = new Map()
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let assistantMessages = 0
  let requests = 0
  let schemaByteTotal = 0
  let schemaByteSessions = 0
  let injectedToolTotal = 0
  let subagentSessions = 0
  let loadEvents = 0

  for (const session of sessions) {
    if (session.isSubagent) subagentSessions += 1
    else {
      turns += session.turns
      assistantMessages += session.assistantMessages
    }
    steps += session.steps
    toolCalls += session.toolCalls
    toolErrors += session.toolErrors
    requests += session.requests
    if (session.injectedBytes > 0) {
      schemaByteTotal += session.injectedBytes
      schemaByteSessions += 1
      injectedToolTotal += (session.injectedTools ?? []).length
    }
    for (const [name, stats] of Object.entries(session.tools ?? {})) {
      const row = toolRows.get(name) ?? toolRows.set(name, { name, calls: 0, errors: 0, sessions: new Set() }).get(name)
      row.calls += stats.calls
      row.errors += stats.errors
      row.sessions.add(session.id)
    }
    for (const event of session.skillEvents ?? []) {
      if (!event.name) continue
      const row = skillRows.get(event.name) ?? skillRows.set(event.name, { name: event.name, attempts: 0, loads: 0, slash: 0, failures: 0, sessions: new Set(), lastAt: 0, firstAt: 0 }).get(event.name)
      row.attempts += 1
      if (event.ok) {
        row.loads += 1
        loadEvents += 1
        if (event.via === 'slash') row.slash += 1
        row.sessions.add(session.id)
        if (event.time > row.lastAt) row.lastAt = event.time
        if (row.firstAt === 0 || event.time < row.firstAt) row.firstAt = event.time
      } else {
        row.failures += 1
      }
    }
  }

  // The catalog as the model actually saw it: merged across sessions, longest text wins.
  const observedCatalog = new Map()
  for (const session of sessions) {
    for (const [name, description] of Object.entries(session.catalog ?? {})) {
      const known = observedCatalog.get(name)
      if (known === undefined) observedCatalog.set(name, { description, sessions: 1 })
      else {
        known.sessions += 1
        if (description.length > known.description.length) known.description = description
      }
    }
  }

  const catalogSkills = new Map()
  for (const skill of skills) {
    if (skill && typeof skill.name === 'string') catalogSkills.set(skill.name, skill)
  }

  const skillTable = []
  for (const name of new Set([...catalogSkills.keys(), ...skillRows.keys(), ...observedCatalog.keys()])) {
    const catalog = catalogSkills.get(name)
    const observed = observedCatalog.get(name)
    const stats = skillRows.get(name)
    const description = typeof catalog?.description === 'string' ? catalog.description : ''
    const whenToUse = typeof catalog?.whenToUse === 'string' ? catalog.whenToUse : ''
    const indexChars = description.length + (whenToUse.length > 0 ? whenToUse.length + 1 : 0)
    // What the model was really shown beats both the registry text and the cap guess.
    const catalogChars = observed === undefined ? 0 : observed.description.length
    // Three grades of evidence, because the host registry only carries the skills its own
    // layer can see: bundled skills register in the agent-preset layer, so our full text may
    // be unavailable even though the model-facing catalog clearly was cut.
    let truncationEvidence = 'none'
    let truncatedInIndex = false
    if (indexChars > 0 && observed !== undefined) {
      if (indexChars > catalogChars) {
        truncationEvidence = 'measured'
        truncatedInIndex = true
      }
    } else if (observed === undefined) {
      if (indexChars > SKILL_DESCRIPTION_CAP) {
        truncationEvidence = 'suspected'
        truncatedInIndex = true
      }
    } else if (catalogChars >= SKILL_DESCRIPTION_CAP) {
      // The model saw exactly the cap and we cannot see the tail: almost certainly cut.
      truncationEvidence = 'suspected'
      truncatedInIndex = true
    }
    const row = {
      name,
      inCatalog: catalog !== undefined || observed !== undefined,
      catalogObserved: observed !== undefined,
      source: catalog?.source ?? '',
      provider: catalog?.provider ?? '',
      description,
      descriptionKnown: indexChars > 0,
      descriptionChars: indexChars,
      catalogChars,
      truncatedInIndex,
      truncationEvidence,
      modelInvocable: catalog?.invocation?.modelInvocable !== false,
      userInvocable: catalog?.invocation?.userInvocable !== false,
      attempts: stats?.attempts ?? 0,
      failures: stats?.failures ?? 0,
      loads: stats?.loads ?? 0,
      slashLoads: stats?.slash ?? 0,
      sessions: stats ? stats.sessions.size : 0,
      lastAt: stats?.lastAt ?? 0,
      firstAt: stats?.firstAt ?? 0,
      verdict: 'unused',
    }
    row.verdict = verdictForSkill(row)
    skillTable.push(row)
  }
  skillTable.sort((a, b) => a.loads - b.loads || a.name.localeCompare(b.name))

  const catalogTools = new Map()
  for (const tool of tools) {
    if (tool && typeof tool.name === 'string') catalogTools.set(tool.name, tool)
  }
  const injectedNames = new Set()
  for (const session of sessions) {
    for (const tool of session.injectedTools ?? []) injectedNames.add(tool.name)
  }

  const toolTable = []
  for (const name of new Set([...catalogTools.keys(), ...toolRows.keys()])) {
    const catalog = catalogTools.get(name)
    const stats = toolRows.get(name)
    const owner = typeof toolOwners[name] === 'string' ? toolOwners[name] : ''
    const mcpMatch = /^mcp__(.+?)__/.exec(name)
    const mcpServer = mcpMatch === null ? '' : mcpMatch[1]
    // Runtime ownership is not exposed, so every row is either bridged MCP, a literal found
    // in an installed bundle, or something the host/preset registered on its own.
    const kind = mcpServer !== '' ? 'mcp' : owner !== '' ? 'plugin' : 'builtin'
    const row = {
      name,
      registered: catalog !== undefined,
      schemaBytes: catalog === undefined ? 0 : schemaBytes(catalog),
      injected: injectedNames.has(name),
      calls: stats?.calls ?? 0,
      errors: stats?.errors ?? 0,
      sessions: stats ? stats.sessions.size : 0,
      owner,
      mcpServer,
      kind,
      verdict: 'unused',
    }
    row.verdict = verdictForTool(row)
    toolTable.push(row)
  }
  toolTable.sort((a, b) => b.schemaBytes - a.schemaBytes || b.calls - a.calls || a.name.localeCompare(b.name))

  const bytesByBundle = new Map()
  for (const tool of toolTable) {
    if (tool.schemaBytes === 0) continue
    const bundle = tool.owner || (tool.kind === 'mcp' ? `MCP: ${tool.mcpServer}` : '(内置/动态)')
    const row = bytesByBundle.get(bundle) ?? bytesByBundle.set(bundle, { bundle, kind: tool.kind, bytes: 0, tools: 0, calls: 0 }).get(bundle)
    row.bytes += tool.schemaBytes
    row.tools += 1
    row.calls += tool.calls
  }
  const bundleTable = [...bytesByBundle.values()].sort((a, b) => b.bytes - a.bytes)

  // The tier view answers the only question that can change a decision: how much of the
  // fixed schema cost sits behind a server or bundle the user can actually remove.
  const tierLabels = { plugin: '第三方插件', mcp: 'MCP 服务', builtin: '内置/动态' }
  const byTier = []
  for (const kind of ['plugin', 'mcp', 'builtin']) {
    const rows = toolTable.filter((row) => row.kind === kind)
    const bytes = rows.reduce((sum, row) => sum + row.schemaBytes, 0)
    byTier.push({
      kind,
      label: tierLabels[kind],
      bytes,
      tools: rows.length,
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      removable: kind !== 'builtin',
    })
  }
  byTier.sort((a, b) => b.bytes - a.bytes)

  const meanBytes = schemaByteSessions === 0 ? 0 : Math.round(schemaByteTotal / schemaByteSessions)

  return {
    generatedAt,
    profile,
    // Which slice of history these numbers cover. `null` means every session on disk, which
    // is the only baseline comparable across runs; a bounded window says so explicitly.
    window,
    sessions: {
      total: sessions.length,
      subagent: subagentSessions,
      interactive: sessions.length - subagentSessions,
      turns,
      steps,
      assistantMessages,
      requests,
    },
    skills: {
      total: skillTable.length,
      unused: skillTable.filter((row) => row.verdict === 'unused').length,
      watch: skillTable.filter((row) => row.verdict === 'watch').length,
      keep: skillTable.filter((row) => row.verdict === 'keep').length,
      notInCatalog: skillTable.filter((row) => !row.inCatalog).length,
      truncatedInIndex: skillTable.filter((row) => row.truncatedInIndex).length,
      truncatedMeasured: skillTable.filter((row) => row.truncationEvidence === 'measured').length,
      truncatedSuspected: skillTable.filter((row) => row.truncationEvidence === 'suspected').length,
      descriptionKnown: skillTable.filter((row) => row.descriptionKnown).length,
      catalogObserved: observedCatalog.size,
      slashLoads: skillTable.reduce((sum, row) => sum + row.slashLoads, 0),
      loadEvents,
      rows: skillTable,
    },
    tools: {
      total: toolTable.length,
      registered: toolTable.filter((row) => row.registered).length,
      unused: toolTable.filter((row) => row.verdict === 'unused').length,
      rare: toolTable.filter((row) => row.verdict === 'rare').length,
      used: toolTable.filter((row) => row.verdict === 'used').length,
      calls: toolCalls,
      errors: toolErrors,
      schemaBytes: toolTable.reduce((sum, row) => sum + row.schemaBytes, 0),
      rows: toolTable,
    },
    schema: {
      // Historical measurement: what was really injected into each request's header.
      bytesPerRequest: meanBytes,
      tokensPerRequest: bytesToTokens(meanBytes),
      requestsMeasured: schemaByteSessions,
      toolsPerRequest: schemaByteSessions === 0 ? 0 : Math.round(injectedToolTotal / schemaByteSessions),
      // Current registry: what the next request will carry, which is the only number a
      // removal decision can change. Keeping it separate stops the two from being read as one.
      registryBytes: toolTable.reduce((sum, row) => sum + row.schemaBytes, 0),
      registryTokens: bytesToTokens(toolTable.reduce((sum, row) => sum + row.schemaBytes, 0)),
      registryTools: toolTable.filter((row) => row.registered).length,
      byBundle: bundleTable,
      byTier,
      bytesPerToken: BYTES_PER_TOKEN,
    },
  }
}

/** What changed since the previous snapshot: new/fixed problems, skill deltas, cost drift. */
export function diffLedgers(previous, next) {
  if (!previous) return null
  const previousProblems = new Set(previous?.audit?.problems ?? [])
  const nextProblems = new Set(next?.audit?.problems ?? [])
  const previousLoads = new Map((previous?.ledger?.skills?.rows ?? []).map((row) => [row.name, row.loads]))
  const skillDeltas = []
  for (const row of next?.ledger?.skills?.rows ?? []) {
    const before = previousLoads.get(row.name) ?? 0
    if (row.loads !== before) skillDeltas.push({ name: row.name, from: before, to: row.loads })
  }
  return {
    since: previous?.generatedAt ?? 0,
    newProblems: [...nextProblems].filter((problem) => !previousProblems.has(problem)),
    fixedProblems: [...previousProblems].filter((problem) => !nextProblems.has(problem)),
    skillDeltas,
    sessionsDelta: (next?.ledger?.sessions?.total ?? 0) - (previous?.ledger?.sessions?.total ?? 0),
    bytesPerRequestDelta: (next?.ledger?.schema?.bytesPerRequest ?? 0) - (previous?.ledger?.schema?.bytesPerRequest ?? 0),
  }
}

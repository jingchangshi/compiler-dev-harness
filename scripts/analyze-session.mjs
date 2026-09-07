/**
 * Offline analyzer for exported DeepSeek Harness `session.jsonl` logs.
 *
 * Non-model-facing tooling for the compiler-dev preset: it is never loaded
 * into a prompt and adds no runtime overhead. It reports objective session
 * metrics — model steps, tool-call mix, `compiler_inspect` adoption, token
 * accounting, tool-result sizes, and compaction activity — so preset changes
 * can be judged against real production sessions.
 *
 * Usage:
 *   node scripts/analyze-session.mjs <session.jsonl>
 *   node scripts/analyze-session.mjs <session.jsonl.zstd>
 *
 * Without an argument it falls back to this session's own log when the
 * `DSH_SESSION_JSONL` environment variable is set. Zstandard artifacts decode
 * through `node:zlib` (Node 22.15+). The parser tolerates malformed lines,
 * packed chunk rows, and events with missing fields; unknown event types and
 * future envelope variants are ignored rather than fatal.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { constants, zstdDecompressSync } from 'node:zlib'

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'str_replace_editor'])
const COMPACT_INSPECT_TOOL = 'compiler_inspect'
const COMPACT_KNOWLEDGE_TOOL = 'compiler_knowledge'
const COMPACT_ROUTE_TOOL = 'compiler_route'
/** Heuristic for "manual source search" bash calls: grep/rg/awk/find verbs. */
const BASH_SEARCH_VERBS = /(^|[\s;&|(])\b(grep|rg|awk|find)\b/
/** Bounded file reads (sed ranges, head/tail slices) — verification reads when pointed. */
const BASH_READ_VERBS = /(^|[\s;&|(])\b(sed|head|tail|cat|nl|less)\b/
/** Generated / artifact-ish path fragments: searches there are operational, not source discovery. */
const ARTIFACT_PATH = /(^|[\s"'=(])(\/tmp\/|~\/|\.{0,1}\/?(build|out|dist|\.cache|3rdparty|node_modules|\.git)\b|[\w./-]+\.(log|txt|out|json|ninja|bcmlir|mlir))/
/** file:line pointers from knowledge/inspect results (bounded per result). */
const POINTER_RE = /([A-Za-z0-9_.\-/]+\.(?:cpp|cc|cxx|c|h|hpp|hh|py|td|mlir|inc))[:.](\d{1,6})\b/g
const POINTER_FILE_KEY_RE = /"file":\s*"([^"]+\.(?:cpp|cc|cxx|c|h|hpp|hh|py|td|mlir|inc))"/g
const CORRELATION_RE = /"correlation_id":\s*"([^"]+)"/
/** The compiler_inspect backend line the v1.3 bundle renders (Phase R1). */
const CONTEXT_BACKEND_RE = /^Context backend: (\S+) \(fallback: ([^)]+)\)(.*)$/m
const MAX_POINTERS_PER_RESULT = 400
const MAX_ROUTE_GROUPS = 60
const LARGE_RESULT_BYTES = 8192
const LARGEST_LISTED = 5
const ZSTD_MAGIC = 0xFD2FB528

/**
 * Decode one supported session artifact into its newline-delimited records.
 * A `.zstd` session artifact is a CONCATENATION of independently decodable
 * zstd frames (header frame + one frame per durable batch), so every frame is
 * scanned and decoded; a one-shot decompress would yield only the header.
 */
export function loadRecords(path) {
  if (path.endsWith('.zstd')) {
    // Zstandard decoding needs Node 22.15+; without it, ask for a plain log.
    if (typeof zstdDecompressSync !== 'function') {
      throw new Error('this Node runtime cannot decode .zstd logs; decompress the file first')
    }
    const buffer = readFileSync(path)
    const text = scanZstdFrames(buffer).map(range => zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8')).join('')
    return text.split('\n')
  }
  return readFileSync(path, 'utf8').split('\n')
}

/**
 * Locate structurally complete zstd frames in a concatenated stream (byte
 * ranges only — mirrors the harness persistence framing scan).
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Parse log lines into records; malformed lines and packed chunk rows are skipped. */
export function parseRecords(lines) {
  const records = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.type !== 'string') continue
    records.push(value)
  }
  return records
}

function textOfToolResult(event) {
  const blocks = event?.data?.message?.content?.[0]?.content
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Parse a tool call's `arguments` JSON string; malformed input yields undefined. */
function parseArguments(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract bounded `file:line` pointers from one knowledge/inspect result text.
 * Only the file paths are kept (plus basenames for operand matching) — never
 * result content. Both `path:line` occurrences and JSON `"file": "…"` keys count.
 */
export function extractPointers(text, into = new Set()) {
  if (typeof text !== 'string' || text === '') return into
  let matches = 0
  for (const match of text.matchAll(POINTER_RE)) {
    into.add(match[1]); into.add(basenameOf(match[1]))
    if (++matches >= MAX_POINTERS_PER_RESULT) return into
  }
  for (const match of text.matchAll(POINTER_FILE_KEY_RE)) {
    into.add(match[1]); into.add(basenameOf(match[1]))
    if (++matches >= MAX_POINTERS_PER_RESULT) return into
  }
  return into
}

function basenameOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * Classify one bash search/read call (§8 precision-first):
 * - `verification-read`: every referenced file is a pointer a knowledge/inspect
 *   result already returned — the pointed verification the contract allows;
 * - `discovery-search`: an unscoped grep/rg/awk/find over non-pointed sources —
 *   the potential coverage-gap signal;
 * - `uncertain`: anything not decidable (artifact/log paths, generated dirs,
 *   mixed commands) — reported, never judged a gap.
 */
export function classifySearchCommand(command, pointedFiles) {
  if (typeof command !== 'string' || command === '') return { category: 'uncertain', pointed: false }
  const pointed = pointedFiles instanceof Set
    ? [...pointedFiles].some(path => path.length > 2 && command.includes(path))
    : false
  const isSearch = BASH_SEARCH_VERBS.test(command)
  const isRead = BASH_READ_VERBS.test(command)
  if (!isSearch && !isRead) return { category: 'uncertain', pointed }
  if (pointed) return { category: 'verification-read', pointed }
  if (!isSearch) return { category: 'uncertain', pointed }
  // Search verb without any pointed file. Reads of logs/artifacts and finds in
  // generated trees are operational, not source discovery — keep them out of
  // the gap signal (precision over recall).
  if (ARTIFACT_PATH.test(command)) return { category: 'uncertain', pointed }
  return { category: 'discovery-search', pointed }
}

/** Summarize one parsed record stream into the objective metrics object. */
export function analyzeRecords(records) {
  const result = {
    session: { id: undefined, agentPreset: undefined, cwd: undefined, version: undefined },
    routes: [],
    provider: undefined,
    model: undefined,
    contextWindow: undefined,
    humanTurns: 0,
    goalContinuations: 0,
    modelSteps: 0,
    toolCalls: 0,
    toolCallsByName: {},
    compilerInspectCalls: 0,
    firstCompilerInspectStep: undefined,
    inspectBackends: {},
    inspectFallbacks: {},
    inspectWeakResults: 0,
    inspectTruncatedResults: 0,
    inspectDegradedResults: 0,
    compilerKnowledgeCalls: 0,
    firstCompilerKnowledgeStep: undefined,
    knowledgeByCommand: {},
    bashGrepLikeCalls: 0,
    skillLoadFailures: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    peakRequestTokens: 0,
    peakRequestStep: undefined,
    firstEditWriteStep: undefined,
    toolResultBytes: 0,
    toolResultChars: 0,
    toolResultsOverLargeBytes: 0,
    largestToolResults: [],
    compactionStarts: 0,
    compactionEnds: 0,
    compactionErrors: 0,
    turns: {},
    routeDeclarations: [],
    routeMetrics: { tasksRouted: 0, knowledgeExpected: 0, knowledgeSkipped: 0, confidence: { low: 0, medium: 0, high: 0 }, byKind: {} },
    routeGroups: [],
    adoption: { eligibleTasks: 0, adoptedTasks: 0, missedTasks: 0 },
    temporal: { firstKnowledgeStep: undefined, firstInspectStep: undefined, firstDiscoverySearchStep: undefined, firstEditStep: undefined, knowledgeBeforeSearch: undefined, inspectBeforeSearch: undefined },
    searchClassification: { searchCalls: 0, discoverySearches: 0, verificationReads: 0, uncertain: 0, discoveryAfterKnowledge: 0, discoveryAfterInspect: 0, verificationAfterInspect: 0 },
    /** Per-backend attribution of searches that FOLLOW an inspect result
     *  (ordering only — never causality). Backend is the one that served the
     *  most recent inspect result before the search; `unknown` means the
     *  result predates the v1.3 backend line. */
    searchAfterInspectByBackend: {},
  }

  const callNames = new Map()
  // `user/message` payloads carry no turn; attribute them to the open turn.
  let currentTurn
  // Observation-plane collection: bounded call/result views processed after the
  // scan (pointers, correlation groups, search classification).
  const callViews = []
  const resultViews = new Map()

  const turnEntry = (turn) => {
    if (!Number.isInteger(turn)) return undefined
    const key = String(turn)
    if (result.turns[key] === undefined) {
      result.turns[key] = { humanMessages: 0, modelSteps: 0, toolCalls: 0, toolResultBytes: 0, tokens: 0 }
    }
    return result.turns[key]
  }

  for (const record of records) {
    const { type, data, seq } = record

    if (type === 'session') {
      // The artifact header line keeps its fields at the top level.
      result.session.id = data?.id ?? record.id
      result.session.agentPreset = data?.agentPreset ?? record.agentPreset
      result.session.cwd = data?.cwd ?? record.cwd
      result.session.version = data?.version ?? record.version
      continue
    }
    if (typeof type !== 'string') continue

    switch (type) {
      case 'request/context': {
        if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
          result.routes.push({ provider: data.provider, model: data.model, contextWindow: data?.contextWindow, seq })
          result.provider = data.provider
          result.model = data.model
          if (typeof data?.contextWindow === 'number') result.contextWindow = data.contextWindow
        }
        break
      }
      case 'request/header': {
        const config = data?.header?.config
        if (typeof config?.provider === 'string' && config.provider !== ''
          && typeof config?.model === 'string' && config.model !== ''
          && result.provider === undefined) {
          result.provider = config.provider
          result.model = config.model
        }
        break
      }
      case 'turn/start': {
        currentTurn = data?.turn
        break
      }
      case 'turn/end': {
        currentTurn = undefined
        break
      }
      case 'user/message': {
        // A direct human prompt is `kind: 'user'`; goal continuation rounds
        // enter as `kind: 'goal'` and are counted separately.
        if (data?.source?.kind === 'goal') result.goalContinuations += 1
        if (data?.source?.kind === 'user') {
          result.humanTurns += 1
          const entry = turnEntry(data?.turn ?? currentTurn)
          if (entry) entry.humanMessages += 1
        }
        break
      }
      case 'assistant/message': {
        result.modelSteps += 1
        const turn = turnEntry(data?.turn)
        if (turn) turn.modelSteps += 1
        const usage = data?.usage
        if (usage && typeof usage === 'object') {
          const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
          const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
          const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
          const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
          result.inputTokens += input
          result.outputTokens += output
          result.cacheReadTokens += read
          if (turn) turn.tokens += input + output + read + write
          const requestTokens = input + read + write
          if (requestTokens > result.peakRequestTokens) {
            result.peakRequestTokens = requestTokens
            result.peakRequestStep = data?.step
          }
        }
        break
      }
      case 'tool/call': {
        if (typeof data?.name !== 'string') break
        result.toolCalls += 1
        result.toolCallsByName[data.name] = (result.toolCallsByName[data.name] ?? 0) + 1
        if (typeof data?.callId === 'string') callNames.set(data.callId, data.name)
        const turn = turnEntry(data?.turn)
        if (turn) turn.toolCalls += 1
        if (data.name === COMPACT_INSPECT_TOOL) {
          result.compilerInspectCalls += 1
          if (result.firstCompilerInspectStep === undefined) result.firstCompilerInspectStep = data?.step
        }
        if (data.name === COMPACT_KNOWLEDGE_TOOL) {
          result.compilerKnowledgeCalls += 1
          if (result.firstCompilerKnowledgeStep === undefined) result.firstCompilerKnowledgeStep = data?.step
          const args = parseArguments(data?.arguments)
          if (typeof args?.command === 'string') {
            result.knowledgeByCommand[args.command] = (result.knowledgeByCommand[args.command] ?? 0) + 1
          }
        }
        if (data.name === 'bash') {
          const args = parseArguments(data?.arguments)
          if (typeof args?.command === 'string' && BASH_SEARCH_VERBS.test(args.command)) {
            result.bashGrepLikeCalls += 1
          }
        }
        if (EDIT_TOOL_NAMES.has(data.name) && result.firstEditWriteStep === undefined) {
          result.firstEditWriteStep = data?.step
        }
        // Bounded view for the observation-plane analysis (no result content).
        if (data.name === 'bash' || data.name === COMPACT_INSPECT_TOOL
          || data.name === COMPACT_KNOWLEDGE_TOOL || data.name === COMPACT_ROUTE_TOOL
          || EDIT_TOOL_NAMES.has(data.name)) {
          callViews.push({
            seq: seq ?? 0, turn: data?.turn, step: data?.step, name: data.name,
            callId: data?.callId, args: parseArguments(data?.arguments),
          })
        }
        break
      }
      case 'tool/result': {
        const text = textOfToolResult(record)
        const bytes = Buffer.byteLength(text, 'utf8')
        result.toolResultBytes += bytes
        result.toolResultChars += text.length
        const turn = turnEntry(data?.turn)
        if (turn) turn.toolResultBytes += bytes
        if (bytes > LARGE_RESULT_BYTES) result.toolResultsOverLargeBytes += 1
        const callId = data?.message?.content?.[0]?.toolCallId
        const name = typeof callId === 'string' ? callNames.get(callId) : undefined
        result.largestToolResults.push({ step: data?.step, tool: name ?? 'unknown', bytes })
        // Observation-plane result view: correlation ids and file pointers only.
        if (name === COMPACT_KNOWLEDGE_TOOL || name === COMPACT_INSPECT_TOOL || name === COMPACT_ROUTE_TOOL) {
          const view = { seq: seq ?? 0, callId, correlationId: undefined, operational: undefined, pointers: undefined, inspect: undefined }
          const correlation = CORRELATION_RE.exec(text)
          if (correlation !== null) view.correlationId = correlation[1]
          if (name === COMPACT_KNOWLEDGE_TOOL) {
            view.operational = {
              staleIndex: /"stale":\s*true/.test(text),
              refreshPerformed: /index was stale|index --full/.test(text),
              notFound: /"error":\s*"not found"/.test(text),
              truncated: /"truncated":\s*true/.test(text),
              errorKinds: [...text.matchAll(/"error":\s*"([^"]{1,60})"/g)].map(m => m[1]).slice(0, 3),
            }
          }
          if (name === COMPACT_KNOWLEDGE_TOOL || name === COMPACT_INSPECT_TOOL) {
            view.pointers = [...extractPointers(text, new Set())].slice(0, MAX_POINTERS_PER_RESULT * 2)
          }
          if (name === COMPACT_INSPECT_TOOL) {
            // Backend breakdown (Phase R1; R1.6 adds degraded awareness): the
            // bundle's Context backend line names the provider that actually
            // SERVED and its delivery state. `delivery=degraded: <reason>`
            // means the explicit-Ripwire request failed and NOTHING served —
            // counted as degraded, never as a provider delivery, and never
            // attributed post-delivery behavior. Old sessions render no such
            // line — zero counts are the honest pre-integration baseline.
            const backendLine = CONTEXT_BACKEND_RE.exec(text)
            if (backendLine !== null) {
              const degraded = /delivery=degraded/.test(backendLine[0])
              const weak = /weak=true/.test(backendLine[0])
              const truncated = /TRUNCATED/.test(text)
              if (truncated) result.inspectTruncatedResults += 1
              if (degraded) {
                result.inspectDegradedResults += 1
                view.inspect = { backend: 'none', degraded: true, weak, truncated }
              } else {
                result.inspectBackends[backendLine[1]] = (result.inspectBackends[backendLine[1]] ?? 0) + 1
                if (backendLine[2] !== 'none') {
                  result.inspectFallbacks[backendLine[2]] = (result.inspectFallbacks[backendLine[2]] ?? 0) + 1
                }
                if (weak) result.inspectWeakResults += 1
                // R1.5: keep the backend facts on the view so the ordered walk
                // can attribute searches that FOLLOW this result.
                view.inspect = { backend: backendLine[1], fallbackReason: backendLine[2] !== 'none' ? backendLine[2] : undefined, weak, truncated }
              }
            }
          }
          resultViews.set(callId, view)
        }
        if (name === 'skill') {
          const errorText = `${record?.error ? `${record.error.name}: ${record.error.code}` : ''} ${text}`
          if (record?.error !== undefined || /unknown or no longer available|no skill named|unknown skill|is not available/i.test(errorText)) {
            result.skillLoadFailures += 1
          }
        }
        break
      }
      case 'compaction/start': {
        result.compactionStarts += 1
        break
      }
      case 'compaction/end': {
        result.compactionEnds += 1
        if (data?.error) result.compactionErrors += 1
        break
      }
      default:
        break
    }
  }

  // ── observation-plane analysis (offline, after the raw scan) ────────────
  // One ordered walk over calls and results: pointers accumulate in seq order
  // so a search is classified only against pointers returned BEFORE it.
  const timeline = []
  for (const call of callViews) timeline.push({ kind: 'call', seq: call.seq, call })
  for (const view of resultViews.values()) timeline.push({ kind: 'result', seq: view.seq, view })
  timeline.sort((a, b) => a.seq - b.seq)
  const cumulativePointers = new Set()
  // R1.5: inspect results in seq order (backend from the v1.3 Context backend
  // line; absent for pre-R1.3 sessions). Ordering evidence only.
  const inspectResults = []
  for (const item of timeline) {
    if (item.kind === 'result') {
      for (const pointer of item.view.pointers ?? []) cumulativePointers.add(pointer)
      if (item.view?.inspect !== undefined) {
        // R1.6: a degraded result delivered NO context, so nothing that follows
        // it can be attributed to a delivered provider.
        if (item.view.inspect.degraded !== true) {
          inspectResults.push({ seq: item.seq, callId: item.view.callId, backend: item.view.inspect.backend })
        }
      }
      continue
    }
    const call = item.call
    if (call.name !== 'bash') continue
    const command = typeof call.args?.command === 'string' ? call.args.command : ''
    if (command === '' || !(BASH_SEARCH_VERBS.test(command) || BASH_READ_VERBS.test(command))) continue
    result.searchClassification.searchCalls += 1
    call.search = classifySearchCommand(command, cumulativePointers)
    result.searchClassification[call.search.category === 'discovery-search' ? 'discoverySearches'
      : call.search.category === 'verification-read' ? 'verificationReads' : 'uncertain'] += 1
  }

  // Route declarations (one per real task) and their correlation groups.
  const declarations = callViews
    .filter(call => call.name === COMPACT_ROUTE_TOOL)
    .slice(0, 200)
    .map(call => ({
      seq: call.seq, turn: call.turn, step: call.step,
      route: typeof call.args?.route === 'string' ? call.args.route : 'other',
      knowledgeExpected: call.args?.knowledge_expected === true,
      confidence: typeof call.args?.confidence === 'string' ? call.args.confidence : undefined,
      reason: typeof call.args?.reason === 'string' ? call.args.reason : undefined,
      target: typeof call.args?.target === 'string' ? call.args.target : undefined,
      correlationId: resultViews.get(call.callId)?.correlationId,
    }))
  result.routeDeclarations = declarations
  for (const declaration of declarations) {
    result.routeMetrics.tasksRouted += 1
    if (declaration.knowledgeExpected) result.routeMetrics.knowledgeExpected += 1
    else result.routeMetrics.knowledgeSkipped += 1
    if (declaration.confidence !== undefined) result.routeMetrics.confidence[declaration.confidence] += 1
    result.routeMetrics.byKind[declaration.route] = (result.routeMetrics.byKind[declaration.route] ?? 0) + 1
  }

  const groups = declarations.map(declaration => ({
    route: declaration.route,
    knowledgeExpected: declaration.knowledgeExpected,
    confidence: declaration.confidence,
    reason: declaration.reason,
    target: declaration.target,
    correlationId: declaration.correlationId,
    startSeq: declaration.seq,
    turn: declaration.turn,
    firstRouteStep: declaration.step,
    knowledgeCalls: 0,
    knowledgeCommands: {},
    knowledgeSeqs: [],
    firstKnowledgeStep: undefined,
    firstDiscoveryStep: undefined,
    discoverySearches: 0,
    searchAfterQuery: 0,
    verificationReads: 0,
    uncertainSearches: 0,
    // R1.5 context-plane fields: inspect calls/results inside the route window.
    inspectCalls: 0,
    inspectBackends: {},
    inspectFallbacks: {},
    inspectWeakResults: 0,
    firstInspectStep: undefined,
    discoveryAfterInspect: 0,
    verificationAfterInspect: 0,
    inspectResultSeqs: [],
    editStep: undefined,
    operational: { staleIndex: false, refreshPerformed: false, notFound: false, truncated: false, errorKinds: [] },
  }))
  const byCorrelation = new Map(groups.map(group => [group.correlationId, group]))
  const groupFor = (seqValue, correlationId) => {
    if (correlationId !== undefined && byCorrelation.has(correlationId)) return byCorrelation.get(correlationId)
    let selected
    for (const group of groups) {
      if (group.startSeq < seqValue) selected = group
      else break
    }
    return selected
  }
  let ungroupedKnowledgeCalls = 0
  let firstKnowledgeSeq
  let firstDiscoverySeq
  let firstInspectSeq
  const inspectCallById = new Map(callViews.filter(call => call.name === COMPACT_INSPECT_TOOL && typeof call.callId === 'string').map(call => [call.callId, call]))
  // Route each inspect RESULT to its route window (via the call that produced
  // it) BEFORE the chronological walk, so "after inspect" is a pure seq check.
  for (const inspectResult of inspectResults) {
    const call = inspectResult.callId !== undefined ? inspectCallById.get(inspectResult.callId) : undefined
    if (call === undefined) continue
    const group = groupFor(call.seq)
    if (group !== undefined) group.inspectResultSeqs.push({ seq: inspectResult.seq, backend: inspectResult.backend })
  }
  for (const item of timeline) {
    if (item.kind === 'result') continue
    if (item.kind === 'call' && item.call.name === COMPACT_INSPECT_TOOL) {
      if (firstInspectSeq === undefined) firstInspectSeq = item.seq
      const view = resultViews.get(item.call.callId)
      const group = groupFor(item.seq, view?.correlationId)
      if (group === undefined) continue
      group.inspectCalls += 1
      if (group.firstInspectStep === undefined) group.firstInspectStep = item.call.step
      const inspect = view?.inspect
      if (inspect !== undefined) {
        group.inspectBackends[inspect.backend] = (group.inspectBackends[inspect.backend] ?? 0) + 1
        if (inspect.fallbackReason !== undefined) group.inspectFallbacks[inspect.fallbackReason] = (group.inspectFallbacks[inspect.fallbackReason] ?? 0) + 1
        if (inspect.weak === true) group.inspectWeakResults += 1
      }
      continue
    }
    if (item.kind === 'call' && item.call.name === COMPACT_KNOWLEDGE_TOOL) {
      const view = resultViews.get(item.call.callId)
      const group = groupFor(item.seq, view?.correlationId)
      if (group === undefined) { ungroupedKnowledgeCalls += 1; continue }
      group.knowledgeCalls += 1
      group.knowledgeSeqs.push(item.seq)
      if (group.firstKnowledgeStep === undefined) group.firstKnowledgeStep = item.call.step
      const command = typeof item.call.args?.command === 'string' ? item.call.args.command : undefined
      if (command !== undefined) group.knowledgeCommands[command] = (group.knowledgeCommands[command] ?? 0) + 1
      if (view?.correlationId !== undefined && group.correlationId === undefined) group.correlationId = view.correlationId
      const operational = view?.operational
      if (operational !== undefined) {
        group.operational.staleIndex ||= operational.staleIndex
        group.operational.refreshPerformed ||= operational.refreshPerformed
        group.operational.notFound ||= operational.notFound
        group.operational.truncated ||= operational.truncated
        for (const kind of operational.errorKinds ?? []) {
          if (!group.operational.errorKinds.includes(kind)) group.operational.errorKinds.push(kind)
        }
      }
      if (firstKnowledgeSeq === undefined) firstKnowledgeSeq = item.seq
    } else if (item.kind === 'call' && item.call.name === 'bash' && item.call.search !== undefined) {
      const category = item.call.search.category
      if (category === 'discovery-search' && firstDiscoverySeq === undefined) firstDiscoverySeq = item.seq
      const group = groupFor(item.seq)
      if (group === undefined) continue
      if (category === 'discovery-search') {
        group.discoverySearches += 1
        if (group.knowledgeSeqs.some(knowledgeSeq => knowledgeSeq < item.seq)) {
          group.searchAfterQuery += 1
          result.searchClassification.discoveryAfterKnowledge += 1
          if (group.firstDiscoveryStep === undefined) group.firstDiscoveryStep = item.call.step
        }
      } else if (category === 'verification-read') group.verificationReads += 1
      else group.uncertainSearches += 1
      // R1.5: ordering-only attribution of searches that FOLLOW an inspect
      // result inside the same route window. The most recent preceding result
      // lends its backend; a search with no preceding inspect counts nowhere
      // here. Ordering is NOT causality — a discovery search after inspect is
      // a coverage-gap signal, never proof the backend failed.
      const priorInspect = group.inspectResultSeqs.filter(entry => entry.seq < item.seq)
      if (priorInspect.length > 0 && (category === 'discovery-search' || category === 'verification-read')) {
        const isDiscovery = category === 'discovery-search'
        if (isDiscovery) {
          group.discoveryAfterInspect += 1
          result.searchClassification.discoveryAfterInspect += 1
        } else {
          group.verificationAfterInspect += 1
          result.searchClassification.verificationAfterInspect += 1
        }
        const backend = priorInspect[priorInspect.length - 1].backend
        const byBackend = result.searchAfterInspectByBackend[backend]
          ?? (result.searchAfterInspectByBackend[backend] = { discovery: 0, verification: 0 })
        byBackend[isDiscovery ? 'discovery' : 'verification'] += 1
      }
    } else if (item.kind === 'call' && EDIT_TOOL_NAMES.has(item.call.name)) {
      const group = groupFor(item.seq)
      if (group !== undefined && group.editStep === undefined) group.editStep = item.call.step
    }
  }

  result.routeGroups = groups.slice(0, MAX_ROUTE_GROUPS)
  for (const group of result.routeGroups) {
    delete group.knowledgeSeqs
    delete group.inspectResultSeqs
  }
  result.adoption.eligibleTasks = groups.filter(group => group.knowledgeExpected).length
  result.adoption.adoptedTasks = groups.filter(group => group.knowledgeExpected && group.knowledgeCalls > 0).length
  result.adoption.missedTasks = groups.filter(group => group.knowledgeExpected && group.knowledgeCalls === 0).length
  result.adoption.ungroupedKnowledgeCalls = ungroupedKnowledgeCalls
  result.temporal.firstKnowledgeStep = result.firstCompilerKnowledgeStep
  result.temporal.firstInspectStep = result.firstCompilerInspectStep
  result.temporal.firstEditStep = result.firstEditWriteStep
  if (firstDiscoverySeq !== undefined) {
    for (const item of timeline) {
      if (item.kind === 'call' && item.call.name === 'bash' && item.call.search?.category === 'discovery-search') {
        result.temporal.firstDiscoverySearchStep = item.call.step
        break
      }
    }
  }
  if (firstKnowledgeSeq !== undefined && firstDiscoverySeq !== undefined) {
    result.temporal.knowledgeBeforeSearch = firstKnowledgeSeq < firstDiscoverySeq
  }
  if (firstInspectSeq !== undefined && firstDiscoverySeq !== undefined) {
    result.temporal.inspectBeforeSearch = firstInspectSeq < firstDiscoverySeq
  }

  result.largestToolResults.sort((a, b) => b.bytes - a.bytes)
  result.largestToolResults = result.largestToolResults.slice(0, LARGEST_LISTED)
  return result
}

/** Human-readable report; every value renders even when its source was missing. */
export function formatReport(result) {
  const lines = []
  const fmtInt = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? 'n/a'))
  lines.push('=== DSH session analysis ===')
  lines.push(`session: ${result.session.id ?? 'unknown'}${result.session.agentPreset ? ` (preset: ${result.session.agentPreset})` : ''}`)
  if (result.session.cwd) lines.push(`cwd: ${result.session.cwd}`)
  if (result.session.version !== undefined) lines.push(`format version: ${result.session.version}`)
  lines.push(`model: ${result.provider ?? 'unknown'}/${result.model ?? 'unknown'}${result.contextWindow ? ` (contextWindow ${fmtInt(result.contextWindow)})` : ''}`)
  lines.push('')
  lines.push(`human turns: ${fmtInt(result.humanTurns)}${result.goalContinuations > 0 ? ` (+${result.goalContinuations} goal continuation rounds)` : ''}`)
  lines.push(`model steps: ${fmtInt(result.modelSteps)}`)
  lines.push(`tool calls: ${fmtInt(result.toolCalls)}`)
  for (const [name, count] of Object.entries(result.toolCallsByName).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${name}: ${count}`)
  }
  lines.push(`compiler_inspect calls: ${fmtInt(result.compilerInspectCalls)}${result.firstCompilerInspectStep !== undefined ? ` (first at step ${result.firstCompilerInspectStep})` : ''}`)
  const backendBreakdown = Object.entries(result.inspectBackends).map(([backend, count]) => `${backend}: ${count}`).join(', ')
  if (backendBreakdown) lines.push(`  compiler_inspect backends: ${backendBreakdown}`)
  const fallbackBreakdown = Object.entries(result.inspectFallbacks).map(([reason, count]) => `${reason}: ${count}`).join(', ')
  if (fallbackBreakdown || result.inspectWeakResults > 0) {
    lines.push(`  legacy fallbacks: ${fallbackBreakdown || 'none'}; weak results: ${fmtInt(result.inspectWeakResults)}`)
  }
  const knowledgeBreakdown = Object.entries(result.knowledgeByCommand).map(([command, count]) => `${command}: ${count}`).join(', ')
  lines.push(`compiler_knowledge calls: ${fmtInt(result.compilerKnowledgeCalls)}${result.firstCompilerKnowledgeStep !== undefined ? ` (first at step ${result.firstCompilerKnowledgeStep})` : ''}${knowledgeBreakdown ? ` [${knowledgeBreakdown}]` : ''}`)
  lines.push(`bash grep-like search calls (heuristic): ${fmtInt(result.bashGrepLikeCalls)}`)
  lines.push(`skill load failures: ${fmtInt(result.skillLoadFailures)}`)
  lines.push(`first edit/write step: ${result.firstEditWriteStep ?? 'none'}`)
  lines.push('')
  lines.push(`route decisions: ${fmtInt(result.routeMetrics.tasksRouted)} (knowledge_expected: ${fmtInt(result.routeMetrics.knowledgeExpected)}, declared skips: ${fmtInt(result.routeMetrics.knowledgeSkipped)})`)
  const kindBreakdown = Object.entries(result.routeMetrics.byKind).map(([kind, count]) => `${kind}: ${count}`).join(', ')
  if (kindBreakdown) lines.push(`  route kinds: ${kindBreakdown}`)
  lines.push(`adoption: eligible ${fmtInt(result.adoption.eligibleTasks)}, adopted ${fmtInt(result.adoption.adoptedTasks)}, missed ${fmtInt(result.adoption.missedTasks)}`)
  const temporal = result.temporal
  lines.push(`temporal: knowledge@${temporal.firstKnowledgeStep ?? '-'} inspect@${temporal.firstInspectStep ?? '-'} discovery@${temporal.firstDiscoverySearchStep ?? '-'} edit@${temporal.firstEditStep ?? '-'}; knowledge-before-search: ${temporal.knowledgeBeforeSearch === undefined ? 'n/a' : temporal.knowledgeBeforeSearch ? 'yes' : 'no'}`)
  const search = result.searchClassification
  lines.push(`search classification: ${search.searchCalls} bash search/read calls — discovery ${fmtInt(search.discoverySearches)} (after knowledge: ${fmtInt(search.discoveryAfterKnowledge)}, after inspect: ${fmtInt(search.discoveryAfterInspect)}), verification reads ${fmtInt(search.verificationReads)} (after inspect: ${fmtInt(search.verificationAfterInspect)}), uncertain ${fmtInt(search.uncertain)}`)
  const afterInspectByBackend = Object.entries(result.searchAfterInspectByBackend)
    .map(([backend, counts]) => `${backend}: discovery ${counts.discovery}, verification ${counts.verification}`)
    .join('; ')
  if (afterInspectByBackend !== '') lines.push(`  after-inspect by backend (ordering, not causality): ${afterInspectByBackend}`)
  lines.push('')
  lines.push(`tokens: input ${fmtInt(result.inputTokens)}, output ${fmtInt(result.outputTokens)}, cacheRead ${fmtInt(result.cacheReadTokens)}`)
  lines.push(`peak request context: ${fmtInt(result.peakRequestTokens)} tokens${result.peakRequestStep !== undefined ? ` (step ${result.peakRequestStep})` : ''}`)
  lines.push('')
  lines.push(`tool results: ${fmtInt(result.toolResultChars)} chars / ${fmtInt(result.toolResultBytes)} bytes total; ${result.toolResultsOverLargeBytes} above ${LARGE_RESULT_BYTES / 1024}KB`)
  if (result.largestToolResults.length > 0) {
    lines.push('largest tool results:')
    for (const entry of result.largestToolResults) {
      lines.push(`  step ${entry.step ?? '?'} ${entry.tool}: ${fmtInt(entry.bytes)} bytes`)
    }
  }
  lines.push('')
  lines.push(`compaction: ${result.compactionStarts} started, ${result.compactionEnds} ended, ${result.compactionErrors} errored`)
  const turnKeys = Object.keys(result.turns)
  if (turnKeys.length > 1) {
    lines.push('')
    lines.push('per-turn: turn | human | steps | toolCalls | toolResultBytes | tokens')
    for (const key of turnKeys) {
      const turn = result.turns[key]
      lines.push(`  ${key} | ${turn.humanMessages} | ${turn.modelSteps} | ${turn.toolCalls} | ${turn.toolResultBytes} | ${turn.tokens}`)
    }
  }
  return lines.join('\n')
}

function main() {
  const path = process.argv[2] ?? process.env.DSH_SESSION_JSONL
  if (!path) {
    process.stderr.write('usage: node analyze-session.mjs <session.jsonl[.zstd]>\n')
    process.exitCode = 1
    return
  }
  try {
    const records = parseRecords(loadRecords(path))
    process.stdout.write(`${formatReport(analyzeRecords(records))}\n`)
  } catch (error) {
    process.stderr.write(`analyze-session: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

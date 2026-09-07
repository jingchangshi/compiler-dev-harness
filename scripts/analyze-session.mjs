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
/** Heuristic for "manual source search" bash calls: grep/rg/awk/find verbs. */
const BASH_SEARCH_VERBS = /(^|[\s;&|(])\b(grep|rg|awk|find)\b/
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
  }

  const callNames = new Map()
  // `user/message` payloads carry no turn; attribute them to the open turn.
  let currentTurn

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
  const knowledgeBreakdown = Object.entries(result.knowledgeByCommand).map(([command, count]) => `${command}: ${count}`).join(', ')
  lines.push(`compiler_knowledge calls: ${fmtInt(result.compilerKnowledgeCalls)}${result.firstCompilerKnowledgeStep !== undefined ? ` (first at step ${result.firstCompilerKnowledgeStep})` : ''}${knowledgeBreakdown ? ` [${knowledgeBreakdown}]` : ''}`)
  lines.push(`bash grep-like search calls (heuristic): ${fmtInt(result.bashGrepLikeCalls)}`)
  lines.push(`skill load failures: ${fmtInt(result.skillLoadFailures)}`)
  lines.push(`first edit/write step: ${result.firstEditWriteStep ?? 'none'}`)
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

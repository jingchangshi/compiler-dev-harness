/**
 * Offline candidate-feedback generation for the production knowledge
 * observation loop. Correlates exported session logs with the gitignored
 * `compiler_knowledge` query stream and generates Feedback Protocol v2
 * (mlir-compiler-harness ADR-025) CANDIDATE artifacts (`origin: automatic`):
 *
 * - query-sufficient    knowledge_expected + queries used + no discovery search after
 * - query-insufficient  queries used + clear discovery search after (possible_gap only)
 * - adoption-missed     knowledge_expected=true, high confidence, zero knowledge calls
 * - query-operational   refresh failures, not-found, truncation, diagnostics, errors
 *
 * Conservative by design: groups without a declared route, skipped routes
 * (knowledge_expected=false — a correct skip, not a failure), status-only
 * groups, and undecidable search classifications never become candidates.
 * Positive evidence (query-sufficient) is preserved on purpose: it is the
 * signal that a deterministic query already covers a task shape.
 *
 * No prompt, transcript, reasoning, result content, or shell command text is
 * ever copied into a candidate — only counts, step numbers, stable ids, and
 * operational flags. Candidates are reviewed by a human via
 * `scripts/review-feedback.mjs` before they become curated evidence.
 *
 * Usage:
 *   node scripts/collect-feedback.mjs <session.jsonl[.zstd]...> [--queries <dir>] [--out <dir>] [--date YYYY-MM-DD]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'
import { analyzeRecords, loadRecords, parseRecords } from './analyze-session.mjs'
import { QUERY_COMMANDS, validateFeedback } from './feedback-schema.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Feedback tree root; tests redirect it with COMPILER_DEV_FEEDBACK_DIR. */
export function feedbackRoot() {
  return process.env.COMPILER_DEV_FEEDBACK_DIR
    ? resolve(process.env.COMPILER_DEV_FEEDBACK_DIR)
    : join(DEFAULT_ROOT, 'analysis', 'feedback')
}
const MAX_CANDIDATES_PER_SESSION = 20

const TASK_KIND_BY_ROUTE = {
  'pass-review': 'compiler-review',
  'finding-review': 'bug-investigation',
  'pipeline-audit': 'pipeline-audit',
}
const TARGET_PREFIX_BY_COMMAND = {
  review: 'pass',
  'finding-impact': 'finding',
  'pipeline-stages': 'pipeline',
  evidence: 'entity',
}

function parseArgs(argv) {
  const options = { sessions: [], queriesDir: undefined, outDir: undefined, date: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--queries') options.queriesDir = resolve(argv[++index])
    else if (arg === '--out') options.outDir = resolve(argv[++index])
    else if (arg === '--date') options.date = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!arg.startsWith('--')) options.sessions.push(arg)
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Load the non-sensitive query stream, indexed by correlation id. */
export function loadQueryRecords(queriesDir) {
  const byCorrelation = new Map()
  if (queriesDir === undefined || !existsSync(queriesDir)) return byCorrelation
  for (const file of readdirSync(queriesDir).filter(name => name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(queriesDir, file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try { record = JSON.parse(trimmed) } catch { continue }
      if (record === null || typeof record !== 'object' || typeof record.correlation_id !== 'string') continue
      if (!byCorrelation.has(record.correlation_id)) byCorrelation.set(record.correlation_id, [])
      byCorrelation.get(record.correlation_id).push(record)
    }
  }
  return byCorrelation
}

/** Aggregate one correlation group's operational signals from its query records. */
export function operationalFromRecords(records) {
  const operational = {}
  const errorKinds = new Set()
  let diagnostics = 0
  let duration = 0
  for (const record of records) {
    if (record.refreshed === true) { operational.stale_index = true; operational.refresh_performed = true }
    if (record.error === 'refused-stale') { operational.stale_index = true; operational.error = true }
    if (record.error === 'refresh-failed') { operational.stale_index = true; operational.refresh_performed = true; operational.error = true }
    if (record.error === 'not found') operational.not_found = true
    if (record.truncated === true) operational.truncated = true
    if (typeof record.error === 'string' && record.error !== '') {
      operational.error = true
      errorKinds.add(String(record.error).slice(0, 40))
    }
    if (Number.isInteger(record.diagnostics)) diagnostics = Math.min(999, diagnostics + record.diagnostics)
    if (Number.isInteger(record.duration_ms)) duration += record.duration_ms
  }
  if (diagnostics > 0) operational.diagnostic_count = diagnostics
  if (duration > 0) operational.duration_ms = duration
  return { operational, errorKinds: [...errorKinds] }
}

function operationalFromSession(group) {
  const operational = {}
  const flags = group.operational ?? {}
  for (const key of ['stale_index', 'refresh_performed', 'not_found', 'truncated']) {
    if (flags[key] === true) operational[key] = true
  }
  if ((flags.errorKinds ?? []).length > 0) operational.error = true
  return { operational, errorKinds: flags.errorKinds ?? [] }
}

function taskTarget(group, records) {
  if (typeof group.target === 'string' && group.target !== '') return group.target
  const named = records.find(record => typeof record.name === 'string' && record.name !== '')
  if (named !== undefined) return `${TARGET_PREFIX_BY_COMMAND[named.command] ?? 'query'}:${named.name}`
  return `route:${group.route}`
}

function knowledgeCommandsOf(group, records) {
  const commands = {}
  for (const record of records) {
    if (QUERY_COMMANDS.includes(record.command)) commands[record.command] = (commands[record.command] ?? 0) + 1
  }
  if (Object.keys(commands).length === 0) {
    for (const [command, count] of Object.entries(group.knowledgeCommands ?? {})) {
      if (QUERY_COMMANDS.includes(command)) commands[command] = count
    }
  }
  return commands
}

/** Build one v2 candidate document for a correlation group. */
export function buildCandidate(kind, group, records, options = {}) {
  const created = options.date ?? (records.find(record => typeof record.ts === 'string')?.ts.slice(0, 10)) ?? new Date().toISOString().slice(0, 10)
  const commands = knowledgeCommandsOf(group, records)
  const commandList = Object.entries(commands).map(([command, count]) => `${command}×${count}`).join(', ')
  const { operational, errorKinds } = records.length > 0
    ? operationalFromRecords(records)
    : operationalFromSession(group)
  const knowledgeCalls = records.length > 0
    ? records.length
    : group.knowledgeCalls ?? 0
  const route = {
    knowledge_expected: group.knowledgeExpected === true,
    kind: group.route,
    confidence: group.confidence ?? 'low',
  }
  const usage = {
    compiler_knowledge_calls: knowledgeCalls,
    knowledge_commands: commands,
    discovery_search_calls: group.discoverySearches ?? 0,
    search_after_query_calls: group.searchAfterQuery ?? 0,
  }
  if (Number.isInteger(group.firstKnowledgeStep)) usage.first_knowledge_step = group.firstKnowledgeStep
  if (Number.isInteger(group.firstDiscoveryStep)) usage.first_discovery_step = group.firstDiscoveryStep
  if (Number.isInteger(group.editStep)) usage.first_edit_step = group.editStep

  const task = {
    kind: TASK_KIND_BY_ROUTE[group.route] ?? 'other',
    target: taskTarget(group, records),
  }
  if (group.confidence !== undefined) {
    task.classification = { confidence: group.confidence, source: 'heuristic' }
  }

  let query = null
  const firstQuery = records.find(record => QUERY_COMMANDS.includes(record.command))
  if (kind !== 'adoption-missed' && firstQuery !== undefined) {
    query = { command: firstQuery.command, args: { name: firstQuery.name ?? '' } }
  }

  let observation = ''
  let possibleGap = null
  let manualSearch = { performed: false }
  if (kind === 'query-sufficient') {
    observation = `Route ${group.route} was served by ${knowledgeCalls} knowledge query call(s) (${commandList || 'no adapter command'}) with no discovery search after the queries; the deterministic queries covered the task's knowledge needs.`
  } else if (kind === 'query-insufficient') {
    const after = usage.search_after_query_calls
    observation = `Route ${group.route} used ${knowledgeCalls} knowledge query call(s) (${commandList || 'no adapter command'}) but ${after} repo-wide discovery search(es) followed them; the queries may not have covered the locations the task needed.`
    manualSearch = { performed: true, reason: `${after} discovery search(es) classified after the knowledge queries (verification reads excluded); the searched subjects are not recorded.` }
    possibleGap = {
      category: 'query-coverage',
      statement: 'Possible query-coverage gap: discovery searches after served queries suggest a location or relation the adapter queries did not return; needs human review before any query or workflow change.',
    }
  } else if (kind === 'adoption-missed') {
    observation = `Route ${group.route} declared knowledge_expected=true (confidence ${route.confidence}) but the session made no compiler_knowledge call; candidate adoption gap for human review.`
  } else if (kind === 'query-operational') {
    const signals = []
    if (operational.refresh_performed) signals.push('index refreshed before serving')
    if (operational.stale_index && !operational.refresh_performed) signals.push('stale refusal')
    if (operational.not_found) signals.push('not-found negative')
    if (operational.truncated) signals.push('budget truncation')
    if (operational.diagnostic_count) signals.push(`${operational.diagnostic_count} diagnostics`)
    if (errorKinds.length > 0) signals.push(`error kinds: ${errorKinds.join(', ')}`)
    observation = `Route ${group.route} knowledge queries recorded operational signals: ${signals.join('; ') || 'unspecified'}.`
  }

  const document = {
    feedback: {
      schema_version: 2,
      created_at: created,
      origin: 'automatic',
      observation_kind: kind,
      task,
      query,
      route,
      usage,
      observation,
      manual_source_search: manualSearch,
      possible_gap: possibleGap,
      evidence: [],
      sensitivity: { contains_sensitive_content: false },
    },
  }
  if (Object.keys(operational).length > 0) document.feedback.operational = operational
  return document
}

/** Candidates for one correlation group, per the conservative type rules. */
export function candidatesForGroup(group, records, date) {
  if (group.knowledgeExpected !== true) return []
  const queryRecords = records.filter(record => QUERY_COMMANDS.includes(record.command))
  const candidates = []
  if (queryRecords.length > 0) {
    if ((group.searchAfterQuery ?? 0) === 0) candidates.push(buildCandidate('query-sufficient', group, records, date))
    else candidates.push(buildCandidate('query-insufficient', group, records, date))
  }
  if (queryRecords.length === 0 && group.knowledgeCalls === 0 && group.confidence === 'high') {
    candidates.push(buildCandidate('adoption-missed', group, records, date))
  }
  const { operational, errorKinds } = records.length > 0 ? operationalFromRecords(records) : operationalFromSession(group)
  const hasOperational = Object.keys(operational).length > 0 || errorKinds.length > 0
  if (queryRecords.length > 0 && hasOperational) candidates.push(buildCandidate('query-operational', group, records, date))
  return candidates
}

function sessionShort(analysis) {
  const id = analysis?.session?.id
  return typeof id === 'string' && id !== '' ? id.slice(-12) : 'unknown'
}

export function collectFromSession(path, queriesByCorrelation, date) {
  const records = parseRecords(loadRecords(path))
  const analysis = analyzeRecords(records)
  const candidates = []
  for (const group of analysis.routeGroups) {
    const queryRecords = group.correlationId !== undefined ? (queriesByCorrelation.get(group.correlationId) ?? []) : []
    candidates.push(...candidatesForGroup(group, queryRecords, date))
  }
  const trimmed = candidates.slice(0, MAX_CANDIDATES_PER_SESSION)
  return { analysis, candidates: trimmed, skipped: Math.max(0, candidates.length - trimmed.length) }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`collect-feedback: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.help || options.sessions.length === 0) {
    process.stdout.write('usage: node scripts/collect-feedback.mjs <session.jsonl[.zstd]...> [--queries <dir>] [--out <dir>] [--date YYYY-MM-DD]\n')
    process.exitCode = options.help ? 0 : 1
    return
  }
  const queriesDir = options.queriesDir ?? join(feedbackRoot(), 'queries')
  const outDir = options.outDir ?? join(feedbackRoot(), 'candidates')
  const queriesByCorrelation = loadQueryRecords(queriesDir)
  const totals = { 'query-sufficient': 0, 'query-insufficient': 0, 'adoption-missed': 0, 'query-operational': 0 }
  let written = 0
  try {
    mkdirSync(outDir, { recursive: true })
    for (const path of options.sessions) {
      const { analysis, candidates, skipped } = collectFromSession(path, queriesByCorrelation, options.date)
      const short = sessionShort(analysis)
      candidates.forEach((candidate, index) => {
        const kind = candidate.feedback.observation_kind
        const errors = validateFeedback(candidate)
        if (errors.length > 0) throw new Error(`generated invalid ${kind} candidate: ${errors.join('; ')}`)
        const name = `${candidate.feedback.created_at}-${short}-${String(index + 1).padStart(2, '0')}-${kind}.json`
        writeFileSync(join(outDir, name), `${JSON.stringify(candidate, null, 2)}\n`)
        written += 1
        if (kind in totals) totals[kind] += 1
      })
      process.stdout.write(`${basename(path)}: ${candidates.length} candidate(s)${skipped > 0 ? ` (${skipped} over the per-session cap dropped)` : ''}\n`)
    }
    process.stdout.write(`written: ${written} candidate(s) to ${outDir}\n`)
    process.stdout.write(`totals: ${JSON.stringify(totals)}\n`)
  } catch (error) {
    process.stderr.write(`collect-feedback: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

/**
 * Offline batch aggregation over exported sessions, the gitignored
 * query/route/context streams, and generated candidates.
 *
 *   node scripts/summarize-feedback.mjs --sessions <log...> [--candidates <dir>] [--queries <dir>] [--routes <dir>] [--context <dir>] [--since YYYY-MM-DD] [--output <file>]
 *
 * Emits a structured JSON summary (sessions, route/adoption metrics, query
 * sufficiency, operational failures, temporal order, command breakdown, gap
 * categories, and — Phase R1.5 — the generic context-provider telemetry:
 * backend usage, fallbacks, weak/truncated/outside-corpus counts, and the
 * ordering-only discovery/verification-after-inspect metrics). It deliberately
 * stops at counts: architecture decisions stay with the human reviewer — the
 * summary never concludes "implement X" nor "promote the backend".
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve, basename } from 'node:path'
import { analyzeRecords, loadRecords, parseRecords } from './analyze-session.mjs'
import { OBSERVATION_KINDS, GAP_CATEGORIES, validateFeedback } from './feedback-schema.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))

function parseArgs(argv) {
  const options = { sessions: [], candidatesDir: undefined, queriesDir: undefined, routesDir: undefined, contextDir: undefined, since: undefined, output: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--sessions') {
      while (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) options.sessions.push(resolve(argv[++index]))
    } else if (arg === '--candidates') options.candidatesDir = resolve(argv[++index])
    else if (arg === '--queries') options.queriesDir = resolve(argv[++index])
    else if (arg === '--routes') options.routesDir = resolve(argv[++index])
    else if (arg === '--context') options.contextDir = resolve(argv[++index])
    else if (arg === '--since') options.since = argv[++index]
    else if (arg === '--output') options.output = resolve(argv[++index])
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function withinSince(dateStr, since) {
  if (since === undefined) return true
  return typeof dateStr === 'string' && dateStr.slice(0, 10) >= since
}

/** Read every `.jsonl` file in a stream directory, tolerating bad lines and
 *  optionally filtering by `--since` (record.ts prefix compare). Exported for
 *  the offline evaluation tooling (evaluate-context-backend). */
export function jsonlRecords(dir, since) {
  const records = []
  if (dir === undefined || !existsSync(dir)) return records
  for (const file of readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const record = JSON.parse(trimmed)
        if (record !== null && typeof record === 'object' && withinSince(record.ts, since)) records.push(record)
      } catch { /* tolerate bad lines */ }
    }
  }
  return records
}

function loadCandidates(dir, since) {
  const result = []
  if (dir === undefined || !existsSync(dir)) return result
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    try {
      const document = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (!withinSince(document?.feedback?.created_at, since)) continue
      const errors = validateFeedback(document)
      result.push({ name, document, valid: errors.length === 0, errors })
    } catch (error) {
      result.push({ name, document: undefined, valid: false, errors: [String(error.message ?? error)] })
    }
  }
  return result
}

function sessionDate(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const time = records[index]?.time
    if (typeof time === 'number' && Number.isFinite(time)) return new Date(time).toISOString().slice(0, 10)
  }
  return undefined
}

/** Aggregate sessions + streams + candidates into the batch summary object. */
export function aggregate({ sessionPaths = [], candidatesDir, queriesDir, routesDir, contextDir, since } = {}) {
  const summary = {
    generated_at: new Date().toISOString(),
    since: since ?? null,
    sessions: 0,
    tasks: { routed: 0, knowledge_expected: 0, declared_skips: 0 },
    route_kinds: {},
    route_confidence: { low: 0, medium: 0, high: 0 },
    adoption: { eligible: 0, adopted: 0, missed: 0 },
    candidates: { total: 0, invalid: 0 },
    observation_kinds: Object.fromEntries(OBSERVATION_KINDS.map(kind => [kind, 0])),
    gap_categories: Object.fromEntries(GAP_CATEGORIES.map(category => [category, 0])),
    queries: { total: 0, by_command: {}, refreshed: 0, truncated: 0, not_found: 0, errors: 0, diagnostics: 0 },
    routes: { total: 0, knowledge_expected: 0 },
    temporal: { sessions_knowledge_before_search: 0, sessions_with_discovery_after_knowledge: 0, sessions_with_discovery_after_inspect: 0 },
    search: { discovery_after_knowledge: 0, verification_reads: 0, uncertain: 0, discovery_after_inspect: 0, verification_after_inspect: 0 },
    // Phase R1.5: compiler-dev-owned generic context-provider telemetry.
    // Counts only — the provider decision stays with the human reviewer.
    context: {
      total: 0,
      by_provider: {},
      by_policy: {},
      fallbacks: 0,
      fallback_reasons: {},
      weak: 0,
      truncated: 0,
      outside_corpus: 0,
      total_duration_ms: 0,
      total_result_chars: 0,
    },
  }

  for (const path of sessionPaths) {
    const records = parseRecords(loadRecords(path))
    const analysis = analyzeRecords(records)
    if (since !== undefined) {
      const date = sessionDate(records)
      if (date !== undefined && date < since) continue
    }
    summary.sessions += 1
    summary.tasks.routed += analysis.routeMetrics.tasksRouted
    summary.tasks.knowledge_expected += analysis.routeMetrics.knowledgeExpected
    summary.tasks.declared_skips += analysis.routeMetrics.knowledgeSkipped
    for (const [kind, count] of Object.entries(analysis.routeMetrics.byKind)) {
      summary.route_kinds[kind] = (summary.route_kinds[kind] ?? 0) + count
    }
    for (const confidence of ['low', 'medium', 'high']) {
      summary.route_confidence[confidence] += analysis.routeMetrics.confidence[confidence]
    }
    summary.adoption.eligible += analysis.adoption.eligibleTasks
    summary.adoption.adopted += analysis.adoption.adoptedTasks
    summary.adoption.missed += analysis.adoption.missedTasks
    if (analysis.temporal.knowledgeBeforeSearch === true) summary.temporal.sessions_knowledge_before_search += 1
    if (analysis.searchClassification.discoveryAfterKnowledge > 0) summary.temporal.sessions_with_discovery_after_knowledge += 1
    if (analysis.searchClassification.discoveryAfterInspect > 0) summary.temporal.sessions_with_discovery_after_inspect += 1
    summary.search.discovery_after_knowledge += analysis.searchClassification.discoveryAfterKnowledge
    summary.search.verification_reads += analysis.searchClassification.verificationReads
    summary.search.uncertain += analysis.searchClassification.uncertain
    summary.search.discovery_after_inspect += analysis.searchClassification.discoveryAfterInspect
    summary.search.verification_after_inspect += analysis.searchClassification.verificationAfterInspect
  }

  for (const record of jsonlRecords(queriesDir, since)) {
    summary.queries.total += 1
    if (typeof record.command === 'string') {
      summary.queries.by_command[record.command] = (summary.queries.by_command[record.command] ?? 0) + 1
    }
    if (record.refreshed === true) summary.queries.refreshed += 1
    if (record.truncated === true) summary.queries.truncated += 1
    if (record.error !== undefined && record.error !== '') {
      summary.queries.errors += 1
      if (record.error === 'not found') summary.queries.not_found += 1
    }
    if (Number.isInteger(record.diagnostics)) summary.queries.diagnostics += record.diagnostics
  }

  for (const record of jsonlRecords(routesDir, since)) {
    summary.routes.total += 1
    if (record.knowledge_expected === true) summary.routes.knowledge_expected += 1
  }

  // Phase R1.5: the generic context-provider stream (analysis/feedback/
  // context/). Non-sensitive operational counts only, by design of the
  // runtime writer; malformed lines are tolerated and skipped.
  for (const record of jsonlRecords(contextDir, since)) {
    summary.context.total += 1
    if (typeof record.provider === 'string') summary.context.by_provider[record.provider] = (summary.context.by_provider[record.provider] ?? 0) + 1
    if (typeof record.backend_policy === 'string') summary.context.by_policy[record.backend_policy] = (summary.context.by_policy[record.backend_policy] ?? 0) + 1
    if (record.fallback === true) {
      summary.context.fallbacks += 1
      if (typeof record.fallback_reason === 'string') summary.context.fallback_reasons[record.fallback_reason] = (summary.context.fallback_reasons[record.fallback_reason] ?? 0) + 1
    }
    if (record.weak === true) summary.context.weak += 1
    if (record.truncated === true) summary.context.truncated += 1
    if (Number.isInteger(record.outside_corpus)) summary.context.outside_corpus += record.outside_corpus
    if (Number.isInteger(record.duration_ms)) summary.context.total_duration_ms += record.duration_ms
    if (Number.isInteger(record.result_chars)) summary.context.total_result_chars += record.result_chars
  }

  for (const candidate of loadCandidates(candidatesDir, since)) {
    if (!candidate.valid) {
      summary.candidates.invalid += 1
      continue
    }
    summary.candidates.total += 1
    const kind = candidate.document.feedback.observation_kind
    summary.observation_kinds[kind] += 1
    const gap = candidate.document.feedback.possible_gap
    if (gap !== null && gap !== undefined) summary.gap_categories[gap.category] += 1
  }
  return summary
}

function formatText(summary) {
  const lines = []
  lines.push(`feedback summary (generated ${summary.generated_at}${summary.since ? `, since ${summary.since}` : ''})`)
  lines.push(`sessions analyzed: ${summary.sessions}`)
  lines.push(`route decisions: ${summary.tasks.routed} (expected ${summary.tasks.knowledge_expected}, skips ${summary.tasks.declared_skips})`)
  lines.push(`route kinds: ${Object.entries(summary.route_kinds).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`)
  lines.push(`adoption: eligible ${summary.adoption.eligible}, adopted ${summary.adoption.adopted}, missed ${summary.adoption.missed}`)
  lines.push(`candidates: ${summary.candidates.total} valid, ${summary.candidates.invalid} invalid`)
  lines.push(`observation kinds: ${Object.entries(summary.observation_kinds).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`)
  lines.push(`gap categories: ${Object.entries(summary.gap_categories).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`)
  lines.push(`queries: ${summary.queries.total} (refreshed ${summary.queries.refreshed}, truncated ${summary.queries.truncated}, not-found ${summary.queries.not_found}, errors ${summary.queries.errors}, diagnostics ${summary.queries.diagnostics})`)
  lines.push(`query commands: ${Object.entries(summary.queries.by_command).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`)
  lines.push(`temporal: sessions with knowledge-before-search ${summary.temporal.sessions_knowledge_before_search}, with discovery-after-knowledge ${summary.temporal.sessions_with_discovery_after_knowledge}, with discovery-after-inspect ${summary.temporal.sessions_with_discovery_after_inspect}`)
  lines.push(`search: discovery-after-knowledge ${summary.search.discovery_after_knowledge}, verification reads ${summary.search.verification_reads}, uncertain ${summary.search.uncertain}; discovery-after-inspect ${summary.search.discovery_after_inspect}, verification-after-inspect ${summary.search.verification_after_inspect}`)
  const contextProviders = Object.entries(summary.context.by_provider).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'
  lines.push(`context: ${summary.context.total} attempts (${contextProviders}; fallbacks ${summary.context.fallbacks}, weak ${summary.context.weak}, truncated ${summary.context.truncated}, outside-corpus ${summary.context.outside_corpus}, total ${summary.context.total_duration_ms} ms)`)
  lines.push('(counts only — architecture decisions stay with the human reviewer)')
  return lines.join('\n')
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`summarize-feedback: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.help || (options.sessions.length === 0 && options.candidatesDir === undefined && options.queriesDir === undefined && options.contextDir === undefined)) {
    process.stdout.write('usage: node scripts/summarize-feedback.mjs --sessions <log...> [--candidates <dir>] [--queries <dir>] [--routes <dir>] [--context <dir>] [--since YYYY-MM-DD] [--output <file>]\n')
    process.exitCode = options.help ? 0 : 1
    return
  }
  try {
    const summary = aggregate({
      sessionPaths: options.sessions,
      candidatesDir: options.candidatesDir,
      queriesDir: options.queriesDir,
      routesDir: options.routesDir,
      contextDir: options.contextDir,
      since: options.since,
    })
    const text = `${JSON.stringify(summary, null, 2)}\n`
    if (options.output !== undefined) {
      writeFileSync(options.output, text)
      process.stdout.write(`${formatText(summary)}\n`)
      process.stdout.write(`summary written: ${basename(options.output)}\n`)
    } else {
      process.stdout.write(text)
    }
  } catch (error) {
    process.stderr.write(`summarize-feedback: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

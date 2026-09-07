/**
 * Offline promotion-evidence evaluation for the compiler_inspect generic
 * context backend (Phase R1.5, Workstream F).
 *
 *   node scripts/evaluate-context-backend.mjs --sessions <log...> [--context <dir>] [--since YYYY-MM-DD] [--output <file>]
 *
 * Compares the observed `ripwire` and `legacy-rg` provider groups with
 * objective, counts-only metrics drawn from two independent sources:
 *   - the session logs (analyzer): inspect calls, backends, fallbacks, weak
 *     results, ordering of searches after inspect results, first inspect /
 *     first edit steps, tool-result and peak-context costs;
 *   - the gitignored context observation stream: provider attempts, durations,
 *     result sizes, weak/truncated/outside-corpus counts.
 *
 * Honesty rules (deliberate):
 *   - sessions are NOT controlled experiments; every comparison is labeled
 *     observational and ordering metrics never imply causation;
 *   - no single quality score is computed;
 *   - the tool never promotes or rejects the backend — that decision belongs
 *     to human architecture review (promotion gate: ARCHITECTURE.md §15);
 *   - paired A/B comparison is deliberately NOT implemented: it would require
 *     pairing metadata this tool refuses to guess from prompts.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { analyzeRecords, loadRecords, parseRecords } from './analyze-session.mjs'
import { jsonlRecords } from './summarize-feedback.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))

function parseArgs(argv) {
  const options = { sessions: [], contextDir: undefined, since: undefined, output: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--sessions') {
      while (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) options.sessions.push(resolve(argv[++index]))
    } else if (arg === '--context') options.contextDir = resolve(argv[++index])
    else if (arg === '--since') options.since = argv[++index]
    else if (arg === '--output') options.output = resolve(argv[++index])
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

const emptyRates = () => ({
  calls: 0,
  fallbacks: 0,
  weak: 0,
  truncated: 0,
  outside_corpus: 0,
  total_duration_ms: 0,
  total_result_chars: 0,
})

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null
}

/** Observation-stream view: one reliability/cost block per provider. */
function observationByProvider(records) {
  const byProvider = {}
  for (const record of records) {
    const provider = typeof record.provider === 'string' ? record.provider : 'unknown'
    const entry = byProvider[provider] ?? (byProvider[provider] = { ...emptyRates(), fallback_reasons: {}, repos: {} })
    entry.calls += 1
    if (record.fallback === true) {
      entry.fallbacks += 1
      if (typeof record.fallback_reason === 'string') entry.fallback_reasons[record.fallback_reason] = (entry.fallback_reasons[record.fallback_reason] ?? 0) + 1
    }
    if (record.weak === true) entry.weak += 1
    if (record.truncated === true) entry.truncated += 1
    if (Number.isInteger(record.outside_corpus)) entry.outside_corpus += record.outside_corpus
    if (Number.isInteger(record.duration_ms)) entry.total_duration_ms += record.duration_ms
    if (Number.isInteger(record.result_chars)) entry.total_result_chars += record.result_chars
    if (typeof record.repo === 'string') entry.repos[record.repo] = (entry.repos[record.repo] ?? 0) + 1
  }
  for (const entry of Object.values(byProvider)) {
    entry.fallback_rate = rate(entry.fallbacks, entry.calls)
    entry.weak_rate = rate(entry.weak, entry.calls)
    entry.truncated_rate = rate(entry.truncated, entry.calls)
    entry.avg_duration_ms = entry.calls > 0 ? Math.round(entry.total_duration_ms / entry.calls) : 0
    entry.avg_result_chars = entry.calls > 0 ? Math.round(entry.total_result_chars / entry.calls) : 0
  }
  return byProvider
}

/**
 * Session-level view: adoption/reliability, ordering-based search efficiency,
 * and context cost. All fields come from the analyzer's objective counts.
 */
function sessionEvidence(sessionPaths, since) {
  const totals = {
    sessions_analyzed: 0,
    inspect_calls: 0,
    by_backend: {},
    fallbacks: 0,
    fallback_reasons: {},
    weak_results: 0,
    truncated_results: 0,
    searches_after_inspect: { discovery: 0, verification: 0 },
    search_by_backend: {},
    tasks_routed: 0,
    tasks_with_inspect: 0,
    tasks_with_inspect_and_zero_discovery_after: 0,
    sessions_first_inspect_before_first_edit: 0,
    sessions_first_inspect_step: 0,
    peak_request_tokens_max: 0,
    tool_result_bytes_total: 0,
  }
  for (const path of sessionPaths) {
    const records = parseRecords(loadRecords(path))
    if (since !== undefined) {
      const lastTime = [...records].reverse().find(record => typeof record?.time === 'number')?.time
      if (lastTime !== undefined && new Date(lastTime).toISOString().slice(0, 10) < since) continue
    }
    const analysis = analyzeRecords(records)
    totals.sessions_analyzed += 1
    totals.inspect_calls += analysis.compilerInspectCalls
    for (const [backend, count] of Object.entries(analysis.inspectBackends)) {
      totals.by_backend[backend] = (totals.by_backend[backend] ?? 0) + count
    }
    for (const [reason, count] of Object.entries(analysis.inspectFallbacks)) {
      totals.fallbacks += count
      totals.fallback_reasons[reason] = (totals.fallback_reasons[reason] ?? 0) + count
    }
    totals.weak_results += analysis.inspectWeakResults
    totals.truncated_results += analysis.inspectTruncatedResults
    totals.searches_after_inspect.discovery += analysis.searchClassification.discoveryAfterInspect
    totals.searches_after_inspect.verification += analysis.searchClassification.verificationAfterInspect
    for (const [backend, counts] of Object.entries(analysis.searchAfterInspectByBackend)) {
      const entry = totals.search_by_backend[backend] ?? (totals.search_by_backend[backend] = { discovery: 0, verification: 0 })
      entry.discovery += counts.discovery
      entry.verification += counts.verification
    }
    totals.tasks_routed += analysis.routeMetrics.tasksRouted
    totals.tasks_with_inspect += analysis.routeGroups.filter(group => group.inspectCalls > 0).length
    totals.tasks_with_inspect_and_zero_discovery_after += analysis.routeGroups
      .filter(group => group.inspectCalls > 0 && group.discoveryAfterInspect === 0).length
    if (analysis.temporal.firstInspectStep !== undefined) {
      totals.sessions_first_inspect_step += 1
      if (analysis.temporal.firstEditStep !== undefined && analysis.temporal.firstInspectStep < analysis.temporal.firstEditStep) {
        totals.sessions_first_inspect_before_first_edit += 1
      }
    }
    if (analysis.peakRequestTokens > totals.peak_request_tokens_max) totals.peak_request_tokens_max = analysis.peakRequestTokens
    totals.tool_result_bytes_total += analysis.toolResultBytes
  }
  totals.fallback_rate = rate(totals.fallbacks, totals.inspect_calls)
  totals.weak_rate = rate(totals.weak_results, totals.inspect_calls)
  totals.truncated_rate = rate(totals.truncated_results, totals.inspect_calls)
  return totals
}

/** Build the full evaluation report from session paths and a context stream dir. */
export function evaluate({ sessionPaths = [], contextDir, since } = {}) {
  const contextRecords = jsonlRecords(contextDir, since)
  return {
    generated_at: new Date().toISOString(),
    since: since ?? null,
    scope: {
      note: 'Observational comparison of compiler_inspect backend usage and the ordering of later source searches. Sessions are not controlled experiments: differences between providers do not establish causation, and ordering metrics never imply that a backend failed. This report computes no promotion or rejection decision — human architecture review owns that (promotion gate: ARCHITECTURE.md).',
      paired_comparison: 'not implemented by design: pairing would require metadata this tool refuses to infer from prompts',
      sessions_analyzed: sessionPaths.length,
      context_records: contextRecords.length,
    },
    observation: {
      source: 'context observation stream (compiler-dev-owned, counts only)',
      by_provider: observationByProvider(contextRecords),
    },
    adoption: {
      source: 'session logs (rendered Context backend lines; pre-R1.3 sessions carry none)',
      ...sessionEvidence(sessionPaths, since),
    },
  }
}

function formatText(report) {
  const lines = []
  lines.push(`context-backend evaluation (generated ${report.generated_at}${report.since ? `, since ${report.since}` : ''})`)
  lines.push(`scope: ${report.scope.sessions_analyzed} sessions, ${report.scope.context_records} context records — ${report.scope.note}`)
  for (const [provider, entry] of Object.entries(report.observation.by_provider)) {
    lines.push(`observation ${provider}: calls ${entry.calls}, fallback ${entry.fallbacks} (${entry.fallback_rate ?? 'n/a'}), weak ${entry.weak} (${entry.weak_rate ?? 'n/a'}), truncated ${entry.truncated} (${entry.truncated_rate ?? 'n/a'}), outside-corpus ${entry.outside_corpus}, avg ${entry.avg_duration_ms} ms / ${entry.avg_result_chars} chars`)
  }
  const adoption = report.adoption
  lines.push(`adoption: inspect calls ${adoption.inspect_calls} (${Object.entries(adoption.by_backend).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no backend metadata'}), fallbacks ${adoption.fallbacks}, weak ${adoption.weak_results}, truncated ${adoption.truncated_results}`)
  lines.push(`search efficiency (ordering only): discovery-after-inspect ${adoption.searches_after_inspect.discovery}, verification-after-inspect ${adoption.searches_after_inspect.verification}; tasks with inspect ${adoption.tasks_with_inspect}/${adoption.tasks_routed} routed, zero discovery after inspect ${adoption.tasks_with_inspect_and_zero_discovery_after}`)
  lines.push(`cost: tool result bytes ${adoption.tool_result_bytes_total}, max peak request context ${adoption.peak_request_tokens_max}, sessions with first-inspect-before-first-edit ${adoption.sessions_first_inspect_before_first_edit}/${adoption.sessions_first_inspect_step}`)
  lines.push('(counts only — the promotion decision stays with the human reviewer)')
  return lines.join('\n')
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`evaluate-context-backend: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.help || (options.sessions.length === 0 && options.contextDir === undefined)) {
    process.stdout.write('usage: node scripts/evaluate-context-backend.mjs --sessions <log...> [--context <dir>] [--since YYYY-MM-DD] [--output <file>]\n')
    process.exitCode = options.help ? 0 : 1
    return
  }
  const contextDir = options.contextDir ?? join(DEFAULT_ROOT, 'analysis', 'feedback', 'context')
  if (!existsSync(contextDir) && options.contextDir === undefined) {
    // A missing default stream is not an error: the session side still works.
  }
  try {
    const report = evaluate({ sessionPaths: options.sessions, contextDir, since: options.since })
    const text = `${JSON.stringify(report, null, 2)}\n`
    if (options.output !== undefined) {
      writeFileSync(options.output, text)
      process.stdout.write(`${formatText(report)}\n`)
      process.stdout.write(`report written: ${options.output}\n`)
    } else {
      process.stdout.write(text)
    }
  } catch (error) {
    process.stderr.write(`evaluate-context-backend: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

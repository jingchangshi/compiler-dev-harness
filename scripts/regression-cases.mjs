/**
 * Existing-case regression: replays every session log under `cases/` through
 * the analyzer and compares the metrics against a committed baseline, so the
 * 9 audited production sessions stay a REGRESSION corpus instead of a manual
 * case source. Any analyzer change that would silently move the historical
 * baseline (adoption counts, inspect/knowledge calls, search totals, peak
 * context) fails here.
 *
 *   node scripts/regression-cases.mjs                 # replay + compare
 *   node scripts/regression-cases.mjs --update       # re-bless after intended changes
 *   node scripts/regression-cases.mjs --cases <dir> --baseline <file>
 *
 * `cases/` is gitignored runtime data: maintainers drop exported session logs
 * there (`cases/<name>/session.jsonl` or `cases/<name>.jsonl[.zstd]`). The
 * baseline (analysis/case-baseline.json) holds metric numbers only — session
 * short ids and counts, no paths, no prompts.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, relative, resolve } from 'node:path'
import { analyzeRecords, loadRecords, parseRecords } from './analyze-session.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_CASES = join(DEFAULT_ROOT, 'cases')
const DEFAULT_BASELINE = join(DEFAULT_ROOT, 'analysis', 'case-baseline.json')

/** The deterministic metrics that make up the replay baseline. */
const BASELINE_FIELDS = [
  'sessionId', 'agentPreset', 'humanTurns', 'goalContinuations', 'modelSteps',
  'toolCalls', 'compilerInspectCalls', 'compilerKnowledgeCalls',
  'bashGrepLikeCalls', 'skillLoadFailures', 'peakRequestTokens',
  'firstEditWriteStep', 'compactionStarts', 'compactionEnds',
]

function parseArgs(argv) {
  const options = { cases: DEFAULT_CASES, baseline: DEFAULT_BASELINE, update: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cases') options.cases = resolve(argv[++index])
    else if (arg === '--baseline') options.baseline = resolve(argv[++index])
    else if (arg === '--update') options.update = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Find session logs: `cases/<name>.jsonl[.zstd]` or `cases/<name>/session.jsonl[.zstd]`. */
export function findSessionLogs(casesDir) {
  const logs = []
  if (!existsSync(casesDir)) return logs
  for (const name of readdirSync(casesDir).sort()) {
    const path = join(casesDir, name)
    if (!statSync(path).isDirectory() && /\.jsonl(\.zstd)?$/.test(name)) {
      logs.push(path)
      continue
    }
    if (!statSync(path).isDirectory()) continue
    for (const inner of readdirSync(path).sort()) {
      if (/^session\.jsonl(\.zstd)?$/.test(inner) || /\.jsonl(\.zstd)?$/.test(inner)) logs.push(join(path, inner))
    }
  }
  return logs
}

export function baselineFor(path) {
  const records = parseRecords(loadRecords(path))
  const result = analyzeRecords(records)
  const baseline = {}
  for (const field of BASELINE_FIELDS) {
    if (field === 'sessionId') baseline.sessionId = result.session.id
    else if (field === 'agentPreset') baseline.agentPreset = result.session.agentPreset
    else baseline[field] = result[field]
  }
  return baseline
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`regression-cases: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    process.stdout.write('usage: node scripts/regression-cases.mjs [--cases <dir>] [--baseline <file>] [--update]\n')
    return
  }
  const logs = findSessionLogs(options.cases)
  if (logs.length === 0) {
    process.stdout.write(`no session logs under ${options.cases} — drop exported session.jsonl files there (gitignored) to enable the regression corpus\n`)
    return
  }
  // Keys are case-dir-relative so `cases/<id>/session.jsonl` entries stay unique.
  const current = {}
  for (const path of logs) {
    const key = relative(options.cases, path).replaceAll('\\', '/')
    current[key] = baselineFor(path)
  }

  if (options.update) {
    writeFileSync(options.baseline, `${JSON.stringify(current, null, 2)}\n`)
    process.stdout.write(`baseline updated: ${options.baseline} (${logs.length} sessions)\n`)
    return
  }
  if (!existsSync(options.baseline)) {
    process.stderr.write(`regression-cases: baseline ${options.baseline} missing — run once with --update\n`)
    process.exitCode = 1
    return
  }
  const expected = JSON.parse(readFileSync(options.baseline, 'utf8'))
  let failures = 0
  const names = [...new Set([...Object.keys(expected), ...Object.keys(current)])].sort()
  for (const name of names) {
    const want = expected[name]
    const got = current[name]
    if (want === undefined || got === undefined) {
      process.stdout.write(`${name}: ${want === undefined ? 'NEW (not in baseline)' : 'MISSING (in baseline, not on disk)'}\n`)
      if (want === undefined) continue
      failures += 1
      continue
    }
    const drifts = BASELINE_FIELDS.filter(field => JSON.stringify(want[field]) !== JSON.stringify(got[field]))
    if (drifts.length === 0) {
      process.stdout.write(`${name}: ok\n`)
      continue
    }
    failures += 1
    process.stdout.write(`${name}: DRIFT\n`)
    for (const field of drifts) {
      process.stdout.write(`  ${field}: baseline ${JSON.stringify(want[field])} → now ${JSON.stringify(got[field])}\n`)
    }
  }
  if (failures > 0) {
    process.stderr.write(`regression-cases: ${failures} session(s) drifted from the baseline\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`replayed ${logs.length} session(s) against the baseline: no drift\n`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

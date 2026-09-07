/**
 * Feedback bundle export — the periodic exit of the observation loop.
 *
 *   node scripts/export-feedback-bundle.mjs --since 2026-09-07 --output /tmp/compiler-feedback.tar.gz
 *     [--sessions <log...>] [--include-candidate-summary]
 *
 * Bundle layout (no session transcripts, ever):
 *   manifest.json            generator, counts, staged file list
 *   summary.json             batch aggregate (streams + candidates [+ sessions])
 *   route-summary.json       route stream aggregate (kinds, expected, confidence)
 *   query-summary.json       query stream aggregate (commands, operational)
 *   context-summary.json     generic context-provider aggregate (Phase R1.5:
 *                            backend usage, fallbacks, weak/truncated/
 *                            outside-corpus, cost — counts only; the raw
 *                            context/*.jsonl stream is never bundled)
 *   curated-feedback/*.json  committed curated artifacts (validated again)
 *   candidate-summary.json   optional counts-only candidate aggregate
 *
 * Privacy (fail closed): every staged file is JSON-parsed and scanned for
 * forbidden keys (prompt/messages/transcript/source text/secrets/tokens),
 * absolute /home/<user> paths, private-key blocks, and credential-shaped
 * assignments; any hit or an oversized file aborts the export with a non-zero
 * exit and leaves no bundle. The check reports the offending file and key
 * name — never the value.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, join, relative, resolve } from 'node:path'
import { aggregate } from './summarize-feedback.mjs'
import { validateFeedback } from './feedback-schema.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Feedback tree root; tests redirect it with COMPILER_DEV_FEEDBACK_DIR. */
function feedbackRoot() {
  return process.env.COMPILER_DEV_FEEDBACK_DIR
    ? resolve(process.env.COMPILER_DEV_FEEDBACK_DIR)
    : join(DEFAULT_ROOT, 'analysis', 'feedback')
}
const CURATED_DIR = () => feedbackRoot()
const QUERIES_DIR = () => join(feedbackRoot(), 'queries')
const ROUTES_DIR = () => join(feedbackRoot(), 'routes')
const CONTEXT_DIR = () => join(feedbackRoot(), 'context')
const CANDIDATES_DIR = () => join(feedbackRoot(), 'candidates')
const MAX_FILE_BYTES = 2 * 1024 * 1024

const FORBIDDEN_KEYS = new Set([
  'prompt', 'prompts', 'messages', 'message', 'transcript', 'transcripts',
  'source_text', 'sourceText', 'source_code', 'code_text', 'content',
  'api_key', 'apiKey', 'apikey', 'secret', 'secrets', 'password', 'passwd',
  'token', 'tokens', 'authorization', 'cookie', 'reasoning', 'thinking',
])
const FORBIDDEN_KEY_RE = new RegExp(`"(${[...FORBIDDEN_KEYS].join('|')})"\\s*:`, 'i')
const ABSOLUTE_USER_PATH_RE = /\/home\/[A-Za-z0-9_.-]+/
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const CREDENTIAL_RE = /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{20,}/i

function parseArgs(argv) {
  const options = { sessions: [], since: undefined, output: undefined, candidateSummary: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--since') options.since = argv[++index]
    else if (arg === '--output') options.output = resolve(argv[++index])
    else if (arg === '--sessions') {
      while (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) options.sessions.push(resolve(argv[++index]))
    } else if (arg === '--include-candidate-summary') options.candidateSummary = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** One privacy verdict over a staged file. Returns a list of violation strings. */
export function privacyViolations(filePath, rawText) {
  const violations = []
  const label = basename(filePath)
  if (rawText.length > MAX_FILE_BYTES) violations.push(`${label}: file exceeds ${MAX_FILE_BYTES} bytes — transcripts must never be bundled`)
  try {
    JSON.parse(rawText)
  } catch {
    violations.push(`${label}: not valid JSON — only bounded JSON artifacts may be bundled`)
  }
  if (FORBIDDEN_KEY_RE.test(rawText)) {
    const match = FORBIDDEN_KEY_RE.exec(rawText)
    violations.push(`${label}: forbidden key "${match[1]}"`)
  }
  if (ABSOLUTE_USER_PATH_RE.test(rawText)) violations.push(`${label}: absolute /home/<user> path`)
  if (PRIVATE_KEY_RE.test(rawText)) violations.push(`${label}: private key material`)
  if (CREDENTIAL_RE.test(rawText)) violations.push(`${label}: credential-shaped assignment`)
  return violations
}

function stageCuratedFeedback(staging, since) {
  const destination = join(staging, 'curated-feedback')
  mkdirSync(destination, { recursive: true })
  const copied = []
  for (const name of readdirSync(CURATED_DIR()).filter(name => name.endsWith('.json')).sort()) {
    const path = join(CURATED_DIR(), name)
    if (!statSync(path).isFile()) continue
    const document = JSON.parse(readFileSync(path, 'utf8'))
    if (since !== undefined) {
      const created = document?.feedback?.created_at
      if (typeof created !== 'string' || created.slice(0, 10) < since) continue
    }
    const errors = validateFeedback(document)
    if (errors.length > 0) throw new Error(`curated artifact ${name} failed validation — fail closed: ${errors.join('; ')}`)
    copyFileSync(path, join(destination, name))
    copied.push(name)
  }
  return copied
}

function routesSummary(since) {
  const summary = { total: 0, knowledge_expected: 0, declared_skips: 0, by_kind: {}, by_confidence: { low: 0, medium: 0, high: 0 }, by_reason: {}, correlations: 0 }
  const correlations = new Set()
  for (const file of existsSync(ROUTES_DIR()) ? readdirSync(ROUTES_DIR()).filter(name => name.endsWith('.jsonl')).sort() : []) {
    for (const line of readFileSync(join(ROUTES_DIR(), file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try { record = JSON.parse(trimmed) } catch { continue }
      if (record === null || typeof record !== 'object') continue
      if (since !== undefined && (typeof record.ts !== 'string' || record.ts.slice(0, 10) < since)) continue
      summary.total += 1
      if (record.knowledge_expected === true) summary.knowledge_expected += 1
      else summary.declared_skips += 1
      if (typeof record.route === 'string') summary.by_kind[record.route] = (summary.by_kind[record.route] ?? 0) + 1
      if (typeof record.confidence === 'string') summary.by_confidence[record.confidence] += 1
      if (typeof record.reason === 'string') summary.by_reason[record.reason] = (summary.by_reason[record.reason] ?? 0) + 1
      if (typeof record.correlation_id === 'string') correlations.add(record.correlation_id)
    }
  }
  summary.correlations = correlations.size
  return summary
}

function queriesSummary(since) {
  const summary = { total: 0, by_command: {}, by_repo: {}, refreshed: 0, truncated: 0, not_found: 0, errors: 0, diagnostics: 0, total_duration_ms: 0 }
  for (const file of existsSync(QUERIES_DIR()) ? readdirSync(QUERIES_DIR()).filter(name => name.endsWith('.jsonl')).sort() : []) {
    for (const line of readFileSync(join(QUERIES_DIR(), file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try { record = JSON.parse(trimmed) } catch { continue }
      if (record === null || typeof record !== 'object') continue
      if (since !== undefined && (typeof record.ts !== 'string' || record.ts.slice(0, 10) < since)) continue
      summary.total += 1
      if (typeof record.command === 'string') summary.by_command[record.command] = (summary.by_command[record.command] ?? 0) + 1
      if (typeof record.repo === 'string') summary.by_repo[record.repo] = (summary.by_repo[record.repo] ?? 0) + 1
      if (record.refreshed === true) summary.refreshed += 1
      if (record.truncated === true) summary.truncated += 1
      if (typeof record.error === 'string' && record.error !== '') {
        summary.errors += 1
        if (record.error === 'not found') summary.not_found += 1
      }
      if (Number.isInteger(record.diagnostics)) summary.diagnostics += record.diagnostics
      if (Number.isInteger(record.duration_ms)) summary.total_duration_ms += record.duration_ms
    }
  }
  return summary
}

/** Counts-only aggregate of the gitignored context stream (Phase R1.5).
 *  Mirrors the runtime record's operational fields; never bundles the stream
 *  itself. Malformed lines are tolerated and skipped. */
function contextSummary(since) {
  const summary = {
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
    by_repo: {},
    note: 'counts only — the raw context stream is never bundled',
  }
  const dir = CONTEXT_DIR()
  for (const file of existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort() : []) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try { record = JSON.parse(trimmed) } catch { continue }
      if (record === null || typeof record !== 'object') continue
      if (since !== undefined && (typeof record.ts !== 'string' || record.ts.slice(0, 10) < since)) continue
      summary.total += 1
      if (typeof record.provider === 'string') summary.by_provider[record.provider] = (summary.by_provider[record.provider] ?? 0) + 1
      if (typeof record.backend_policy === 'string') summary.by_policy[record.backend_policy] = (summary.by_policy[record.backend_policy] ?? 0) + 1
      if (typeof record.repo === 'string') summary.by_repo[record.repo] = (summary.by_repo[record.repo] ?? 0) + 1
      if (record.fallback === true) {
        summary.fallbacks += 1
        if (typeof record.fallback_reason === 'string') summary.fallback_reasons[record.fallback_reason] = (summary.fallback_reasons[record.fallback_reason] ?? 0) + 1
      }
      if (record.weak === true) summary.weak += 1
      if (record.truncated === true) summary.truncated += 1
      if (Number.isInteger(record.outside_corpus)) summary.outside_corpus += record.outside_corpus
      if (Number.isInteger(record.duration_ms)) summary.total_duration_ms += record.duration_ms
      if (Number.isInteger(record.result_chars)) summary.total_result_chars += record.result_chars
    }
  }
  return summary
}

function candidateSummary(since) {
  const summary = { total: 0, by_kind: {}, note: 'counts only — candidate documents are never bundled' }
  for (const name of existsSync(CANDIDATES_DIR()) ? readdirSync(CANDIDATES_DIR()).filter(name => name.endsWith('.json')).sort() : []) {
    try {
      const feedback = JSON.parse(readFileSync(join(CANDIDATES_DIR(), name), 'utf8')).feedback
      if (since !== undefined && (typeof feedback?.created_at !== 'string' || feedback.created_at.slice(0, 10) < since)) continue
      summary.total += 1
      summary.by_kind[feedback.observation_kind] = (summary.by_kind[feedback.observation_kind] ?? 0) + 1
    } catch { /* unreadable candidates are not bundled anyway */ }
  }
  return summary
}

function writeJson(staging, name, value) {
  writeFileSync(join(staging, name), `${JSON.stringify(value, null, 2)}\n`)
}

function listStaged(dir, prefix = '') {
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) entries.push(...listStaged(path, `${prefix}${name}/`))
    else entries.push({ path: `${prefix}${name}`, bytes: statSync(path).size })
  }
  return entries
}

function exportBundle(options) {
  if (options.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) {
    throw new Error('--since must be YYYY-MM-DD')
  }
  if (options.output === undefined) throw new Error('--output is required')
  const staging = mkdtempSync(join('/tmp', 'compiler-feedback-'))
  try {
    const summary = aggregate({
      sessionPaths: options.sessions,
      candidatesDir: CANDIDATES_DIR(),
      queriesDir: QUERIES_DIR(),
      routesDir: ROUTES_DIR(),
      contextDir: CONTEXT_DIR(),
      since: options.since,
    })
    summary.privacy = { prompt_or_transcript_free: true, check: 'fail-closed key/credential/path scan passed' }
    writeJson(staging, 'summary.json', summary)
    writeJson(staging, 'route-summary.json', routesSummary(options.since))
    writeJson(staging, 'query-summary.json', queriesSummary(options.since))
    writeJson(staging, 'context-summary.json', contextSummary(options.since))
    const curated = stageCuratedFeedback(staging, options.since)
    if (options.candidateSummary) writeJson(staging, 'candidate-summary.json', candidateSummary(options.since))
    const staged = listStaged(staging)
    writeJson(staging, 'manifest.json', {
      generated_at: new Date().toISOString(),
      generator: 'compiler-dev-harness export-feedback-bundle v1',
      since: options.since ?? null,
      curated_artifacts: curated.length,
      contents: staged,
      privacy_check: 'passed (fail-closed)',
    })

    // Privacy pass over every staged file, manifest included.
    for (const entry of listStaged(staging)) {
      const violations = privacyViolations(join(staging, entry.path), readFileSync(join(staging, entry.path), 'utf8'))
      if (violations.length > 0) throw new Error(`privacy check FAILED — bundle aborted: ${violations.join('; ')}`)
    }

    const tar = execFileSync('tar', ['-czf', options.output, '-C', staging, '.'], { encoding: 'utf8' })
    if (tar) process.stdout.write(tar)
    if (!existsSync(options.output) || statSync(options.output).size === 0) {
      throw new Error(`tar produced no bundle at ${options.output}`)
    }
    process.stdout.write(`bundle: ${options.output} (${statSync(options.output).size} bytes, ${staged.length} files, ${curated.length} curated artifacts)\n`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`export-feedback-bundle: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.help || options.output === undefined) {
    process.stdout.write('usage: node scripts/export-feedback-bundle.mjs --since YYYY-MM-DD --output <file.tar.gz> [--sessions <log...>] [--include-candidate-summary]\n')
    process.exitCode = options.help ? 0 : 1
    return
  }
  try {
    exportBundle(options)
  } catch (error) {
    process.stderr.write(`export-feedback-bundle: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

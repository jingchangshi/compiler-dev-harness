/**
 * CodeContextProvider seam for `compiler_inspect` — the Ripwire-backed generic
 * source-context backend (Phase R1).
 *
 * Separation of responsibility (ARCHITECTURE.md §3 objective):
 *   compiler_inspect
 *     +-- CodeContextProvider    ← THIS module (Ripwire) + the legacy rg path
 *     |                             (kept in compiler-inspect-driver.mjs)
 *     +-- CompilerArtifactProvider (git state/diff/history, MLIR log forensics)
 *
 * Ripwire (redhat-et/ripwire) is a zero-dependency C++23 CLI that crawls a
 * repository with tree-sitter and serves a ranked, budgeted task bundle via
 * `--pack-task="TASK"`. `--json` re-shapes the same section decisions as XML
 * (schema identical fields; supported for pack-task upstream). This module
 * integrates EXACTLY ONE Ripwire capability on purpose: `--pack-task --json`.
 *
 * Hard boundaries (goal §8–§15):
 * - every result discloses the backend actually used: backend/fallback/
 *   fallback_reason with a FINITE fallback-reason vocabulary — never a silent
 *   degradation, never arbitrary stderr blobs in their place;
 * - Ripwire output is normalized into a bounded CompilerDev representation —
 *   raw XML/JSON is never dumped into the model context; truncation and floor
 *   counts are preserved, and `weak` means "nothing retrieved" (a retrieval
 *   fact, never semantic absence);
 * - Ripwire evidence is generic retrieval/ranking context. It is NOT a
 *   compiler-semantic fact: nothing here writes the mlir-repomap graph,
 *   touches findings, or upgrades an approximate 1-hop edge into a confirmed
 *   `mlir-repomap` semantic edge;
 * - the Ripwire token budget is DERIVED from the existing CompilerDev delivery
 *   budget (one total budget, not stacked independent ceilings);
 * - binary discovery is deterministic (RIPWIRE_BIN → PATH), spawns argument
 *   arrays only, never installs, downloads, or builds anything.
 *
 * Observation: one non-sensitive JSONL line per source-retrieval attempt lands
 * in `analysis/feedback/context/<date>.jsonl` (gitignored) — counts and
 * durations only. No prompts, no task prose, no source text, no raw Ripwire
 * output, no stderr, no personal paths.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '1.1'
export const MODE = 'pack-task'
export const BACKEND_RIPWIRE = 'ripwire'
export const BACKEND_LEGACY = 'legacy-rg'
export const BACKEND_POLICIES = ['auto', 'ripwire', 'legacy']

/**
 * The repository's stable default backend policy (Phase R1.5, Workstream A).
 * While the Ripwire provider is experimental — the R1 decision was
 * KEEP_RIPWIRE_EXPERIMENTAL — the default is the retained legacy rg/git path:
 * installing the binary alone must NOT flip production traffic. `ripwire`
 * (explicit experiment) and `auto` (capability-based A/B experiment) remain
 * explicitly selectable. Promotion later means changing THIS constant in one
 * deliberate, reviewed commit; there is no percentage rollout, no random
 * routing, and no model- or identity-based assignment anywhere.
 */
export const REPOSITORY_DEFAULT_BACKEND_POLICY = 'legacy'

/**
 * Finite fallback-reason vocabulary (goal §8). Categories only — stderr text
 * never becomes a reason; at most one bounded stderr excerpt rides the
 * unresolved diagnostics, never the observation stream.
 */
export const FALLBACK_REASONS = {
  NOT_FOUND: 'ripwire-not-found',
  INVOCATION_FAILED: 'ripwire-invocation-failed',
  INVALID_OUTPUT: 'ripwire-invalid-output',
  TIMEOUT: 'ripwire-timeout',
  WEAK_RESULT: 'ripwire-weak-result',
  POLICY_LEGACY: 'backend-policy-legacy',
}

// ── budget mapping (goal §15) ───────────────────────────────────────────────
// The bundle's strict total budget lives in the inspect driver (20000 chars).
// The generic source context owns a fixed slice of that ONE budget; Ripwire's
// own token target is then derived from the slice instead of stacking a second
// independent ceiling. Ripwire prices a token at a measured minimum of ~2.36
// bytes (its kMinBytesPerToken; budget_ceiling_bytes = tokens × 2.36), so a
// 5000-token target ceilings the raw pack-task JSON at ~11.8K bytes — inside
// the slice — and the normalizer trims whatever still overflows, disclosed.
export const SOURCE_CONTEXT_BUDGET_CHARS = 12000
export const RIPWIRE_TOKEN_BUDGET = Math.floor(SOURCE_CONTEXT_BUDGET_CHARS / 2.36)

/** Normalized-row and text caps inside the source-context slice. */
const MAX_RANKED_ROWS = 12
const MAX_BODY_ROWS = 4
const MAX_BODY_CHARS = 1600
const MAX_BODY_TOTAL_CHARS = 6000
const MAX_CALLER_ROWS = 12
const MAX_TEST_ROWS = 8
const MAX_FAR_ROWS = 6
const MAX_NOTE_ROWS = 4
const MAX_SIG_CHARS = 200
const MAX_DOC_CHARS = 160
const MAX_TASK_CHARS = 300
const MAX_ROUTE_NOTE_CHARS = 200
const MAX_OMITTED_NAMES = 8

/**
 * Directory names Ripwire's crawl prunes unconditionally (its committed
 * kCrawlSkipDirs, src/ingest.h at the integrated upstream). An anchored file
 * under one of these can never be in Ripwire's indexed corpus, so it is
 * reported `outside_corpus` instead of silently missing (goal §13). Ripwire
 * additionally prunes `cmake-build-*`/`*.dSYM` and, in a git worktree, everything
 * `.gitignore` covers — those dynamic classes are not enumerable here, so a
 * missing result is always "not retrieved", never "does not exist".
 */
export const RIPWIRE_SKIP_DIRS = [
  '.git', '.claude', '.hg', '.svn', 'node_modules', 'vendor', 'third_party',
  '.cache', 'build', 'dist', 'out', 'target', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', 'asan', 'build_prof', 'CMakeFiles', 'captures',
]

export class RipwireContextError extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'RipwireContextError'
    this.reason = reason
  }
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedText(value, max) {
  const text = trim(value)
  if (text === '') return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Strip undefined-valued keys so every emitted row is schema-concrete (the
 * tool output schema validates the object, not its JSON spelling). `name` is
 * the only required row key everywhere, so it coalesces to ''.
 */
function compact(row, required = {}) {
  const out = { ...required, ...row }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }
  return out
}

function within(root, candidate) {
  const target = resolve(root, candidate)
  return target === root || !relative(root, target).startsWith('..')
}

/**
 * Backend policy resolution (Phase R1.5 Workstream A): explicit tool input
 * wins, then the `COMPILER_INSPECT_BACKEND` environment variable (explicit
 * A/B without source edits), then the stable repository default — `legacy`
 * while Ripwire is experimental. Unknown values degrade to the default with a
 * note rather than failing the call. The resolved policy and its source are
 * carried on every result and observation record, so the backend in effect is
 * always visible.
 */
export function resolveBackendPolicy(input = {}, env = process.env) {
  const requested = trim(input.backend).toLowerCase()
  if (BACKEND_POLICIES.includes(requested)) return { policy: requested, source: 'input', notes: [] }
  const fromEnv = trim(env.COMPILER_INSPECT_BACKEND).toLowerCase()
  if (BACKEND_POLICIES.includes(fromEnv)) {
    return { policy: fromEnv, source: 'env', notes: requested === '' ? [] : [`Unknown backend '${requested}' ignored; using env policy '${fromEnv}'.`] }
  }
  return {
    policy: REPOSITORY_DEFAULT_BACKEND_POLICY,
    source: 'repository-default',
    notes: requested === ''
      ? []
      : [`Unknown backend '${requested}' ignored; using the repository default '${REPOSITORY_DEFAULT_BACKEND_POLICY}'.`],
  }
}

/**
 * Deterministic binary discovery (goal §6): `RIPWIRE_BIN` (must exist as a
 * file) → bare `ripwire` name resolved on PATH by spawn. No probe, no shell,
 * no installation. `tried` names what was consulted so a missing binary is
 * diagnosable from the error alone.
 */
export function ripwireBinary(env = process.env) {
  const tried = []
  const override = trim(env.RIPWIRE_BIN)
  if (override !== '') {
    if (existsSync(override)) return { path: override, tried }
    tried.push(`RIPWIRE_BIN=${override} (missing)`)
  }
  tried.push('ripwire (PATH)')
  return { path: 'ripwire', tried }
}

/**
 * The pack-task task string. An explicit `task` input (the model's own task
 * phrase) is used verbatim when given; otherwise one is derived from the
 * anchors the model already passed (goal §12 — no cross-tool fusion): symbol
 * names first (Ripwire routes a strong name hit to exact anchors), file
 * basenames second.
 */
export function deriveTaskString(input = {}) {
  const explicit = trim(input.task)
  if (explicit !== '') return explicit.slice(0, MAX_TASK_CHARS)
  const symbols = (Array.isArray(input.symbols) ? input.symbols : []).map(trim).filter(Boolean)
  const files = (Array.isArray(input.files) ? input.files : []).map(trim).filter(Boolean)
    .map(path => (isAbsolute(path) ? basename(path) : path))
  const parts = []
  if (symbols.length > 0) parts.push(`understand ${symbols.slice(0, 6).join(' ')}`)
  if (files.length > 0) parts.push(`in ${files.slice(0, 4).join(' ')}`)
  const derived = parts.join(' ')
  return derived === '' ? '' : derived.slice(0, MAX_TASK_CHARS)
}

/**
 * CLI argument array for one pack-task call. Contract `exclude_dirs` map onto
 * repeatable `--exclude=SUBSTR` prunes (Ripwire drops any path containing the
 * substring); a trailing `/` keeps the match at directory granularity and
 * avoids over-matching sibling names. Nothing here reaches a shell.
 */
export function buildPackTaskArgs(root, task, options = {}) {
  const args = [root, `--pack-task=${task}`, '--json', `--token-budget=${options.tokenBudget ?? RIPWIRE_TOKEN_BUDGET}`]
  for (const dir of options.excludeDirs ?? []) {
    const clean = trim(dir).replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean !== '') args.push(`--exclude=${clean}/`)
  }
  return args
}

/**
 * Anchored files that can never be in Ripwire's indexed corpus because they
 * resolve under a directory its crawl prunes (or under a caller-supplied
 * exclude). Reported, never silently dropped (goal §13.3).
 */
export function outsideCorpusFiles(root, files = [], extraExcludeDirs = []) {
  const skip = new Set([...RIPWIRE_SKIP_DIRS, ...extraExcludeDirs.map(dir => trim(dir).replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean)])
  return files.filter((file) => {
    const clean = trim(file)
    if (clean === '') return false
    const segments = (isAbsolute(clean) ? relative(root, clean) : clean).split('/')
    return segments.slice(0, -1).some(segment => skip.has(segment))
  })
}

/**
 * Parse one `--pack-task --json` stdout into a bounded, normalized CompilerDev
 * source-context object plus its disclosure block. Every cap cut is counted
 * and disclosed; nothing is invented that the JSON did not carry, and the
 * `weak` flag means "nothing retrieved" — a retrieval fact only.
 *
 * `cuts` accumulates human-readable bounding notes for Unresolved/budget
 * reporting; the boolean `truncated` result covers BOTH Ripwire's own
 * disclosed truncation and this normalizer's caps.
 */
export function normalizePackTaskResult(json, cuts = []) {
  const disclosedTruncated = json.ranking_capped === true
    || (Array.isArray(json.bodies_omitted) && json.bodies_omitted.length > 0)
    || json.over_ceiling === true
    || (typeof json.bodies_kept === 'number' && typeof json.bodies_total === 'number' && json.bodies_kept < json.bodies_total)
    || (typeof json.callers_kept === 'number' && typeof json.callers_total === 'number' && json.callers_kept < json.callers_total)
    || (typeof json.tests_kept === 'number' && typeof json.tests_total === 'number' && json.tests_kept < json.tests_total)
    || (typeof json.far_kept === 'number' && typeof json.far_total === 'number' && json.far_kept < json.far_total)
    || (typeof json.notes_kept === 'number' && typeof json.notes_total === 'number' && json.notes_kept < json.notes_total)

  const rankingRows = Array.isArray(json.ranking) ? json.ranking : []
  const rankedSymbols = rankingRows.slice(0, MAX_RANKED_ROWS).map(row => compact({
    name: boundedText(row?.n, 120) ?? '',
    kind: boundedText(row?.t, 16),
    path: boundedText(row?.p, 200),
    line: typeof row?.l === 'number' ? row.l : undefined,
    rank: typeof row?.r === 'number' ? row.r : undefined,
    fan_in: typeof row?.in === 'number' ? row.in : undefined,
    signature: boundedText(row?.sig, MAX_SIG_CHARS),
    doc: boundedText(row?.doc, MAX_DOC_CHARS),
  }))
  if (rankingRows.length > rankedSymbols.length) cuts.push(`ranking rows cut to ${rankedSymbols.length} of ${rankingRows.length} by the source-context budget`)

  const bodyRows = Array.isArray(json.bodies) ? json.bodies : []
  const bodies = []
  let bodyBudget = MAX_BODY_TOTAL_CHARS
  for (const row of bodyRows.slice(0, MAX_BODY_ROWS)) {
    const text = trim(row?.body)
    const clipped = text.length > Math.min(MAX_BODY_CHARS, Math.max(0, bodyBudget))
      ? `${text.slice(0, Math.min(MAX_BODY_CHARS, bodyBudget) - 1)}…`
      : text
    if (clipped.length < text.length) cuts.push(`body '${boundedText(row?.n, 80)}' clipped by the source-context body budget`)
    bodyBudget -= clipped.length
    bodies.push(compact({
      name: boundedText(row?.n, 120) ?? '',
      kind: boundedText(row?.t, 16),
      path: boundedText(row?.p, 200),
      line: typeof row?.l === 'number' ? row.l : undefined,
      lines_served: typeof row?.lines === 'number' ? row.lines : undefined,
      text: clipped === '' ? undefined : clipped,
    }))
    if (bodyBudget <= 0) {
      const skipped = bodyRows.length - bodies.length
      if (skipped > 0) cuts.push(`${skipped} body rows cut by the source-context body budget`)
      break
    }
  }

  const callerRows = Array.isArray(json.callers) ? json.callers : []
  const callers = callerRows.slice(0, MAX_CALLER_ROWS).map(row => compact({
    name: boundedText(row?.n, 120) ?? '',
    kind: boundedText(row?.t, 16),
    path: boundedText(row?.p, 200),
    relation: boundedText(row?.rel, 8),
    shared: typeof row?.shared === 'number' ? row.shared : undefined,
    signature: boundedText(row?.sig, MAX_SIG_CHARS),
  }))
  if (callerRows.length > callers.length) cuts.push(`caller rows cut to ${callers.length} of ${callerRows.length} by the source-context budget`)

  const testRows = Array.isArray(json.tests_to_run) ? json.tests_to_run : []
  const tests = testRows.slice(0, MAX_TEST_ROWS).map(row => compact({
    path: boundedText(row?.p, 200) ?? '',
    runner: boundedText(row?.run, 200),
  }))
  if (testRows.length > tests.length) cuts.push(`tests_to_run rows cut to ${tests.length} of ${testRows.length} by the source-context budget`)

  const farRows = Array.isArray(json.far) ? json.far : []
  const far = farRows.slice(0, MAX_FAR_ROWS).map(row => compact({
    name: boundedText(row?.n, 120) ?? '',
    kind: boundedText(row?.t, 16),
    path: boundedText(row?.p, 200),
  }))
  if (farRows.length > far.length) cuts.push(`far rows cut to ${far.length} of ${farRows.length} by the source-context budget`)

  const noteRows = Array.isArray(json.notes) ? json.notes : []
  const notes = noteRows.slice(0, MAX_NOTE_ROWS).map(row => ({
    target: boundedText(row?.target, 120),
    items: (Array.isArray(row?.notes) ? row.notes : [])
      .slice(0, 4)
      .map(note => ({ date: boundedText(note?.d, 24), text: boundedText(note?.text, 200) })),
  }))
  if (noteRows.length > notes.length) cuts.push(`note rows cut to ${notes.length} of ${noteRows.length} by the source-context budget`)

  // Ambiguity is DERIVED from returned rows only: a ranked name whose rows
  // span more than one path is a multi-match name. Counted, never guessed.
  const pathsByName = new Map()
  for (const row of rankingRows) {
    const name = trim(row?.n)
    const path = trim(row?.p)
    if (name === '' || path === '') continue
    if (!pathsByName.has(name)) pathsByName.set(name, new Set())
    pathsByName.get(name).add(path)
  }
  const ambiguous = [...pathsByName.values()].filter(paths => paths.size > 1).length

  const omitted = (Array.isArray(json.bodies_omitted) ? json.bodies_omitted : [])
    .slice(0, MAX_OMITTED_NAMES).map(name => boundedText(name, 120)).filter(Boolean)

  const sourceContext = {
    provider: BACKEND_RIPWIRE,
    mode: MODE,
    task: boundedText(json.task, MAX_TASK_CHARS),
    root: boundedText(json.root, 200),
    ranked_symbols: rankedSymbols,
    bodies,
    callers,
    tests_to_run: tests,
    far,
    notes,
  }

  const disclosures = {
    weak: rankedSymbols.length === 0,
    ambiguous,
    truncated: disclosedTruncated || cuts.length > 0,
    counts_floor: disclosedTruncated,
    route_note: boundedText(json.route, MAX_ROUTE_NOTE_CHARS),
    mention_note: boundedText(json.mention, MAX_ROUTE_NOTE_CHARS),
    doc_mention_note: boundedText(json.doc_mention, MAX_ROUTE_NOTE_CHARS),
    ranking_capped: json.ranking_capped === true,
    ranking_total: rankingRows.length,
    bodies_total: json.bodies_total,
    bodies_kept: json.bodies_kept,
    bodies_omitted: omitted.length > 0 ? omitted : undefined,
    callers_total: json.callers_total,
    callers_kept: json.callers_kept,
    tests_total: json.tests_total,
    tests_kept: json.tests_kept,
    notes_total: json.notes_total,
    notes_kept: json.notes_kept,
    far_total: json.far_total,
    far_kept: json.far_kept,
    budget_tokens: json.budget_tokens,
    budget_bytes: json.budget_bytes,
    budget_ceiling_bytes: json.budget_ceiling_bytes,
    over_ceiling: json.over_ceiling === true,
    bounding_notes: cuts.length > 0 ? cuts.slice(0, 8) : undefined,
  }

  return { sourceContext, disclosures }
}

/**
 * One Ripwire `--pack-task --json` invocation. Argument-array spawn, abort
 * propagation, and clean mapping of every failure to a stable
 * `RipwireContextError.reason`. Never installs, never retries blindly.
 */
export async function runRipwireContext(input, signal, options = {}) {
  signal?.throwIfAborted()
  const root = resolve(input.repo_root ?? process.cwd())
  if (!existsSync(root)) throw new RipwireContextError('ripwire-invocation-failed', `repo_root does not exist: ${root}`)
  const task = options.task ?? deriveTaskString(input)
  if (task === '') throw new RipwireContextError('ripwire-invocation-failed', 'pack-task needs a task string; pass task or anchors')
  const binary = options.binary ?? ripwireBinary(options.env ?? process.env)
  const args = buildPackTaskArgs(root, task, {
    tokenBudget: options.tokenBudget,
    excludeDirs: options.excludeDirs ?? input.exclude_dirs ?? [],
  })
  const started = Date.now()
  const raw = await spawnJson(binary.path, args, root, signal, options.env)
  const durationMs = Date.now() - started
  let parsed
  try {
    parsed = JSON.parse(raw.stdout)
  } catch {
    throw new RipwireContextError('ripwire-invalid-output', `ripwire --pack-task --json did not return JSON (exit ${raw.code}). stderr tail: ${raw.stderr.slice(-200) || '(empty)'}`)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.ranking)) {
    throw new RipwireContextError('ripwire-invalid-output', `ripwire --pack-task --json output missing the ranking array (exit ${raw.code}). stdout head: ${raw.stdout.slice(0, 120)}`)
  }
  const cuts = []
  const { sourceContext, disclosures } = normalizePackTaskResult(parsed, cuts)
  return {
    sourceContext,
    disclosures,
    meta: {
      binary: binary.path,
      args_template: ['<root>', '--pack-task=<task>', '--json', '--token-budget=<n>', '[--exclude=<dir>/]...'],
      duration_ms: durationMs,
      result_chars: raw.stdout.length,
      exit_code: raw.code,
      tried: binary.tried,
      stderr_tail: raw.stderr.slice(-200),
    },
  }
}

/** One child process; argument array only, never a shell. */
function spawnJson(bin, args, cwd, signal, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(env !== undefined ? { env: { ...process.env, ...env } } : {}) })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
    const onAbort = () => {
      child.kill('SIGTERM')
      fail(signal.reason instanceof Error && signal.reason.name !== 'AbortError'
        ? signal.reason
        : new RipwireContextError('ripwire-timeout', 'ripwire pack-task aborted before answering'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      const reason = error?.code === 'ENOENT' ? 'ripwire-not-found' : 'ripwire-invocation-failed'
      fail(new RipwireContextError(reason, `cannot execute ${bin}: ${error.message}`))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      if (signal?.aborted) {
        fail(new RipwireContextError('ripwire-timeout', 'ripwire pack-task aborted before answering'))
        return
      }
      if (code !== 0) {
        fail(new RipwireContextError('ripwire-invocation-failed', `ripwire exited ${code}: ${stderr.slice(-300) || '(no stderr)'}`))
        return
      }
      settled = true
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Non-sensitive auto-log: one JSON line per source-retrieval attempt. */
export function logContextRecord(record, logDir) {
  const dir = logDir ?? fileURLToPath(new URL('../analysis/feedback/context', import.meta.url))
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(`${dir}/${String(record.ts).slice(0, 10)}.jsonl`, `${JSON.stringify(record)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Build the observation-plane record for one source-retrieval attempt (goal
 * §16). Counts and categories only: no task prose, no anchors' paths, no
 * source bodies, no raw Ripwire output, no stderr, no personal paths.
 */
export function contextObservationRecord({ ts = new Date().toISOString(), correlationId, policy, backend, fallback, fallbackReason, durationMs, resultChars, truncated, weak, repoRoot, fileCount, symbolCount, rankedCount, bodyCount, testCount, outsideCorpusCount }) {
  const record = {
    ts,
    correlation_id: correlationId,
    backend_policy: policy,
    provider: backend,
    mode: backend === BACKEND_RIPWIRE ? MODE : 'legacy',
    duration_ms: durationMs,
    result_chars: resultChars,
    truncated: truncated === true,
    weak: weak === true,
    fallback: fallback === true,
    fallback_reason: fallbackReason ?? null,
    repo: basename(repoRoot ?? ''),
    file_count: fileCount,
    symbol_count: symbolCount,
    ranked_symbols: rankedCount,
    bodies: bodyCount,
    tests: testCount,
    outside_corpus: outsideCorpusCount,
  }
  return record
}

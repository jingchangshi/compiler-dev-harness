/**
 * compiler_inspect v1.2 driver — one model roundtrip into a bounded Evidence
 * Bundle. Runs in-process under the preset plugin with the repository (or a
 * subdirectory of it) as the working directory, so every path it emits is
 * relative to the routed working directory. It retrieves deterministic code
 * facts only; build/environment procedures stay human-owned (Repository
 * Contract) and are never inferred here.
 *
 * v1.3 (Phase R1, generic-context backend): the source-retrieval half of the
 * driver becomes a provider seam with an explicit backend policy
 * (`auto`/`ripwire`/`legacy`, input → COMPILER_INSPECT_BACKEND env → auto):
 * - `ripwire` — the new primary provider (`compiler-context-backend.mjs`)
 *   serves one bounded `--pack-task --json` bundle as `source_context`;
 * - `legacy-rg` — the original hand-written rg/git retrieval below, retained
 *   unchanged and still the fallback;
 * - every result discloses `backend`/`fallback`/`fallback_reason` (finite
 *   reason vocabulary; no silent fallback), git state/diff/history and MLIR
 *   log forensics stay provider-independent, and one non-sensitive context
 *   observation line is emitted per source-retrieval attempt.
 *
 * v1.2 retrieval improvements over v1.1 (from the 2026-09-06 case feedback):
 * - definition retrieval adds the C/C++ function-definition shape
 *   `name(args) {` (with an optional preceding return-type token run), which
 *   v1.1's keyword/assignment shapes missed entirely;
 * - the vendored fallback also runs when an anchored file sits inside a
 *   vendored tree or when no definition-shaped match exists outside it, and
 *   it now propagates the abort signal (v1.1 dropped it);
 * - optional bounded pipeline-log forensics via `log_files`: per-file
 *   `IR Dump After/Before <pass>` indexes, occurrence-addressed bounded dump
 *   slices, and a two-file pass-sequence diff. Mechanical line arithmetic
 *   only — it never interprets IR semantics;
 * - `history_window` clamps into 1–30 and records the clamp in Unresolved
 *   instead of failing the whole call.
 *
 * v1.1 retrieval improvements over v1:
 * - portable repository root: a missing `.git` falls back to
 *   `git rev-parse --show-toplevel` so a subdirectory anchor still yields the
 *   worktree root;
 * - default exclusion of noise and vendored trees (.git, node_modules, build,
 *   dist, caches, third_party/vendor), with a bounded vendored fallback only
 *   when a symbol has zero matches outside them;
 * - batched searches: symbols run as one ripgrep alternation per pass instead
 *   of one process per term;
 * - definitions and references are separated by a cheap definition-syntax pass
 *   with two lines of context, so the bundle usually removes the follow-up
 *   full-file read;
 * - total bundle output is held under a strict character budget by trimming
 *   the lowest-priority sections first.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import {
  BACKEND_LEGACY,
  BACKEND_RIPWIRE,
  FALLBACK_REASONS,
  RipwireContextError,
  contextObservationRecord,
  logContextRecord,
  outsideCorpusFiles,
  resolveBackendPolicy,
  runRipwireContext,
} from './compiler-context-backend.mjs?v=1.1'

const VERSION = '1.4'
const MAX_ITEMS = 12
const MAX_LINE_CHARS = 280
const MAX_DEFINITION_ITEMS = 10
const DEFAULT_HISTORY_WINDOW = 6
const MAX_HISTORY_SYMBOLS = 3
/** Strict budget for the whole rendered bundle; sections trim until it holds. */
const MAX_TOTAL_CHARS = 20000
/** Two lines of context around a probable definition. */
const DEFINITION_CONTEXT = 2
/** Log-forensics bounds (v1.2). */
const MAX_LOG_FILES = 4
const MAX_LOG_PASSES = 8
const DEFAULT_SLICE_LINES = 60
const MAX_SLICE_TEXT_CHARS = 8000
const MAX_DIFF_ITEMS = 24
const MAX_PASS_INDEX_ITEMS = 24

/** Trees searched last (only when nothing matched outside them). */
const VENDOR_DIRS = ['third_party', '3rdparty', 'vendor', 'external', 'submodules']
/** Directories never useful for code evidence. */
const DEFAULT_EXCLUDED_DIRS = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.cache',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.cxx',
]

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function unique(items) {
  return [...new Set(items)]
}

function limitedLines(text, maxItems = MAX_ITEMS) {
  const lines = Array.isArray(text) ? text : text.split('\n')
  return unique(lines.map(trim).filter(Boolean)
    .map(line => line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line))
    .slice(0, maxItems)
}

function within(root, candidate) {
  const target = resolve(root, candidate)
  return target === root || !relative(root, target).startsWith('..')
}

function displayPath(root, path) {
  return isAbsolute(path) ? relative(root, path) || '.' : path
}

function command(bin, args, cwd, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const onAbort = () => {
      child.kill('SIGTERM')
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('compiler_inspect aborted'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('compiler_inspect aborted'))
      else resolvePromise({ code, stdout, stderr })
    })
  })
}

async function git(args, cwd, signal) {
  return command('git', args, cwd, signal)
}

async function rg(args, cwd, signal) {
  return command('rg', args, cwd, signal)
}

/**
 * One ripgrep call over one alternation of all terms (batched, not per term).
 * Vendored-tree excludes are appended last on purpose: ripgrep's last-glob-wins
 * precedence keeps them excluded even under include globs such as test files.
 */
async function rgOnce(pattern, flags, includeGlobs, excludedDirs, root, signal) {
  const excludes = unique(excludedDirs.map(dir => `!${dir.replace(/^\.\//, '').replace(/\/$/, '')}/**`))
  return rg([
    '--line-number', '--no-heading',
    ...flags,
    ...excludes.flatMap(glob => ['--glob', glob]),
    ...includeGlobs.flatMap(glob => ['--glob', glob]),
    ...VENDOR_DIRS.flatMap(dir => ['--glob', `!${dir}/**`]),
    '--regexp', pattern,
    '.',
  ], root, signal)
}

/** Vendored-only pass for the zero-match fallback; vendor include globs go last. */
async function rgVendoredOnly(pattern, flags, excludedDirs, root, signal) {
  const baseExcludes = unique(excludedDirs.map(dir => `!${dir.replace(/^\.\//, '').replace(/\/$/, '')}/**`))
  return rg([
    '--line-number', '--no-heading',
    ...flags,
    ...baseExcludes.flatMap(glob => ['--glob', glob]),
    ...VENDOR_DIRS.flatMap(dir => ['--glob', `${dir}/**`]),
    '--regexp', pattern,
    '.',
  ], root)
}

/**
 * Definition-shaped patterns for the symbol set. v1.2 adds the C/C++
 * function-definition shape `name(args) {` (optionally preceded by
 * return-type-like tokens on the same line), which the keyword and
 * assignment shapes miss — plain C/C++ definitions were previously reported
 * only as undifferentiated references.
 */
function definitionPatterns(symbols) {
  const alternation = symbols.join('|')
  return [
    `\\b(class|struct|union|enum|interface|trait|record|def|fn|func|function|macro|method)\\s+(${alternation})\\b`,
    `\\b(${alternation})\\s*[:=]`,
    // Attached-brace C/C++ definitions: optional return-type-ish tokens, the
    // name, a brace-free parameter list, and the opening brace on one line.
    // The leading token run keeps `if (sym(x)) {`-style call sites out.
    `^\\s*(?:[\\w:&*<>,~]+\\s+)*(${alternation})\\s*\\([^{}]*\\)\\s*(?:const\\s*)?\\{`,
  ]
}

/** One ripgrep pass over all definition shapes combined. */
function combinedDefinitionPattern(symbols) {
  return definitionPatterns(symbols).map(pattern => `(?:${pattern})`).join('|')
}

function referencePattern(symbols) {
  return [`\\b(${symbols.join('|')})\\b`]
}

/** Strip the `./` search-root prefix and drop ripgrep group separators. */
function cleanRgLines(stdout) {
  return stdout.split('\n').map(line => line.replace(/^\.\//, '')).filter(line => line && line !== '--')
}

/**
 * Rank definition evidence: match lines inside anchored files first, then
 * match lines elsewhere, then context lines. Stable within a rank.
 */
function rankDefinitionLines(lines, anchoredFiles) {
  const anchored = new Set(anchoredFiles)
  const rank = (line) => {
    const match = /^(.+?):(\d+)[::-]/.exec(line)
    if (!match) return 4
    const isMatchLine = /^(.+?):(\d+):/.test(line)
    if (anchored.has(match[1])) return isMatchLine ? 0 : 2
    return isMatchLine ? 1 : 3
  }
  return lines
    .map((line, index) => ({ line, index, rank: rank(line) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.line)
}

async function collectDefinitions(root, symbols, excludedDirs, anchoredFiles, signal) {
  if (symbols.length === 0) return []
  const result = await rgOnce(combinedDefinitionPattern(symbols), ['--max-count', '6', '-C', String(DEFINITION_CONTEXT)], [], excludedDirs, root, signal)
  const lines = rankDefinitionLines(cleanRgLines(result.stdout), anchoredFiles)
  return limitedLines(lines, MAX_DEFINITION_ITEMS)
}

async function collectReferences(root, symbols, excludedDirs, signal) {
  if (symbols.length === 0) return []
  const result = await rgOnce(referencePattern(symbols)[0], ['--max-count', '8'], [], excludedDirs, root, signal)
  return limitedLines(cleanRgLines(result.stdout), MAX_ITEMS)
}

/** Bounded vendored fallback: only when a symbol matched nowhere else. */
/**
 * Bounded vendored fallback. Runs when a symbol matched nowhere outside the
 * vendored trees (v1.1 behavior), when no definition-shaped match exists
 * outside them (v1.2: the vendored half of an ABI chain otherwise had no tool
 * coverage), or when an anchored file sits inside a vendored tree. The
 * missing-definitions trigger searches definition shapes; the others search
 * plain references. Returns the trigger so Unresolved can state it.
 */
async function collectVendoredFallback(root, symbols, excludedDirs, nonVendorMatchCount, signal, opts = {}) {
  if (symbols.length === 0) return { items: [], reason: null }
  const definitionShaped = opts.definitionsEmpty === true && opts.anchorInVendored !== true
  const relaxed = nonVendorMatchCount === 0 || opts.definitionsEmpty === true || opts.anchorInVendored === true
  if (!relaxed) return { items: [], reason: null }
  const pattern = definitionShaped ? combinedDefinitionPattern(symbols) : referencePattern(symbols)[0]
  const result = await rgVendoredOnly(pattern, ['--max-count', '4'], excludedDirs, root, signal)
  const reason = opts.anchorInVendored === true
    ? 'anchor-inside-vendored'
    : opts.definitionsEmpty === true ? 'definitions-only-in-vendored' : 'no-match-outside-vendored'
  return { items: limitedLines(cleanRgLines(result.stdout), 4), reason }
}

async function collectTestMatches(root, symbols, contractTestDirs, excludedDirs, signal) {
  if (symbols.length === 0) return []
  const testGlobs = contractTestDirs.length > 0
    ? contractTestDirs.map(dir => `${dir.replace(/\/$/, '')}/**`)
    : ['**/*test*', '**/*Test*', '**/test/**', '**/tests/**']
  const result = await rgOnce(referencePattern(symbols)[0], ['--max-count', '4'], testGlobs, excludedDirs, root, signal)
  return limitedLines(cleanRgLines(result.stdout), 8)
}

async function history(root, files, symbols, window, signal) {
  const paths = files.length > 0 ? files : ['.']
  const commits = await git(['log', `-${window}`, '--format=%h %s', '--', ...paths], root, signal)
  const results = limitedLines(commits.stdout)
  for (const symbol of symbols.slice(0, MAX_HISTORY_SYMBOLS)) {
    const found = await git(['log', `-${window}`, '-S', symbol, '--format=%h %s', '--', ...paths], root, signal)
    results.push(...limitedLines(found.stdout, 4).map(line => `${symbol}: ${line}`))
  }
  return limitedLines(results)
}

/** Extract the pass name from an `IR Dump After/Before <name> …` marker line. */
function dumpPassName(line) {
  const match = /IR Dump (?:After|Before) (.+)$/.exec(line)
  if (match === null) return null
  const name = match[1].replace(/\s*\/\/-----.*$/, '').trim()
  return name === '' ? null : name
}

/**
 * Bounded scan of one pipeline log: per-pass dump counts with first-line
 * numbers. Mechanical line arithmetic only — the IR itself is never read or
 * interpreted, and the returned dump list is bounded only by log size.
 */
function scanLogFile(path, displayPathName) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const dumps = []
  for (let index = 0; index < lines.length; index++) {
    const name = dumpPassName(lines[index])
    if (name !== null) dumps.push({ pass: name, line: index + 1 })
  }
  const stats = new Map()
  for (const dump of dumps) {
    const entry = stats.get(dump.pass)
    if (entry === undefined) stats.set(dump.pass, { count: 1, first_line: dump.line })
    else entry.count += 1
  }
  const perPass = [...stats.entries()]
    .map(([pass, entry]) => ({ pass, count: entry.count, first_line: entry.first_line }))
    .sort((a, b) => b.count - a.count || a.pass.localeCompare(b.pass))
    .slice(0, MAX_PASS_INDEX_ITEMS)
  return { path: displayPathName, lineCount: lines.length, lineTexts: lines, bytes: Buffer.byteLength(text, 'utf8'), dumpTotal: dumps.length, perPass, dumps }
}

/** Resolve a requested pass to its dump entries: exact name first, then the first-seen substring match. */
function resolvePassDumps(dumps, requested) {
  const exact = dumps.filter(dump => dump.pass === requested)
  if (exact.length > 0) return { name: requested, hits: exact }
  const lower = requested.toLowerCase()
  const name = dumps.find(dump => dump.pass.toLowerCase().includes(lower))?.pass
  if (name === undefined) return null
  return { name, hits: dumps.filter(dump => dump.pass === name) }
}

/**
 * Extract one bounded dump slice: from the marker line to the next dump
 * marker or `sliceLines` lines, whichever comes first. Lines are capped at
 * MAX_LINE_CHARS like every other bundle line.
 */
function extractLogSlice(lines, hits, occurrence, sliceLines) {
  const hit = hits[occurrence - 1]
  if (hit === undefined) return null
  const startIndex = hit.line - 1
  const limit = Math.min(lines.length, startIndex + sliceLines)
  let endIndex = startIndex + 1
  while (endIndex < limit && dumpPassName(lines[endIndex]) === null) endIndex++
  const captured = lines.slice(startIndex, endIndex)
    .map(line => line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line)
  return { markerLine: hit.line, count: captured.length, text: captured.join('\n') }
}

/**
 * Two-file pass-sequence diff: per-pass count deltas, the first dump-index
 * divergence, and first-occurrence line alignment for common passes.
 */
function diffLogs(a, b) {
  const firstA = new Map()
  const firstB = new Map()
  const countsA = new Map()
  const countsB = new Map()
  for (const dump of a.dumps) {
    countsA.set(dump.pass, (countsA.get(dump.pass) ?? 0) + 1)
    if (!firstA.has(dump.pass)) firstA.set(dump.pass, dump.line)
  }
  for (const dump of b.dumps) {
    countsB.set(dump.pass, (countsB.get(dump.pass) ?? 0) + 1)
    if (!firstB.has(dump.pass)) firstB.set(dump.pass, dump.line)
  }
  const names = [...new Set([...countsA.keys(), ...countsB.keys()])]
  const passCountDiffs = names
    .map(name => ({ name, a: countsA.get(name) ?? 0, b: countsB.get(name) ?? 0 }))
    .filter(entry => entry.a !== entry.b)
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b) || x.name.localeCompare(y.name))
    .slice(0, MAX_DIFF_ITEMS)
    .map(entry => `${entry.name}: ${entry.a} vs ${entry.b}`)
  const common = Math.min(a.dumps.length, b.dumps.length)
  let index = 0
  while (index < common && a.dumps[index].pass === b.dumps[index].pass) index++
  const firstDivergence = index < common
    ? `dump #${index + 1}: '${a.dumps[index].pass}' vs '${b.dumps[index].pass}'`
    : a.dumps.length !== b.dumps.length
      ? `sequences identical up to dump #${common}; totals differ (${a.dumps.length} vs ${b.dumps.length})`
      : null
  const alignedFirstLines = names
    .filter(name => firstA.has(name) && firstB.has(name))
    .map(name => ({ name, line: firstA.get(name) }))
    .sort((x, y) => x.line - y.line)
    .slice(0, MAX_DIFF_ITEMS)
    .map(name => `${name.name}: a@L${firstA.get(name.name)} b@L${firstB.get(name.name)}`)
  return {
    files: [a.path, b.path],
    pass_count_diffs: passCountDiffs,
    first_divergence: firstDivergence,
    aligned_first_lines: alignedFirstLines,
  }
}

/**
 * Bounded pipeline-log forensics over the requested `log_files`. Produces a
 * per-file dump index, occurrence-addressed slices for requested passes, and
 * a two-file diff. Appends diagnostics to `unresolved`; never interprets IR.
 */
function collectLogForensics(root, logFiles, logPasses, occurrence, sliceLines, unresolved) {
  if (logFiles.length === 0) return { files: [], slices: [], slice_items: [], diff: null, truncated: false }
  const scanned = []
  for (const file of logFiles) {
    const path = resolve(root, file)
    if (!existsSync(path) || !statSync(path).isFile()) {
      unresolved.push(`Requested log file not found: ${file}`)
      continue
    }
    const scan = scanLogFile(path, displayPath(root, file))
    scanned.push(scan)
  }
  const slices = []
  const sliceItems = []
  let sliceBudget = MAX_SLICE_TEXT_CHARS
  let truncated = false
  for (const scan of scanned) {
    for (const requested of logPasses) {
      const resolved = resolvePassDumps(scan.dumps, requested)
      if (resolved === null) {
        unresolved.push(`No IR-dump pass matches '${requested}' in ${scan.path}`)
        continue
      }
      const slice = extractLogSlice(scan.lineTexts, resolved.hits, occurrence, sliceLines)
      if (slice === null) {
        unresolved.push(`Occurrence #${occurrence} of '${resolved.name}' not present in ${scan.path} (${resolved.hits.length} dumps)`)
        continue
      }
      slices.push({ file: scan.path, pass: resolved.name, occurrence, marker_line: slice.markerLine, lines: slice.count })
      if (sliceBudget <= 0) {
        truncated = true
        continue
      }
      const header = `${scan.path} — '${resolved.name}' dump #${occurrence} @L${slice.markerLine} (${slice.count} lines)`
      const body = slice.text.length > sliceBudget ? slice.text.slice(0, sliceBudget - 1) + '…' : slice.text
      if (body.length < slice.text.length) truncated = true
      sliceBudget -= body.length + header.length + 2
      sliceItems.push(`${header}\n${body}`)
    }
  }
  const diff = scanned.length === 2 ? diffLogs(scanned[0], scanned[1]) : null
  return {
    files: scanned.map(scan => ({ path: scan.path, lines: scan.lineCount, bytes: scan.bytes, dump_total: scan.dumpTotal, per_pass: scan.perPass })),
    slices,
    slice_items: sliceItems,
    diff,
    truncated,
  }
}

/**
 * Render the bundle and enforce the strict total budget by dropping items from
 * the largest section until the whole bundle fits.
 */
function enforceBudget(sections) {
  let truncated = false
  const render = () => sections.map(([name, items]) => `${name}:\n${items.map(item => `- ${item}`).join('\n')}`).join('\n\n')
  const order = ['References', 'History', 'Tests', 'Definitions', 'Logs']
  while (render().length > MAX_TOTAL_CHARS) {
    const largest = [...sections]
      .filter(([name]) => order.includes(name))
      .sort((a, b) => b[1].length - a[1].length)[0]
    if (largest === undefined || largest[1].length === 0) break
    largest[1] = largest[1].slice(0, Math.max(1, Math.floor(largest[1].length / 2)))
    truncated = true
  }
  return { text: render(), truncated }
}

export async function inspectCompilerRepository(input, signal, context = {}) {
  const env = context.env ?? process.env
  signal?.throwIfAborted()
  const startedAt = Date.now()
  let root = resolve(input.repo_root ?? process.cwd())
  if (!existsSync(root)) throw new Error(`repo_root does not exist: ${root}`)
  if (!existsSync(resolve(root, '.git'))) {
    const toplevel = await git(['rev-parse', '--show-toplevel'], root, signal)
    if (toplevel.code === 0 && trim(toplevel.stdout)) root = trim(toplevel.stdout)
  }
  const files = unique((input.files ?? []).filter(file => within(root, file)).map(file => displayPath(root, file)))
  const symbols = unique((input.symbols ?? []).map(trim).filter(Boolean)).slice(0, 12)
  const historyWindow = input.history_window === undefined ? DEFAULT_HISTORY_WINDOW : Math.max(1, Math.min(30, input.history_window))
  const includeTests = input.include_tests !== false
  const includeDiff = input.include_diff !== false
  const excludedDirs = unique([...DEFAULT_EXCLUDED_DIRS, ...(input.exclude_dirs ?? []).map(trim).filter(Boolean)])
  const contractTestDirs = unique((input.contract_test_dirs ?? []).map(trim).filter(Boolean))
  const logFiles = unique((input.log_files ?? []).map(trim).filter(Boolean)).slice(0, MAX_LOG_FILES)
  const logPasses = unique((input.log_passes ?? []).map(trim).filter(Boolean)).slice(0, MAX_LOG_PASSES)
  const logOccurrence = Math.max(1, Math.floor(input.log_occurrence ?? 1))
  const logSliceLines = Math.max(5, Math.min(400, Math.floor(input.log_slice_lines ?? DEFAULT_SLICE_LINES)))

  const repository = { root, branch: 'unknown', dirty: 'unknown' }
  const unresolved = []
  if (!existsSync(resolve(root, '.git'))) {
    unresolved.push('Not a Git worktree: Git state and history are unavailable.')
  }

  // ── Backend policy (v1.3, R1.5 Workstream A): CodeContextProvider selection ──
  // The repository default is `legacy` while Ripwire is experimental (R1
  // decision KEEP_RIPWIRE_EXPERIMENTAL): installing the binary alone never
  // flips production traffic. `ripwire` is the explicit experiment; `auto` is
  // the capability-based A/B experiment (Ripwire when usable, controlled
  // legacy fallback on ANY failure — finite reason, never silent). Only the
  // GENERIC source retrieval swaps — git state/diff/history and log forensics
  // run regardless.
  const policy = resolveBackendPolicy(input, env)
  unresolved.push(...policy.notes)
  const task = trim(input.task)
  const sourceRetrievalRequested = symbols.length > 0 || exactFilesRequested(input) > 0 || task !== ''

  let backend = BACKEND_LEGACY
  let fallback = false
  let fallbackReason = null
  let sourceContext = null
  let sourceDisclosures = null
  let ripwireAttempt // observation-plane facts about the ripwire attempt, if one ran
  // Anchored files that can never be in Ripwire's indexed corpus (crawl-pruned
  // or contract-excluded trees) — reported whenever a Ripwire attempt ran,
  // regardless of whether it succeeded, fell back, or degraded (goal §13).
  const outsideCorpus = (input.files ?? []).length > 0
    ? outsideCorpusFiles(root, files, input.exclude_dirs ?? [])
    : []

  if (policy.policy !== 'legacy' && sourceRetrievalRequested) {
    try {
      const result = await runRipwireContext({ ...input, task: task || undefined }, signal, { excludeDirs: input.exclude_dirs, env })
      if (!includeTests && result.sourceContext.tests_to_run.length > 0) {
        result.sourceContext.tests_to_run = []
        result.disclosures.bounding_notes = [...(result.disclosures.bounding_notes ?? []), 'tests_to_run dropped (include_tests=false)']
        result.disclosures.truncated = true
      }
      ripwireAttempt = {
        duration_ms: result.meta.duration_ms,
        result_chars: result.meta.result_chars,
        weak: result.disclosures.weak,
        failed: false,
      }
      if (result.disclosures.weak && policy.policy === 'auto') {
        // Weak = nothing retrieved. In auto that is a controlled fallback, and
        // "not retrieved" must never read as semantic absence.
        fallback = true
        fallbackReason = FALLBACK_REASONS.WEAK_RESULT
        unresolved.push(`Ripwire pack-task retrieved nothing for the anchors (${result.meta.duration_ms} ms); legacy retrieval ran instead — not retrieved is not semantic absence.`)
      } else {
        backend = BACKEND_RIPWIRE
        sourceContext = result.sourceContext
        sourceDisclosures = result.disclosures
        const disclosures = result.disclosures
        if (disclosures.ambiguous > 0) {
          unresolved.push(`Ripwire ranking holds ${disclosures.ambiguous} name(s) defined in several files; disambiguate by path before relying on a body.`)
        }
        if (disclosures.truncated) {
          unresolved.push('Ripwire bundle was truncated (budget); counts are floors — request narrower anchors or raise nothing blindly.')
        }
      }
    } catch (error) {
      if (!(error instanceof RipwireContextError)) throw error
      ripwireAttempt = { failed: true, reason: error.reason, duration_ms: Date.now() - startedAt }
      if (policy.policy === 'auto') {
        fallback = true
        fallbackReason = error.reason
        unresolved.push(`Ripwire unavailable (${error.reason}); legacy rg/git retrieval ran instead.`)
      } else {
        // Explicit `ripwire` must NOT silently become legacy (goal §7): keep
        // the backend honest and surface the degraded condition.
        backend = BACKEND_RIPWIRE
        sourceContext = {
          provider: BACKEND_RIPWIRE,
          mode: 'pack-task',
          degraded: true,
          error: error.reason,
          message: error.message.length > 200 ? `${error.message.slice(0, 199)}…` : error.message,
          ranked_symbols: [],
          bodies: [],
          callers: [],
          tests_to_run: [],
          far: [],
          notes: [],
        }
        unresolved.push(`Ripwire was requested explicitly but failed (${error.reason}); no legacy fallback ran. Re-call with backend 'legacy' for rg/git retrieval.`)
      }
    }
  }

  signal?.throwIfAborted()
  const branch = await git(['branch', '--show-current'], root, signal)
  if (branch.code === 0) repository.branch = trim(branch.stdout) || 'detached'
  const status = await git(['status', '--short'], root, signal)
  if (status.code === 0) repository.dirty = limitedLines(status.stdout, 8).join(' | ') || 'clean'

  const exactFiles = []
  for (const file of files) {
    if (existsSync(resolve(root, file))) exactFiles.push(file)
    else unresolved.push(`Requested file not found: ${file}`)
  }
  const anchorInVendored = exactFiles.some(file => VENDOR_DIRS.some(dir => file === dir || file.startsWith(`${dir}/`)))
  if (ripwireAttempt !== undefined && outsideCorpus.length > 0) {
    unresolved.push(`Anchored files outside Ripwire's indexed corpus (crawl-pruned or contract-excluded trees): ${outsideCorpus.join(', ')} — absence there is not-retrieved, not evidence of absence.`)
  }

  // Legacy rg/git source retrieval — the retained fallback and the explicit
  // `legacy` backend. When Ripwire serves, only the NARROW vendored supplement
  // may still run (an anchored file in a tree Ripwire prunes is invisible to
  // its corpus; the legacy vendored pass is the bounded remedy, goal §13).
  let definitions = []
  let references = []
  let vendored = []
  let vendoredResult = { items: [], reason: null }
  let tests = []
  if (backend !== BACKEND_RIPWIRE) {
    signal?.throwIfAborted()
    definitions = await collectDefinitions(root, symbols, excludedDirs, exactFiles, signal)
    references = await collectReferences(root, symbols, excludedDirs, signal)
    vendoredResult = await collectVendoredFallback(root, symbols, excludedDirs, definitions.length + references.length, signal, { anchorInVendored, definitionsEmpty: symbols.length > 0 && definitions.length === 0 })
    vendored = vendoredResult.items
    signal?.throwIfAborted()
    tests = includeTests ? await collectTestMatches(root, symbols, contractTestDirs, excludedDirs, signal) : []
  } else if (outsideCorpus.some(file => VENDOR_DIRS.some(dir => file === dir || file.startsWith(`${dir}/`)))) {
    signal?.throwIfAborted()
    vendoredResult = await collectVendoredFallback(root, symbols, excludedDirs, 0, signal, { anchorInVendored: true })
    vendored = vendoredResult.items
    if (vendored.length > 0) {
      unresolved.push('Narrow legacy vendored pass ran for anchored files Ripwire cannot index; matches come from vendored/submodule trees.')
    }
  }

  const changes = []
  if (includeDiff) {
    const diff = await git(['diff', '--stat', '--', ...(exactFiles.length > 0 ? exactFiles : ['.'])], root, signal)
    changes.push(...limitedLines(diff.stdout))
  }
  const historyItems = await history(root, exactFiles, symbols, historyWindow, signal)

  if (symbols.length === 0 && files.length === 0 && task === '') unresolved.push('No explicit anchors supplied; inspect a task anchor before broadening discovery.')
  if (backend !== BACKEND_RIPWIRE && symbols.length > 0 && definitions.length === 0 && references.length === 0 && vendored.length === 0) {
    unresolved.push('No match for the symbols outside vendored trees; inspect spelling, generated sources, or an implementation-specific name.')
  }
  if (backend !== BACKEND_RIPWIRE && vendored.length > 0) {
    const reasonNote = vendoredResult.reason === 'definitions-only-in-vendored'
      ? 'no definition-shaped match outside vendored trees'
      : vendoredResult.reason === 'anchor-inside-vendored'
        ? 'an anchored file sits inside vendored trees'
        : 'no match outside vendored trees'
    unresolved.push(`Vendored pass ran (${reasonNote}); matches come from vendored/submodule trees — anchor exact files to scope evidence.`)
  }
  const logs = collectLogForensics(root, logFiles, logPasses, logOccurrence, logSliceLines, unresolved)

  const sections = [
    ['Definitions', definitions],
    ['References', references],
    ['Vendored matches', vendored],
    ['Tests', tests],
    ['Current changes', changes],
    ['History', historyItems],
    ['Logs', logs.slice_items],
    ['Unresolved', limitedLines(unresolved, 8)],
  ]
  const { text: rendered, truncated } = enforceBudget(sections)
  // Schema-strict output: keys must be present-and-typed or absent, never
  // present-with-undefined (the harness validates the object, not its JSON
  // spelling). Rows are already compact; the two top-level Ripwire objects get
  // a shallow strip here.
  const stripUndefined = (value) => (value === null || value === undefined ? value : Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)))
  const bundle = {
    repository,
    anchors: { files: exactFiles, symbols },
    backend,
    fallback,
    fallback_reason: fallbackReason,
    source_context: stripUndefined(sourceContext),
    source_disclosures: stripUndefined(sourceDisclosures),
    definitions,
    references,
    vendored_matches: vendored,
    tests,
    changes,
    history: historyItems,
    logs,
    unresolved: limitedLines(unresolved, 8),
    budget: {
      max_items_per_section: MAX_ITEMS,
      max_line_chars: MAX_LINE_CHARS,
      total_budget_chars: MAX_TOTAL_CHARS,
      truncated,
      version: VERSION,
    },
  }

  // ── Observation plane (goal §16): one non-sensitive line per source-      ──
  // ── retrieval attempt. Counts/categories only — never task prose, paths,  ──
  // ── source bodies, raw Ripwire output, or stderr.                         ──
  if (sourceRetrievalRequested) {
    const rankedCount = sourceContext?.ranked_symbols?.length
    logContextRecord(contextObservationRecord({
      correlationId: context.correlationId,
      policy: policy.policy,
      backend,
      fallback,
      fallbackReason,
      durationMs: Date.now() - startedAt,
      resultChars: backend === BACKEND_RIPWIRE
        ? (sourceContext?.degraded === true ? 0 : (ripwireAttempt?.result_chars ?? 0))
        : rendered.length,
      truncated: truncated === true || sourceDisclosures?.truncated === true,
      weak: backend === BACKEND_RIPWIRE
        ? (sourceContext?.degraded === true ? true : ripwireAttempt?.weak)
        : (definitions.length + references.length + vendored.length + tests.length) === 0,
      repoRoot: root,
      fileCount: exactFiles.length,
      symbolCount: symbols.length,
      rankedCount,
      bodyCount: sourceContext?.bodies?.length,
      testCount: sourceContext?.tests_to_run?.length,
      outsideCorpusCount: outsideCorpus.length,
    }), context.logDir)
  }
  return bundle
}

/** Count requested file anchors before existence filtering (pre-resolution). */
function exactFilesRequested(input) {
  return Array.isArray(input.files) ? input.files.filter(file => typeof file === 'string' && file.trim() !== '').length : 0
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const encoded = process.argv[2]
  const input = encoded === undefined ? {} : JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  process.stdout.write(`${JSON.stringify(await inspectCompilerRepository(input))}\n`)
}

/**
 * compiler_inspect v1.1 driver — one model roundtrip into a bounded Evidence
 * Bundle. Runs as a plain Node script through the shell tool with the
 * repository (or a subdirectory of it) as the working directory, so every path
 * it emits is relative to the routed working directory. It retrieves
 * deterministic code facts only; build/environment procedures stay
 * human-owned (Repository Contract) and are never inferred here.
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
import { existsSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'

const VERSION = '1.1'
const MAX_ITEMS = 12
const MAX_LINE_CHARS = 280
const MAX_DEFINITION_ITEMS = 10
const DEFAULT_HISTORY_WINDOW = 6
const MAX_HISTORY_SYMBOLS = 3
/** Strict budget for the whole rendered bundle; sections trim until it holds. */
const MAX_TOTAL_CHARS = 20000
/** Two lines of context around a probable definition. */
const DEFINITION_CONTEXT = 2

/** Trees searched last (only when nothing matched outside them). */
const VENDOR_DIRS = ['third_party', '3rdparty', 'vendor', 'external', 'submodules']
/** Directories never useful for code evidence. */
const DEFAULT_EXCLUDED_DIRS = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.cache',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.cxx',
]

function trim(value) {
  return value.trim()
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

/** Keyword-declaration and annotation/assignment shapes for the symbol set. */
function definitionPattern(symbols) {
  const alternation = symbols.join('|')
  return [
    `\\b(class|struct|union|enum|interface|trait|record|def|fn|func|function|macro|method)\\s+(${alternation})\\b`,
    `\\b(${alternation})\\s*[:=]`,
  ]
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
  const [declPattern, assignPattern] = definitionPattern(symbols)
  const decl = await rgOnce(declPattern, ['--max-count', '6', '-C', String(DEFINITION_CONTEXT)], [], excludedDirs, root, signal)
  const assign = await rgOnce(assignPattern, ['--max-count', '6', '-C', String(DEFINITION_CONTEXT)], [], excludedDirs, root, signal)
  const lines = rankDefinitionLines(cleanRgLines(`${decl.stdout}\n${assign.stdout}`), anchoredFiles)
  return limitedLines(lines, MAX_DEFINITION_ITEMS)
}

async function collectReferences(root, symbols, excludedDirs, signal) {
  if (symbols.length === 0) return []
  const result = await rgOnce(referencePattern(symbols)[0], ['--max-count', '8'], [], excludedDirs, root, signal)
  return limitedLines(cleanRgLines(result.stdout), MAX_ITEMS)
}

/** Bounded vendored fallback: only when a symbol matched nowhere else. */
async function collectVendoredFallback(root, symbols, excludedDirs, nonVendorMatchCount, signal) {
  if (symbols.length === 0 || nonVendorMatchCount > 0) return []
  const result = await rgVendoredOnly(referencePattern(symbols)[0], ['--max-count', '4'], excludedDirs, root, signal)
  return limitedLines(cleanRgLines(result.stdout), 4)
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

/**
 * Render the bundle and enforce the strict total budget by dropping items from
 * the largest section until the whole bundle fits.
 */
function enforceBudget(sections) {
  let truncated = false
  const render = () => sections.map(([name, items]) => `${name}:\n${items.map(item => `- ${item}`).join('\n')}`).join('\n\n')
  const order = ['References', 'History', 'Tests', 'Definitions']
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

export async function inspectCompilerRepository(input, signal) {
  signal?.throwIfAborted()
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

  const repository = { root, branch: 'unknown', dirty: 'unknown' }
  const unresolved = []
  if (!existsSync(resolve(root, '.git'))) {
    unresolved.push('Not a Git worktree: Git state and history are unavailable.')
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

  signal?.throwIfAborted()
  const definitions = await collectDefinitions(root, symbols, excludedDirs, exactFiles, signal)
  const references = await collectReferences(root, symbols, excludedDirs, signal)
  const vendored = await collectVendoredFallback(root, symbols, excludedDirs, definitions.length + references.length, signal)
  signal?.throwIfAborted()
  const tests = includeTests ? await collectTestMatches(root, symbols, contractTestDirs, excludedDirs, signal) : []
  const changes = []
  if (includeDiff) {
    const diff = await git(['diff', '--stat', '--', ...(exactFiles.length > 0 ? exactFiles : ['.'])], root, signal)
    changes.push(...limitedLines(diff.stdout))
  }
  const historyItems = await history(root, exactFiles, symbols, historyWindow, signal)

  if (symbols.length === 0 && files.length === 0) unresolved.push('No explicit anchors supplied; inspect a task anchor before broadening discovery.')
  if (symbols.length > 0 && definitions.length === 0 && references.length === 0 && vendored.length === 0) {
    unresolved.push('No match for the symbols outside vendored trees; inspect spelling, generated sources, or an implementation-specific name.')
  }
  if (vendored.length > 0) unresolved.push('Matches shown may come from vendored/submodule trees; anchor exact files to scope evidence.')

  const sections = [
    ['Definitions', definitions],
    ['References', references],
    ['Vendored matches', vendored],
    ['Tests', tests],
    ['Current changes', changes],
    ['History', historyItems],
    ['Unresolved', limitedLines(unresolved, 8)],
  ]
  const { truncated } = enforceBudget(sections)
  return {
    repository,
    anchors: { files: exactFiles, symbols },
    definitions,
    references,
    vendored_matches: vendored,
    tests,
    changes,
    history: historyItems,
    unresolved: limitedLines(unresolved, 8),
    budget: {
      max_items_per_section: MAX_ITEMS,
      max_line_chars: MAX_LINE_CHARS,
      total_budget_chars: MAX_TOTAL_CHARS,
      truncated,
      version: VERSION,
    },
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const encoded = process.argv[2]
  const input = encoded === undefined ? {} : JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  process.stdout.write(`${JSON.stringify(await inspectCompilerRepository(input))}\n`)
}

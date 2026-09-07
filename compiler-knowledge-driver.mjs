/**
 * compiler_knowledge driver — deterministic compiler-memory queries over the
 * mlir-compiler-harness `mlir-repomap` CLI (adapters/compiler-dev contract,
 * Phase 20). Runs in-process under the preset plugin; the CLI is spawned as an
 * argument array — nothing reaches a shell — and only its JSON envelope is
 * returned, bounded.
 *
 * Contract enforcement built in (adapters/compiler-dev/query-contract.md):
 * - every command's envelope keeps the stable `command`, `index`, `result`
 *   fields; `index.stale=true` means the worktree is not covered by the index,
 *   so by default the driver refreshes (`index --full`) BEFORE answering and
 *   reports the refresh — stale results are never served for reasoning;
 * - `refresh_index: false` turns that into an explicit stale refusal (status
 *   only), so a caller can check freshness without paying the rebuild;
 * - diagnostics, `error: "not found"` and empty memory pass through verbatim:
 *   they are valid negative results, never padded with guesses.
 *
 * Session observation (non-sensitive, feedback-schema.md spirit): every served
 * query appends one JSON line to `<preset>/analysis/feedback/queries/<date>.jsonl`
 * — command, target name, repo, head, refresh flag, duration, size, truncation,
 * error. No prompts, no result content, no source text. The directory is
 * gitignored runtime data; curated feedback artifacts stay hand-written.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'

const VERSION = '1.0'
/** Strict budget for the delivered JSON envelope. */
const MAX_TOTAL_CHARS = 24000
/** Overall guard for one tool call: covers an auto `index --full` (~100s on AscendNPU-IR) plus the query. */
const REFRESH_GUARD_MS = 240000

/** The four contract query commands plus the status probe. */
const QUERY_COMMANDS = new Set(['review', 'finding-impact', 'pipeline-stages', 'evidence'])
const ALL_COMMANDS = new Set([...QUERY_COMMANDS, 'status'])

/** The CLI executable, in discovery order. Env override first for ports. */
function knowledgeBinary(env = process.env) {
  const tried = []
  if (env.MLIR_REPOMAP_BIN) {
    if (existsSync(env.MLIR_REPOMAP_BIN)) return { path: env.MLIR_REPOMAP_BIN, tried }
    tried.push(`MLIR_REPOMAP_BIN=${env.MLIR_REPOMAP_BIN} (missing)`)
  }
  const sibling = fileURLToPath(new URL('../mlir-compiler-harness/repomap/.venv/bin/mlir-repomap', import.meta.url))
  if (existsSync(sibling)) return { path: sibling, tried }
  tried.push(sibling)
  return { path: 'mlir-repomap', tried }
}

/** One child process; argument array only, never a shell. */
function command(bin, args, cwd, signal, timeoutMs, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(env !== undefined ? { env: { ...process.env, ...env } } : {}) })
    let stdout = ''
    let stderr = ''
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`mlir-repomap ${args.filter(a => !a.startsWith('--')).join(' ')} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer)
      child.kill('SIGTERM')
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('compiler_knowledge aborted'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', code => {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('compiler_knowledge aborted'))
      else resolvePromise({ code, stdout, stderr })
    })
  })
}

/**
 * Build the CLI argument array for one query command. Global `--repo` goes
 * before the subcommand; the name/fid/ident is the first positional; optional
 * contract flags follow. Returns null when `name` is missing (status needs
 * nothing).
 */
export function buildCliArgs(root, cmd, input) {
  const flags = []
  const addFlag = (flag, value) => {
    if (typeof value === 'string' && value.trim() !== '') flags.push(flag, value.trim())
  }
  if (cmd === 'review') {
    if (typeof input.name !== 'string' || input.name.trim() === '') return null
    addFlag('--dir', input.findings_dir)
    addFlag('--docs-dir', input.docs_dir)
    addFlag('--git-repo', input.git_repo)
    addFlag('--since', input.since)
    return ['--repo', root, 'review', input.name.trim(), ...flags]
  }
  if (cmd === 'finding-impact') {
    if (typeof input.name !== 'string' || input.name.trim() === '') return null
    addFlag('--dir', input.findings_dir)
    addFlag('--git-repo', input.git_repo)
    addFlag('--since', input.since)
    return ['--repo', root, 'finding-impact', input.name.trim(), ...flags]
  }
  if (cmd === 'pipeline-stages') {
    if (typeof input.name !== 'string' || input.name.trim() === '') return null
    return ['--repo', root, 'pipeline-stages', input.name.trim()]
  }
  if (cmd === 'evidence') {
    if (typeof input.name !== 'string' || input.name.trim() === '') return null
    return ['--repo', root, 'evidence', input.name.trim()]
  }
  if (cmd === 'status') return ['--repo', root, 'status']
  return null
}

/**
 * Enforce the strict envelope budget by halving the largest array anywhere
 * under `result` until the whole envelope fits. Envelope keys (`command`,
 * `index`) are never dropped, and every cut is reported.
 */
export function boundEnvelope(envelope, budget = MAX_TOTAL_CHARS) {
  let text = JSON.stringify(envelope, null, 1)
  if (text.length <= budget) return { envelope, text, truncated: false }
  const notes = []
  const collectArrays = (node, path, out) => {
    if (Array.isArray(node)) out.push({ path, value: node })
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) collectArrays(value, `${path}.${key}`, out)
    }
  }
  for (;;) {
    const arrays = []
    collectArrays(envelope.result, 'result', arrays)
    if (arrays.length === 0) break
    arrays.sort((a, b) => JSON.stringify(b.value).length - JSON.stringify(a.value).length)
    const largest = arrays[0]
    if (largest.value.length === 0) break
    largest.value.length = Math.max(1, Math.floor(largest.value.length / 2))
    notes.push(`${largest.path} cut to ${largest.value.length} items by the ${budget}-char budget`)
    text = JSON.stringify(envelope, null, 1)
    if (text.length <= budget) break
  }
  return { envelope, text, truncated: true, notes }
}

/** Non-sensitive auto-log: one JSON line per served command. Best effort. */
export function logQueryRecord(record, logDir) {
  const dir = logDir ?? fileURLToPath(new URL('./analysis/feedback/queries', import.meta.url))
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${record.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`)
    return true
  } catch {
    return false
  }
}

function parseEnvelope(stdout, stderr, exitCode) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`mlir-repomap did not return JSON (exit ${exitCode}). stderr: ${stderr.slice(-400) || '(empty)'}`)
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.command !== 'string' || typeof parsed.result !== 'object') {
    throw new Error(`mlir-repomap envelope missing command/index/result fields: ${stdout.slice(0, 200)}`)
  }
  return parsed
}

/**
 * One contract-shaped knowledge query. Returns the CLI envelope with the
 * stable `command`/`index`/`result` fields plus a `delivery` section (version,
 * refresh report, truncation notes) — never result content of its own.
 */
export async function runKnowledgeQuery(input, signal, logDir, env = process.env) {
  signal?.throwIfAborted()
  const cmd = input.command
  if (!ALL_COMMANDS.has(cmd)) {
    throw new Error(`command must be one of ${[...ALL_COMMANDS].join(', ')} (contract: adapters/compiler-dev/query-contract.md)`)
  }
  let root = resolve(input.repo_root ?? process.cwd())
  if (!existsSync(root)) throw new Error(`repo_root does not exist: ${root}`)
  const binary = knowledgeBinary(env)
  const started = Date.now()
  const record = {
    ts: new Date().toISOString(),
    command: cmd,
    name: typeof input.name === 'string' ? input.name.trim() : undefined,
    repo: basename(root),
    head: undefined,
    refreshed: false,
    duration_ms: undefined,
    result_chars: undefined,
    truncated: false,
    error: undefined,
  }
  const delivery = { driver: VERSION, notes: [] }

  // Freshness probe first: stale worktrees are refreshed before reasoning.
  const probe = await command(binary.path, ['--repo', root, 'status'], root, signal, REFRESH_GUARD_MS, env)
  if (probe.code === null) {
    throw new Error(`cannot execute mlir-repomap (tried: ${[binary.path, ...binary.tried].join('; ')}). Set MLIR_REPOMAP_BIN or install it on PATH.`)
  }
  const probeEnvelope = parseEnvelope(probe.stdout, probe.stderr, probe.code)
  const indexInfo = probeEnvelope.result?.index ?? probeEnvelope.index ?? {}
  record.head = typeof indexInfo.head === 'string' ? indexInfo.head.slice(0, 12) : undefined
  const stale = indexInfo.stale === true

  if (cmd === 'status') {
    const { envelope, text, truncated } = boundEnvelope({
      command: 'status', index: indexInfo, result: probeEnvelope.result, delivery,
    })
    record.duration_ms = Date.now() - started
    record.result_chars = text.length
    record.truncated = truncated
    if (stale && input.refresh_index === true) {
      const built = await command(binary.path, ['--repo', root, 'index', '--full'], root, signal, REFRESH_GUARD_MS, env)
      delivery.notes.push(built.code === 0 ? 'index --full completed' : `index --full failed (exit ${built.code}): ${built.stderr.slice(-200)}`)
    }
    if (stale) delivery.notes.push('index is stale; run a query (default refresh_index:true) to refresh with index --full before reasoning over results')
    logQueryRecord(record, logDir)
    return envelope
  }

  if (stale) {
    if (input.refresh_index === false) {
      delivery.notes.push('REFUSED: index is stale (worktree not covered). Call again with refresh_index:true (default) to run index --full, or read-only status.')
      logQueryRecord({ ...record, error: 'refused-stale' }, logDir)
      return { command: cmd, index: indexInfo, result: { error: 'stale-index', hint: 'run mlir-repomap index --full (or refresh_index:true) before reasoning over results' }, delivery }
    }
    const refreshStart = Date.now()
    const built = await command(binary.path, ['--repo', root, 'index', '--full'], root, signal, REFRESH_GUARD_MS, env)
    signal?.throwIfAborted()
    if (built.code !== 0) {
      delivery.notes.push(`index --full failed (exit ${built.code}); serving no results: ${built.stderr.slice(-300)}`)
      logQueryRecord({ ...record, error: 'refresh-failed' }, logDir)
      return { command: cmd, index: indexInfo, result: { error: 'index-refresh-failed' }, delivery }
    }
    let refreshStats
    try { refreshStats = JSON.parse(built.stdout)?.result } catch { refreshStats = undefined }
    delivery.notes.push(`index was stale; ran index --full in ${((Date.now() - refreshStart) / 1000).toFixed(1)}s${refreshStats?.seconds !== undefined ? ` (${refreshStats.scanned} files scanned, ${refreshStats.reextracted} reextracted)` : ''}`)
    record.refreshed = true
    const fresh = await command(binary.path, ['--repo', root, 'status'], root, signal, REFRESH_GUARD_MS, env)
    if (fresh.code === 0) {
      try {
        const freshInfo = JSON.parse(fresh.stdout)?.result?.index
        if (freshInfo?.head) record.head = String(freshInfo.head).slice(0, 12)
        if (freshInfo?.stale === true) delivery.notes.push('index still reports stale after refresh; treat results as provisional')
      } catch { /* probe detail is optional */ }
    }
  }

  const args = buildCliArgs(root, cmd, input)
  if (args === null) {
    throw new Error(`command '${cmd}' requires a 'name' argument (pass arg/class, finding id, pipeline name, or entity id)`)
  }
  const query = await command(binary.path, args, root, signal, REFRESH_GUARD_MS, env)
  signal?.throwIfAborted()
  record.duration_ms = Date.now() - started
  if (query.code !== 0 && query.stdout.trim() === '') {
    record.error = `exit-${query.code}`
    logQueryRecord(record, logDir)
    throw new Error(`mlir-repomap ${cmd} failed (exit ${query.code}): ${query.stderr.slice(-400)}`)
  }
  const envelope = parseEnvelope(query.stdout, query.stderr, query.code)
  const { envelope: bounded, text, truncated, notes } = boundEnvelope({
    command: envelope.command,
    index: envelope.index ?? indexInfo,
    result: envelope.result,
    delivery,
  })
  if (truncated) delivery.notes.push(...notes)
  record.result_chars = text.length
  record.truncated = truncated
  if (envelope.result?.error !== undefined) record.error = String(envelope.result.error).slice(0, 80)
  logQueryRecord(record, logDir)
  return bounded
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const encoded = process.argv[2]
  const input = encoded === undefined ? { command: 'status' } : JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  process.stdout.write(`${JSON.stringify(await runKnowledgeQuery(input))}\n`)
}

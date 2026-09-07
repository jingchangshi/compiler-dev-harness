/**
 * Candidate → curated feedback review (no manual JSON re-typing).
 *
 *   node scripts/review-feedback.mjs <candidate.json> --accept
 *   node scripts/review-feedback.mjs <candidate.json> --reject [--reason "…"]
 *   node scripts/review-feedback.mjs --list [--candidates <dir>]
 *
 * --accept  validate (Feedback Protocol v2), strip any runtime-only field,
 *           set origin to `curated` (the explicit human-review mark), cross-
 *           check against the sibling harness Python validator when its venv
 *           is available, then write the artifact into `analysis/feedback/`.
 * --reject  move the candidate into `candidates/rejected/` (never committed).
 * Neither path stages or commits anything — git stays a human decision.
 *
 * Only the maintainer's acceptance turns an `automatic` candidate into
 * `curated` evidence; there is no automatic promotion (ADR-025).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, join, resolve } from 'node:path'
import { stripRuntimeFields, validateFeedback } from './feedback-schema.mjs'

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Feedback tree root; tests redirect it with COMPILER_DEV_FEEDBACK_DIR. */
function feedbackRoot() {
  return process.env.COMPILER_DEV_FEEDBACK_DIR
    ? resolve(process.env.COMPILER_DEV_FEEDBACK_DIR)
    : join(DEFAULT_ROOT, 'analysis', 'feedback')
}
const CANDIDATES_DIR = () => join(feedbackRoot(), 'candidates')
const CURATED_DIR = () => feedbackRoot()
const REJECTED_DIR = () => join(CANDIDATES_DIR(), 'rejected')
/** Sibling harness venv, used only for an optional protocol cross-check. */
const PYTHON_VALIDATOR_CANDIDATES = [
  fileURLToPath(new URL('../mlir-compiler-harness/repomap/.venv/bin/python3', import.meta.url)),
]

function parseArgs(argv) {
  const options = { file: undefined, mode: undefined, reason: undefined, list: false, candidatesDir: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--accept') options.mode = 'accept'
    else if (arg === '--reject') options.mode = 'reject'
    else if (arg === '--reason') options.reason = argv[++index]
    else if (arg === '--list') options.list = true
    else if (arg === '--candidates') options.candidatesDir = resolve(argv[++index])
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!arg.startsWith('--')) options.file = resolve(arg)
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Optional cross-check against the protocol's owning implementation. */
function pythonValidate(document) {
  for (const python of PYTHON_VALIDATOR_CANDIDATES) {
    if (!existsSync(python)) continue
    try {
      const script = 'import json,sys; from mlir_repomap.feedback import validate_feedback;'
        + 'doc=json.load(sys.stdin); print("\\n".join(validate_feedback(doc)))'
      const out = execFileSync(python, ['-c', script], {
        input: JSON.stringify(document),
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, PYTHONPATH: join(python, '..', '..', '..', 'src') },
      }).trim()
      return { checked: true, errors: out === '' ? [] : out.split('\n') }
    } catch (error) {
      const stderr = String(error?.stderr ?? '')
      if (error?.status === 1 && stderr.includes('validate_feedback')) {
        return { checked: true, errors: stderr.trim().split('\n') }
      }
      return { checked: false, errors: [`python cross-check unavailable: ${String(error?.message ?? error).slice(0, 160)}`] }
    }
  }
  return { checked: false, errors: [] }
}

function slugOf(text) {
  return String(text ?? 'target')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'target'
}

function accept(path) {
  let document
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read candidate: ${error.message}`)
  }
  const before = validateFeedback(document)
  if (document?.feedback?.schema_version !== 2) {
    process.stderr.write(`review-feedback: ${basename(path)} is not a v2 candidate (schema_version ${document?.feedback?.schema_version}); refusing\n`)
    process.exitCode = 1
    return
  }
  if (before.length > 0) process.stdout.write(`note: candidate had ${before.length} validation issue(s); stripping runtime fields may fix them\n`)
  const stripped = stripRuntimeFields(document)
  stripped.feedback.origin = 'curated'
  const errors = validateFeedback(stripped)
  if (errors.length > 0) {
    process.stderr.write(`review-feedback: candidate invalid after stripping — NOT accepted\n  ${errors.join('\n  ')}\n`)
    process.exitCode = 1
    return
  }
  const cross = pythonValidate(stripped)
  if (cross.checked && cross.errors.length > 0) {
    process.stderr.write(`review-feedback: python validator rejected the artifact — NOT accepted\n  ${cross.errors.join('\n  ')}\n`)
    process.exitCode = 1
    return
  }
  if (!cross.checked && cross.errors.length > 0) process.stdout.write(`note: ${cross.errors[0]}\n`)
  const feedback = stripped.feedback
  const name = `${feedback.created_at}-${feedback.observation_kind}-${slugOf(feedback.task?.target)}.json`
  const destination = join(CURATED_DIR(), name)
  if (existsSync(destination)) {
    process.stderr.write(`review-feedback: ${name} already exists; refusing to overwrite a curated artifact\n`)
    process.exitCode = 1
    return
  }
  writeFileSync(destination, `${JSON.stringify(stripped, null, 2)}\n`)
  try {
    unlinkSync(path)
  } catch {
    // The curated artifact is written; a non-writable pending pool is not fatal.
  }
  process.stdout.write(`accepted: ${basename(path)} → analysis/feedback/${name} (origin: curated)\n`)
  if (cross.checked) process.stdout.write('cross-checked with mlir_repomap.feedback.validate_feedback\n')
}

function moveFile(from, to) {
  try {
    renameSync(from, to)
  } catch {
    // Cross-device (e.g. candidate on /tmp): copy + unlink instead.
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

function reject(path, reason) {
  mkdirSync(REJECTED_DIR(), { recursive: true })
  const name = basename(path)
  const destination = join(REJECTED_DIR(), name)
  if (existsSync(destination)) {
    process.stderr.write(`review-feedback: rejected/${name} already exists\n`)
    process.exitCode = 1
    return
  }
  moveFile(path, destination)
  if (typeof reason === 'string' && reason.trim() !== '') {
    writeFileSync(`${destination}.reason.txt`, `${reason.trim()}\n`)
  }
  process.stdout.write(`rejected: ${name} → candidates/rejected/${name}\n`)
}

function list(dir) {
  const root = dir ?? CANDIDATES_DIR()
  if (!existsSync(root)) {
    process.stdout.write(`no candidates directory at ${root}\n`)
    return
  }
  const entries = readdirSync(root).filter(name => name.endsWith('.json')).sort()
  if (entries.length === 0) {
    process.stdout.write('no pending candidates\n')
    return
  }
  for (const name of entries) {
    try {
      const feedback = JSON.parse(readFileSync(join(root, name), 'utf8')).feedback
      process.stdout.write(`${name}: ${feedback?.observation_kind} route=${feedback?.route?.kind} expected=${feedback?.route?.knowledge_expected} confidence=${feedback?.route?.confidence}\n`)
    } catch {
      process.stdout.write(`${name}: (unreadable)\n`)
    }
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`review-feedback: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.help || (options.list === false && (options.file === undefined || options.mode === undefined))) {
    process.stdout.write('usage: node scripts/review-feedback.mjs <candidate.json> --accept | --reject [--reason "…"] | --list [--candidates <dir>]\n')
    process.exitCode = options.help ? 0 : 1
    return
  }
  try {
    if (options.list) list(options.candidatesDir)
    else if (options.mode === 'accept') accept(options.file)
    else if (options.mode === 'reject') reject(options.file, options.reason)
    else throw new Error('no mode given')
  } catch (error) {
    process.stderr.write(`review-feedback: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

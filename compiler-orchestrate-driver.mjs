/**
 * Orchestration control plane for the code-explanation workflow (Phase T4).
 *
 * Ownership model (ARCHITECTURE): the knowledge plane (Evidence →
 * TeachingDossier → PresentationHandoff) and the composition layer (T3) are
 * unchanged. This driver adds ONLY an Execution/Control Plane on top:
 *
 *   ArtifactCatalog   — derived on every call from source-of-truth artifacts
 *                       (runtime + curated roots); never a database.
 *   SubjectResolver   — deterministic user-subject → bundle resolution with
 *                       explicit AMBIGUOUS (never silent fuzzy matching).
 *   Planner           — REUSE / REFRESH / CREATE classification with depth
 *                       compatibility, composition reuse, presentation reuse.
 *   ExplanationRun    — request-level coordination state + execution DAG
 *                       (coordination only; artifact truth is re-derived).
 *   Final Gate        — verifies every requested deliverable exists, is
 *                       fresh, ready, and traceable.
 *   Renderer          — derived human-readable single-subject explanation.md
 *                       (JSON artifacts stay the only source of truth).
 *
 * The semantic half (mechanisms, mental models, bridges, storylines, semantic
 * reviews) is agent reasoning recorded in the artifacts — this driver never
 * generates it. It only tells the agent what to do next (work packets, next
 * actions) and verifies what was actually produced.
 *
 * Node-only, stdlib. Anti-overfitting: subject-agnostic — no compiler-only
 * concepts (enforced by the orchestration generic-layer scan).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DEPTHS, AUDIENCE_QUESTIONS, validateBundle, computeReadiness, slugify,
} from './scripts/teaching-schema.mjs'
import {
  loadBundle, stalenessForBundle, resolveCompositionImports, repositoryProvenance,
  explainRoot, planTeaching,
} from './compiler-explain-driver.mjs'
import { renderSystemStory } from './compiler-compose-driver.mjs'
import { preflightHandoff } from './scripts/preflight-handoff.mjs'

const ORCHESTRATE_DRIVER_VERSION = 'compiler-orchestrate-driver v1.0'

export const DEPTH_RANK = { overview: 0, standard: 1, deep: 2, presentation: 3 }
export const OUTPUT_KINDS = ['artifacts', 'documents', 'system_story', 'presentation']
export const DEFAULT_OUTPUTS = ['artifacts', 'documents']
export const RUN_STATES = [
  'planning', 'in_progress', 'ready_to_finalize', 'blocked_at_child',
  'blocked_at_composition', 'presentation_invalid', 'complete',
]
export const SUBJECT_ACTIONS = ['REUSE', 'REFRESH', 'CREATE', 'AMBIGUOUS', 'BLOCKED']
export const COMPOSITION_ACTIONS = ['COMPOSE', 'REUSE_COMPOSITION']
export const PRESENTATION_ACTIONS = ['PRESENT', 'REUSE_PRESENTATION']

const HARNESS_ROOT = dirname(fileURLToPath(import.meta.url))
const ARTIFACT_FILES = ['subject.json', 'evidence.json', 'dossier.json', 'handoff.json', 'readiness.json', 'composition.json']

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ─────────────────────────────────────────────────────────────────────────────
// Roots: runtime store vs curated store
// ─────────────────────────────────────────────────────────────────────────────

/** Curated explanation bundles (committed regression/dogfood fixtures). */
export function curatedExplanationsRoot() {
  return join(HARNESS_ROOT, 'analysis', 'explanations')
}

/** Curated presentation projects. */
export function curatedPresentationsRoot() {
  return join(HARNESS_ROOT, 'analysis', 'presentations')
}

/**
 * Base of the runtime store: `<harness>/analysis/runtime/` by default
 * (gitignored — normal use never dirties the tracked harness tree), or the
 * legacy COMPILER_DEV_EXPLAIN_DIR override (compatibility: the override
 * replaces the runtime explanations root, exactly like before).
 */
export function runtimeBase() {
  const override = process.env.COMPILER_DEV_EXPLAIN_DIR
  if (override !== undefined && override !== '') return resolve(dirname(override))
  return join(HARNESS_ROOT, 'analysis', 'runtime')
}

/** Runtime explanation bundles, partitioned by analyzed repository. */
export function runtimeExplanationsRoot() {
  const override = process.env.COMPILER_DEV_EXPLAIN_DIR
  if (override !== undefined && override !== '') return resolve(override)
  return join(HARNESS_ROOT, 'analysis', 'runtime', 'explanations')
}

export function runtimePresentationsRoot(repoSlug) {
  return join(runtimeBase(), 'presentations', repoSlug)
}

export function runsRoot(repoSlug) {
  return join(runtimeBase(), 'runs', repoSlug)
}

/** Path-safe repository key for runtime-store partitioning. */
export function repoSlugFor(repoRoot) {
  return slugify(basename(resolve(repoRoot))) || 'repo'
}

/** Where new normal-use bundles go for a target repository (runtime store). */
export function runtimeBundleRootFor(repoRoot) {
  return join(runtimeExplanationsRoot(), repoSlugFor(repoRoot))
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact Catalog (derived — never persisted, never a database)
// ─────────────────────────────────────────────────────────────────────────────

function listBundleDirs(root, depth) {
  if (!root || !existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    let isDir = false
    try { isDir = readdirSync(dir).length >= 0 } catch { isDir = false }
    if (!isDir) continue
    if (existsSync(join(dir, 'subject.json')) || existsSync(join(dir, 'dossier.json'))) {
      out.push(dir)
    } else if (depth > 0) {
      out.push(...listBundleDirs(dir, depth - 1))
    }
  }
  return out
}

function loadPresentationManifest(projectDir) {
  const path = join(projectDir, 'presentation-manifest.json')
  if (!existsSync(path)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    return { path, project_dir: projectDir, manifest }
  } catch {
    return { path, project_dir: projectDir, manifest: undefined, error: 'invalid JSON' }
  }
}

function listPresentationProjects(root, depth = 2) {
  if (!root || !existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    if (existsSync(join(dir, 'presentation-manifest.json'))) {
      const loaded = loadPresentationManifest(dir)
      if (loaded) out.push(loaded)
    } else if (depth > 0) {
      try { if (readdirSync(dir).length >= 0) out.push(...listPresentationProjects(dir, depth - 1)) } catch { /* not a dir */ }
    }
  }
  return out
}

function canonicalIdsFor(bundle) {
  const ids = []
  const passArg = bundle.dossier?.extensions?.pass?.pass_arg
  if (typeof passArg === 'string' && passArg.trim() !== '') ids.push(passArg.trim())
  if (Array.isArray(passArg)) ids.push(...passArg.filter((a) => typeof a === 'string' && a.trim() !== '').map((a) => a.trim()))
  return [...new Set(ids)]
}

/**
 * Build the catalog fresh from the source-of-truth artifacts: curated
 * (`analysis/explanations/`) + runtime store roots. Entries carry the §6
 * fields; readiness and freshness are RECOMPUTED from the artifacts, never
 * trusted from a stored verdict.
 */
export function buildCatalog({ repoRoot } = {}) {
  const requestedRoot = repoRoot ? resolve(repoRoot) : undefined
  const bundles = []
  const errors = []
  const origins = [
    ['curated', curatedExplanationsRoot(), 1],
    ['runtime', runtimeExplanationsRoot(), 2],
  ]
  for (const [origin, root, depth] of origins) {
    for (const dir of listBundleDirs(root, depth)) {
      const entry = scanBundleEntry(dir, origin, requestedRoot)
      bundles.push(entry)
      if (entry.error) errors.push(`${entry.bundle_id}: ${entry.error}`)
    }
  }
  const presentations = [
    ...listPresentationProjects(curatedPresentationsRoot(), 1),
    ...listPresentationProjects(join(runtimeBase(), 'presentations'), 2),
  ]
  for (const entry of bundles) {
    entry.presentation = presentationStateForBundle(entry, presentations)
  }
  return {
    ok: true,
    driver: ORCHESTRATE_DRIVER_VERSION,
    repository: requestedRoot ? basename(requestedRoot) : undefined,
    head: requestedRoot ? repositoryProvenance(requestedRoot).head : undefined,
    roots: { curated: curatedExplanationsRoot(), runtime: runtimeExplanationsRoot() },
    bundles,
    presentations: presentations.map((p) => ({ project_dir: p.project_dir, manifest_path: p.path, error: p.error })),
    errors,
    built_at: new Date().toISOString(),
  }
}

function scanBundleEntry(dir, origin, requestedRoot) {
  const entry = {
    bundle_id: basename(dir),
    bundle_path: dir,
    artifact_origin: origin,
    subject_id: undefined, subject_type: undefined, name: undefined,
    repository: undefined, repository_path: undefined, head: undefined,
    depth: undefined, readiness: 'unknown', freshness: { state: 'unknown', reasons: [] },
    is_composition: false, child_subject_ids: [], handoff_present: false,
    doc_present: false, canonical_ids: [], analyzed_at: undefined,
    error: undefined,
  }
  // Raw-file presence first: an unreadable artifact is catalog-visible and
  // classified BLOCKED later, not silently skipped.
  const present = ARTIFACT_FILES.filter((f) => existsSync(join(dir, f)))
  entry.artifacts_present = present
  entry.handoff_present = present.includes('handoff.json')
  entry.is_composition = present.includes('composition.json')
  entry.doc_present = existsSync(join(dir, 'explanation.md')) || existsSync(join(dir, 'system-story.md'))
  // Metadata extraction is independent of full-bundle validity: a corrupt
  // dossier must still resolve to its subject (→ BLOCKED/REFRESH), while a
  // corrupt subject.json leaves the entry anonymous (→ treated as missing).
  try {
    const subject = JSON.parse(readFileSync(join(dir, 'subject.json'), 'utf8'))
    entry.subject_id = subject.subject_id
    entry.subject_type = subject.subject_type
    entry.name = subject.name
    entry.repository = subject.provenance?.repository || subject.repository
    entry.repository_path = subject.provenance?.repository_path || subject.repository_path
    entry.head = subject.provenance?.head
    entry.analyzed_at = subject.provenance?.analyzed_at
  } catch { /* subject.json missing or unreadable — metadata stays undefined */ }
  const load = loadBundle(dir)
  if (!load.ok) { entry.error = load.error; return entry }
  const bundle = load.bundle
  const subject = bundle.subject
  if (subject) {
    entry.subject_id = subject.subject_id
    entry.subject_type = subject.subject_type
    entry.name = subject.name
    entry.repository = subject.provenance?.repository || subject.repository
    entry.repository_path = subject.provenance?.repository_path || subject.repository_path
    entry.head = subject.provenance?.head
    entry.analyzed_at = subject.provenance?.analyzed_at
  } else if (bundle.dossier) {
    entry.subject_id = bundle.dossier.subject_id
    entry.subject_type = bundle.dossier.subject_type
    entry.depth = bundle.dossier.depth
  }
  entry.depth = bundle.dossier?.depth || entry.depth
  entry.canonical_ids = canonicalIdsFor(bundle)
  if (bundle.composition) {
    entry.child_subject_ids = (bundle.composition.components || [])
      .filter((c) => c && isNonemptyString(c.child_subject_id))
      .map((c) => c.child_subject_id)
  }
  // Readiness recomputed (imports resolved for compositions).
  let imports = []
  if (bundle.composition) {
    const resolved = resolveCompositionImports(dir)
    if (resolved.ok) imports = resolved.imports
    else entry.freshness.reasons.push(...resolved.errors.slice(0, 3).map((e) => `import: ${e}`))
  }
  const readiness = computeReadiness({
    subject: bundle.subject, evidence: bundle.evidence, dossier: bundle.dossier,
    handoff: bundle.handoff, readiness: bundle.readiness, composition: bundle.composition,
  }, { depth: bundle.dossier?.depth, imports })
  entry.readiness = readiness.verdict
  // Freshness evaluated against the bundle's own analyzed repository
  // (falling back to the requested repo root when unrecorded).
  const staleRoot = entry.repository_path || requestedRoot
  const stale = stalenessForBundle(dir, staleRoot)
  if (!stale.ok) {
    entry.freshness = { state: 'unknown', reasons: [stale.error] }
  } else if (stale.staleness.stale) {
    entry.freshness = {
      state: 'stale',
      reasons: [
        ...(stale.staleness.head_stale ? [`head drift: analyzed at ${String(stale.staleness.head_at_analysis).slice(0, 12)}, repository now at ${String(stale.staleness.head_now).slice(0, 12)}`] : []),
        ...stale.staleness.stale_files.map((f) => `source changed: ${f}`),
        ...stale.staleness.composition?.reasons || [],
      ].slice(0, 6),
    }
  } else {
    entry.freshness = { state: 'fresh', reasons: [] }
  }
  return entry
}

function isNonemptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * Deterministic presentation state for one bundle: find the presentation
 * project whose manifest consumed THIS bundle and compare the recorded
 * handoff (and composition) hashes with the current artifacts.
 */
export function presentationStateForBundle(entry, presentations) {
  const list = presentations || []
  const matches = list.filter((p) => {
    if (!p.manifest) return false
    const input = p.manifest.input || {}
    if (input.bundle_id === entry.bundle_id) return true
    if (isNonemptyString(input.bundle_dir) && resolve(input.bundle_dir) === resolve(entry.bundle_path)) return true
    return false
  })
  if (matches.length === 0) return { present: false }
  // Deterministic selection among manifests of the same bundle: newest mtime
  // is unstable — prefer the one whose project dir sorts last is equally
  // arbitrary. Same-bundle duplicate manifests are a consumer-side anomaly;
  // report all candidates and pick the hash-matching one when exactly one
  // matches, else AMBIGUOUS for the caller.
  const withHash = matches.map((p) => {
    const input = p.manifest.input || {}
    let handoff_hash_match = false
    try { handoff_hash_match = isNonemptyString(input.handoff_sha256) && input.handoff_sha256 === sha256File(join(entry.bundle_path, 'handoff.json')) } catch { handoff_hash_match = false }
    let composition_hash_match
    if (entry.is_composition && isNonemptyString(input.composition_sha256)) {
      try { composition_hash_match = input.composition_sha256 === sha256File(join(entry.bundle_path, 'composition.json')) } catch { composition_hash_match = false }
    }
    return { project_dir: p.project_dir, manifest_path: p.path, handoff_hash_match, composition_hash_match }
  })
  if (withHash.length === 1) return { present: true, ...withHash[0] }
  const hashMatches = withHash.filter((w) => w.handoff_hash_match)
  if (hashMatches.length === 1) return { present: true, ambiguous_manifests: withHash.length, ...hashMatches[0] }
  return { present: true, ambiguous: true, candidates: withHash }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject resolution (deterministic keys only — no silent fuzzy matching)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Separator- and case-insensitive condensed form: still EXACT equality
 * (deterministic), so `MyVectorPass` and `my-vector-pass` style spellings of
 * the same identifier match without any fuzzy guessing. */
function condenseName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function bundleMatchesQuery(entry, query) {
  const q = String(query).trim()
  if (q === '') return []
  const keys = []
  if (entry.subject_id === q) keys.push('subject_id')
  if (entry.name === q) keys.push('name')
  if (isNonemptyString(entry.subject_id) && normalizeName(entry.subject_id) === normalizeName(q)) keys.push('normalized_subject_id')
  if (isNonemptyString(entry.name) && normalizeName(entry.name) === normalizeName(q)) keys.push('normalized_name')
  if (isNonemptyString(entry.subject_id) && condenseName(entry.subject_id) === condenseName(q) && condenseName(q) !== '') keys.push('condensed_subject_id')
  if (isNonemptyString(entry.name) && condenseName(entry.name) === condenseName(q) && condenseName(q) !== '') keys.push('condensed_name')
  for (const id of entry.canonical_ids || []) if (id === q) keys.push('canonical_id')
  return keys
}

/**
 * Resolve user subject strings against the catalog for one repository.
 * Deterministic keys: subject_id, exact name, normalized name, and
 * type-specific canonical ids already recorded in the artifact.
 * Multiple DISTINCT subject identities → AMBIGUOUS (candidates returned for
 * the agent to disambiguate with repository evidence — never auto-picked).
 * No deterministic match → UNRESOLVED (planner turns this into CREATE).
 */
export function resolveSubjects(queries, catalog, { repository } = {}) {
  const repoName = repository || catalog.repository
  // Repository scoping: a bundle analyzed in another repository is a
  // different subject namespace — only same-repo bundles are candidates.
  const scoped = catalog.bundles.filter((b) => b.repository === undefined || b.repository === repoName)
  return queries.map((raw) => {
    const query = String(raw).trim()
    const matched = []
    for (const entry of scoped) {
      const keys = bundleMatchesQuery(entry, query)
      if (keys.length > 0) matched.push({ entry, keys })
    }
    const identities = [...new Set(matched.map((m) => m.entry.subject_id || m.entry.bundle_id))]
    if (matched.length === 0) {
      return { query, status: 'UNRESOLVED', candidates: [], reason: 'no bundle in the catalog matches any deterministic key (subject id, name, normalized name, canonical id)' }
    }
    if (identities.length > 1) {
      return {
        query, status: 'AMBIGUOUS',
        candidates: matched.map((m) => ({ bundle_id: m.entry.bundle_id, bundle_path: m.entry.bundle_path, subject_id: m.entry.subject_id, subject_type: m.entry.subject_type, name: m.entry.name, matched_by: m.keys, readiness: m.entry.readiness, freshness: m.entry.freshness.state, depth: m.entry.depth })),
        reason: `query matches ${identities.length} distinct subjects (${identities.join(', ')}) — explicit disambiguation required, never auto-selected`,
      }
    }
    return {
      query, status: 'RESOLVED', subject_id: identities[0],
      versions: matched.map((m) => ({ entry: m.entry, matched_by: m.keys })),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle classification (REUSE / REFRESH / CREATE / AMBIGUOUS / BLOCKED)
// ─────────────────────────────────────────────────────────────────────────────

function depthCompatible(existingDepth, requestedDepth) {
  return (DEPTH_RANK[existingDepth] ?? -1) >= (DEPTH_RANK[requestedDepth] ?? 1)
}

/**
 * Classify one resolved subject against the requested depth/repo/HEAD.
 * REUSE: READY + FRESH + compatible depth + same repository (+ HEAD, implied
 * by freshness). REFRESH: bundle exists but stale / HEAD drift / depth too
 * shallow / not ready. CREATE: nothing usable. BLOCKED: artifacts unreadable.
 */
export function classifySubject(resolution, { requestedDepth, repository, head }) {
  if (resolution.status === 'AMBIGUOUS') {
    return { action: 'AMBIGUOUS', reasons: [resolution.reason], candidates: resolution.candidates, rejected: [] }
  }
  if (resolution.status === 'UNRESOLVED') {
    return { action: 'CREATE', reasons: [resolution.reason], rejected: [] }
  }
  const versions = resolution.versions || []
  const unreadable = versions.filter((v) => v.entry.error)
  if (versions.length > 0 && unreadable.length === versions.length) {
    return { action: 'BLOCKED', reasons: unreadable.map((v) => `${v.entry.bundle_id}: ${v.entry.error}`), rejected: [] }
  }
  const eligible = []
  const rejected = []
  for (const { entry, matched_by } of versions) {
    if (entry.error) { rejected.push(rej(entry, `artifacts unreadable: ${entry.error}`, matched_by)); continue }
    if (entry.repository !== undefined && entry.repository !== repository) { rejected.push(rej(entry, `repository mismatch (bundle: ${entry.repository}, request: ${repository})`, matched_by)); continue }
    if (entry.freshness.state !== 'fresh') { rejected.push(rej(entry, `not fresh: ${entry.freshness.reasons.join('; ') || 'unknown'}`, matched_by)); continue }
    if (entry.readiness !== 'ready') { rejected.push(rej(entry, `not READY (readiness: ${entry.readiness})`, matched_by)); continue }
    if (!depthCompatible(entry.depth, requestedDepth)) { rejected.push(rej(entry, `depth ${entry.depth} is shallower than requested ${requestedDepth}`, matched_by)); continue }
    eligible.push({ entry, matched_by })
  }
  if (eligible.length > 0) {
    // Deterministic selection among versions of the SAME subject: highest
    // compatible depth, then newest analyzed_at. Selection reason recorded;
    // every other version recorded as rejected with its reason (§37).
    const sorted = [...eligible].sort((a, b) =>
      (DEPTH_RANK[b.entry.depth] ?? -1) - (DEPTH_RANK[a.entry.depth] ?? -1)
      || String(b.entry.analyzed_at || '').localeCompare(String(a.entry.analyzed_at || '')))
    const selected = sorted[0]
    return {
      action: 'REUSE',
      reasons: [`READY + FRESH + depth ${selected.entry.depth} covers requested ${requestedDepth}`],
      selected: bundleRef(selected.entry),
      rejected: sorted.slice(1).map((s) => rej(s.entry, 'an equally or more usable version of the same subject was selected (higher depth / newer analysis)', s.matched_by)),
    }
  }
  return {
    action: 'REFRESH',
    reasons: versions.length === 0
      ? ['subject recorded in the run but no bundle evaluated']
      : rejected.map((r) => `${r.bundle_id}: ${r.reason}`),
    rejected,
  }
}

function bundleRef(entry) {
  return {
    bundle_id: entry.bundle_id, bundle_path: entry.bundle_path, subject_id: entry.subject_id,
    subject_type: entry.subject_type, depth: entry.depth, readiness: entry.readiness,
    freshness: entry.freshness.state, head: entry.head, artifact_origin: entry.artifact_origin,
  }
}

function rej(entry, reason, matched_by) {
  return { bundle_id: entry.bundle_id, bundle_path: entry.bundle_path, subject_id: entry.subject_id, reason, matched_by }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition reuse (§28/§29) — component set identity, repo, HEAD, depth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an existing composition bundle whose requested component set is
 * IDENTICAL to the requested subject identities (A+B+C → A+B+C+D forces a
 * recompose), same repository, recursively fresh, and deep enough.
 */
export function findReusableComposition(catalog, requestedSubjectIds, { depth, repository, head } = {}) {
  const wanted = [...new Set(requestedSubjectIds)].sort()
  const candidates = catalog.bundles.filter((b) => b.is_composition && !b.error)
  const eligible = []
  const rejected = []
  for (const entry of candidates) {
    const childIds = [...new Set(entry.child_subject_ids)].sort()
    if (childIds.length === 0) { rejected.push(rej(entry, 'composition records no child subject ids', [])); continue }
    if (JSON.stringify(childIds) !== JSON.stringify(wanted)) { rejected.push(rej(entry, `component set differs: composition has [${childIds.join(', ')}], request is [${wanted.join(', ')}]`, [])); continue }
    if (entry.repository !== undefined && entry.repository !== repository) { rejected.push(rej(entry, `repository mismatch (composition: ${entry.repository}, request: ${repository})`, [])); continue }
    if (entry.readiness !== 'ready') { rejected.push(rej(entry, `system bundle not READY (readiness: ${entry.readiness})`, [])); continue }
    if (entry.freshness.state !== 'fresh') { rejected.push(rej(entry, `not fresh: ${entry.freshness.reasons.join('; ') || 'unknown'}`, [])); continue }
    if (depth && !depthCompatible(entry.depth, depth)) { rejected.push(rej(entry, `depth ${entry.depth} is shallower than requested ${depth}`, [])); continue }
    eligible.push(entry)
  }
  if (eligible.length === 0) return { action: 'COMPOSE', reasons: ['no existing composition matches the requested component set / repository / freshness / depth'], rejected }
  const sorted = [...eligible].sort((a, b) => String(b.analyzed_at || '').localeCompare(String(a.analyzed_at || '')))
  const selected = sorted[0]
  return {
    action: 'REUSE_COMPOSITION',
    reasons: [`existing system bundle ${selected.bundle_id} matches the requested component set at ${selected.depth} depth and is recursively fresh`],
    selected: bundleRef(selected),
    rejected: sorted.slice(1).map((s) => rej(s, 'another equally usable composition was selected (newer analysis)', [])),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ExplanationRun — request-level coordination state (execution provenance)
// ─────────────────────────────────────────────────────────────────────────────

function newRunId() {
  return `run-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(16).slice(2, 10)}`
}

function requestSignature({ repository, subjects, depth, outputs }) {
  return JSON.stringify({
    repository,
    subjects: [...subjects].map((s) => normalizeName(s)).sort(),
    depth,
    outputs: [...outputs].sort(),
  })
}

function loadRunFile(path) {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

export function loadRun({ repoRoot, runId }) {
  const slug = repoSlugFor(repoRoot)
  if (runId) {
    const path = join(runsRoot(slug), `${runId}.json`)
    const run = loadRunFile(path)
    if (!run) return { ok: false, error: `run not found: ${path}` }
    return { ok: true, run, path }
  }
  const root = runsRoot(slug)
  if (!existsSync(root)) return { ok: false, error: `no runs recorded for repository ${slug} — start one with run-plan` }
  const files = readdirSync(root).filter((f) => f.endsWith('.json')).sort()
  for (const f of [...files].reverse()) {
    const run = loadRunFile(join(root, f))
    if (run && run.state !== 'complete') return { ok: true, run, path: join(root, f) }
  }
  const last = files[files.length - 1]
  if (last) {
    const run = loadRunFile(join(root, last))
    if (run) return { ok: true, run, path: join(root, last) }
  }
  return { ok: false, error: `no runs recorded for repository ${slug}` }
}

function saveRun(run, path) {
  mkdirSync(dirname(path), { recursive: true })
  run.updated_at = new Date().toISOString()
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`)
  return path
}

/**
 * Plan (or resume) an explanation run: request → catalog → resolution →
 * reuse decisions → execution DAG. Idempotent: an OPEN run with the same
 * request signature (repository + normalized subjects + depth + outputs) is
 * resumed instead of duplicated; identical bundles are REUSEd, never
 * re-created.
 */
export function planRun(args) {
  const subjects = (args.subjects || []).map((s) => String(s).trim()).filter(Boolean)
  const errors = []
  if (subjects.length === 0) errors.push('subjects must be a non-empty array of subject names')
  const depth = args.depth || 'standard'
  if (!DEPTHS.includes(depth)) errors.push(`depth must be one of ${DEPTHS}`)
  const outputs = args.outputs && args.outputs.length > 0 ? args.outputs : [...DEFAULT_OUTPUTS]
  for (const o of outputs) if (!OUTPUT_KINDS.includes(o)) errors.push(`outputs must be chosen from ${OUTPUT_KINDS} (got ${o})`)
  const repoRoot = resolve(args.repo_root ?? args.repoRoot ?? process.cwd())
  if (errors.length > 0) return { ok: false, errors }

  const provenance = repositoryProvenance(repoRoot)
  const repository = provenance.repository
  const slug = repoSlugFor(repoRoot)
  const signature = requestSignature({ repository, subjects, depth, outputs })

  // Resume: same signature → same run (coordination state, not duplicate work).
  let run
  let runPath
  let resumed = false
  if (args.run_id) {
    const loaded = loadRun({ repoRoot, runId: args.run_id })
    if (!loaded.ok) return loaded
    run = loaded.run
    runPath = loaded.path
    resumed = true
  } else {
    const root = runsRoot(slug)
    if (existsSync(root)) {
      for (const f of readdirSync(root).filter((f) => f.endsWith('.json')).sort().reverse()) {
        const candidate = loadRunFile(join(root, f))
        if (candidate && candidate.state !== 'complete' && candidate.request_signature === signature) {
          run = candidate
          runPath = join(root, f)
          resumed = true
          break
        }
      }
    }
  }

  const catalog = buildCatalog({ repoRoot })
  const resolutions = resolveSubjects(subjects, catalog, { repository })

  if (!resumed) {
    const runId = newRunId()
    runPath = join(runsRoot(slug), `${runId}.json`)
    const nodes = []
    for (const resolution of resolutions) {
      const classification = classifySubject(resolution, { requestedDepth: depth, repository, head: provenance.head })
      nodes.push({
        id: `subject:${normalizeName(resolution.query)}`,
        kind: 'subject',
        query: resolution.query,
        action: classification.action,
        deps: [],
        parallelizable: ['CREATE', 'REFRESH'].includes(classification.action),
        reasons: classification.reasons,
        resolution: resolution.status === 'RESOLVED'
          ? { status: resolution.status, subject_id: resolution.subject_id }
          : { status: resolution.status, candidates: resolution.candidates || [] },
        rejected: classification.rejected,
        artifact_refs: classification.selected ? { bundle: classification.selected.bundle_path } : {},
      })
    }
    const multi = subjects.length > 1
    const needsComposition = multi && (outputs.includes('system_story') || outputs.includes('presentation'))
    if (needsComposition) {
      const resolvedIds = resolutions.map((r) => r.status === 'RESOLVED' ? r.subject_id : normalizeName(r.query))
      const ambig = resolutions.filter((r) => r.status === 'AMBIGUOUS')
      if (ambig.length > 0) {
        nodes.push({
          id: 'composition', kind: 'composition', action: 'BLOCKED', deps: nodes.map((n) => n.id),
          reasons: [`subject resolution ambiguous: ${ambig.map((a) => a.query).join(', ')} — resolve subjects before composing`],
          artifact_refs: {},
        })
      } else {
        const compReuse = findReusableComposition(catalog, resolvedIds, { depth, repository, head: provenance.head })
        nodes.push({
          id: 'composition', kind: 'composition', action: compReuse.action, deps: nodes.map((n) => n.id),
          parallelizable: false,
          reasons: compReuse.reasons,
          rejected: compReuse.rejected,
          artifact_refs: compReuse.selected ? { bundle: compReuse.selected.bundle_path } : {},
        })
      }
    }
    const compositionNodeId = needsComposition ? 'composition' : undefined
    const presentationDep = compositionNodeId || (nodes.length === 1 ? nodes[0].id : undefined)
    if (outputs.includes('documents')) {
      for (const n of nodes.filter((n) => n.kind === 'subject')) {
        nodes.push({
          id: `doc:${n.id.slice('subject:'.length)}`, kind: 'document', action: 'RENDER',
          deps: [n.id], artifact_refs: {}, reasons: ['derived human-readable document for the requested subject'],
        })
      }
    }
    if (needsComposition && outputs.includes('system_story')) {
      nodes.push({
        id: 'doc:system', kind: 'document', action: 'RENDER', deps: ['composition'],
        artifact_refs: {}, reasons: ['derived system-story document for the requested component set'],
      })
    }
    if (outputs.includes('presentation') && presentationDep) {
      // Presentation reuse is decided against the target bundle's handoff
      // hash (§30); when the target will be (re)built, status re-derives
      // reuse if the recomposed handoff is byte-identical.
      nodes.push({
        id: 'presentation', kind: 'presentation', action: 'PRESENT', deps: [presentationDep],
        parallelizable: false, reasons: ['presentation is derived from a READY+FRESH handoff of the target bundle'],
        artifact_refs: {},
      })
    }
    run = {
      artifact: 'explanation_run',
      schema_version: 1,
      driver: ORCHESTRATE_DRIVER_VERSION,
      run_id: runId,
      repository,
      repository_path: repoRoot,
      head: provenance.head,
      request: { subjects, desired_depth: depth, outputs },
      request_signature: signature,
      nodes,
      state: 'in_progress',
      observed: {},
      metrics: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  }

  const status = deriveRunStatus(run, { catalog, resolutions, depth, repository, repoRoot })
  run.observed = status.observed
  run.metrics = status.metrics
  run.state = status.state
  run.head = catalog.head || run.head
  const savedPath = saveRun(run, runPath)
  return {
    ok: true,
    driver: ORCHESTRATE_DRIVER_VERSION,
    run_id: run.run_id,
    run_path: savedPath,
    resumed,
    repository: run.repository,
    head: run.head,
    request: run.request,
    state: run.state,
    nodes: status.nodes,
    next_actions: status.next_actions,
    work_packets: status.work_packets,
    metrics: run.metrics,
    ambiguous: resolutions.filter((r) => r.status === 'AMBIGUOUS').map((r) => ({ query: r.query, candidates: r.candidates, reason: r.reason })),
  }
}

/**
 * Derived run status (§18): every node's observed state is recomputed from
 * the artifacts (readiness + freshness + doc currency + presentation hash);
 * run.json stores only coordination facts. Emits NEXT_ACTIONS and compact
 * work packets for CREATE/REFRESH subjects (§21).
 */
export function runStatus({ repoRoot, runId } = {}) {
  const root = resolve(repoRoot || process.cwd())
  const loaded = loadRun({ repoRoot: root, runId })
  if (!loaded.ok) return loaded
  const run = loaded.run
  const catalog = buildCatalog({ repoRoot: root })
  const resolutions = resolveSubjects(run.request.subjects, catalog, { repository: run.repository })
  const status = deriveRunStatus(run, { catalog, resolutions, depth: run.request.desired_depth, repository: run.repository, repoRoot: root })
  run.observed = status.observed
  run.metrics = status.metrics
  run.state = status.state
  run.head = catalog.head || run.head
  saveRun(run, loaded.path)
  return {
    ok: true,
    driver: ORCHESTRATE_DRIVER_VERSION,
    run_id: run.run_id,
    run_path: loaded.path,
    repository: run.repository,
    head: run.head,
    request: run.request,
    state: run.state,
    nodes: status.nodes,
    next_actions: status.next_actions,
    work_packets: status.work_packets,
    blockers: status.blockers,
    metrics: run.metrics,
    ambiguous: resolutions.filter((r) => r.status === 'AMBIGUOUS').map((r) => ({ query: r.query, candidates: r.candidates, reason: r.reason })),
  }
}

/** Reclassify a resolved subject NOW (deterministic re-check, §24). */
function observedSubjectState(node, { catalog, depth, repository }) {
  const resolution = resolveSubjects([node.query], catalog, { repository })[0]
  const classification = classifySubject(resolution, { requestedDepth: depth, repository })
  if (classification.action === 'AMBIGUOUS') {
    return { state: 'needs_decision', action: classification.action, reasons: classification.reasons, candidates: resolution.candidates }
  }
  if (classification.action === 'BLOCKED') {
    return { state: 'blocked', action: classification.action, reasons: classification.reasons }
  }
  if (classification.action === 'REUSE') {
    const taken = node.action === 'REUSE' ? 'reused' : (node.action === 'CREATE' ? 'created' : 'refreshed')
    return { state: 'done', action: classification.action, taken, bundle: classification.selected, reasons: classification.reasons }
  }
  // REFRESH / CREATE still outstanding — but if a bundle at the target path
  // is now READY+FRESH the child work is done (agent may have written a new
  // bundle the resolver now resolves).
  const reasons = classification.reasons
  const resolvable = resolution.status === 'RESOLVED'
  return {
    state: 'pending',
    action: classification.action,
    reasons: resolvable ? reasons : ['no matching bundle yet — create one'],
    subject_id: resolution.status === 'RESOLVED' ? resolution.subject_id : undefined,
  }
}

function observedCompositionState(node, { catalog, depth, repository, requestedSubjectIds }) {
  if (node.action === 'BLOCKED') return { state: 'blocked', reasons: node.reasons }
  const reuse = findReusableComposition(catalog, requestedSubjectIds, { depth, repository })
  if (reuse.action === 'REUSE_COMPOSITION') {
    const composition = loadBundle(reuse.selected.bundle_path)
    const conflictsOpen = (composition.bundle?.composition?.conflicts || []).filter((c) => c && c.status === 'open')
    if (conflictsOpen.length > 0) {
      return { state: 'blocked', reasons: conflictsOpen.map((c) => `open composition conflict ${c.conflict_id}: ${c.description}`), composition: reuse.selected }
    }
    const taken = node.action === 'REUSE_COMPOSITION' ? 'reused' : 'rebuilt'
    return { state: 'done', action: reuse.action, taken, composition: reuse.selected, reasons: reuse.reasons }
  }
  // A matching component set exists but was rejected as not READY: an open
  // composition conflict blocks the run (§54) — never narrate past it.
  const conflicted = (reuse.rejected || [])
    .filter((r) => typeof r.reason === 'string' && r.reason.startsWith('system bundle not READY'))
    .map((r) => ({ r, load: loadBundle(r.bundle_path) }))
    .filter((x) => x.load.ok && (x.load.bundle.composition?.conflicts || []).some((c) => c && c.status === 'open'))
  if (conflicted.length > 0) {
    return {
      state: 'blocked',
      reasons: conflicted.flatMap((x) => x.load.bundle.composition.conflicts
        .filter((c) => c.status === 'open')
        .map((c) => `open composition conflict ${c.conflict_id} in ${x.r.bundle_id}: ${c.description}`)),
    }
  }
  return { state: 'pending', action: 'COMPOSE', reasons: reuse.reasons, rejected: reuse.rejected }
}

/**
 * Where a derived document lands: runtime-origin bundles keep their derived
 * view alongside the bundle; CURATED bundles are never written to by normal
 * runs (no dirtying of the tracked harness tree) — their runtime documents
 * render into the runtime store under the analyzed repository.
 */
function documentPathFor(entry, docName, repoRoot) {
  if (entry.artifact_origin === 'curated') {
    return join(runtimeBase(), 'documents', repoSlugFor(repoRoot), entry.bundle_id, docName)
  }
  return join(entry.bundle_path, docName)
}

function renderDocumentFor(node, run, { observedNodes }) {
  if (node.id === 'doc:system') {
    const compRef = observedNodes?.composition?.composition
    if (!compRef?.bundle_path) return { ok: false, error: 'composition bundle not resolved yet' }
    const outPath = documentPathFor(compRef, 'system-story.md', run.repository_path)
    const out = renderSystemStory(compRef.bundle_path, { out: outPath })
    if (!out.ok) return out
    // renderSystemStory writes the derived view itself; read it back so the
    // caller can compare currency uniformly.
    const markdown = existsSync(out.rendered) ? readFileSync(out.rendered, 'utf8') : undefined
    return { ok: true, doc_path: out.rendered, markdown, renderer: 'compose-render (system-story.md)' }
  }
  const subjectNodeId = `subject:${node.id.slice('doc:'.length)}`
  const bundleRef = observedNodes?.[subjectNodeId]?.bundle
  if (!bundleRef?.bundle_path) return { ok: false, error: 'subject bundle not ready' }
  const outPath = documentPathFor(bundleRef, 'explanation.md', run.repository_path)
  return renderExplanation(bundleRef.bundle_path, { out: outPath, write: false })
}

function observedDocumentState(node, run, { observedNodes }) {
  const rendered = renderDocumentFor(node, run, { observedNodes })
  if (!rendered.ok) return { state: 'pending', reasons: [rendered.error || 'document cannot be rendered yet'] }
  const existing = existsSync(rendered.doc_path) ? readFileSync(rendered.doc_path, 'utf8') : undefined
  const current = existing === rendered.markdown
  return {
    state: current ? 'done' : 'pending',
    taken: existing === undefined ? 'rendered' : (current ? 'already_current' : 're_rendered'),
    doc_path: rendered.doc_path,
    reasons: current ? [] : [existing === undefined ? 'document missing' : 'document out of date with the JSON artifacts'],
  }
}

/**
 * Phase T5: run the deck project's own deterministic checker
 * (scripts/check_project.py — structure, manifest coverage, Quarto content
 * semantics, diagram geometry). Purely mechanical, bounded output; the check
 * is part of the presentation node's truth so a physically broken deck can
 * no longer count as done.
 */
function runPresentationChecker(projectDir) {
  const checker = join(projectDir, 'scripts', 'check_project.py')
  if (!existsSync(checker)) return { available: false }
  try {
    const r = spawnSync('python3', [checker], { cwd: projectDir, encoding: 'utf8', timeout: 120000 })
    if (r.status === 0) return { available: true, ok: true }
    const errs = String(r.stderr || r.stdout || '').split('\n')
      .filter((l) => l.startsWith('ERROR:')).slice(0, 5)
    return { available: true, ok: false, errors: errs.length > 0 ? errs : [`checker exited ${r.status}`] }
  } catch (e) {
    return { available: true, ok: false, errors: [`checker failed to run: ${e.message}`] }
  }
}

function observedPresentationState(node, run, { catalog }) {
  const targetNode = node.deps[0]
  const targetPath = run.observed?.nodes?.[targetNode]?.composition?.bundle_path || run.observed?.nodes?.[targetNode]?.bundle?.bundle_path
  if (!targetPath) return { state: 'pending', reasons: ['target bundle not ready'] }
  const target = catalog.bundles.find((b) => resolve(b.bundle_path) === resolve(targetPath))
  if (!target) return { state: 'pending', reasons: ['target bundle not in catalog'] }
  const presentation = target.presentation || { present: false }
  const gate = preflightHandoff(targetPath)
  if (!presentation.present) {
    return { state: 'pending', reasons: ['no presentation project consumed this bundle yet — run the presentation consumer (handoff-first)'], gate: gate.verdict }
  }
  if (presentation.ambiguous) {
    return { state: 'needs_decision', reasons: ['multiple presentation manifests consumed this bundle — pick the current deck'], candidates: presentation.candidates }
  }
  if (presentation.handoff_hash_match && gate.verdict === 'CONSUMABLE') {
    const checker = runPresentationChecker(presentation.project_dir)
    if (checker.available && !checker.ok) {
      return {
        state: 'pending',
        reasons: ['presentation checker failed — fix the deck (QMD semantics / diagram geometry), do not regenerate the story', ...checker.errors],
        presentation_dir: presentation.project_dir,
        manifest_path: presentation.manifest_path,
        gate: gate.verdict, checker: 'fail',
      }
    }
    return {
      state: 'done',
      taken: 'reused',
      presentation_dir: presentation.project_dir,
      manifest_path: presentation.manifest_path,
      gate: gate.verdict,
      checker: checker.available ? 'pass' : 'unavailable',
      reasons: [],
    }
  }
  if (gate.verdict === 'CONSUMABLE') {
    return { state: 'pending', reasons: ['handoff hash changed since the deck was generated — the deck is invalidated (§30)'], presentation_dir: presentation.project_dir, gate: gate.verdict }
  }
  return { state: 'pending', reasons: [`handoff not consumable: ${gate.verdict}`], presentation_dir: presentation.project_dir, gate: gate.verdict }
}

function deriveRunStatus(run, { catalog, resolutions, depth, repository, repoRoot }) {
  const observedNodes = {}
  const requestedSubjectIds = resolutions.map((r) => r.status === 'RESOLVED' ? r.subject_id : normalizeName(r.query))
  const nodesOut = []
  for (const node of run.nodes) {
    let observed
    if (node.kind === 'subject') observed = observedSubjectState(node, { catalog, depth, repository })
    else if (node.kind === 'composition') observed = observedCompositionState(node, { catalog, depth, repository, requestedSubjectIds })
    else if (node.kind === 'document') observed = observedDocumentState(node, run, { observedNodes })
    else if (node.kind === 'presentation') observed = observedPresentationState(node, run, { catalog })
    else observed = { state: 'pending', reasons: [`unknown node kind: ${node.kind}`] }
    observedNodes[node.id] = observed
    nodesOut.push({
      id: node.id, kind: node.kind, action: node.action, planned_action: node.action,
      query: node.query, observed_action: observed.taken, state: observed.state,
      deps: node.deps, parallelizable: node.parallelizable || false,
      bundle: observed.bundle, composition: observed.composition, doc_path: observed.doc_path,
      presentation_dir: observed.presentation_dir, gate: observed.gate, checker: observed.checker,
      reasons: observed.reasons || [], candidates: observed.candidates,
    })
  }

  // Documents whose deps are done are rendered by the driver right away —
  // rendering is deterministic and derived (like compose-render), never
  // semantic content generation.
  const nextActions = []
  for (const node of run.nodes.filter((n) => n.kind === 'document')) {
    const depsDone = node.deps.every((d) => observedNodes[d]?.state === 'done')
    if (depsDone && observedNodes[node.id]?.state === 'pending') {
      const rendered = renderDocumentFor(node, run, { observedNodes })
      if (rendered.ok) {
        const existing = existsSync(rendered.doc_path) ? readFileSync(rendered.doc_path, 'utf8') : undefined
        if (existing !== rendered.markdown) {
          mkdirSync(dirname(rendered.doc_path), { recursive: true })
          writeFileSync(rendered.doc_path, rendered.markdown)
        }
        observedNodes[node.id] = {
          state: 'done',
          taken: existing === undefined ? 'rendered' : 're_rendered',
          doc_path: rendered.doc_path, reasons: [],
        }
        const out = nodesOut.find((n) => n.id === node.id)
        out.state = 'done'
        out.observed_action = observedNodes[node.id].taken
        out.doc_path = rendered.doc_path
        out.reasons = []
      }
    }
  }

  const nodeDone = (id) => observedNodes[id]?.state === 'done'
  const pending = run.nodes.filter((n) => !nodeDone(n.id))
  const actionable = []
  for (const node of pending) {
    if (node.deps.every(nodeDone)) actionable.push(node)
  }

  const workPackets = []
  for (const node of actionable.filter((n) => n.kind === 'subject')) {
    const observed = observedNodes[node.id]
    if (observed.state === 'pending' && (node.action === 'CREATE' || node.action === 'REFRESH' || observed.action === 'CREATE' || observed.action === 'REFRESH')) {
      workPackets.push(buildWorkPacket(node, observed, { run, depth, repository, repoRoot }))
    }
  }

  const blockers = []
  for (const node of run.nodes) {
    const observed = observedNodes[node.id]
    if (observed.state === 'blocked') blockers.push({ node: node.id, reasons: observed.reasons })
    if (observed.state === 'needs_decision') blockers.push({ node: node.id, decision_required: true, reasons: observed.reasons, candidates: observed.candidates })
  }

  // Aggregate run state (§53/§54/§55).
  let state = 'in_progress'
  const subjectBlocked = run.nodes.some((n) => n.kind === 'subject' && ['blocked', 'needs_decision'].includes(observedNodes[n.id].state))
  const compBlocked = run.nodes.some((n) => n.kind === 'composition' && observedNodes[n.id].state === 'blocked')
  const presentationPendingInvalid = run.nodes.some((n) => n.kind === 'presentation' && observedNodes[n.id].state === 'pending' && (observedNodes[n.id].gate || 'CONSUMABLE') !== 'CONSUMABLE')
  if (compBlocked) state = 'blocked_at_composition'
  else if (subjectBlocked) state = 'blocked_at_child'
  else if (presentationPendingInvalid) state = 'presentation_invalid'
  else if (pending.length === 0) state = 'ready_to_finalize'

  // Metrics (§43) — derived from planned action vs observed outcome.
  const metrics = {
    subjects_total: run.nodes.filter((n) => n.kind === 'subject').length,
    reused: nodesOut.filter((n) => n.kind === 'subject' && n.observed_action === 'reused').length,
    refreshed: nodesOut.filter((n) => n.kind === 'subject' && n.observed_action === 'refreshed').length,
    created: nodesOut.filter((n) => n.kind === 'subject' && n.observed_action === 'created').length,
    ambiguous: nodesOut.filter((n) => n.kind === 'subject' && n.state === 'needs_decision').length,
    blocked: nodesOut.filter((n) => n.state === 'blocked').length,
    documents_total: run.nodes.filter((n) => n.kind === 'document').length,
    documents_done: nodesOut.filter((n) => n.kind === 'document' && n.state === 'done').length,
    composition: nodesOut.find((n) => n.kind === 'composition')?.observed_action || undefined,
    presentation: nodesOut.find((n) => n.kind === 'presentation')?.observed_action || undefined,
  }

  // NEXT_ACTIONS (§19): what the agent should do next, in dependency order.
  for (const node of actionable) {
    const observed = observedNodes[node.id]
    if (node.kind === 'subject' && observed.state === 'pending') {
      nextActions.push({
        node: node.id,
        type: node.action === 'AMBIGUOUS' || observed.state === 'needs_decision' ? 'resolve_ambiguity' : 'child_work',
        parallelizable: node.parallelizable || false,
        work_packet: workPackets.find((p) => p.node === node.id),
        reasons: observed.reasons,
      })
    } else if (node.kind === 'subject' && observed.state === 'needs_decision') {
      nextActions.push({ node: node.id, type: 'resolve_ambiguity', candidates: observed.candidates, reasons: observed.reasons })
    } else if (node.kind === 'composition') {
      nextActions.push({
        node: node.id, type: observed.action === 'REUSE_COMPOSITION' ? 'verify_composition' : 'compose',
        child_bundles: requestedSubjectIds.map((id) => catalog.bundles.find((b) => b.subject_id === id)?.bundle_path).filter(Boolean),
        reasons: observed.reasons,
      })
    } else if (node.kind === 'presentation') {
      nextActions.push({ node: node.id, type: 'present', reasons: observed.reasons, presentation_dir: observed.presentation_dir })
    } else if (node.kind === 'document') {
      nextActions.push({ node: node.id, type: 'render_document', reasons: observed.reasons })
    }
  }
  if (actionable.length === 0 && pending.length === 0) {
    nextActions.push({ node: 'finalize', type: 'finalize', reasons: ['all planned nodes verified — run run-finalize to gate the requested outputs'] })
  }

  return { observed: { nodes: observedNodes }, nodes: nodesOut, next_actions: nextActions, work_packets: workPackets, blockers, state, metrics }
}

// ─────────────────────────────────────────────────────────────────────────────
// Child work packet (§21) — compact, no conversation injection
// ─────────────────────────────────────────────────────────────────────────────

export function buildWorkPacket(node, observed, { run, depth, repository, repoRoot }) {
  const existing = observed.subject_id
    ? catalogFindSubject(catalogForWorkPacket(repoRoot), observed.subject_id)
    : undefined
  const isRefresh = node.action === 'REFRESH' || observed.action === 'REFRESH' || existing !== undefined
  return {
    node: node.id,
    subject: node.query,
    subject_type: existing?.subject_type,
    repository,
    head: run.head,
    target_bundle_root: runtimeBundleRootFor(repoRoot),
    required_depth: depth,
    why_needed: isRefresh
      ? `REFRESH: an existing bundle exists but is not reusable (${(observed.reasons || []).join('; ') || 'stale or insufficient depth'}) — update it incrementally, keep everything the unchanged sources still support`
      : 'CREATE: no usable bundle exists for this subject',
    required_outputs: [
      'teaching bundle (subject/evidence/dossier[/handoff] JSON per the Teaching Artifact Protocol)',
      ...(run.request.outputs.includes('documents') ? ['human-readable explanation.md (derived — the orchestrator renders it)'] : []),
      ...(run.request.outputs.includes('presentation') ? ['presentation handoff (presentation depth)'] : []),
    ],
    existing_artifact: existing ? { bundle_path: existing.bundle_path, depth: existing.depth, freshness: existing.freshness } : undefined,
    finish_with: 'compiler_explain readiness (record the semantic review) — the orchestrator re-verifies READY+FRESH deterministically',
  }
}

function catalogForWorkPacket(repoRoot) {
  return buildCatalog({ repoRoot })
}

function catalogFindSubject(catalog, subjectId) {
  return catalog.bundles.find((b) => b.subject_id === subjectId && !b.error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Final gate (§35) — every requested deliverable verified, then COMPLETE
// ─────────────────────────────────────────────────────────────────────────────

export function runFinalize({ repoRoot, runId } = {}) {
  const root = resolve(repoRoot || process.cwd())
  const loaded = loadRun({ repoRoot: root, runId })
  if (!loaded.ok) return loaded
  const run = loaded.run
  const catalog = buildCatalog({ repoRoot: root })
  const resolutions = resolveSubjects(run.request.subjects, catalog, { repository: run.repository })
  const status = deriveRunStatus(run, { catalog, resolutions, depth: run.request.desired_depth, repository: run.repository, repoRoot: root })
  const failures = []
  const checks = []

  const subjectNodes = run.nodes.filter((n) => n.kind === 'subject')
  for (const node of subjectNodes) {
    const observed = status.observed.nodes[node.id]
    if (observed.state === 'done') {
      checks.push({ check: `subject ${node.query}`, ok: true, detail: `READY+FRESH at ${observed.bundle.depth} depth (${observed.taken})`, bundle: observed.bundle.bundle_path })
    } else {
      failures.push(`subject ${node.query}: ${observed.state} — ${(observed.reasons || []).join('; ') || 'not verified READY+FRESH'}`)
      checks.push({ check: `subject ${node.query}`, ok: false, detail: observed.state })
    }
  }

  if (run.request.outputs.includes('documents')) {
    for (const node of run.nodes.filter((n) => n.kind === 'document')) {
      const observed = status.observed.nodes[node.id]
      const ok = observed.state === 'done' && observed.doc_path && existsSync(observed.doc_path)
      if (ok) checks.push({ check: `document ${node.id}`, ok: true, detail: 'current with the JSON artifacts', doc: observed.doc_path })
      else failures.push(`document ${node.id}: missing or out of date — ${(observed.reasons || []).join('; ')}`)
    }
  }

  if (run.request.outputs.includes('system_story') || run.nodes.some((n) => n.kind === 'composition')) {
    const compNode = run.nodes.find((n) => n.kind === 'composition')
    if (compNode) {
      const observed = status.observed.nodes[compNode.id]
      if (observed.state === 'done') checks.push({ check: 'system composition', ok: true, detail: `recursively fresh + no open conflicts (${observed.taken})`, bundle: observed.composition.bundle_path })
      else failures.push(`composition: ${observed.state} — ${(observed.reasons || []).join('; ')}`)
      const docNode = run.nodes.find((n) => n.id === 'doc:system')
      if (docNode) {
        const docObserved = status.observed.nodes[docNode.id]
        if (docObserved?.state === 'done') checks.push({ check: 'system story document', ok: true, detail: 'system story current', doc: docObserved.doc_path })
        else failures.push('system story document: missing or out of date')
      }
    } else if (run.request.outputs.includes('system_story')) {
      failures.push('system_story requested but the run has no composition node (single-subject request)')
    }
  }

  if (run.request.outputs.includes('presentation')) {
    const node = run.nodes.find((n) => n.kind === 'presentation')
    if (!node) failures.push('presentation requested but the run has no presentation node')
    else {
      const observed = status.observed.nodes[node.id]
      const gate = observed.gate
      if (observed.state === 'done' && gate === 'CONSUMABLE') {
        checks.push({ check: 'presentation', ok: true, detail: `handoff CONSUMABLE + manifest handoff hash matches (${observed.taken})`, presentation_dir: observed.presentation_dir })
      } else if (observed.state === 'pending' && gate && gate !== 'CONSUMABLE' && observed.presentation_dir) {
        failures.push(`presentation: handoff READY but the recorded deck failed the gate (${gate}) — PRESENTATION_INVALID until rebuilt`)
      } else {
        failures.push(`presentation: ${observed.state} — ${(observed.reasons || []).join('; ')}`)
      }
    }
  }

  // Aggregate state (§53/§54/§55): children first, then composition, then
  // presentation — a run never claims COMPLETE past a failed gate.
  let state = 'complete'
  if (failures.length > 0) {
    if (failures.some((f) => f.startsWith('subject '))) state = 'blocked_at_child'
    else if (failures.some((f) => f.startsWith('composition:'))) state = 'blocked_at_composition'
    else if (failures.some((f) => f.startsWith('presentation:'))) state = 'presentation_invalid'
    else state = 'blocked_at_child'
  }
  run.state = state
  run.metrics = status.metrics
  run.observed = status.observed
  saveRun(run, loaded.path)

  return {
    ok: true,
    driver: ORCHESTRATE_DRIVER_VERSION,
    run_id: run.run_id,
    state,
    complete: state === 'complete',
    checks,
    failures,
    result_summary: {
      run: state === 'complete' ? 'COMPLETE' : state.toUpperCase(),
      subjects: subjectNodes.map((n) => ({ subject: n.query, outcome: status.observed.nodes[n.id].taken || status.observed.nodes[n.id].state })),
      composition: status.metrics.composition,
      documents: `${status.metrics.documents_done}/${status.metrics.documents_total}`,
      presentation: status.metrics.presentation,
      re_analysis_avoided: status.metrics.reused,
    },
    metrics: run.metrics,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-subject human-readable renderer (§31–§33) — derived view only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render `explanation.md` from the bundle's JSON artifacts. Deterministic and
 * adaptive: sections render only when the dossier actually carries the
 * content; the type extension is rendered generically; no new claims.
 */
export function renderExplanation(bundleDir, { out, write = true } = {}) {
  const load = loadBundle(bundleDir)
  if (!load.ok) return { ok: false, error: load.error }
  const bundle = load.bundle
  const d = bundle.dossier
  if (!d) return { ok: false, error: 'no dossier.json — nothing to render' }
  const s = bundle.subject || {}
  const h = bundle.handoff || {}
  const ev = bundle.evidence || { records: [] }
  const comp = bundle.composition
  const lines = []
  const push = (...l) => lines.push(...l)
  const refList = (refs) => (refs || []).map((r) => `\`${r}\``).join(', ')

  push(`# ${d.subject_id || s.subject_id}: ${s.name || d.subject_id}`)
  push('')
  push('> Derived view rendered mechanically from the JSON artifacts in this bundle.')
  push('> The JSON artifacts (subject/evidence/dossier/handoff/readiness) are the only source of truth.')
  push('')
  push(`- Subject type: ${d.subject_type || 'n/a'}; depth: ${d.depth || 'n/a'}`)
  if (s.provenance?.repository) push(`- Repository: ${s.provenance.repository}${s.provenance.head ? ` @ ${String(s.provenance.head).slice(0, 12)}` : ''}`)
  if (s.provenance?.analyzed_at) push(`- Analyzed: ${s.provenance.analyzed_at}`)
  push(`- Bundle: \`${basename(load.dir)}\``)
  push('')

  if (d.mental_model) {
    push('## Mental model')
    push('')
    push(d.mental_model)
    push('')
  }
  if (d.need || d.responsibility || d.purpose || d.observable_outcome) {
    push('## Why this exists')
    push('')
    for (const [label, field] of [['Need', d.need], ['Responsibility', d.responsibility], ['Purpose', d.purpose], ['Observable outcome', d.observable_outcome]]) {
      if (field) push(`- **${label}:** ${field}`)
    }
    push('')
  }
  const ctx = d.system_context || {}
  if ((ctx.upstream || []).length + (ctx.triggers || []).length + (ctx.downstream || []).length > 0) {
    push('## Context')
    push('')
    for (const [label, side] of [['Triggers', ctx.triggers], ['Upstream', ctx.upstream], ['Downstream', ctx.downstream]]) {
      for (const e of side || []) {
        push(`- **${label} — ${e.entity || e.role || 'n/a'}${e.role && e.entity ? ` (${e.role})` : ''}:** ${e.interaction || ''}`)
      }
    }
    push('')
  }
  if ((d.inputs || []).length + (d.outputs || []).length + (d.contracts || []).length > 0) {
    push('## Inputs, outputs, contracts')
    push('')
    for (const [label, side] of [['Input', d.inputs], ['Output', d.outputs]]) {
      for (const e of side || []) push(`- **${label} — ${e.name || 'n/a'}:** ${e.form || ''}${e.description ? ` — ${e.description}` : ''}`)
    }
    for (const c of d.contracts || []) push(`- **Contract — ${c.name || 'n/a'}:** ${c.form || ''}${c.description ? ` — ${c.description}` : ''}`)
    push('')
  }
  if (d.mechanism) {
    push('## Mechanism')
    push('')
    if (d.mechanism.summary) push(d.mechanism.summary, '')
    for (const [i, st] of (d.mechanism.stages || []).entries()) {
      push(`${i + 1}. **${st.name}** — ${st.what}${st.where ? ` (${st.where})` : ''}`)
      if (st.key_functions?.length) push(`   - Key functions: ${st.key_functions.join(', ')}`)
      if (st.evidence_refs?.length) push(`   - Evidence: ${refList(st.evidence_refs)}`)
    }
    push('')
  }
  if (d.canonical_example) {
    push('## Canonical example')
    push('')
    push(`Provenance: ${d.canonical_example.provenance?.kind || 'n/a'} — ${d.canonical_example.provenance?.source || 'n/a'}`)
    push('')
    if (typeof d.canonical_example.initial_state === 'string') push(`Initial state: ${d.canonical_example.initial_state}`, '')
    if (d.canonical_example.inputs !== undefined) push(`Inputs: ${typeof d.canonical_example.inputs === 'string' ? d.canonical_example.inputs : JSON.stringify(d.canonical_example.inputs)}`, '')
    const stepText = (t) => {
      if (typeof t === 'string') return t
      const text = t.label ? `**${t.label}** — ${t.action || ''}`
        : t.action || t.description || t.state || t.what || ''
      const stage = t.mechanism_stage ? ` _[stage: ${t.mechanism_stage}]_` : ''
      return `${text}${t.result ? ` → ${t.result}` : ''}${stage}`
    }
    for (const [i, t] of (d.canonical_example.execution_trace || []).entries()) {
      push(`${i + 1}. ${stepText(t)}`)
    }
    for (const [i, t] of (d.canonical_example.steps || []).entries()) {
      push(`${(d.canonical_example.execution_trace || []).length + i + 1}. ${stepText(t)}`)
    }
    if (typeof d.canonical_example.result === 'string') push('', `Result: ${d.canonical_example.result}`)
    push('')
  }
  if ((d.worked_examples || []).length > 0) {
    push('## Worked examples')
    push('')
    for (const we of d.worked_examples) {
      push(`### ${we.title}`, '')
      if (we.provenance) push(`Provenance: ${we.provenance.kind} — ${we.provenance.source}`, '')
      for (const [i, t] of (we.steps || []).entries()) {
        push(`${i + 1}. ${typeof t === 'string' ? t : `${t.label ? `**${t.label}** — ` : ''}${t.action || ''}${t.result ? ` → ${t.result}` : ''}`}`)
      }
      if (typeof we.result === 'string') push('', `Result: ${we.result}`)
      push('')
    }
  }
  if ((d.state_transitions || []).length > 0) {
    push('## State transitions')
    push('')
    for (const t of d.state_transitions) {
      push(`- **${t.phase || 'phase'}:** ${t.before} → (${t.operation}) → ${t.after}${t.reason ? ` — ${t.reason}` : ''}`)
    }
    push('')
  }
  if ((d.decisions || []).length > 0) {
    push('## Decisions')
    push('')
    for (const dec of d.decisions) {
      push(`- **${dec.question}** — ${dec.condition}`)
      if (dec.reason) push(`  - ${dec.reason}`)
      push(`  - Evidence: ${refList(dec.evidence_refs)}`)
    }
    push('')
  }
  if ((d.strategies || []).length > 0 || (d.comparisons || []).length > 0) {
    push('## Strategies')
    push('')
    for (const st of d.strategies || []) {
      push(`- **${st.name || st.id || 'strategy'}:** ${st.what || st.description || ''}`)
      if (st.tradeoff) push(`  - Tradeoff: ${st.tradeoff}`)
    }
    for (const c of d.comparisons || []) {
      push(`- Comparison **${(c.compared || []).join(' vs ')}**: ${c.verdict || c.summary || ''}`)
      if (c.reason) push(`  - ${c.reason}`)
    }
    push('')
  }
  if ((d.constraints || []).length + (d.invariants || []).length + (d.assumptions || []).length > 0) {
    push('## Constraints, invariants, assumptions')
    push('')
    for (const c of d.constraints || []) push(`- Constraint: ${c.statement} (${c.status || 'n/a'})`)
    for (const i of d.invariants || []) push(`- Invariant: ${i.statement} (${i.status || 'n/a'})`)
    for (const a of d.assumptions || []) push(`- Assumption: ${a.statement} (${a.status || 'n/a'})`)
    push('')
  }
  if ((d.boundaries || []).length > 0) {
    push('## Boundaries')
    push('')
    for (const b of d.boundaries) push(`- [${b.category}] ${b.statement}`)
    push('')
  }
  if (d.placement) {
    push('## Placement')
    push('')
    if (d.placement.applicable === false) push(`Not applicable: ${d.placement.status || 'n/a'}`)
    else {
      for (const key of ['why_here', 'why_not_earlier', 'why_not_later']) {
        if (d.placement[key]) push(`- **${key}:** ${d.placement[key]}`)
      }
    }
    push('')
  }
  if (d.ownership || d.complexity) {
    push('## Ownership and complexity')
    push('')
    if (d.ownership) push(`- Ownership: ${typeof d.ownership === 'string' ? d.ownership : JSON.stringify(d.ownership)}`)
    if (d.complexity) push(`- Complexity: ${typeof d.complexity === 'string' ? d.complexity : JSON.stringify(d.complexity)}`)
    push('')
  }
  if ((d.key_takeaways || []).length > 0) {
    push('## Key takeaways')
    push('')
    for (const t of d.key_takeaways) push(`- ${t}`)
    push('')
  }
  if ((d.risks || []).length > 0) {
    push('## Risks')
    push('')
    for (const r of d.risks) push(`- ${r.statement || r}${r.status ? ` (${r.status})` : ''}`)
    push('')
  }
  if (h.storyline?.length > 0) {
    push('## How to tell it (handoff storyline)')
    push('')
    for (const step of h.storyline) push(`${step.position ?? ''}. **${step.role}** — ${step.claim}`)
    push('')
  }
  const ext = d.extensions?.[d.subject_type]
  if (ext && Object.keys(ext).length > 0) {
    push(`## Type extension: ${d.subject_type}`)
    push('')
    for (const [key, value] of Object.entries(ext)) {
      if (value === undefined) continue
      if (typeof value === 'string') push(`- **${key}:** ${value}`)
      else if (Array.isArray(value)) {
        push(`- **${key}:**`)
        for (const item of value) {
          push(`  - ${typeof item === 'string' ? item : JSON.stringify(item)}`)
        }
      } else push(`- **${key}:** ${JSON.stringify(value)}`)
    }
    push('')
  }
  if (comp) {
    push('## System composition')
    push('')
    push(`Requested components: ${(comp.requested_components || []).join(', ')}`)
    for (const c of comp.components || []) push(`- ${c.component_id} (${c.disposition})${c.child_bundle ? ` — child: \`${c.child_bundle}\`` : ''}`)
    push('')
  }
  push('## Evidence index')
  push('')
  const index = h.evidence_index?.length
    ? h.evidence_index
    : ev.records.filter((r) => r.class && !['reasoning', 'hypothesis', 'unknown'].includes(r.class)).slice(0, 20).map((r) => ({ id: r.id }))
  for (const e of index) {
    const rec = ev.records.find((r) => r.id === e.id)
    push(`- \`${e.id}\`${rec ? ` (${rec.class}) ${rec.statement}` : ''}`)
  }
  push('')
  const md = `${lines.join('\n')}\n`
  const docPath = resolve(out || join(load.dir, 'explanation.md'))
  if (!write) return { ok: true, markdown: md, doc_path: docPath }
  const existing = existsSync(docPath) ? readFileSync(docPath, 'utf8') : undefined
  mkdirSync(dirname(docPath), { recursive: true })
  writeFileSync(docPath, md)
  return { ok: true, rendered: docPath, doc_path: docPath, bytes: md.length, changed: existing !== md }
}

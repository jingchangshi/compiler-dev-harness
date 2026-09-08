/**
 * Driver for the `compiler_explain` tool: deterministic scaffolding,
 * validation, mechanical readiness, and staleness for teaching artifact
 * bundles. The semantic content (mechanisms, mental models, storylines,
 * semantic readiness verdicts) is agent reasoning recorded in artifacts —
 * this driver never generates it.
 *
 * Bundle layout (default root `<preset>/analysis/explanations/`, override with
 * COMPILER_DEV_EXPLAIN_DIR — the dogfood bundles live there as curated case
 * data):
 *
 *   <root>/<YYYY-MM-DD>-<slug>-<type>/
 *     subject.json      AnalysisSubject + provenance
 *     evidence.json     evidence ledger (Source Fact ... Unknown classes)
 *     dossier.json      TeachingDossier (common core + one type extension)
 *     handoff.json      PresentationHandoff (optional until presentation depth)
 *     readiness.json    readiness report (written by `readiness` command)
 *
 * All spawns are argument-array git invocations; output is bounded.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEPTHS, SUBJECT_TYPES, EXAMPLE_REQUIRED_TYPES, AUDIENCE_QUESTIONS, semanticQuestionsFor,
  validateBundle, computeMechanicalReadiness, computeReadiness, computeStaleness,
  slugify, assessMentalModel,
} from './scripts/teaching-schema.mjs'

const DRIVER_VERSION = 'compiler-explain-driver v1.0'
const ARTIFACT_FILES = ['subject.json', 'evidence.json', 'dossier.json', 'handoff.json', 'readiness.json']

/** Bundle root: preset analysis/explanations/ unless overridden (tests). */
export function explainRoot() {
  const override = process.env.COMPILER_DEV_EXPLAIN_DIR
  if (override !== undefined && override !== '') return resolve(override)
  return resolve(dirname(fileURLToPath(import.meta.url)), 'analysis', 'explanations')
}

function runGit(repoRoot, args, timeoutMs = 15000) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: timeoutMs })
  if (result.error || result.status !== 0) {
    return { ok: false, error: String(result.error?.message || result.stderr || `git exit ${result.status}`).slice(0, 300) }
  }
  return { ok: true, stdout: result.stdout }
}

export function newCorrelationId() {
  return `e${Math.random().toString(16).slice(2, 18)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// plan
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_PLAN_CORE = [
  { step: 'identity-and-scope', tool: 'compiler_inspect', guidance: 'anchors = subject definition files; get definitions, bounded bodies, and probable tests in one bundle', produces: 'source_fact' },
  { step: 'context-and-usage', tool: 'compiler_inspect', guidance: 'anchor the caller/consumer entry points from source_context 1-hop callers; treat name-based edges as leads, confirm by reading', produces: 'source_fact' },
  { step: 'history', tool: 'compiler_inspect', guidance: 'history_window 5-10 scoped to the subject paths; read diffs only when they carry design intent', produces: 'historical_fact' },
  { step: 'tests', tool: 'bash + repo contract', guidance: 'run the contract test dirs relevant to the subject; record runtime facts from real executions only', produces: 'runtime_fact' },
]

const EVIDENCE_PLAN_BY_TYPE = {
  pass: [
    { step: 'graph-review', tool: 'compiler_knowledge', guidance: 'review <pass>: pass identity, review records, invariant guards, linked findings', produces: 'graph_fact' },
    { step: 'pipeline-order', tool: 'compiler_knowledge', guidance: 'pipeline-stages <pipeline> when the subject sits in a Python-composed pipeline; C++ pipelines report not-a-Python-composition', produces: 'graph_fact' },
    { step: 'ir-evidence', tool: 'compiler_inspect', guidance: 'log_files forensics for IR Dump Before/After slices when compile logs exist; never interpret beyond the dump', produces: 'runtime_fact' },
  ],
  pipeline: [
    { step: 'pipeline-order', tool: 'compiler_knowledge', guidance: 'pipeline-stages <pipeline> for AST-confirmed stage order with file:line', produces: 'graph_fact' },
  ],
  algorithm: [
    { step: 'data-structures', tool: 'compiler_inspect', guidance: 'anchor the core data structure definitions; iteration and termination come from reading, classed as reasoning unless a comment/spec states them', produces: 'source_fact' },
  ],
  subsystem: [
    { step: 'component-map', tool: 'compiler_inspect', guidance: 'anchor each component entry point separately; component boundaries need per-component evidence', produces: 'source_fact' },
  ],
}

export function planTeaching(args) {
  const subjectType = args.subject_type
  const name = String(args.name || '').trim()
  const depth = args.depth || 'standard'
  const errors = []
  if (!SUBJECT_TYPES.includes(subjectType)) errors.push(`subject_type must be one of ${SUBJECT_TYPES}`)
  if (name === '') errors.push('name is required')
  if (!DEPTHS.includes(depth)) errors.push(`depth must be one of ${DEPTHS}`)
  if (errors.length > 0) return { ok: false, errors }

  const slug = slugify(name)
  const bundleId = `${new Date().toISOString().slice(0, 10)}-${slug}-${subjectType}`
  const bundleDir = join(explainRoot(), bundleId)
  const checklist = buildReadinessChecklist(subjectType, depth)

  const plan = {
    ok: true,
    driver: DRIVER_VERSION,
    bundle: { id: bundleId, dir: bundleDir, files: ARTIFACT_FILES },
    subject_skeleton: {
      artifact: 'subject',
      subject_id: `${slug}-${subjectType}`,
      subject_type: subjectType,
      name,
      repository: args.repo_root ? basename(resolve(args.repo_root)) : '(cwd repository)',
      source_locations: [],
      scope: undefined,
      related_entities: [],
      why_this_subject: args.why_this_subject,
      provenance: { repository: undefined, branch: undefined, head: undefined, analyzed_at: undefined, tool_versions: { driver: DRIVER_VERSION }, runtime_verification: 'none' },
    },
    evidence_plan: [...EVIDENCE_PLAN_CORE, ...(EVIDENCE_PLAN_BY_TYPE[subjectType] || [])],
    extension_fields: extensionFieldsFor(subjectType),
    readiness_checklist: checklist,
    audience_questions: semanticQuestionsFor(subjectType),
    notes: [
      'Mechanism stage names must be derived from source — never preset, never source-file order.',
      'Class every statement: source/graph/runtime/historical facts cite the tool that produced them; reasoning and hypotheses say so.',
      'canonical_example provenance kinds: test > production > probe > reconstructed; a reconstructed example is labeled RECONSTRUCTED and never presented as executed.',
      'Readiness = mechanical pass + recorded semantic review. Field completeness alone never yields READY.',
    ],
  }
  if (EXAMPLE_REQUIRED_TYPES.includes(subjectType) && depth !== 'overview') {
    plan.notes.push(`canonical_example is mechanically required for ${subjectType} at depth ${depth}.`)
  }
  return plan
}

function extensionFieldsFor(subjectType) {
  const fields = {
    pass: ['pass_arg', 'operation_scope', 'pipeline_placements', 'ir_contract', 'attributes', 'legality', 'rewrite'],
    function: ['parameters', 'return_values', 'preconditions', 'control_flow', 'side_effects', 'callers', 'callees'],
    algorithm: ['input_model', 'state_representation', 'iteration', 'termination', 'complexity'],
    class: ['responsibility', 'owned_state', 'lifecycle', 'public_api', 'collaborators'],
    subsystem: ['components', 'architecture_boundaries', 'external_interfaces'],
    pipeline: ['stages', 'stage_order_evidence', 'representation_boundaries'],
    data_structure: ['representation', 'invariants', 'operations', 'ownership'],
    module: ['responsibilities', 'public_api', 'dependencies'],
    workflow: ['participants', 'flow', 'contracts'],
    component_group: ['components', 'interactions'],
    other: [],
  }
  return { subject_type: subjectType, fields: fields[subjectType] || [], note: 'fields are offers, not mandatory sections — fill what the subject actually has; only the readiness-listed ones are required' }
}

function buildReadinessChecklist(subjectType, depth) {
  const generic = [
    'identity understood', 'purpose/need explained', 'mental model exists (1-3 sentences, domain language)',
    'causal system context (who triggers / who relies on it)', 'inputs/outputs or equivalent contracts',
    'mechanism as source-derived stages', 'constraints/invariants with status', 'boundaries classified with evidence',
    'key takeaways (3-5)', 'fact/reasoning separation preserved', 'semantic review recorded',
  ]
  const byDepth = depth === 'presentation'
    ? ['implementation + conceptual views', 'presentation handoff with adaptive storyline (≥3 steps)', 'semantic visual specs (no layout/pixel/color)', 'evidence index in the handoff']
    : depth === 'deep' || depth === 'standard'
      ? ['canonical example when useful', 'state transitions when mutable state exists', 'decision model when important branching exists']
      : []
  const byType = {
    pass: ['pipeline placement', 'IR contract (before/after or form description)', 'legality or rewrite rationale'],
    function: ['parameters/returns/preconditions', 'callers and callees'],
    algorithm: ['iteration and invariants', 'termination', 'complexity with provenance (derived/measured/reasoning)'],
    class: ['lifecycle', 'owned state', 'collaborators'],
    subsystem: ['component boundaries', 'end-to-end flow', 'external interfaces'],
    pipeline: ['stage order evidence', 'representation boundaries'],
  }
  return { generic, by_depth: byDepth, by_type: byType[subjectType] || [] }
}

// ─────────────────────────────────────────────────────────────────────────────
// bundle IO
// ─────────────────────────────────────────────────────────────────────────────

export function loadBundle(bundleDir) {
  const resolved = resolve(bundleDir)
  if (!existsSync(resolved)) return { ok: false, error: `bundle dir not found: ${resolved}` }
  const bundle = {}
  const loaded = []
  for (const file of ARTIFACT_FILES) {
    const path = join(resolved, file)
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const key = file.replace(/\.json$/, '')
      bundle[key] = parsed
      loaded.push(file)
    } catch (err) {
      return { ok: false, error: `${file}: invalid JSON (${String(err.message).slice(0, 200)})` }
    }
  }
  if (bundle.subject === undefined && bundle.dossier === undefined) {
    return { ok: false, error: `no subject.json or dossier.json found in ${resolved} (loaded: ${loaded.join(', ') || 'nothing'})` }
  }
  return { ok: true, bundle, loaded, dir: resolved }
}

// ─────────────────────────────────────────────────────────────────────────────
// validate / readiness / stale
// ─────────────────────────────────────────────────────────────────────────────

export function validateBundleDir(bundleDir) {
  const load = loadBundle(bundleDir)
  if (!load.ok) return { ok: false, error: load.error }
  const { errors } = validateBundle(load.bundle)
  const warnings = []
  const dossier = load.bundle.dossier
  if (dossier) {
    const mm = assessMentalModel(dossier.mental_model)
    if (mm.present && mm.symbol_dump) warnings.push('mental_model looks like a symbol dump — rewrite in domain language')
    if (dossier.depth === 'presentation' && load.bundle.handoff === undefined) warnings.push('presentation depth without a presentation handoff')
  }
  if (load.bundle.handoff !== undefined && dossier === undefined) warnings.push('handoff without a dossier — the handoff must be derived from a teaching dossier')
  return {
    ok: true, dir: load.dir, loaded: load.loaded, valid: errors.length === 0,
    errors: errors.slice(0, 50), warnings,
  }
}

export function readinessForBundle(bundleDir, semanticReview, { depth } = {}) {
  const load = loadBundle(bundleDir)
  if (!load.ok) return { ok: false, error: load.error }
  const bundle = load.bundle
  if (semanticReview !== undefined) bundle.readiness = { ...(bundle.readiness || {}), artifact: 'readiness_report', schema_version: 1, subject_id: bundle.subject?.subject_id || bundle.dossier?.subject_id, semantic_review: semanticReview }
  const depthOpt = depth || bundle.dossier?.depth || bundle.subject?.depth
  const result = computeReadiness({ subject: bundle.subject, evidence: bundle.evidence, dossier: bundle.dossier, handoff: bundle.handoff, readiness: bundle.readiness }, { depth: depthOpt })
  const report = {
    artifact: 'readiness_report',
    schema_version: 1,
    subject_id: bundle.subject?.subject_id || bundle.dossier?.subject_id,
    depth: depthOpt || 'standard',
    mechanical: result.mechanical,
    semantic_review: bundle.readiness?.semantic_review,
    verdict: result.verdict,
    reasons: result.reasons,
    driver: DRIVER_VERSION,
    evaluated_at: new Date().toISOString(),
  }
  return { ok: true, dir: load.dir, report, result }
}

/** Persist readiness.json into the bundle dir (the only command that writes). */
export function saveReadiness(bundleDir, semanticReview, options = {}) {
  const out = readinessForBundle(bundleDir, semanticReview, options)
  if (!out.ok) return out
  const path = join(out.dir, 'readiness.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(out.report, null, 2)}\n`)
  return { ...out, saved: path }
}

export function stalenessForBundle(bundleDir, repoRoot) {
  const load = loadBundle(bundleDir)
  if (!load.ok) return { ok: false, error: load.error }
  const provenance = load.bundle.subject?.provenance
  if (!provenance) return { ok: false, error: 'subject.json has no provenance — staleness cannot be evaluated' }
  const root = resolve(repoRoot || provenance.repository_path || process.cwd())
  const head = runGit(root, ['rev-parse', 'HEAD'])
  const currentHead = head.ok ? head.stdout.trim() : undefined
  const currentFileHashes = {}
  for (const f of provenance.source_files || []) {
    const abs = join(root, f.path)
    if (existsSync(abs)) {
      currentFileHashes[f.path] = createHash('sha256').update(readFileSync(abs)).digest('hex')
    }
  }
  const staleness = computeStaleness({ provenance, currentHead, currentFileHashes })
  return { ok: true, dir: load.dir, repo_root: root, staleness }
}

/** Provenance facts for the analyzed repository (used when saving subject.json). */
export function repositoryProvenance(repoRoot) {
  const root = resolve(repoRoot || process.cwd())
  const head = runGit(root, ['rev-parse', 'HEAD'])
  const branch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return {
    repository: basename(root),
    repository_path: root,
    branch: branch.ok ? branch.stdout.trim() : undefined,
    head: head.ok ? head.stdout.trim() : undefined,
    analyzed_at: new Date().toISOString(),
  }
}

/** SHA-256 of the subject's source files, relative to the repo root. */
export function hashSourceFiles(repoRoot, sourceLocations) {
  const root = resolve(repoRoot || process.cwd())
  const seen = new Set()
  const out = []
  for (const loc of sourceLocations || []) {
    if (!loc || typeof loc.file !== 'string' || seen.has(loc.file)) continue
    seen.add(loc.file)
    const abs = join(root, loc.file)
    if (!existsSync(abs)) continue
    out.push({ path: loc.file, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') })
  }
  return out
}

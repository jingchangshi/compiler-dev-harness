/**
 * Teaching Artifact Protocol v1 — schema validators and the mechanical part of
 * the presentation-readiness gate for the generic Code Explanation capability.
 *
 * Ownership model (ARCHITECTURE §15):
 *   - mlir-compiler-harness / Ripwire / git  = deterministic evidence + graph facts
 *   - compiler-dev-harness                    = understand + verify + explain
 *   - presentation system                     = storyboard + layout + slides
 *
 * This module is the deterministic half of "explain": it validates artifact
 * shapes, enforces evidence discipline (Source Fact vs Reasoning separation),
 * runs mechanical readiness preconditions, and checks artifact staleness.
 * It never generates teaching content — mental models, mechanisms, storylines,
 * and semantic readiness verdicts are agent reasoning recorded in the artifacts
 * and reviewed through the required semantic-review section.
 *
 * Anti-overfitting invariants:
 *   - The common core is subject-type agnostic; pass-centric fields
 *     (pipeline_position, legality, before_ir, after_ir, pass_option,
 *     attribute_creator/consumer) exist ONLY inside the `pass` extension.
 *   - Extension fields are validated only when the matching extension object
 *     is present; no subject type repeats another type's schema.
 *   - No subject-specific concept (any concrete pass, class, algorithm, or
 *     subsystem name/term) may appear in this module — dogfood specifics live
 *     exclusively in artifact data; the anti-overfitting test enforces it.
 *
 * Node-only, stdlib. Style follows scripts/feedback-schema.mjs.
 */

export const SCHEMA_VERSION = 1

// Composition layer (Phase T3): the id space resolves parent evidence ids plus
// namespaced child-bundle references (`alias::EV-ID`), and composition bundles
// append their own mechanical checks. Pure module, no I/O, no cycle
// (composition-schema imports nothing).
import { compositionChecks, makeEvidenceIdSpace, validateComposition } from './composition-schema.mjs'
// Semantic visual fidelity (Phase T6): the protocol half of the semantic visual
// contract (vocabularies + shape validation) and the readiness check that the
// declared semantics are consumed. check-visual-semantics imports nothing from
// this module, so the dependency stays one-directional.
import {
  checkVisualSemantics,
  EDGE_DOMAINS, EDGE_KINDS_BY_DOMAIN,
  STATE_KINDS, STAGE_DISPOSITIONS, VISUAL_COVERAGE,
} from './check-visual-semantics.mjs'

export const SUBJECT_TYPES = [
  'function', 'class', 'algorithm', 'pass', 'module', 'subsystem', 'pipeline',
  'data_structure', 'workflow', 'component_group', 'other',
]

export const EVIDENCE_CLASSES = [
  'source_fact', 'graph_fact', 'runtime_fact', 'historical_fact',
  'reasoning', 'hypothesis', 'unknown',
]

/** Evidence classes strong enough to support a factual claim. */
export const FACT_CLASSES = ['source_fact', 'graph_fact', 'runtime_fact', 'historical_fact']

export const DEPTHS = ['overview', 'standard', 'deep', 'presentation']

export const CONSTRAINT_STATUSES = ['guarded', 'unguarded', 'verified', 'assumed', 'potential']

export const BOUNDARY_CATEGORIES = [
  'supported', 'partially_supported', 'rejected_by_design', 'unsupported',
  'potential_risk', 'unknown',
]

export const EXAMPLE_PROVENANCE = ['test', 'production', 'probe', 'reconstructed']
/** Acceptable primary text keys for structured example step entries (backward
 * compatible: pre-T5 artifacts use {description} / {state}; T5 adds
 * {label, action}). */
export const STEP_TEXT_KEYS = ['label', 'action', 'description', 'state', 'what']

export const ARTIFACT_KINDS = ['subject', 'evidence', 'mechanism', 'teaching_dossier', 'presentation_handoff', 'readiness_report']

export const VISUAL_KINDS = [
  'architecture', 'pipeline', 'control_flow', 'data_flow', 'flowchart',
  'decision_tree', 'state_transition', 'sequence', 'before_after',
  'comparison', 'dependency_graph', 'ownership',
]

/**
 * Semantic visual specs only. Any of these keys inside nodes/edges/groups or
 * the spec itself is a layout/pixel/color leak and is rejected: the harness
 * does not do slide layout.
 */
export const FORBIDDEN_VISUAL_KEYS = ['x', 'y', 'width', 'height', 'left', 'top', 'color', 'fill', 'stroke', 'font', 'fontSize', 'px']

/**
 * Type-specific extension keys. Common-core fields are validated for shape
 * wherever they appear; extension fields are validated only inside the
 * matching `extensions.<subject_type>` object. An extension object present
 * under a key that does not match the subject type is an error.
 */
export const EXTENSION_KEYS = {
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

/**
 * Subject types whose canonical example is mechanically required at
 * standard/deep/presentation depth ("when useful"): these types describe
 * behavior over data or control flow, where a worked example is the primary
 * teaching device. Simple leaf types (function/class/data_structure/other)
 * keep it optional — a stateless utility must not be forced into a fake
 * example (Goal §12/§40).
 */
export const EXAMPLE_REQUIRED_TYPES = ['pass', 'algorithm', 'pipeline', 'subsystem', 'workflow', 'component_group']

const isNonempty = (v) => typeof v === 'string' && v.trim() !== ''
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStringArray = (v) => Array.isArray(v) && v.every(isNonempty)
const isRefArray = (v) => Array.isArray(v) && v.every((r) => typeof r === 'string' && r.trim() !== '')

function error(errors, source, message) {
  errors.push(`${source}: ${message}`)
}

function unknownFields(errors, source, value, allowed) {
  if (!isObject(value)) return
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) error(errors, source, `unknown field: ${key}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evidence ledger: the only place factual statements live. Classes separate
 * deterministic retrieval from agent reasoning:
 *   source_fact   — read directly from source (file:line refs)
 *   graph_fact    — from a graph engine (mlir-repomap knowledge query, repomap CLI)
 *   runtime_fact  — observed by running something (test, probe, tool execution)
 *   historical_fact — from git/history evidence (commit, diff, message)
 *   reasoning     — agent inference; NEVER presentable as a fact
 *   hypothesis    — unverified conjecture kept alive for verification
 *   unknown       — explicitly unknown; absence of knowledge, recorded as such
 */
export function validateEvidenceLedger(ledger, errors, source = 'evidence') {
  if (!isObject(ledger)) { error(errors, source, 'must be a mapping'); return new Set() }
  unknownFields(errors, source, ledger, ['artifact', 'records', 'note'])
  const records = ledger.records
  if (!Array.isArray(records)) { error(errors, source, 'records must be an array'); return new Set() }
  const ids = new Set()
  for (let i = 0; i < records.length; i++) {
    const at = `${source}.records[${i}]`
    const r = records[i]
    if (!isObject(r)) { error(errors, at, 'record must be a mapping'); continue }
    let rid = at
    if (!isNonempty(r.id)) error(errors, at, 'id must be a non-empty string')
    else if (ids.has(r.id)) error(errors, at, `duplicate evidence id: ${r.id}`)
    else { ids.add(r.id); rid = `${at} (${r.id})` }
    if (!EVIDENCE_CLASSES.includes(r.class)) error(errors, rid, `class must be one of ${EVIDENCE_CLASSES}`)
    if (!isNonempty(r.statement)) error(errors, rid, 'statement must be a non-empty string')
    if (r.tool !== undefined && !isNonempty(r.tool)) error(errors, rid, 'tool must be a non-empty string when present')
    if (r.command !== undefined && !isNonempty(r.command)) error(errors, rid, 'command must be a non-empty string when present')
    if (r.refs !== undefined) {
      if (!Array.isArray(r.refs)) error(errors, rid, 'refs must be an array')
      else r.refs.forEach((ref, j) => {
        if (!isObject(ref) || !isNonempty(ref.file)) error(errors, `${rid}.refs[${j}]`, 'ref must be a mapping with a non-empty file')
        else if (ref.lines !== undefined && !(typeof ref.lines === 'string' || typeof ref.lines === 'number')) error(errors, `${rid}.refs[${j}]`, 'lines must be a string or number')
      })
    }
    if (r.commit !== undefined && !isNonempty(r.commit)) error(errors, rid, 'commit must be a non-empty string when present')
    if (r.class === 'historical_fact' && r.commit === undefined && (r.refs === undefined || r.refs.length === 0)) {
      error(errors, rid, 'historical_fact requires a commit or refs')
    }
    if (r.class === 'source_fact' && (r.refs === undefined || r.refs.length === 0)) {
      error(errors, rid, 'source_fact requires refs (file:line)')
    }
    if (r.class === 'graph_fact' && !isNonempty(r.tool) && !isNonempty(r.command)) {
      error(errors, rid, 'graph_fact requires the graph tool/command it came from')
    }
  }
  return ids
}

/**
 * Evidence-discipline check for a claim-bearing element: cited ids must exist,
 * and an element presented as factual may not cite only reasoning/hypothesis/
 * unknown evidence.
 */
export function checkClaimEvidence(element, elementSource, ids, errors, expectFact = false) {
  if (element === null || typeof element !== 'object') return
  const refs = element.evidence_refs
  if (refs === undefined) return
  if (!isRefArray(refs)) { error(errors, elementSource, 'evidence_refs must be an array of evidence ids'); return }
  for (const id of refs) {
    if (!ids.has(id)) error(errors, elementSource, `evidence_ref not found in ledger: ${id}`)
  }
  if (expectFact && refs.length > 0 && hasIds(ids)) {
    const cited = refs.map((id) => lookupEvidenceClass(element, id)).filter(Boolean)
    if (cited.length > 0 && cited.every((c) => !FACT_CLASSES.includes(c))) {
      error(errors, elementSource, `factual claim cites only non-fact evidence (${cited.join(', ')}) — reclass the claim as reasoning or add fact evidence`)
    }
  }
}

/** Duck-typed id-space check: works for a plain Set (parent ledger only) and
 * for the composition id space (parent ledger + namespaced child imports). */
function hasIds(ids) {
  if (ids instanceof Set) return ids.size > 0
  return typeof ids?.count === 'function' ? ids.count() > 0 : false
}

// Internal: evidence id → class lookup attached by validateBundle so
// checkClaimEvidence can classify citations. Kept off the validated data.
const CLASS_INDEX = Symbol('evidenceClassIndex')

function lookupEvidenceClass(element, id) {
  const index = element?.[CLASS_INDEX]
  if (!index || !(index.map instanceof Map)) return undefined
  const direct = index.map.get(id)
  if (direct !== undefined) return direct
  return typeof index.idSpace?.classOf === 'function' ? index.idSpace.classOf(id) : undefined
}

/** Attach the ledger class index to an element (internal, non-enumerable).
 * `idSpace` (optional) extends class lookup to namespaced child-bundle
 * references (`alias::EV-ID`) via declared composition imports. */
export function withEvidenceIndex(element, ledger, idSpace) {
  if (!isObject(element)) return element
  const index = new Map()
  for (const r of (ledger && ledger.records) || []) {
    if (isNonempty(r.id) && EVIDENCE_CLASSES.includes(r.class)) index.set(r.id, r.class)
  }
  Object.defineProperty(element, CLASS_INDEX, { value: { map: index, idSpace }, configurable: true })
  return element
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject
// ─────────────────────────────────────────────────────────────────────────────

export function validateSubject(subject, errors, source = 'subject') {
  if (!isObject(subject)) { error(errors, source, 'must be a mapping'); return }
  unknownFields(errors, source, subject, ['artifact', 'schema_version', 'subject_id', 'subject_type', 'name', 'repository', 'repository_path',
    'source_locations', 'scope', 'related_entities', 'why_this_subject', 'provenance', 'notes'])
  if (subject.artifact !== undefined && subject.artifact !== 'subject') error(errors, source, 'artifact must be "subject"')
  if (!isNonempty(subject.subject_id)) error(errors, `${source}.subject_id`, 'must be a non-empty string')
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(subject.subject_id)) error(errors, `${source}.subject_id`, 'must be a lowercase slug ([a-z0-9-])')
  if (!SUBJECT_TYPES.includes(subject.subject_type)) error(errors, `${source}.subject_type`, `must be one of ${SUBJECT_TYPES}`)
  if (!isNonempty(subject.name)) error(errors, `${source}.name`, 'must be a non-empty string')
  if (!isNonempty(subject.repository)) error(errors, `${source}.repository`, 'must be a non-empty string (repository name or path)')
  if (subject.source_locations !== undefined) {
    if (!Array.isArray(subject.source_locations) || subject.source_locations.length === 0) {
      error(errors, `${source}.source_locations`, 'must be a non-empty array when present')
    } else subject.source_locations.forEach((loc, i) => {
      if (!isObject(loc) || !isNonempty(loc.file)) error(errors, `${source}.source_locations[${i}]`, 'must be a mapping with a non-empty file')
    })
  }
  if (subject.scope !== undefined && !isNonempty(subject.scope)) error(errors, `${source}.scope`, 'must be a non-empty string when present')
  if (subject.related_entities !== undefined) {
    if (!Array.isArray(subject.related_entities)) error(errors, `${source}.related_entities`, 'must be an array when present')
    else subject.related_entities.forEach((e, i) => {
      if (!isObject(e) || !isNonempty(e.name)) error(errors, `${source}.related_entities[${i}]`, 'must be a mapping with a non-empty name')
      else if (e.relation !== undefined && !isNonempty(e.relation)) error(errors, `${source}.related_entities[${i}].relation`, 'must be a non-empty string when present')
    })
  }
  validateProvenance(subject.provenance, errors, `${source}.provenance`, { requireComplete: true })
  if (subject.why_this_subject !== undefined && !isNonempty(subject.why_this_subject)) {
    error(errors, `${source}.why_this_subject`, 'must be a non-empty string when present')
  }
}

/** Provenance: repository/branch/HEAD/timestamps/tool versions/verification. */
export function validateProvenance(prov, errors, source, { requireComplete = false } = {}) {
  if (!isObject(prov)) {
    if (requireComplete) error(errors, source, 'provenance is required (repository, branch, head, analyzed_at)')
    return
  }
  for (const field of ['repository', 'branch', 'head', 'analyzed_at']) {
    if (!isNonempty(prov[field])) error(errors, `${source}.${field}`, requireComplete ? 'is required' : 'must be a non-empty string when present')
  }
  if (prov.analyzed_at !== undefined && !isNonempty(prov.analyzed_at)) error(errors, `${source}.analyzed_at`, 'must be an ISO timestamp string')
  if (prov.tool_versions !== undefined && !isObject(prov.tool_versions)) error(errors, `${source}.tool_versions`, 'must be a mapping when present')
  if (prov.runtime_verification !== undefined) {
    if (!['none', 'partial', 'full'].includes(prov.runtime_verification)) {
      error(errors, `${source}.runtime_verification`, 'must be none | partial | full')
    }
    if (prov.runtime_verification !== 'none' && !isNonempty(prov.runtime_verification_note)) {
      error(errors, `${source}.runtime_verification_note`, 'is required when runtime_verification is partial/full')
    }
  }
  if (prov.source_files !== undefined) {
    if (!Array.isArray(prov.source_files)) error(errors, `${source}.source_files`, 'must be an array when present')
    else prov.source_files.forEach((f, i) => {
      if (!isObject(f) || !isNonempty(f.path)) error(errors, `${source}.source_files[${i}]`, 'must be a mapping with a non-empty path')
      else if (f.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(f.sha256)) error(errors, `${source}.source_files[${i}].sha256`, 'must be a hex sha256')
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Teaching dossier (common core + type extension)
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_ENTRY_KEYS = ['role', 'entity', 'interaction', 'evidence_refs']
const CONTRACT_ENTRY_KEYS = ['name', 'form', 'description', 'evidence_refs']
const STAGE_KEYS = ['name', 'what', 'where', 'key_functions', 'evidence_refs']
// Phase T6 semantic visual contract (producer side): state entities carry the
// lifecycle the presentation must not contradict; control relations are typed
// stage→stage edges the deck must consume or explicitly defer.
const STATE_KEYS = ['id', 'name', 'kind', 'created_in', 'read_in', 'updated_in', 'finalized_in', 'evidence_refs', 'note']
const CONTROL_RELATION_KEYS = ['from', 'to', 'kind', 'condition', 'evidence_refs', 'note']
const TRANSITION_KEYS = ['phase', 'before', 'operation', 'after', 'reason', 'evidence_refs']
const DECISION_KEYS = ['id', 'question', 'condition', 'outcomes', 'reason', 'evidence_refs', 'example_refs']
const CONSTRAINT_KEYS = ['statement', 'status', 'evidence_refs']
const BOUNDARY_KEYS = ['category', 'statement', 'evidence_refs']
const CONTRACT_EDGE_KEYS = ['producer', 'consumer', 'subject_side', 'element', 'form', 'evidence_refs']

function validateEntryArray(arr, keys, errors, source, { requireRefs = true } = {}) {
  if (!Array.isArray(arr)) { error(errors, source, 'must be an array when present'); return }
  arr.forEach((entry, i) => {
    const at = `${source}[${i}]`
    if (!isObject(entry)) { error(errors, at, 'must be a mapping'); return }
    if (requireRefs && (entry.evidence_refs === undefined || !isRefArray(entry.evidence_refs) || entry.evidence_refs.length === 0)) {
      error(errors, at, 'evidence_refs with at least one id is required — an explanation primitive without evidence is a claim, not a fact')
    }
    for (const key of Object.keys(entry).sort()) {
      if (!keys.includes(key)) error(errors, at, `unknown field: ${key}`)
    }
    if (entry.role !== undefined && !isNonempty(entry.role)) error(errors, `${at}.role`, 'must be a non-empty string')
    if (entry.entity !== undefined && !isNonempty(entry.entity)) error(errors, `${at}.entity`, 'must be a non-empty string')
    if (entry.interaction !== undefined && !isNonempty(entry.interaction)) error(errors, `${at}.interaction`, 'must be a non-empty string')
    if (entry.statement !== undefined && !isNonempty(entry.statement)) error(errors, `${at}.statement`, 'must be a non-empty string')
    if (entry.name !== undefined && !isNonempty(entry.name)) error(errors, `${at}.name`, 'must be a non-empty string')
  })
}

/** Mental-model heuristic floor (mechanical only — semantic quality is the
 * reviewer's job): 1–3 sentences, and not a symbol dump. */
export function assessMentalModel(text) {
  if (!isNonempty(text)) return { present: false }
  const trimmed = text.trim()
  const sentences = trimmed.split(/[.!?。！？]+\s*/).filter((s) => s.trim() !== '')
  const tokens = trimmed.split(/[\s,，;；、()（）::'"]+/).filter((t) => t !== '')
  const identifierish = tokens.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && (/[_]/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t) || /^(get|set|is|has|try|do|on|run|make|create|update)[A-Z]/.test(t)))
  const density = tokens.length > 0 ? identifierish.length / tokens.length : 1
  return {
    present: true,
    sentences: sentences.length,
    token_count: tokens.length,
    identifier_density: Number(density.toFixed(2)),
    symbol_dump: sentences.length >= 1 && tokens.length >= 6 && density > 0.5,
    too_long: sentences.length > 3,
  }
}

/** Walk any artifact value and require every cited evidence id to resolve.
 * `ids` is a plain Set (parent ledger) or a composition id space (has/classOf). */
function walkEvidenceRefs(value, source, ids, errors) {
  const resolvable = (ref) => (ids instanceof Set || (ids && typeof ids.has === 'function')) ? ids.has(ref) : false
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkEvidenceRefs(v, `${source}[${i}]`, ids, errors))
    return
  }
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'evidence_refs') {
      if (!Array.isArray(child) || !child.every((r) => typeof r === 'string' && r.trim() !== '')) {
        error(errors, `${source}.${key}`, 'evidence_refs must be an array of evidence ids')
        continue
      }
      for (const id of child) {
        if (!resolvable(id)) error(errors, `${source}.${key}`, `evidence_ref not found in ledger: ${id}`)
      }
      continue
    }
    if (key === 'evidence_index' && Array.isArray(child)) {
      child.forEach((e, i) => {
        if (isObject(e) && !resolvable(e.id)) error(errors, `${source}.${key}[${i}]`, `evidence id not found in ledger: ${e.id}`)
      })
      continue
    }
    if (isObject(child) || Array.isArray(child)) walkEvidenceRefs(child, `${source}.${key}`, ids, errors)
  }
}

export function validateDossier(dossier, evidenceIds, errors, source = 'dossier') {
  if (!isObject(dossier)) { error(errors, source, 'must be a mapping'); return }
  unknownFields(errors, source, dossier, ['artifact', 'schema_version', 'subject_id', 'subject_type', 'depth', 'audience_contract',
    'mental_model', 'need', 'responsibility', 'observable_outcome', 'purpose', 'system_context', 'inputs', 'outputs',
    'mechanism', 'implementation_view', 'conceptual_view', 'canonical_example', 'worked_examples', 'state_transitions', 'decisions',
    'strategies', 'comparisons', 'contracts', 'constraints', 'invariants', 'assumptions', 'boundaries', 'placement',
    'ownership', 'complexity', 'key_takeaways', 'design_tradeoffs', 'risks', 'extensions', 'evidence_refs'])
  if (dossier.artifact !== undefined && dossier.artifact !== 'teaching_dossier') error(errors, source, 'artifact must be "teaching_dossier"')
  if (!isNonempty(dossier.subject_id)) error(errors, `${source}.subject_id`, 'must be a non-empty string')
  if (!SUBJECT_TYPES.includes(dossier.subject_type)) error(errors, `${source}.subject_type`, `must be one of ${SUBJECT_TYPES}`)
  if (dossier.depth !== undefined && !DEPTHS.includes(dossier.depth)) error(errors, `${source}.depth`, `must be one of ${DEPTHS}`)

  // Common core — presence is a readiness-policy question, not a schema
  // requirement; when present, shape is validated.
  const mm = assessMentalModel(dossier.mental_model)
  if (dossier.mental_model !== undefined && !mm.present) error(errors, `${source}.mental_model`, 'must be a non-empty string when present')
  for (const field of ['need', 'responsibility', 'observable_outcome', 'purpose']) {
    if (dossier[field] !== undefined && !isNonempty(dossier[field])) error(errors, `${source}.${field}`, 'must be a non-empty string when present')
  }
  if (dossier.audience_contract !== undefined && !isObject(dossier.audience_contract)) error(errors, `${source}.audience_contract`, 'must be a mapping when present')
  if (dossier.system_context !== undefined) {
    const ctx = dossier.system_context
    if (!isObject(ctx)) error(errors, `${source}.system_context`, 'must be a mapping when present')
    else {
      for (const side of ['upstream', 'downstream', 'triggers']) {
        if (ctx[side] !== undefined) validateEntryArray(ctx[side], CONTEXT_ENTRY_KEYS, errors, `${source}.system_context.${side}`)
      }
      for (const key of Object.keys(ctx).sort()) {
        if (!['upstream', 'downstream', 'triggers'].includes(key)) error(errors, `${source}.system_context`, `unknown field: ${key}`)
      }
    }
  }
  for (const field of ['inputs', 'outputs']) {
    if (dossier[field] !== undefined) validateEntryArray(dossier[field], CONTRACT_ENTRY_KEYS, errors, `${source}.${field}`)
  }

  // Mechanism: stage names MUST be derived from source, never preset.
  if (dossier.mechanism !== undefined) {
    const mech = dossier.mechanism
    if (!isObject(mech)) error(errors, `${source}.mechanism`, 'must be a mapping when present')
    else {
      if (mech.summary !== undefined && !isNonempty(mech.summary)) error(errors, `${source}.mechanism.summary`, 'must be a non-empty string when present')
      if (mech.stages !== undefined) validateEntryArray(mech.stages, STAGE_KEYS, errors, `${source}.mechanism.stages`)
      if (mech.control_flow !== undefined && !Array.isArray(mech.control_flow)) error(errors, `${source}.mechanism.control_flow`, 'must be an array when present')
      if (mech.data_flow !== undefined && !Array.isArray(mech.data_flow)) error(errors, `${source}.mechanism.data_flow`, 'must be an array when present')
      if (mech.mutable_state !== undefined && typeof mech.mutable_state !== 'boolean') error(errors, `${source}.mechanism.mutable_state`, 'must be a boolean when present')
      if (mech.has_important_branching !== undefined && typeof mech.has_important_branching !== 'boolean') error(errors, `${source}.mechanism.has_important_branching`, 'must be a boolean when present')
      // Phase T6: state entities with declared lifecycles. Shape only here —
      // stage-name resolution against mechanism.stages is the semantic
      // validator's job (check-visual-semantics.mjs).
      if (mech.states !== undefined) {
        if (!Array.isArray(mech.states)) error(errors, `${source}.mechanism.states`, 'must be an array when present')
        else mech.states.forEach((s, i) => {
          const at = `${source}.mechanism.states[${i}]`
          if (!isObject(s)) { error(errors, at, 'must be a mapping'); return }
          for (const key of Object.keys(s).sort()) if (!STATE_KEYS.includes(key)) error(errors, at, `unknown field: ${key}`)
          if (!isNonempty(s.id)) error(errors, `${at}.id`, 'must be a non-empty string')
          if (!isNonempty(s.name)) error(errors, `${at}.name`, 'must be a non-empty string')
          if (!STATE_KINDS.includes(s.kind)) error(errors, `${at}.kind`, `must be one of ${STATE_KINDS}`)
          for (const field of ['created_in', 'finalized_in']) {
            if (s[field] !== undefined && !isNonempty(s[field])) error(errors, `${at}.${field}`, 'must be a non-empty stage name when present')
          }
          for (const field of ['read_in', 'updated_in']) {
            if (s[field] !== undefined && !isStringArray(s[field])) error(errors, `${at}.${field}`, 'must be an array of stage names when present')
          }
          if (s.evidence_refs === undefined || !isRefArray(s.evidence_refs) || s.evidence_refs.length === 0) {
            error(errors, at, 'evidence_refs with at least one id is required — a state lifecycle without evidence is a claim, not a fact')
          }
        })
      }
      if (mech.control_relations !== undefined) {
        if (!Array.isArray(mech.control_relations)) error(errors, `${source}.mechanism.control_relations`, 'must be an array when present')
        else mech.control_relations.forEach((r, i) => {
          const at = `${source}.mechanism.control_relations[${i}]`
          if (!isObject(r)) { error(errors, at, 'must be a mapping'); return }
          for (const key of Object.keys(r).sort()) if (!CONTROL_RELATION_KEYS.includes(key)) error(errors, at, `unknown field: ${key}`)
          for (const field of ['from', 'to', 'kind']) {
            if (!isNonempty(r[field])) error(errors, `${at}.${field}`, 'must be a non-empty string')
          }
          if (r.condition !== undefined && !isNonempty(r.condition)) error(errors, `${at}.condition`, 'must be a non-empty string when present')
          if (r.evidence_refs === undefined || !isRefArray(r.evidence_refs) || r.evidence_refs.length === 0) {
            error(errors, at, 'evidence_refs with at least one id is required — a control relation without evidence is a claim, not a fact')
          }
        })
      }
      for (const key of Object.keys(mech).sort()) {
        if (!['summary', 'stages', 'control_flow', 'data_flow', 'mutable_state', 'has_important_branching', 'states', 'control_relations'].includes(key)) {
          error(errors, `${source}.mechanism`, `unknown field: ${key}`)
        }
      }
    }
  }

  // The two views: implementation (how) vs conceptual/decision (why).
  for (const field of ['implementation_view', 'conceptual_view']) {
    if (dossier[field] !== undefined) validateEntryArray(dossier[field], ['aspect', 'description', 'evidence_refs'], errors, `${source}.${field}`)
  }

  // Canonical example: generic concepts (initial_state/inputs/execution_trace/
  // important_states/result); pass-shaped before_ir/after_ir live in the pass
  // extension's ir_contract, not here. Trace/state entries may be plain strings
  // or structured steps (Phase T5): {label?, action, result?, mechanism_stage?,
  // evidence_refs?} — at least one of label/action must be non-empty.
  if (dossier.canonical_example !== undefined) {
    const ex = dossier.canonical_example
    if (!isObject(ex)) error(errors, `${source}.canonical_example`, 'must be a mapping when present')
    else {
      if (ex.provenance === undefined || !isObject(ex.provenance)) error(errors, `${source}.canonical_example.provenance`, 'is required (kind + source)')
      else {
        if (!EXAMPLE_PROVENANCE.includes(ex.provenance.kind)) error(errors, `${source}.canonical_example.provenance.kind`, `must be one of ${EXAMPLE_PROVENANCE}`)
        if (!isNonempty(ex.provenance.source)) error(errors, `${source}.canonical_example.provenance.source`, 'must be a non-empty string')
      }
      for (const field of ['initial_state', 'inputs', 'result']) {
        if (ex[field] !== undefined && !(typeof ex[field] === 'string' || isObject(ex[field]))) error(errors, `${source}.canonical_example.${field}`, 'must be a string or mapping when present')
      }
      for (const field of ['execution_trace', 'important_states', 'boundary_examples', 'steps']) {
        if (ex[field] === undefined) continue
        if (!Array.isArray(ex[field])) {
          error(errors, `${source}.canonical_example.${field}`, 'must be an array when present')
          continue
        }
        ex[field].forEach((entry, i) => {
          if (typeof entry === 'string') return
          if (!isObject(entry)) {
            error(errors, `${source}.canonical_example.${field}[${i}]`, 'must be a string or a step mapping (label/action)')
            return
          }
          if (!STEP_TEXT_KEYS.some((k) => isNonempty(entry[k]))) {
            error(errors, `${source}.canonical_example.${field}[${i}]`, 'step mapping needs a non-empty label, action, description, or state')
          }
          if (entry.mechanism_stage !== undefined && !isNonempty(entry.mechanism_stage)) {
            error(errors, `${source}.canonical_example.${field}[${i}].mechanism_stage`, 'must be a non-empty stage name when present')
          }
        })
      }
    }
  }

  // Worked examples (Phase T5): per-mechanism step-by-step instances beyond the
  // canonical example. Same provenance discipline as canonical_example.
  if (dossier.worked_examples !== undefined) {
    if (!Array.isArray(dossier.worked_examples)) error(errors, `${source}.worked_examples`, 'must be an array when present')
    else dossier.worked_examples.forEach((we, i) => {
      const at = `${source}.worked_examples[${i}]`
      if (!isObject(we)) { error(errors, at, 'must be a mapping'); return }
      if (!isNonempty(we.title)) error(errors, `${at}.title`, 'must be a non-empty string')
      if (we.provenance === undefined || !isObject(we.provenance)) error(errors, `${at}.provenance`, 'is required (kind + source)')
      else {
        if (!EXAMPLE_PROVENANCE.includes(we.provenance.kind)) error(errors, `${at}.provenance.kind`, `must be one of ${EXAMPLE_PROVENANCE}`)
        if (!isNonempty(we.provenance.source)) error(errors, `${at}.provenance.source`, 'must be a non-empty string')
      }
      if (we.steps !== undefined) {
        if (!Array.isArray(we.steps) || we.steps.length === 0) error(errors, `${at}.steps`, 'must be a non-empty array of steps when present')
        else we.steps.forEach((entry, j) => {
          if (typeof entry === 'string') return
          if (!isObject(entry)) { error(errors, `${at}.steps[${j}]`, 'must be a string or a step mapping (label/action)'); return }
          if (!STEP_TEXT_KEYS.some((k) => isNonempty(entry[k]))) {
            error(errors, `${at}.steps[${j}]`, 'step mapping needs a non-empty label, action, description, or state')
          }
        })
      }
      if (we.result !== undefined && !(typeof we.result === 'string' || isObject(we.result))) {
        error(errors, `${at}.result`, 'must be a string or mapping when present')
      }
    })
  }

  if (dossier.state_transitions !== undefined) validateEntryArray(dossier.state_transitions, TRANSITION_KEYS, errors, `${source}.state_transitions`)
  if (dossier.decisions !== undefined) {
    const decisions = dossier.decisions
    if (!Array.isArray(decisions)) error(errors, `${source}.decisions`, 'must be an array when present')
    else decisions.forEach((d, i) => {
      const at = `${source}.decisions[${i}]`
      if (!isObject(d)) { error(errors, at, 'must be a mapping'); return }
      for (const key of Object.keys(d).sort()) if (!DECISION_KEYS.includes(key)) error(errors, at, `unknown field: ${key}`)
      if (!isNonempty(d.question)) error(errors, `${at}.question`, 'must be a non-empty string')
      if (!isNonempty(d.condition)) error(errors, `${at}.condition`, 'must be a non-empty string')
      if (d.outcomes !== undefined && !Array.isArray(d.outcomes)) error(errors, `${at}.outcomes`, 'must be an array when present')
      if (d.evidence_refs === undefined || !isRefArray(d.evidence_refs) || d.evidence_refs.length === 0) {
        error(errors, at, 'evidence_refs with at least one id is required')
      }
    })
  }
  // Strategies/comparisons exist only when real (≥2 paths) — never for schema
  // completeness.
  if (dossier.strategies !== undefined) {
    if (!Array.isArray(dossier.strategies)) error(errors, `${source}.strategies`, 'must be an array when present')
    else {
      if (dossier.strategies.length > 0 && dossier.strategies.length < 2) {
        error(errors, `${source}.strategies`, 'a single strategy is not a strategy model — omit the field unless ≥2 real paths exist')
      }
      dossier.strategies.forEach((s, i) => {
        if (!isObject(s) || !isNonempty(s.name)) error(errors, `${source}.strategies[${i}]`, 'must be a mapping with a non-empty name')
      })
    }
  }
  if (dossier.comparisons !== undefined) {
    if (!Array.isArray(dossier.comparisons)) error(errors, `${source}.comparisons`, 'must be an array when present')
    else if (dossier.comparisons.length > 0 && (dossier.strategies === undefined || dossier.strategies.length < 2)) {
      error(errors, `${source}.comparisons`, 'requires ≥2 strategies to compare')
    }
  }
  if (dossier.contracts !== undefined) validateEntryArray(dossier.contracts, CONTRACT_EDGE_KEYS, errors, `${source}.contracts`)

  for (const [field, statuses] of [['constraints', CONSTRAINT_STATUSES], ['invariants', CONSTRAINT_STATUSES], ['assumptions', CONSTRAINT_STATUSES]]) {
    if (dossier[field] !== undefined) {
      const arr = dossier[field]
      if (!Array.isArray(arr)) error(errors, `${source}.${field}`, 'must be an array when present')
      else arr.forEach((c, i) => {
        const at = `${source}.${field}[${i}]`
        if (!isObject(c)) { error(errors, at, 'must be a mapping'); return }
        for (const key of Object.keys(c).sort()) if (!CONSTRAINT_KEYS.includes(key)) error(errors, at, `unknown field: ${key}`)
        if (!isNonempty(c.statement)) error(errors, `${at}.statement`, 'must be a non-empty string')
        if (c.status !== undefined && !statuses.includes(c.status)) error(errors, `${at}.status`, `must be one of ${statuses}`)
      })
    }
  }
  if (dossier.boundaries !== undefined) {
    const arr = dossier.boundaries
    if (!Array.isArray(arr)) error(errors, `${source}.boundaries`, 'must be an array when present')
    else arr.forEach((b, i) => {
      const at = `${source}.boundaries[${i}]`
      if (!isObject(b)) { error(errors, at, 'must be a mapping'); return }
      for (const key of Object.keys(b).sort()) if (!BOUNDARY_KEYS.includes(key)) error(errors, at, `unknown field: ${key}`)
      if (!BOUNDARY_CATEGORIES.includes(b.category)) error(errors, `${at}.category`, `must be one of ${BOUNDARY_CATEGORIES}`)
      if (!isNonempty(b.statement)) error(errors, `${at}.statement`, 'must be a non-empty string')
      if (b.evidence_refs === undefined || !isRefArray(b.evidence_refs) || b.evidence_refs.length === 0) {
        error(errors, at, 'evidence_refs with at least one id is required — a boundary classification without evidence is forbidden (unseen ≠ unsupported)')
      }
    })
  }
  if (dossier.placement !== undefined) {
    const p = dossier.placement
    if (!isObject(p)) error(errors, `${source}.placement`, 'must be a mapping when present')
    else {
      if (p.applicable !== undefined && typeof p.applicable !== 'boolean') error(errors, `${source}.placement.applicable`, 'must be a boolean when present')
      if (p.applicable === false) {
        if (p.status !== 'not_applicable') error(errors, `${source}.placement.status`, 'must be "not_applicable" when applicable=false — never fabricate a placement story')
      }
      for (const field of ['why_here', 'why_not_earlier', 'why_not_later', 'status']) {
        if (p[field] !== undefined && !isNonempty(p[field])) error(errors, `${source}.placement.${field}`, 'must be a non-empty string when present')
      }
    }
  }
  if (dossier.ownership !== undefined && !isObject(dossier.ownership)) error(errors, `${source}.ownership`, 'must be a mapping when present')
  if (dossier.complexity !== undefined && !isObject(dossier.complexity)) error(errors, `${source}.complexity`, 'must be a mapping when present')
  if (dossier.key_takeaways !== undefined) {
    if (!isStringArray(dossier.key_takeaways)) error(errors, `${source}.key_takeaways`, 'must be an array of non-empty strings when present')
    else if (dossier.key_takeaways.length > 6) error(errors, `${source}.key_takeaways`, 'more than 6 takeaways is not a takeaway list — cut or move to appendix_topics in the handoff')
  }
  for (const field of ['design_tradeoffs', 'risks']) {
    if (dossier[field] !== undefined && !Array.isArray(dossier[field])) error(errors, `${source}.${field}`, 'must be an array when present')
  }

  // Extension: exactly one, matching subject_type, validated against its key
  // set. Unknown extension types and pass fields at the core are rejected.
  if (dossier.extensions !== undefined) {
    const ext = dossier.extensions
    if (!isObject(ext)) error(errors, `${source}.extensions`, 'must be a mapping when present')
    else {
      const keys = Object.keys(ext).sort()
      if (keys.length > 1) error(errors, `${source}.extensions`, `only the extension matching subject_type may be present, got: ${keys.join(', ')}`)
      for (const key of keys) {
        if (key !== dossier.subject_type) {
          error(errors, `${source}.extensions.${key}`, `does not match subject_type ${dossier.subject_type}`)
          continue
        }
        if (!isObject(ext[key])) { error(errors, `${source}.extensions.${key}`, 'must be a mapping'); continue }
        for (const field of Object.keys(ext[key]).sort()) {
          if (!EXTENSION_KEYS[key].includes(field)) error(errors, `${source}.extensions.${key}`, `unknown extension field: ${field}`)
        }
      }
    }
  }

  // Evidence discipline: every cited id anywhere in the dossier must resolve.
  walkEvidenceRefs(dossier, source, evidenceIds, errors)
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation handoff
// ─────────────────────────────────────────────────────────────────────────────

/** Phase T6 semantic visual contract (consumer side). All fields are optional
 * and additive — legacy visuals without them stay valid. Shape only: whether
 * the declared stages/states/relations are actually consumed is the semantic
 * validator's job (check-visual-semantics.mjs). */
function validateVisualSemanticsFields(spec, errors, source) {
  if (spec.covers !== undefined) {
    if (!isStringArray(spec.covers)) error(errors, `${source}.covers`, 'must be an array of coverage claims when present')
    else for (const c of spec.covers) {
      if (!VISUAL_COVERAGE.includes(c)) error(errors, `${source}.covers`, `unknown coverage claim ${JSON.stringify(c)} (allowed: ${VISUAL_COVERAGE.join(', ')})`)
    }
  }
  if (spec.stage_dispositions !== undefined) {
    if (!Array.isArray(spec.stage_dispositions)) error(errors, `${source}.stage_dispositions`, 'must be an array when present')
    else spec.stage_dispositions.forEach((d, i) => {
      const at = `${source}.stage_dispositions[${i}]`
      if (!isObject(d)) { error(errors, at, 'must be a mapping'); return }
      for (const key of Object.keys(d).sort()) {
        if (!['stage', 'disposition', 'reason', 'to_visual'].includes(key)) error(errors, at, `unknown field: ${key}`)
      }
      if (!isNonempty(d.stage)) error(errors, `${at}.stage`, 'must be a non-empty stage name')
      if (!STAGE_DISPOSITIONS.includes(d.disposition)) error(errors, `${at}.disposition`, `must be one of ${STAGE_DISPOSITIONS}`)
      if (!isNonempty(d.reason)) error(errors, `${at}.reason`, 'is required — a silent drop must never look like a disposition')
      if (d.to_visual !== undefined && !isNonempty(d.to_visual)) error(errors, `${at}.to_visual`, 'must be a non-empty visual id when present')
    })
  }
  if (spec.deferred_relations !== undefined) {
    if (!Array.isArray(spec.deferred_relations)) error(errors, `${source}.deferred_relations`, 'must be an array when present')
    else spec.deferred_relations.forEach((d, i) => {
      const at = `${source}.deferred_relations[${i}]`
      if (!isObject(d)) { error(errors, at, 'must be a mapping'); return }
      for (const key of Object.keys(d).sort()) {
        if (!['from', 'to', 'kind', 'reason'].includes(key)) error(errors, at, `unknown field: ${key}`)
      }
      for (const field of ['from', 'to', 'kind', 'reason']) {
        if (!isNonempty(d[field])) error(errors, `${at}.${field}`, 'must be a non-empty string')
      }
    })
  }
}

export function validateVisualSpec(spec, errors, source) {
  if (!isObject(spec)) { error(errors, source, 'must be a mapping'); return }
  for (const key of Object.keys(spec)) {
    if (FORBIDDEN_VISUAL_KEYS.includes(key)) error(errors, `${source}.${key}`, `layout/pixel/color key "${key}" is forbidden — visual specs are semantic only`)
  }
  if (!VISUAL_KINDS.includes(spec.kind)) error(errors, `${source}.kind`, `must be one of ${VISUAL_KINDS}`)
  if (!isNonempty(spec.title)) error(errors, `${source}.title`, 'must be a non-empty string')
  if (spec.nodes !== undefined) {
    if (!Array.isArray(spec.nodes)) error(errors, `${source}.nodes`, 'must be an array when present')
    else spec.nodes.forEach((n, i) => {
      if (!isObject(n) || !isNonempty(n.id) || !isNonempty(n.label)) error(errors, `${source}.nodes[${i}]`, 'must be a mapping with non-empty id and label')
      else {
        for (const key of Object.keys(n)) if (FORBIDDEN_VISUAL_KEYS.includes(key)) error(errors, `${source}.nodes[${i}].${key}`, `layout/pixel/color key "${key}" is forbidden — visual specs are semantic only`)
        for (const field of ['mechanism_stages', 'state_refs']) {
          if (n[field] !== undefined && !isStringArray(n[field])) error(errors, `${source}.nodes[${i}].${field}`, 'must be an array of non-empty strings when present')
        }
        for (const field of ['stage_merge_reason', 'state_merge_reason']) {
          if (n[field] !== undefined && !isNonempty(n[field])) error(errors, `${source}.nodes[${i}].${field}`, 'must be a non-empty string when present')
        }
      }
    })
  }
  if (spec.edges !== undefined) {
    if (!Array.isArray(spec.edges)) error(errors, `${source}.edges`, 'must be an array when present')
    else spec.edges.forEach((e, i) => {
      if (!isObject(e) || !isNonempty(e.from) || !isNonempty(e.to)) error(errors, `${source}.edges[${i}]`, 'must be a mapping with non-empty from/to')
      else {
        for (const key of Object.keys(e)) if (FORBIDDEN_VISUAL_KEYS.includes(key)) error(errors, `${source}.edges[${i}].${key}`, `layout/pixel/color key "${key}" is forbidden — visual specs are semantic only`)
        if (e.domain !== undefined && !EDGE_DOMAINS.includes(e.domain)) error(errors, `${source}.edges[${i}].domain`, `must be one of ${EDGE_DOMAINS} when present`)
        if (e.kind !== undefined) {
          if (!isNonempty(e.kind)) error(errors, `${source}.edges[${i}].kind`, 'must be a non-empty string when present')
          else {
            const domains = e.domain !== undefined ? [e.domain] : Object.keys(EDGE_KINDS_BY_DOMAIN)
            if (!domains.some((d) => EDGE_KINDS_BY_DOMAIN[d].includes(e.kind))) {
              error(errors, `${source}.edges[${i}].kind`, `${JSON.stringify(e.kind)} is not a valid ${e.domain !== undefined ? e.domain : ''} edge kind`)
            }
          }
        }
        if (e.states !== undefined && !isStringArray(e.states)) error(errors, `${source}.edges[${i}].states`, 'must be an array of state ids when present')
      }
    })
  }
  if (spec.ordering !== undefined && !Array.isArray(spec.ordering)) error(errors, `${source}.ordering`, 'must be an array of ordering constraints when present')
  validateVisualSemanticsFields(spec, errors, source)
}

export function validateHandoff(handoff, evidenceIds, errors, source = 'handoff') {
  if (!isObject(handoff)) { error(errors, source, 'must be a mapping'); return }
  unknownFields(errors, source, handoff, ['artifact', 'schema_version', 'subject_id', 'subject_type', 'depth', 'audience',
    'learning_objectives', 'storyline', 'visuals', 'must_have_visuals', 'optional_visuals', 'canonical_example',
    'worked_examples', 'key_takeaways', 'comparisons', 'important_decisions', 'appendix_topics', 'evidence_index'])
  if (handoff.artifact !== undefined && handoff.artifact !== 'presentation_handoff') error(errors, source, 'artifact must be "presentation_handoff"')
  if (!isNonempty(handoff.subject_id)) error(errors, `${source}.subject_id`, 'must be a non-empty string')
  if (!SUBJECT_TYPES.includes(handoff.subject_type)) error(errors, `${source}.subject_type`, `must be one of ${SUBJECT_TYPES}`)
  if (handoff.depth !== undefined && !DEPTHS.includes(handoff.depth)) error(errors, `${source}.depth`, `must be one of ${DEPTHS}`)
  if (handoff.audience !== undefined && !isObject(handoff.audience)) error(errors, `${source}.audience`, 'must be a mapping when present')
  if (handoff.learning_objectives !== undefined && !isStringArray(handoff.learning_objectives)) error(errors, `${source}.learning_objectives`, 'must be an array of non-empty strings when present')
  // Storyline is a reasoning output and deliberately NOT a fixed role enum —
  // roles are free text adapted to the subject.
  if (handoff.storyline !== undefined) {
    if (!Array.isArray(handoff.storyline)) error(errors, `${source}.storyline`, 'must be an array when present')
    else handoff.storyline.forEach((step, i) => {
      const at = `${source}.storyline[${i}]`
      if (!isObject(step)) { error(errors, at, 'must be a mapping'); return }
      for (const key of Object.keys(step).sort()) {
        if (!['position', 'role', 'claim', 'dossier_section', 'evidence_refs'].includes(key)) error(errors, at, `unknown field: ${key}`)
      }
      if (!isNonempty(step.role)) error(errors, `${at}.role`, 'must be a non-empty string (adaptive, not a fixed template)')
      if (!isNonempty(step.claim)) error(errors, `${at}.claim`, 'must be a non-empty string')
      if (step.evidence_refs !== undefined && !isRefArray(step.evidence_refs)) error(errors, `${at}.evidence_refs`, 'must be an array of evidence ids when present')
    })
  }
  if (handoff.visuals !== undefined) {
    if (!Array.isArray(handoff.visuals)) error(errors, `${source}.visuals`, 'must be an array when present')
    else handoff.visuals.forEach((v, i) => validateVisualSpec(v, errors, `${source}.visuals[${i}]`))
  }
  for (const field of ['must_have_visuals', 'optional_visuals']) {
    if (handoff[field] !== undefined) {
      if (!Array.isArray(handoff[field])) error(errors, `${source}.${field}`, 'must be an array when present')
      else handoff[field].forEach((id, i) => {
        if (!isNonempty(id)) error(errors, `${source}.${field}[${i}]`, 'must be a non-empty visual id')
      })
    }
  }
  if (handoff.canonical_example !== undefined && !isObject(handoff.canonical_example)) error(errors, `${source}.canonical_example`, 'must be a mapping (summary/reference, not a full copy) when present')
  // Worked examples (Phase T5): semantic references the deck must map to
  // slides — coverage itself is enforced by the presentation manifest checker.
  if (handoff.worked_examples !== undefined) {
    if (!Array.isArray(handoff.worked_examples)) error(errors, `${source}.worked_examples`, 'must be an array when present')
    else handoff.worked_examples.forEach((we, i) => {
      const at = `${source}.worked_examples[${i}]`
      if (!isObject(we)) { error(errors, at, 'must be a mapping'); return }
      if (!isNonempty(we.id)) error(errors, `${at}.id`, 'must be a non-empty string (stable key for manifest mapping)')
      if (!isNonempty(we.title)) error(errors, `${at}.title`, 'must be a non-empty string')
      if (!isNonempty(we.summary)) error(errors, `${at}.summary`, 'must be a non-empty string (what the example shows)')
    })
  }
  if (handoff.key_takeaways !== undefined && !isStringArray(handoff.key_takeaways)) error(errors, `${source}.key_takeaways`, 'must be an array of non-empty strings when present')
  if (handoff.appendix_topics !== undefined && !isStringArray(handoff.appendix_topics)) error(errors, `${source}.appendix_topics`, 'must be an array of non-empty strings when present')
  if (handoff.evidence_index !== undefined) {
    if (!Array.isArray(handoff.evidence_index)) error(errors, `${source}.evidence_index`, 'must be an array when present')
    else handoff.evidence_index.forEach((e, i) => {
      if (!isObject(e) || !isNonempty(e.id)) error(errors, `${source}.evidence_index[${i}]`, 'must be a mapping with a non-empty id')
    })
  }

  // Evidence discipline: every cited id anywhere in the handoff must resolve.
  walkEvidenceRefs(handoff, source, evidenceIds, errors)
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness report + mechanical gate
// ─────────────────────────────────────────────────────────────────────────────

export function validateReadinessReport(report, errors, source = 'readiness') {
  if (!isObject(report)) { error(errors, source, 'must be a mapping'); return }
  if (report.artifact !== undefined && report.artifact !== 'readiness_report') error(errors, source, 'artifact must be "readiness_report"')
  if (!isNonempty(report.subject_id)) error(errors, `${source}.subject_id`, 'must be a non-empty string')
  if (report.mechanical !== undefined) {
    const m = report.mechanical
    if (!isObject(m)) error(errors, `${source}.mechanical`, 'must be a mapping')
    else if (m.verdict !== undefined && !['pass', 'fail'].includes(m.verdict)) error(errors, `${source}.mechanical.verdict`, 'must be pass | fail')
  }
  if (report.semantic_review !== undefined) {
    const s = report.semantic_review
    if (!isObject(s)) error(errors, `${source}.semantic_review`, 'must be a mapping')
    else {
      if (s.verdict !== undefined && !['ready', 'not_ready'].includes(s.verdict)) error(errors, `${source}.semantic_review.verdict`, 'must be ready | not_ready')
      if (s.audience_questions !== undefined) {
        if (!Array.isArray(s.audience_questions)) error(errors, `${source}.semantic_review.audience_questions`, 'must be an array')
        else s.audience_questions.forEach((q, i) => {
          if (!isObject(q) || !isNonempty(q.question)) error(errors, `${source}.semantic_review.audience_questions[${i}]`, 'must be a mapping with a non-empty question')
          else if (typeof q.sufficient !== 'boolean') error(errors, `${source}.semantic_review.audience_questions[${i}].sufficient`, 'must be a boolean')
        })
      }
    }
  }
  if (report.verdict !== undefined && !['ready', 'not_ready'].includes(report.verdict)) error(errors, `${source}.verdict`, 'must be ready | not_ready')
}

export const AUDIENCE_QUESTIONS = [
  '它是什么？',
  '为什么存在？',
  '它处在什么上下文？',
  '输入和输出是什么？',
  '核心机制是什么？',
  '哪些状态最重要？',
  '哪些决策决定行为？',
  '与哪些组件交互？',
  '什么情况下不能工作或选择另一条路径？',
  '最值得记住的 3～5 点是什么？',
]

/** Subject-type-adaptive semantic questions appended to the generic ten. */
export function semanticQuestionsFor(subjectType) {
  const specific = {
    pass: ['Pass 在 pipeline 的哪个位置，前后的 IR 形态是什么？', '合法性条件是什么，什么情况下拒绝改写？'],
    function: ['参数、返回值和前置条件是什么？', '有哪些副作用和调用者/被调用者？'],
    algorithm: ['迭代过程和不变量是什么？', '终止条件和复杂度是什么？'],
    class: ['对象的生命周期和拥有的状态是什么？', '公共接口和协作对象是什么？'],
    subsystem: ['组件边界和端到端流程是什么？', '外部接口和所有权边界是什么？'],
    pipeline: ['阶段顺序的证据是什么？', '表示形态在哪些边界发生转换？'],
    workflow: ['参与者之间的契约是什么？', '整体流程中哪些步骤可能失败？'],
    component_group: ['组件之间如何交互（谁驱动谁）？', '数据如何在组件之间流动？'],
    data_structure: ['表示形式和不变量是什么？', '支持哪些操作，成本如何？'],
    module: ['模块的职责和公共 API 是什么？', '依赖方向是什么？'],
    other: [],
  }
  return [...AUDIENCE_QUESTIONS, ...(specific[subjectType] || [])]
}

function check(name, status, detail) {
  return { name, status, detail }
}

/**
 * Mechanical readiness preconditions for one bundle. This is the deterministic
 * floor only: a pass here does NOT mean ready — READY additionally requires
 * the recorded semantic review (audience comprehension) to conclude ready.
 */
export function computeMechanicalReadiness({ subject, evidence, dossier, handoff, composition }, { depth = 'standard', imports = [] } = {}) {
  const checks = []
  const errors = []
  const evidenceIds = validateEvidenceLedger(evidence, errors, 'evidence')
  // Composition id space (Phase T3): parent ledger ids + namespaced child
  // refs (`alias::EV-ID`) resolved through declared imports. Without imports
  // this behaves exactly like the v1 parent-only resolution.
  const parentClasses = new Map((evidence?.records || [])
    .filter((r) => r !== null && typeof r === 'object' && isNonempty(r.id))
    .map((r) => [r.id, r.class]))
  const idSpace = makeEvidenceIdSpace(parentClasses, imports)
  if (subject) validateSubject(subject, errors, 'subject')
  if (dossier) withEvidenceIndex(dossier, evidence || {}, idSpace)
  if (dossier) validateDossier(dossier, idSpace, errors, 'dossier')
  if (handoff) validateHandoff(handoff, idSpace, errors, 'handoff')
  const schemaFails = errors.filter((e) => !e.includes('readiness policy'))
  checks.push(check('schema_valid', schemaFails.length === 0 ? 'pass' : 'fail', schemaFails.length === 0 ? 'subject/evidence/dossier/handoff shapes valid' : schemaFails.slice(0, 10).join('; ')))
  if (!dossier) {
    checks.push(check('dossier_present', 'fail', 'teaching dossier missing'))
    return finish(checks)
  }

  const d = dossier.depth || depth
  const requireExample = EXAMPLE_REQUIRED_TYPES.includes(dossier.subject_type) && d !== 'overview'

  // Identity & purpose & mental model.
  checks.push(check('identity', subject && isNonempty(subject.name) && isNonempty(subject.subject_type) ? 'pass' : 'fail', subject ? `subject ${subject.subject_type}:${subject.name}` : 'subject missing'))
  const whyPresent = isNonempty(dossier.need) || isNonempty(dossier.purpose)
  checks.push(check('purpose_explained', whyPresent ? 'pass' : 'fail', whyPresent ? 'need/purpose present' : 'need (or purpose) missing — the why-model must start from a need'))
  const mm = assessMentalModel(dossier.mental_model)
  if (!mm.present) checks.push(check('mental_model', 'fail', 'mental_model missing — analysis depth is insufficient without it'))
  else if (mm.symbol_dump) checks.push(check('mental_model', 'fail', `mental_model reads as a symbol dump (identifier density ${Math.round(mm.identifier_density * 100)}%) — rewrite in domain language, then let the semantic review judge quality`))
  else if (mm.too_long) checks.push(check('mental_model', 'warn', `mental_model has ${mm.sentences} sentences (target 1–3)`))
  else checks.push(check('mental_model', 'pass', `${mm.sentences} sentence(s), identifier density ${Math.round(mm.identifier_density * 100)}%`))

  // Context (causal, both sides) + inputs/outputs or equivalent contracts.
  const ctx = dossier.system_context || {}
  const up = (ctx.upstream || []).concat(ctx.triggers || [])
  const down = ctx.downstream || []
  const ctxOk = up.length > 0 && down.length > 0
  checks.push(check('system_context', ctxOk ? 'pass' : 'fail', ctxOk ? `${up.length} upstream/trigger, ${down.length} downstream entries` : 'system_context needs at least one upstream/trigger AND one downstream entry (who triggers me / who relies on me)'))
  const ioOk = (dossier.inputs?.length || 0) > 0 || (dossier.outputs?.length || 0) > 0 || (dossier.contracts?.length || 0) > 0
  checks.push(check('inputs_outputs', ioOk ? 'pass' : 'fail', ioOk ? 'inputs/outputs/contracts present' : 'no inputs, outputs, or contracts — the interface is unexplained'))

  // Mechanism.
  const stages = dossier.mechanism?.stages || []
  checks.push(check('mechanism', stages.length > 0 ? 'pass' : 'fail', stages.length > 0 ? `${stages.length} source-derived stages` : 'mechanism.stages missing — source-order narration is not a mechanism model'))

  // Views coherence (deep/presentation).
  if (d === 'deep' || d === 'presentation') {
    const viewsOk = (dossier.implementation_view?.length || 0) > 0 && (dossier.conceptual_view?.length || 0) > 0
    checks.push(check('two_views', viewsOk ? 'pass' : (d === 'presentation' ? 'fail' : 'warn'), viewsOk ? 'implementation and conceptual views present' : 'implementation_view and conceptual_view are required at this depth'))
  }

  // Canonical example when useful. At presentation depth a pass/algorithm/
  // pipeline/… example must be a WORKED example: an ordered step trace the
  // audience can follow, not just a provenance pointer (Phase T5).
  if (requireExample) {
    const ex = dossier.canonical_example
    const hasProvenance = ex && isObject(ex.provenance) && isNonempty(ex.provenance.source)
    const stepCount = ex ? ((ex.execution_trace || []).length + (ex.steps || []).length) : 0
    const ok = hasProvenance && (d !== 'presentation' || stepCount >= 3)
    checks.push(check('canonical_example', ok ? 'pass' : 'fail',
      ok ? `example from ${ex.provenance.kind} (${stepCount} step${stepCount === 1 ? '' : 's'})`
         : hasProvenance
           ? `presentation depth requires a worked example with ≥3 trace steps, got ${stepCount}`
           : `canonical_example required for ${dossier.subject_type} at depth ${d}`))
  } else {
    checks.push(check('canonical_example', 'not_applicable', `optional for ${dossier.subject_type}`))
  }

  // State transitions only when mutable state was declared.
  const mutable = dossier.mechanism?.mutable_state === true
  if (mutable) {
    const st = dossier.state_transitions || []
    checks.push(check('state_transitions', st.length > 0 ? 'pass' : 'fail', st.length > 0 ? `${st.length} transitions` : 'mechanism.mutable_state=true but state_transitions is empty'))
  } else {
    checks.push(check('state_transitions', 'not_applicable', 'subject declares no significant mutable state — no fabricated transitions required'))
  }

  // Decisions when important branching was declared.
  const branching = dossier.mechanism?.has_important_branching === true
  if (branching) {
    const dec = dossier.decisions || []
    checks.push(check('decisions', dec.length > 0 ? 'pass' : 'fail', dec.length > 0 ? `${dec.length} decisions` : 'mechanism.has_important_branching=true but decisions is empty — the branching that decides behavior is unexplained'))
  } else {
    checks.push(check('decisions', 'not_applicable', 'no important branching declared'))
  }

  // Constraints & boundaries & takeaways.
  const constraintsOk = (dossier.constraints?.length || 0) + (dossier.invariants?.length || 0) > 0
  checks.push(check('constraints', constraintsOk ? 'pass' : (d === 'overview' ? 'warn' : 'fail'), constraintsOk ? `${(dossier.constraints?.length || 0)} constraints, ${(dossier.invariants?.length || 0)} invariants` : 'constraints/invariants missing'))
  const boundariesOk = (dossier.boundaries?.length || 0) > 0
  checks.push(check('boundaries', boundariesOk ? 'pass' : (d === 'overview' ? 'warn' : 'fail'), boundariesOk ? `${dossier.boundaries.length} boundary entries` : 'boundaries missing'))
  const kt = dossier.key_takeaways || []
  checks.push(check('key_takeaways', kt.length >= 3 && kt.length <= 5 ? 'pass' : (kt.length === 0 ? 'fail' : 'warn'), kt.length === 0 ? 'key_takeaways missing' : `${kt.length} takeaways`))

  // Evidence discipline.
  const factCount = (evidence?.records || []).filter((r) => FACT_CLASSES.includes(r.class)).length
  checks.push(check('fact_evidence', factCount > 0 ? 'pass' : 'fail', factCount > 0 ? `${factCount} fact-class evidence records` : 'no fact-class evidence (source/graph/runtime/historical) — the dossier would rest on reasoning alone'))
  const refOk = schemaFails.every((e) => !e.includes('evidence_ref not found') && !e.includes('evidence_refs with at least one id') && !e.includes('cites only non-fact'))
  checks.push(check('claims_trace_to_evidence', refOk ? 'pass' : 'fail', refOk ? 'all explanation primitives cite ledger evidence' : 'some primitives cite missing/insufficient evidence (see schema_valid detail)'))

  // Placement (why here) — warn when missing at deep/presentation for types
  // that have system placement; not_applicable is explicit in the dossier.
  if (d === 'deep' || d === 'presentation') {
    if (dossier.placement === undefined) checks.push(check('placement', 'warn', 'placement (why here / why this boundary) absent — add it or mark placement.applicable=false with status not_applicable'))
    else checks.push(check('placement', 'pass', dossier.placement.applicable === false ? 'explicitly not applicable' : 'placement explained'))
  }

  // Type extension requirements (only for the declared type).
  checks.push(...extensionChecks(dossier))

  // Handoff (presentation depth requires it with a storyline).
  if (d === 'presentation') {
    const story = handoff?.storyline || []
    const visuals = handoff?.visuals || []
    const must = handoff?.must_have_visuals || []
    const visualsOk = must.every((id) => visuals.some((v) => v.id === id))
    checks.push(check('handoff_storyline', story.length >= 3 ? 'pass' : 'fail', story.length >= 3 ? `${story.length} storyline steps` : 'handoff.storyline needs ≥3 adaptive steps'))
    checks.push(check('handoff_visuals', (handoff ? (visualsOk && visuals.length > 0) : false) ? 'pass' : 'fail', handoff ? (visualsOk ? `${visuals.length} visual specs` : 'must_have_visuals reference undefined visual ids') : 'presentation handoff missing'))
    checks.push(check('handoff_takeaways', (handoff?.key_takeaways?.length || 0) > 0 ? 'pass' : 'fail', handoff?.key_takeaways?.length ? `${handoff.key_takeaways.length} takeaways` : 'handoff.key_takeaways missing'))
  } else if (handoff) {
    checks.push(check('handoff_optional', 'pass', 'handoff present at non-presentation depth'))
  }

  // Semantic visual fidelity (Phase T6): the semantics the producer declared
  // (stage model, state lifecycles, control relations) must be consumed by the
  // visuals, and no visual may contradict a declared lifecycle. Obligations
  // bind to visual coverage claims, so legacy bundles without claims stay valid.
  if (handoff) {
    const sem = checkVisualSemantics({ dossier, handoff })
    const detail = sem.verdict === 'pass'
      ? `semantic visual contract ok${sem.warnings.length > 0 ? ` (${sem.warnings.length} warning${sem.warnings.length === 1 ? '' : 's'})` : ''}${sem.recommendations.length > 0 ? ` — ${sem.recommendations.length} SPLIT_RECOMMENDED` : ''}`
      : sem.errors.slice(0, 5).map((e) => `${e.check}: ${e.detail}`).join('; ')
    checks.push(check('visual_semantics', sem.verdict === 'pass' ? 'pass' : 'fail', detail))
  }

  // Composition-specific mechanical floor (Phase T3): only when the bundle
  // carries composition.json. Checks requested-component coverage, bridge
  // evidence (including namespaced child refs), conflicts, representation
  // boundaries, and the end-to-end flow skeleton.
  if (composition !== undefined) {
    checks.push(...compositionChecks({ composition, dossier, idSpace }, { depth: d }))
  }

  return finish(checks)
}

function extensionChecks(dossier) {
  const type = dossier.subject_type
  const ext = dossier.extensions?.[type]
  const fail = (name, detail) => check(name, 'fail', detail)
  const pass = (name, detail) => check(name, 'pass', detail)
  switch (type) {
    case 'pass': {
      if (!ext) return [fail('extension_pass', 'pass subject without extensions.pass — pipeline placement, IR contract, and legality/rewrite rationale are required pass context')]
      const placements = ext.pipeline_placements
      const hasPlacement = Array.isArray(placements) ? placements.length > 0 : isNonempty(placements)
      if (!hasPlacement) return [fail('extension_pass', 'extensions.pass.pipeline_placements missing')]
      const hasIr = ext.ir_contract !== undefined
      const hasLegalityOrRewrite = ext.legality !== undefined || ext.rewrite !== undefined
      if (!hasIr || !hasLegalityOrRewrite) return [fail('extension_pass', 'extensions.pass needs ir_contract and legality/rewrite')]
      return [pass('extension_pass', 'pipeline placement + IR contract + legality/rewrite present')]
    }
    case 'function': {
      if (!ext) return [fail('extension_function', 'function subject without extensions.function — parameters, return values, and callers/callees are required')]
      const ok = (Array.isArray(ext.parameters) ? ext.parameters.length > 0 : isNonempty(ext.parameters))
        && (Array.isArray(ext.return_values) ? ext.return_values.length > 0 : isNonempty(ext.return_values))
        && (ext.callers !== undefined || ext.callees !== undefined)
      return [ok ? pass('extension_function', 'parameters, returns, callers/callees present') : fail('extension_function', 'extensions.function needs parameters, return_values, and callers or callees')]
    }
    case 'algorithm': {
      if (!ext) return [fail('extension_algorithm', 'algorithm subject without extensions.algorithm — iteration, termination, and complexity are required')]
      const ok = isNonempty(ext.iteration) && isNonempty(ext.termination) && ext.complexity !== undefined
      return [ok ? pass('extension_algorithm', 'iteration, termination, complexity present') : fail('extension_algorithm', 'extensions.algorithm needs iteration, termination, complexity')]
    }
    case 'class': {
      if (!ext) return [fail('extension_class', 'class subject without extensions.class — lifecycle and collaborators are required')]
      const ok = isNonempty(ext.lifecycle) && (ext.collaborators !== undefined) && (ext.owned_state !== undefined || ext.public_api !== undefined)
      return [ok ? pass('extension_class', 'lifecycle, state/api, collaborators present') : fail('extension_class', 'extensions.class needs lifecycle, collaborators, and owned_state or public_api')]
    }
    case 'subsystem': {
      if (!ext) return [fail('extension_subsystem', 'subsystem subject without extensions.subsystem — components and external interfaces are required')]
      const comps = Array.isArray(ext.components) ? ext.components.length > 0 : isNonempty(ext.components)
      const ifaces = Array.isArray(ext.external_interfaces) ? ext.external_interfaces.length > 0 : isNonempty(ext.external_interfaces)
      return [comps && ifaces ? pass('extension_subsystem', 'components + external interfaces present') : fail('extension_subsystem', 'extensions.subsystem needs components and external_interfaces')]
    }
    default:
      return ext === undefined ? [check(`extension_${type}`, 'not_applicable', `no required extension for ${type}`)] : [pass(`extension_${type}`, 'extension present')]
  }
}

function finish(checks) {
  const failed = checks.filter((c) => c.status === 'fail')
  return { checks, verdict: failed.length === 0 ? 'pass' : 'fail', failures: failed.map((c) => `${c.name}: ${c.detail}`) }
}

/**
 * Full readiness verdict: mechanical pass AND recorded semantic review that
 * concludes ready. Encodes Goal §30/§31 — field completeness is never enough.
 */
export function computeReadiness(bundle, options = {}) {
  const mechanical = computeMechanicalReadiness(bundle, options)
  const semantic = bundle.readiness?.semantic_review
  let verdict = 'not_ready'
  const reasons = []
  if (mechanical.verdict !== 'pass') reasons.push(...mechanical.failures)
  if (semantic === undefined) {
    reasons.push('semantic review missing — mechanical pass alone never yields READY (audience comprehension must be recorded)')
  } else if (semantic.verdict !== 'ready') {
    reasons.push('semantic review concluded not_ready')
  } else {
    const unsufficient = (semantic.audience_questions || []).filter((q) => q.sufficient === false)
    if (unsufficient.length > 0) reasons.push(`semantic review marked ${unsufficient.length} audience question(s) insufficient`)
    else if ((semantic.audience_questions || []).length < AUDIENCE_QUESTIONS.length) reasons.push(`semantic review covers ${(semantic.audience_questions || []).length}/${AUDIENCE_QUESTIONS.length} generic audience questions`)
    else if (mechanical.verdict === 'pass') verdict = 'ready'
  }
  if (bundle.readiness?.stale?.stale === true) {
    verdict = 'not_ready'
    reasons.push('artifact is stale: analyzed source changed since analysis')
  }
  return { mechanical, verdict, reasons }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle assembly + staleness
// ─────────────────────────────────────────────────────────────────────────────

/** Read and validate a bundle object {subject, evidence, dossier, handoff,
 * readiness, composition?}. `imports` (optional) carries resolved child
 * evidence class maps so namespaced `alias::EV-ID` references resolve. */
export function validateBundle(bundle, { imports = [] } = {}) {
  const errors = []
  const evidenceIds = validateEvidenceLedger(bundle.evidence, errors, 'evidence')
  const parentClasses = new Map(((bundle.evidence && bundle.evidence.records) || [])
    .filter((r) => r !== null && typeof r === 'object' && isNonempty(r.id))
    .map((r) => [r.id, r.class]))
  const idSpace = makeEvidenceIdSpace(parentClasses, imports)
  if (bundle.subject) validateSubject(bundle.subject, errors, 'subject')
  if (bundle.dossier) {
    withEvidenceIndex(bundle.dossier, bundle.evidence || {}, idSpace)
    validateDossier(bundle.dossier, idSpace, errors, 'dossier')
  }
  if (bundle.handoff) validateHandoff(bundle.handoff, idSpace, errors, 'handoff')
  if (bundle.readiness) validateReadinessReport(bundle.readiness, errors, 'readiness')
  if (bundle.composition) validateComposition(bundle.composition, errors, 'composition')
  return { errors, evidenceIds }
}

/** Deterministic staleness: HEAD drift + per-file content hash comparison. */
export function computeStaleness({ provenance, currentHead, currentFileHashes }) {
  const staleFiles = []
  const previous = new Map((provenance?.source_files || []).map((f) => [f.path, f.sha256]))
  for (const [path, hash] of Object.entries(currentFileHashes || {})) {
    const before = previous.get(path)
    if (before !== undefined && before !== hash) staleFiles.push(path)
  }
  const headStale = isNonempty(provenance?.head) && isNonempty(currentHead) && provenance.head !== currentHead
  return { stale: headStale || staleFiles.length > 0, head_stale: headStale, stale_files: staleFiles, head_at_analysis: provenance?.head, head_now: currentHead }
}

/** Subject id slug from a name. */
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'subject'
}

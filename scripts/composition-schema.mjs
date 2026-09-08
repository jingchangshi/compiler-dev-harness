/**
 * System Story Composition — schema validators and the mechanical part of the
 * composition-readiness gate (Phase T3).
 *
 * Ownership model (extends ARCHITECTURE §15/§17/§18):
 *   - A system story is NOT a new knowledge layer. It is a normal Teaching
 *     Artifact Protocol v1 bundle (subject / evidence / dossier / handoff /
 *     readiness) whose subject_type is workflow, component_group, subsystem,
 *     or pipeline, PLUS one lightweight composition provenance artifact
 *     (`composition.json`) that records: which requested components it covers
 *     and with what disposition, which READY child bundles it consumed (with
 *     hashes), which context-only nodes fill the flow, which cross-component
 *     bridges connect the components (each with its own evidence), which
 *     representation boundaries the system crosses, and which composition
 *     conflicts are still open.
 *   - Child bundles are the semantic source: composition consumes their
 *     recorded knowledge, it never restates it. Cross-component claims cite
 *     either fresh composition-level evidence (parent ledger) or child
 *     evidence through a namespaced reference `alias::EV-ID` resolved via the
 *     `imports` block — never by copying child evidence into the parent
 *     ledger.
 *   - This module is PURE (no I/O): bundle reading, child-hash checks, and
 *     import resolution live in the drivers. The evidence id space they build
 *     is passed in here.
 *
 * Anti-overfitting invariants (same rule as teaching-schema.mjs):
 *   - Relation names, contract forms, and representation names are free text —
 *     no compiler-only enum. The model must fit function/class/algorithm/
 *     scheduler/runtime/subsystem/workflow compositions, not only passes.
 *   - No subject-specific concept (any concrete pass, class, subsystem, or
 *     domain term) may appear in this module — dogfood specifics live
 *     exclusively in artifact data.
 *
 * Node-only, stdlib. Style follows scripts/teaching-schema.mjs.
 */

export const COMPOSITION_SCHEMA_VERSION = 1

export const ARTIFACT_COMPOSITION = 'composition'

/** §29: every requested component gets an explicit disposition — never a
 * silent drop. */
export const DISPOSITIONS = ['core', 'supporting', 'context', 'appendix', 'excluded']

/** §24: control flow and data flow are judged per bridge, never merged into
 * one arrow kind. */
export const FLOW_TYPES = ['data_flow', 'control_flow']

/** §8: a bridge either cites fact-class evidence or is explicitly marked as
 * reasoning/hypothesis/unknown. */
export const EPISTEMIC_STATUSES = ['fact', 'reasoning', 'hypothesis', 'unknown']

export const CONFLICT_STATUSES = ['open', 'resolved']

export const COMPOSITION_TYPES = ['workflow', 'component_group', 'subsystem', 'pipeline']

const COMPOSITION_KEYS = [
  'artifact', 'schema_version', 'system_subject_id', 'requested_components',
  'components', 'context_nodes', 'bridges', 'representation_boundaries',
  'imports', 'conflicts', 'composed_at', 'repository', 'source_head', 'notes',
]

const COMPONENT_KEYS = [
  'component_id', 'requested_as', 'disposition', 'role', 'child_bundle',
  'child_subject_id', 'child_presentation_dir', 'reason',
]

const CONTEXT_NODE_KEYS = ['node_id', 'role', 'note', 'evidence_refs']

const BRIDGE_KEYS = [
  'bridge_id', 'from', 'to', 'relation', 'flow_type', 'contract',
  'ordering_matters', 'why_order_matters', 'representation_before',
  'representation_after', 'evidence_refs', 'epistemic_status', 'confidence',
  'unresolved', 'unresolved_reason',
]

const REPRESENTATION_BOUNDARY_KEYS = ['boundary_id', 'before', 'after', 'where', 'evidence_refs']

const IMPORT_KEYS = ['alias', 'bundle', 'subject_id', 'evidence_sha256', 'head']

const CONFLICT_KEYS = [
  'conflict_id', 'kind', 'description', 'involved', 'status', 'resolution', 'evidence_refs',
]

const isNonempty = (v) => typeof v === 'string' && v.trim() !== ''
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStringArray = (v) => Array.isArray(v) && v.every(isNonempty)
const isRefArray = (v) => Array.isArray(v) && v.every((r) => typeof r === 'string' && r.trim() !== '')
const isSha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isSlug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(v)

function error(errors, source, message) {
  errors.push(`${source}: ${message}`)
}

function unknownFields(errors, source, value, allowed) {
  if (!isObject(value)) return
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) error(errors, source, `unknown field: ${key}`)
  }
}

/** Namespaced reference syntax: `<alias>::<child-evidence-id>`. */
export function parseNamespacedRef(ref) {
  if (!isNonempty(ref)) return undefined
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)::(.+)$/.exec(ref)
  return m ? { alias: m[1], id: m[2] } : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence id space (parent ledger ∪ declared child imports)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the evidence id space for one bundle. Plain ids resolve against the
 * parent ledger class map; `alias::id` namespaced ids resolve through the
 * resolved import entries (each carrying the child ledger's class map). Pure:
 * the caller (driver) does the I/O and passes resolved child class maps in.
 *
 * parentClasses: Map<id, class>
 * imports: [{ alias, bundle, subject_id, evidence_sha256?, head?, classes: Map<id, class>, dir? }]
 */
export function makeEvidenceIdSpace(parentClasses, imports = []) {
  const byAlias = new Map()
  for (const imp of imports || []) {
    if (isObject(imp) && isNonempty(imp.alias)) byAlias.set(imp.alias, imp)
  }
  const classes = (map, id) => (map instanceof Map ? map.get(id) : undefined)
  return {
    parent: parentClasses,
    imports: byAlias,
    has(ref) {
      if (parentClasses.has(ref)) return true
      const ns = parseNamespacedRef(ref)
      if (!ns) return false
      const imp = byAlias.get(ns.alias)
      return imp !== undefined && imp.classes instanceof Map && imp.classes.has(ns.id)
    },
    classOf(ref) {
      const direct = classes(parentClasses, ref)
      if (direct !== undefined) return direct
      const ns = parseNamespacedRef(ref)
      if (!ns) return undefined
      const imp = byAlias.get(ns.alias)
      return imp ? classes(imp.classes, ns.id) : undefined
    },
    importFor(ref) {
      const ns = parseNamespacedRef(ref)
      return ns ? byAlias.get(ns.alias) : undefined
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// composition.json validator (shape only; cross-checks live in compositionChecks)
// ─────────────────────────────────────────────────────────────────────────────

export function validateComposition(composition, errors, source = 'composition') {
  if (!isObject(composition)) { error(errors, source, 'must be a mapping'); return }
  unknownFields(errors, source, composition, COMPOSITION_KEYS)
  if (composition.artifact !== undefined && composition.artifact !== ARTIFACT_COMPOSITION) {
    error(errors, source, `artifact must be "${ARTIFACT_COMPOSITION}"`)
  }
  if (composition.schema_version !== undefined && composition.schema_version !== COMPOSITION_SCHEMA_VERSION) {
    error(errors, source, `schema_version must be ${COMPOSITION_SCHEMA_VERSION}`)
  }
  if (!isSlug(composition.system_subject_id)) error(errors, `${source}.system_subject_id`, 'must be a lowercase slug ([a-z0-9-])')
  if (!isStringArray(composition.requested_components) || composition.requested_components.length === 0) {
    error(errors, `${source}.requested_components`, 'must be a non-empty array of component names')
  }
  if (!Array.isArray(composition.components)) error(errors, `${source}.components`, 'must be an array')
  else composition.components.forEach((c, i) => {
    const at = `${source}.components[${i}]`
    if (!isObject(c)) { error(errors, at, 'must be a mapping'); return }
    unknownFields(errors, at, c, COMPONENT_KEYS)
    if (!isSlug(c.component_id)) error(errors, `${at}.component_id`, 'must be a lowercase slug')
    if (!isNonempty(c.requested_as)) error(errors, `${at}.requested_as`, 'must be a non-empty string (the exact requested component name it accounts for)')
    if (!DISPOSITIONS.includes(c.disposition)) error(errors, `${at}.disposition`, `must be one of ${DISPOSITIONS}`)
    if (!isNonempty(c.role) && ['core', 'supporting', 'context'].includes(c.disposition)) {
      error(errors, `${at}.role`, `is required for disposition "${c.disposition}" (a system-level role, not a local-algorithm description)`)
    }
    if (['core', 'supporting'].includes(c.disposition)) {
      if (!isNonempty(c.child_bundle)) error(errors, `${at}.child_bundle`, `is required for disposition "${c.disposition}" (the READY child bundle this component consumes)`)
    }
    if (['excluded', 'appendix'].includes(c.disposition) && !isNonempty(c.reason)) {
      error(errors, `${at}.reason`, `is required for disposition "${c.disposition}" — a requested component is never dropped silently`)
    }
    if (c.child_bundle !== undefined && !isNonempty(c.child_bundle)) error(errors, `${at}.child_bundle`, 'must be a non-empty string when present')
    if (c.child_subject_id !== undefined && !isNonempty(c.child_subject_id)) error(errors, `${at}.child_subject_id`, 'must be a non-empty string when present')
    if (c.child_presentation_dir !== undefined && !isNonempty(c.child_presentation_dir)) error(errors, `${at}.child_presentation_dir`, 'must be a non-empty string when present')
    if (c.reason !== undefined && !isNonempty(c.reason)) error(errors, `${at}.reason`, 'must be a non-empty string when present')
  })
  if (composition.context_nodes !== undefined) {
    if (!Array.isArray(composition.context_nodes)) error(errors, `${source}.context_nodes`, 'must be an array when present')
    else composition.context_nodes.forEach((n, i) => {
      const at = `${source}.context_nodes[${i}]`
      if (!isObject(n)) { error(errors, at, 'must be a mapping'); return }
      unknownFields(errors, at, n, CONTEXT_NODE_KEYS)
      if (!isSlug(n.node_id)) error(errors, `${at}.node_id`, 'must be a lowercase slug')
      if (!isNonempty(n.role)) error(errors, `${at}.role`, 'must be a non-empty string (what this context-only stage contributes to the flow)')
      if (n.note !== undefined && !isNonempty(n.note)) error(errors, `${at}.note`, 'must be a non-empty string when present')
      if (n.evidence_refs !== undefined && !isRefArray(n.evidence_refs)) error(errors, `${at}.evidence_refs`, 'must be an array of evidence ids when present')
    })
  }
  if (composition.bridges !== undefined) {
    if (!Array.isArray(composition.bridges)) error(errors, `${source}.bridges`, 'must be an array when present')
    else composition.bridges.forEach((b, i) => {
      const at = `${source}.bridges[${i}]`
      if (!isObject(b)) { error(errors, at, 'must be a mapping'); return }
      unknownFields(errors, at, b, BRIDGE_KEYS)
      if (!isSlug(b.bridge_id)) error(errors, `${at}.bridge_id`, 'must be a lowercase slug')
      if (!isNonempty(b.from)) error(errors, `${at}.from`, 'must be a non-empty component/context node id')
      if (!isNonempty(b.to)) error(errors, `${at}.to`, 'must be a non-empty component/context node id')
      if (!isNonempty(b.relation)) error(errors, `${at}.relation`, 'must be a non-empty free-text relation (no fixed enum)')
      if (!FLOW_TYPES.includes(b.flow_type)) error(errors, `${at}.flow_type`, `must be one of ${FLOW_TYPES} — control flow and data flow are judged separately`)
      if (!isNonempty(b.contract)) error(errors, `${at}.contract`, 'is required — an arrow without a transferred contract explains nothing')
      if (b.ordering_matters !== undefined && typeof b.ordering_matters !== 'boolean') error(errors, `${at}.ordering_matters`, 'must be a boolean when present')
      if (b.why_order_matters !== undefined && !isNonempty(b.why_order_matters)) error(errors, `${at}.why_order_matters`, 'must be a non-empty string when present')
      for (const field of ['representation_before', 'representation_after']) {
        if (b[field] !== undefined && !isNonempty(b[field])) error(errors, `${at}.${field}`, 'must be a non-empty string when present')
      }
      if (!isRefArray(b.evidence_refs) || b.evidence_refs.length === 0) {
        error(errors, `${at}.evidence_refs`, 'with at least one id is required — a bridge asserted without evidence is forbidden')
      }
      if (!EPISTEMIC_STATUSES.includes(b.epistemic_status)) {
        error(errors, `${at}.epistemic_status`, `must be one of ${EPISTEMIC_STATUSES} (fact requires fact-class evidence; otherwise say reasoning/hypothesis/unknown)`)
      }
      if (b.confidence !== undefined && !['high', 'medium', 'low'].includes(b.confidence)) {
        error(errors, `${at}.confidence`, 'must be high | medium | low when present')
      }
      if (b.unresolved !== undefined && typeof b.unresolved !== 'boolean') error(errors, `${at}.unresolved`, 'must be a boolean when present')
      if (b.unresolved === true && !isNonempty(b.unresolved_reason)) {
        error(errors, `${at}.unresolved_reason`, 'is required when unresolved=true')
      }
    })
  }
  if (composition.representation_boundaries !== undefined) {
    if (!Array.isArray(composition.representation_boundaries)) error(errors, `${source}.representation_boundaries`, 'must be an array when present')
    else composition.representation_boundaries.forEach((r, i) => {
      const at = `${source}.representation_boundaries[${i}]`
      if (!isObject(r)) { error(errors, at, 'must be a mapping'); return }
      unknownFields(errors, at, r, REPRESENTATION_BOUNDARY_KEYS)
      if (!isSlug(r.boundary_id)) error(errors, `${at}.boundary_id`, 'must be a lowercase slug')
      if (!isNonempty(r.before)) error(errors, `${at}.before`, 'is required — what representation exists before the boundary')
      if (!isNonempty(r.after)) error(errors, `${at}.after`, 'is required — what representation exists after the boundary')
      if (!isNonempty(r.where)) error(errors, `${at}.where`, 'is required — which component boundary this transition sits at')
      if (!isRefArray(r.evidence_refs) || r.evidence_refs.length === 0) {
        error(errors, `${at}.evidence_refs`, 'with at least one id is required — a representation boundary claimed without evidence is forbidden')
      }
    })
  }
  if (composition.imports !== undefined) {
    if (!Array.isArray(composition.imports)) error(errors, `${source}.imports`, 'must be an array when present')
    else composition.imports.forEach((imp, i) => {
      const at = `${source}.imports[${i}]`
      if (!isObject(imp)) { error(errors, at, 'must be a mapping'); return }
      unknownFields(errors, at, imp, IMPORT_KEYS)
      if (!isSlug(imp.alias)) error(errors, `${at}.alias`, 'must be a lowercase slug (used as `<alias>::<child-evidence-id>`)')
      if (!isNonempty(imp.bundle)) error(errors, `${at}.bundle`, 'must be a non-empty child bundle directory name')
      if (!isNonempty(imp.subject_id)) error(errors, `${at}.subject_id`, 'must be a non-empty child subject id')
      if (imp.evidence_sha256 !== undefined && !isSha256(imp.evidence_sha256)) error(errors, `${at}.evidence_sha256`, 'must be a hex sha256 of the child evidence.json')
      if (imp.head !== undefined && !isNonempty(imp.head)) error(errors, `${at}.head`, 'must be a non-empty string when present')
    })
  }
  if (composition.conflicts !== undefined) {
    if (!Array.isArray(composition.conflicts)) error(errors, `${source}.conflicts`, 'must be an array when present')
    else composition.conflicts.forEach((cf, i) => {
      const at = `${source}.conflicts[${i}]`
      if (!isObject(cf)) { error(errors, at, 'must be a mapping'); return }
      unknownFields(errors, at, cf, CONFLICT_KEYS)
      if (!isSlug(cf.conflict_id)) error(errors, `${at}.conflict_id`, 'must be a lowercase slug')
      if (!isNonempty(cf.kind)) error(errors, `${at}.kind`, 'must be a non-empty free-text conflict kind')
      if (!isNonempty(cf.description)) error(errors, `${at}.description`, 'must be a non-empty description')
      if (cf.involved !== undefined && !isStringArray(cf.involved)) error(errors, `${at}.involved`, 'must be an array of non-empty ids when present')
      if (!CONFLICT_STATUSES.includes(cf.status)) error(errors, `${at}.status`, `must be one of ${CONFLICT_STATUSES}`)
      if (cf.status === 'resolved' && !isNonempty(cf.resolution)) {
        error(errors, `${at}.resolution`, 'is required when status="resolved" — a conflict is never silently resolved')
      }
      if (cf.evidence_refs !== undefined && !isRefArray(cf.evidence_refs)) error(errors, `${at}.evidence_refs`, 'must be an array of evidence ids when present')
    })
  }
  for (const field of ['composed_at', 'repository', 'source_head', 'notes']) {
    if (composition[field] !== undefined && !isNonempty(composition[field])) error(errors, `${source}.${field}`, 'must be a non-empty string when present')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition mechanical checks (the composition-specific floor)
// ─────────────────────────────────────────────────────────────────────────────

function check(name, status, detail) {
  return { name, status, detail }
}

const FACT_CLASSES = ['source_fact', 'graph_fact', 'runtime_fact', 'historical_fact']

/**
 * Cross-checks that only make sense at composition level. Pure: `idSpace`
 * resolves both parent ids and namespaced child refs; `dossier` is the system
 * TeachingDossier. Appended to the mechanical readiness gate when the bundle
 * carries composition.json.
 */
export function compositionChecks({ composition, dossier, idSpace }, { depth } = {}) {
  const checks = []
  const fail = (name, detail) => checks.push(check(name, 'fail', detail))
  const pass = (name, detail) => checks.push(check(name, 'pass', detail))

  // Composition provenance.
  const provOk = isNonempty(composition.composed_at) && isNonempty(composition.repository) && isNonempty(composition.source_head)
  checks.push(check('composition_provenance', provOk ? 'pass' : 'fail', provOk ? `composed_at ${composition.composed_at}, source_head ${composition.source_head.slice(0, 12)}` : 'composition.json needs composed_at, repository, and source_head'))

  // §29/§30 requested-component coverage: set equality both directions.
  const requested = Array.isArray(composition.requested_components) ? composition.requested_components : []
  const components = Array.isArray(composition.components) ? composition.components : []
  const requestedSet = new Set(requested)
  const coveredSet = new Set(components.map((c) => c.requested_as).filter(isNonempty))
  const missing = [...requestedSet].filter((r) => !coveredSet.has(r))
  const extra = [...coveredSet].filter((r) => !requestedSet.has(r))
  if (requested.length === 0) fail('requested_coverage', 'requested_components is empty — nothing was requested, so nothing can be silently dropped or added')
  else if (missing.length > 0) fail('requested_coverage', `requested component(s) silently absent from the composition: ${missing.join(', ')}`)
  else if (extra.length > 0) fail('requested_coverage', `composition covers component(s) that were never requested: ${extra.join(', ')}`)
  else pass('requested_coverage', `all ${requested.length} requested component(s) accounted for`)

  // Dispositions, child-bundle wiring, roles.
  const badDisposition = components.filter((c) => ['core', 'supporting'].includes(c.disposition) && !isNonempty(c.child_bundle))
  const badRole = components.filter((c) => ['core', 'supporting', 'context'].includes(c.disposition) && !isNonempty(c.role))
  const badReason = components.filter((c) => ['excluded', 'appendix'].includes(c.disposition) && !isNonempty(c.reason))
  if (components.length === 0) fail('component_dispositions', 'no components recorded')
  else if (badDisposition.length > 0) fail('component_dispositions', `core/supporting component(s) without a child bundle: ${badDisposition.map((c) => c.component_id).join(', ')}`)
  else if (badRole.length > 0) fail('component_dispositions', `component(s) without a system-level role: ${badRole.map((c) => c.component_id).join(', ')}`)
  else if (badReason.length > 0) fail('component_dispositions', `excluded/appendix component(s) without a recorded reason: ${badReason.map((c) => c.component_id).join(', ')}`)
  else pass('component_dispositions', `${components.length} component(s): ${components.map((c) => `${c.component_id}=${c.disposition}`).join(', ')}`)

  // Bridges: endpoints resolvable, evidence-backed, flow-typed, contract-carrying.
  const bridges = Array.isArray(composition.bridges) ? composition.bridges : []
  const contextNodes = Array.isArray(composition.context_nodes) ? composition.context_nodes : []
  const endpointIds = new Set([...components.map((c) => c.component_id), ...contextNodes.map((n) => n.node_id)])
  const badEndpoint = bridges.filter((b) => !endpointIds.has(b.from) || !endpointIds.has(b.to))
  if (bridges.length === 0) fail('bridge_evidence', 'no cross-component bridges recorded — a composition without bridges is a concatenation, not a system story')
  else if (badEndpoint.length > 0) fail('bridge_evidence', `bridge endpoint(s) not resolvable to a component or context node: ${badEndpoint.map((b) => `${b.from}→${b.to}`).join(', ')}`)
  else {
    const badRefs = []
    const badFact = []
    for (const b of bridges) {
      const refs = Array.isArray(b.evidence_refs) ? b.evidence_refs : []
      if (refs.length === 0 || refs.some((r) => !idSpace.has(r))) { badRefs.push(b.bridge_id); continue }
      if (b.epistemic_status === 'fact') {
        const cited = refs.map((r) => idSpace.classOf(r)).filter(Boolean)
        if (cited.length === 0 || !cited.some((c) => FACT_CLASSES.includes(c))) badFact.push(b.bridge_id)
      }
    }
    if (badRefs.length > 0) fail('bridge_evidence', `bridge(s) citing evidence missing from the ledger or the declared imports: ${badRefs.join(', ')}`)
    else if (badFact.length > 0) fail('bridge_evidence', `bridge(s) marked epistemic_status="fact" without fact-class evidence: ${badFact.join(', ')} — re-mark as reasoning/hypothesis or gather fact evidence`)
    else {
      const dataFlow = bridges.filter((b) => b.flow_type === 'data_flow').length
      pass('bridge_evidence', `${bridges.length} bridge(s) (${dataFlow} data_flow, ${bridges.length - dataFlow} control_flow), all evidence-resolved; every bridge carries a transferred contract`)
    }
  }

  // §35 conflicts: an open conflict blocks readiness — never narrate past it.
  const conflicts = Array.isArray(composition.conflicts) ? composition.conflicts : []
  const open = conflicts.filter((c) => c.status === 'open')
  const badResolution = conflicts.filter((c) => c.status === 'resolved' && !isNonempty(c.resolution))
  if (open.length > 0) fail('composition_conflicts', `open composition conflict(s) — resolve or gather new cross-component evidence before composing: ${open.map((c) => c.conflict_id).join(', ')}`)
  else if (badResolution.length > 0) fail('composition_conflicts', `resolved conflict(s) without a recorded resolution: ${badResolution.map((c) => c.conflict_id).join(', ')}`)
  else pass('composition_conflicts', conflicts.length === 0 ? 'no composition conflicts recorded' : `${conflicts.length} conflict(s), all resolved with recorded resolutions`)

  // §22 representation boundaries are a first-class system concept.
  const boundaries = Array.isArray(composition.representation_boundaries) ? composition.representation_boundaries : []
  if (boundaries.length === 0) fail('representation_boundaries', 'no representation boundary recorded — a system story must state what representation exists before and after at least one component boundary')
  else pass('representation_boundaries', `${boundaries.length} representation boundary(ies): ${boundaries.map((b) => `${b.before} → ${b.after}`).join('; ')}`)

  // §21 end-to-end flow: the system dossier mechanism is the flow skeleton.
  const stages = dossier?.mechanism?.stages || []
  if (stages.length < 2) fail('end_to_end_flow', `end-to-end flow needs the input→…→output chain as mechanism stages (found ${stages.length})`)
  else pass('end_to_end_flow', `${stages.length}-stage end-to-end flow`)

  // §16 freshness is aggregated by the driver (system + every child); at
  // readiness time the recorded freshness is reported for transparency.
  const childFresh = components.filter((c) => ['core', 'supporting'].includes(c.disposition))
  checks.push(check('child_inputs', childFresh.every((c) => isNonempty(c.child_bundle)) ? 'pass' : 'fail', `${childFresh.length} child bundle input(s) declared`))

  return checks
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursive staleness (§16) — pure aggregation; drivers gather the inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * inputs:
 *   composition      — the loaded composition.json
 *   systemStaleness  — the system bundle's own staleness result {stale, head_now, ...}
 *   children         — [{component_id, bundle, exists, error, staleness, evidence_sha256, head}]
 *   imports          — resolved import entries [{alias, bundle, evidence_sha256, head, exists, error}]
 * Returns { stale, reasons, children: per-child status } — stale covers the
 * system bundle, every child bundle, child HEAD drift, and child evidence
 * hash drift against the recorded imports.
 */
export function computeCompositionStaleness({ composition, systemStaleness, children = [], imports = [] }) {
  const reasons = []
  const systemHead = systemStaleness?.head_now
  if (systemStaleness?.stale) {
    reasons.push(`system bundle stale: head_at_analysis=${systemStaleness.head_at_analysis}, head_now=${systemStaleness.head_now}, changed_files=${(systemStaleness.stale_files || []).join(', ') || 'none'}`)
  }
  const childStatus = []
  for (const child of children) {
    const entry = { component_id: child.component_id, bundle: child.bundle }
    if (!child.exists) {
      entry.status = 'missing'
      reasons.push(`child bundle missing: ${child.bundle} (component ${child.component_id})${child.error ? ` — ${child.error}` : ''}`)
    } else if (child.staleness?.stale) {
      entry.status = 'stale'
      reasons.push(`child bundle stale: ${child.bundle} (head_at_analysis=${child.staleness.head_at_analysis}, head_now=${child.staleness.head_now}, changed_files=${(child.staleness.stale_files || []).join(', ') || 'none'})`)
    } else {
      entry.status = 'fresh'
    }
    if (child.exists && isNonempty(child.head) && isNonempty(systemHead) && child.head !== systemHead) {
      entry.status = 'head_drift'
      reasons.push(`child analyzed at a different HEAD than the system story: ${child.bundle} child_head=${child.head}, system_head=${systemHead} — refresh the child before composing`)
    }
    childStatus.push(entry)
  }
  for (const imp of imports) {
    if (!imp.exists) {
      reasons.push(`imported child bundle missing: ${imp.bundle} (alias ${imp.alias})${imp.error ? ` — ${imp.error}` : ''}`)
      continue
    }
    if (isNonempty(imp.evidence_sha256) && isNonempty(imp.recorded_evidence_sha256) && imp.evidence_sha256 !== imp.recorded_evidence_sha256) {
      reasons.push(`imported child evidence changed after composition: ${imp.bundle} (alias ${imp.alias}) — recorded ${imp.recorded_evidence_sha256.slice(0, 12)}, now ${imp.evidence_sha256.slice(0, 12)} — re-compose or refresh the import`)
    }
    if (isNonempty(imp.head) && isNonempty(systemHead) && imp.head !== systemHead) {
      reasons.push(`imported child analyzed at a different HEAD than the system story: ${imp.bundle} (alias ${imp.alias}) — refresh before composing`)
    }
  }
  return { stale: reasons.length > 0, reasons, children: childStatus }
}

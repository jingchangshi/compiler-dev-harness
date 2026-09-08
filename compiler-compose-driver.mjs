/**
 * Driver for the System Story Composition commands of `compiler_explain`
 * (Phase T3): scaffolding, deterministic composition preflight over child
 * bundles, composition-bundle validation, and the derived human-readable
 * system-story view.
 *
 * Ownership model (ARCHITECTURE §19): a system story is a NORMAL Teaching
 * Artifact Protocol bundle (subject/evidence/dossier/handoff/readiness — the
 * single-subject machinery is fully reused) plus one lightweight composition
 * provenance artifact (composition.json). Child bundles are the semantic
 * source: this driver consumes their recorded knowledge, resolves namespaced
 * evidence imports, and checks cross-bundle freshness — it never re-analyzes
 * child internals and never copies child evidence into the parent ledger.
 *
 * The semantic half (system mental model, bridges, storylines, roles, the
 * semantic readiness verdict) is agent reasoning recorded in the artifacts;
 * this driver never generates it. system-story.md is a DERIVED view rendered
 * mechanically from the JSON artifacts — the JSON remains the only source of
 * truth.
 *
 * Node-only, stdlib. Anti-overfitting: subject-agnostic — no compiler-only
 * concepts (enforced by the dogfood generic-layer scan).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SUBJECT_TYPES, DEPTHS, semanticQuestionsFor,
  validateBundle, computeReadiness,
} from './scripts/teaching-schema.mjs'
import {
  COMPOSITION_SCHEMA_VERSION, ARTIFACT_COMPOSITION, DISPOSITIONS, FLOW_TYPES,
  EPISTEMIC_STATUSES, validateComposition,
} from './scripts/composition-schema.mjs'
import {
  loadBundle, stalenessForBundle, resolveCompositionImports, readinessForBundle,
  repositoryProvenance, explainRoot,
} from './compiler-explain-driver.mjs'

const COMPOSE_DRIVER_VERSION = 'compiler-compose-driver v1.0'

// ─────────────────────────────────────────────────────────────────────────────
// compose-plan
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_RELATION_HINTS = [
  'produces-for', 'consumes-from', 'precedes', 'calls', 'creates', 'normalizes-for',
  'marks-for', 'lowers-to', 'materializes-for', 'requires', 'enables',
]

export function planComposition(args) {
  const subjectType = args.subject_type
  const name = String(args.name || '').trim()
  const depth = args.depth || 'presentation'
  const requested = args.requested_components
  const errors = []
  if (!SUBJECT_TYPES.includes(subjectType)) errors.push(`subject_type must be one of ${SUBJECT_TYPES}`)
  if (name === '') errors.push('name is required')
  if (!DEPTHS.includes(depth)) errors.push(`depth must be one of ${DEPTHS}`)
  if (!Array.isArray(requested) || requested.length === 0 || !requested.every((r) => typeof r === 'string' && r.trim() !== '')) {
    errors.push('requested_components must be a non-empty array of component names — every requested component will be held to an explicit disposition')
  }
  if (errors.length > 0) return { ok: false, errors }

  const slug = slugifyComposition(name)
  const bundleId = `${new Date().toISOString().slice(0, 10)}-${slug}-${subjectType}`
  const bundleDir = join(explainRoot(), bundleId)
  const compositionSkeleton = {
    artifact: ARTIFACT_COMPOSITION,
    schema_version: COMPOSITION_SCHEMA_VERSION,
    system_subject_id: `${slug}-${subjectType}`,
    requested_components: requested.map((r) => String(r).trim()),
    components: requested.map((r) => ({
      component_id: slugifyComposition(r),
      requested_as: String(r).trim(),
      disposition: 'core',
      role: '<system-level role: what this component establishes or normalizes for the others>',
      child_bundle: '<child bundle dir name under analysis/explanations/> — REQUIRED for core/supporting',
      child_subject_id: undefined,
    })),
    context_nodes: [],
    bridges: [{
      bridge_id: 'example-bridge',
      from: '<component-or-context-node id>',
      to: '<component-or-context-node id>',
      relation: '<free text — e.g. ' + BRIDGE_RELATION_HINTS.join(' / ') + '>',
      flow_type: 'data_flow',
      contract: '<WHAT crosses this boundary — the arrow must say what it carries>',
      ordering_matters: true,
      why_order_matters: '<why this order is required, not incidental>',
      representation_before: '<representation before the boundary>',
      representation_after: '<representation after the boundary>',
      evidence_refs: ['<parent evidence id or alias::child-EV-ID>'],
      epistemic_status: 'fact',
      unresolved: false,
    }],
    representation_boundaries: [{
      boundary_id: 'example-boundary',
      before: '<representation before>',
      after: '<representation after>',
      where: '<which component boundary>',
      evidence_refs: ['<evidence ids>'],
    }],
    imports: [{
      alias: '<short-alias>',
      bundle: '<child bundle dir name>',
      subject_id: '<child subject id>',
      evidence_sha256: '<sha256 of the child evidence.json at composition time>',
      head: '<child provenance head>',
    }],
    conflicts: [],
    composed_at: new Date().toISOString(),
    repository: args.repo_root ? basename(resolve(args.repo_root)) : undefined,
    source_head: undefined,
    notes: undefined,
  }
  return {
    ok: true,
    driver: COMPOSE_DRIVER_VERSION,
    bundle: { id: bundleId, dir: bundleDir },
    composition_skeleton: compositionSkeleton,
    disposition_model: {
      values: DISPOSITIONS,
      rules: [
        'every requested component gets exactly one disposition — a requested component is never silently dropped',
        'core/supporting must reference a READY child bundle; context nodes need no dossier, only enough cross evidence to explain the connection',
        'excluded/appendix require a recorded reason',
      ],
    },
    bridge_model: {
      flow_types: FLOW_TYPES,
      epistemic_statuses: EPISTEMIC_STATUSES,
      rules: [
        'relation is free text — never a fixed compiler-only enum',
        'every bridge carries the contract that crosses it and evidence resolving in the parent ledger or declared imports',
        'epistemic_status "fact" requires fact-class evidence; otherwise mark reasoning/hypothesis/unknown explicitly',
        'an open composition conflict blocks readiness — never narrate past it',
      ],
    },
    reuse_rules: [
      'READY+FRESH child bundles are the semantic source: consume mental model, contracts, mechanism summary, takeaways, boundaries, handoff storyline, evidence index',
      'never re-read child implementation internals, re-derive child algorithms, or re-select child canonical examples',
      'new evidence gathering is only for cross-component relations (A↔B): pipeline order, caller/callee, producer→consumer, shared state, ordering',
      'never copy child evidence into the parent ledger — cite it through imports as alias::EV-ID',
      'v0 composes ONE repository at ONE current HEAD: children analyzed at a different HEAD must be refreshed, never ignored',
    ],
    freshness: 'system story freshness is recursive: system bundle + every child bundle + every import hash. Refresh incrementally — only stale children.',
    audience_questions: semanticQuestionsFor(subjectType),
    notes: [
      'The system story is a normal TeachingDossier (subject_type chosen for its actual semantics) — not a fifth knowledge layer.',
      'Semantic zoom: component-local mechanism detail stays in the child dossier; the system story adds only horizontal connections.',
      'System story ≠ concatenation: it must answer why these components coexist, in this order, with these contracts.',
    ],
  }
}

function slugifyComposition(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'system'
}

// ─────────────────────────────────────────────────────────────────────────────
// compose-preflight (deterministic gate BEFORE any system-level reasoning)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Preflight a list of child bundle dirs for composition: exists, schema
 * supported, READY, FRESH, unique subject ids, same repository, same HEAD
 * (v0: same repository + same current HEAD). Purely deterministic — the
 * agent runs this before composing, and refreshes only what it refuses.
 */
export function compositionPreflight(bundleDirs, { repoRoot, currentHead } = {}) {
  if (!Array.isArray(bundleDirs) || bundleDirs.length === 0) {
    return { ok: false, verdict: 'NOT_CONSUMABLE', reasons: ['compose-preflight requires bundle_dirs (array of child bundle directories)'] }
  }
  const children = []
  const reasons = []
  // Default the comparison HEAD to the repository's current HEAD.
  let compareHead = currentHead
  if (compareHead === undefined && repoRoot !== undefined) {
    compareHead = repositoryProvenance(repoRoot).head
  }
  for (const dir of bundleDirs) {
    const entry = { dir: resolve(dir) }
    const load = loadBundle(dir)
    if (!load.ok) { entry.verdict = 'NOT_CONSUMABLE'; entry.reasons = [load.error]; children.push(entry); continue }
    const bundle = load.bundle
    entry.subject_id = bundle.subject?.subject_id || bundle.dossier?.subject_id
    entry.subject_type = bundle.dossier?.subject_type
    entry.repository = bundle.subject?.provenance?.repository
    entry.head = bundle.subject?.provenance?.head

    const handoffVersion = bundle.handoff?.schema_version
    if (bundle.handoff && handoffVersion !== undefined && handoffVersion !== 1) {
      entry.verdict = 'UNSUPPORTED_SCHEMA'
      entry.reasons = [`handoff schema_version ${JSON.stringify(handoffVersion)} not supported (supported: 1)`]
      children.push(entry)
      continue
    }

    const { errors } = validateBundle(bundle)
    if (errors.length > 0) { entry.verdict = 'NOT_CONSUMABLE'; entry.reasons = [`schema invalid: ${errors.slice(0, 6).join('; ')}`]; children.push(entry); continue }

    const root = repoRoot || bundle.subject?.provenance?.repository_path
    const stale = stalenessForBundle(load.dir, root)
    if (!stale.ok) { entry.verdict = 'NOT_CONSUMABLE'; entry.reasons = [`staleness unknown: ${stale.error}`]; children.push(entry); continue }
    if (stale.staleness.stale) {
      entry.verdict = 'STALE'
      entry.reasons = ['bundle is stale — refresh it before composing (never ignore HEAD/hash drift)', ...stale.staleness.reasons || []]
      children.push(entry)
      continue
    }

    const readiness = computeReadiness({
      subject: bundle.subject, evidence: bundle.evidence, dossier: bundle.dossier,
      handoff: bundle.handoff, readiness: bundle.readiness,
    }, { depth: bundle.dossier?.depth })
    if (readiness.verdict !== 'ready') {
      entry.verdict = 'NOT_CONSUMABLE'
      entry.reasons = readiness.reasons.slice(0, 6)
      children.push(entry)
      continue
    }

    entry.verdict = 'CONSUMABLE'
    entry.reasons = []
    children.push(entry)
  }

  // Aggregate rules: unique subject ids; same repository; same HEAD.
  const byId = new Map()
  for (const c of children) {
    if (c.subject_id === undefined) continue
    if (byId.has(c.subject_id)) reasons.push(`duplicate child subject id: ${c.subject_id} (${byId.get(c.subject_id)} and ${c.dir})`)
    else byId.set(c.subject_id, c.dir)
  }
  const repos = new Set(children.map((c) => c.repository).filter(Boolean))
  if (repos.size > 1) reasons.push(`children span multiple repositories (${[...repos].join(', ')}) — v0 composes one repository only`)
  const heads = new Set(children.map((c) => c.head).filter(Boolean))
  if (heads.size > 1) reasons.push(`children analyzed at different HEADs (${[...heads].map((h) => h.slice(0, 12)).join(', ')}) — refresh to one current HEAD before composing`)
  if (compareHead !== undefined && heads.size === 1 && !heads.has(compareHead)) {
    reasons.push(`children were analyzed at ${[...heads][0].slice(0, 12)}, repository is now at ${compareHead.slice(0, 12)} — refresh before composing`)
  }
  const refused = children.filter((c) => c.verdict !== 'CONSUMABLE')
  if (refused.length > 0) {
    reasons.push(...refused.flatMap((c) => [`${basename(c.dir)}: ${c.verdict} — ${(c.reasons || [])[0] || 'see per-child reasons'}`]))
  }
  const verdict = reasons.length > 0 ? 'NOT_CONSUMABLE' : 'CONSUMABLE'
  return { ok: true, verdict, reasons, children, driver: COMPOSE_DRIVER_VERSION }
}

// ─────────────────────────────────────────────────────────────────────────────
// compose-validate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a composition bundle: normal Teaching Artifact Protocol validation
 * (with namespaced imports resolved), composition.json shape, import
 * resolvability + hash match, recursive staleness, and the mechanical
 * readiness floor including the composition cross-checks.
 */
export function validateCompositionBundleDir(bundleDir, { repoRoot } = {}) {
  const load = loadBundle(bundleDir)
  if (!load.ok) return { ok: false, error: load.error }
  const bundle = load.bundle
  if (!bundle.composition) {
    return { ok: false, error: 'no composition.json in this bundle — compose-validate is for system-story bundles (use validate for single-subject bundles)' }
  }
  const compShape = []
  validateComposition(bundle.composition, compShape, 'composition')

  const resolved = resolveCompositionImports(load.dir)
  const importErrors = resolved.ok ? [] : resolved.errors
  const imports = resolved.ok ? resolved.imports : []

  const { errors } = validateBundle(bundle, { imports })
  const allErrors = [...compShape, ...errors, ...importErrors]

  // Recursive freshness (system + children + imports).
  const root = repoRoot || bundle.subject?.provenance?.repository_path
  const stale = stalenessForBundle(load.dir, root)
  const staleness = stale.ok ? stale.staleness : { error: stale.error, stale: true, reasons: [stale.error] }

  // Mechanical readiness floor (without a recorded semantic review).
  const readiness = computeReadiness({
    subject: bundle.subject, evidence: bundle.evidence, dossier: bundle.dossier,
    handoff: bundle.handoff, readiness: bundle.readiness, composition: bundle.composition,
  }, { depth: bundle.dossier?.depth, imports })

  const comp = bundle.composition
  return {
    ok: true,
    dir: load.dir,
    valid: allErrors.length === 0,
    errors: allErrors.slice(0, 50),
    composition: {
      system_subject_id: comp.system_subject_id,
      requested_components: comp.requested_components,
      components: (comp.components || []).map((c) => ({ component_id: c.component_id, disposition: c.disposition, child_bundle: c.child_bundle })),
      context_nodes: (comp.context_nodes || []).map((n) => n.node_id),
      bridges: (comp.bridges || []).map((b) => ({ bridge_id: b.bridge_id, from: b.from, to: b.to, relation: b.relation, flow_type: b.flow_type, epistemic_status: b.epistemic_status })),
      representation_boundaries: (comp.representation_boundaries || []).map((b) => b.boundary_id),
      imports: (comp.imports || []).map((i) => ({ alias: i.alias, bundle: i.bundle, subject_id: i.subject_id })),
      conflicts: (comp.conflicts || []).map((c) => ({ conflict_id: c.conflict_id, status: c.status })),
    },
    imports_resolved: resolved.ok,
    staleness,
    mechanical: readiness.mechanical,
    readiness: readiness.verdict,
    reasons: readiness.reasons.slice(0, 10),
    driver: COMPOSE_DRIVER_VERSION,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// compose-render (system-story.md — derived view, JSON stays source of truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render system-story.md from the composition bundle's JSON artifacts.
 * Deterministic and derived: every section cites its artifact path; the
 * renderer adds no claims of its own.
 */
export function renderSystemStory(bundleDir, { out } = {}) {
  const load = loadBundle(bundleDir)
  if (!load.ok) return { ok: false, error: load.error }
  const bundle = load.bundle
  if (!bundle.composition) return { ok: false, error: 'no composition.json in this bundle — nothing to render as a system story' }
  const d = bundle.dossier || {}
  const h = bundle.handoff || {}
  const comp = bundle.composition
  const ev = bundle.evidence || { records: [] }
  const lines = []
  const push = (...l) => lines.push(...l)

  push(`# System Story: ${d.subject_id || comp.system_subject_id}`)
  push('')
  push('> Derived view rendered mechanically from the JSON artifacts in this bundle.')
  push('> The JSON artifacts (subject/evidence/dossier/handoff/composition/readiness) are the only source of truth.')
  push('')
  if (comp.source_head) push(`- Repository: ${comp.repository || 'n/a'} @ ${comp.source_head.slice(0, 12)}`)
  if (comp.composed_at) push(`- Composed: ${comp.composed_at}`)
  push(`- Subject type: ${d.subject_type || 'n/a'}; depth: ${d.depth || 'n/a'}`)
  push('')

  push('## 1. System mental model')
  push('')
  push(d.mental_model || '_missing — the dossier has no mental model_')
  push('')
  if (d.need || d.purpose || d.observable_outcome) {
    push('### Why this system exists')
    push('')
    for (const [label, field] of [['Need', d.need], ['Purpose', d.purpose], ['Observable outcome', d.observable_outcome]]) {
      if (field) push(`- **${label}:** ${field}`)
    }
    push('')
  }

  push('## 2. Components and roles')
  push('')
  for (const c of comp.components || []) {
    push(`### ${c.component_id} — ${c.disposition}${c.child_bundle ? ` (child: \`${c.child_bundle}\`)` : ''}`)
    push('')
    if (c.role) push(`Role: ${c.role}`)
    if (c.reason) push(`Reason for ${c.disposition}: ${c.reason}`)
    if (c.child_presentation_dir) push(`Child deck: \`${c.child_presentation_dir}\``)
    push('')
  }
  for (const n of comp.context_nodes || []) {
    push(`### ${n.node_id} — context-only node`)
    push('')
    if (n.role) push(`Role: ${n.role}`)
    if (n.note) push(n.note)
    push('')
  }

  push('## 3. End-to-end flow')
  push('')
  for (const [i, s] of (d.mechanism?.stages || []).entries()) {
    push(`${i + 1}. **${s.name}** — ${s.what}${s.where ? ` (${s.where})` : ''}`)
  }
  push('')

  push('## 4. Cross-component bridges and contracts')
  push('')
  for (const b of comp.bridges || []) {
    push(`- **${b.from} → ${b.to}** (${b.relation}, ${b.flow_type}${b.epistemic_status ? `, ${b.epistemic_status}` : ''})`)
    push(`  - Contract: ${b.contract}`)
    if (b.why_order_matters) push(`  - Why order matters: ${b.why_order_matters}`)
    if (b.representation_before || b.representation_after) push(`  - Representation: ${b.representation_before || '?'} → ${b.representation_after || '?'}`)
    if (b.unresolved) push(`  - ⚠ UNRESOLVED: ${b.unresolved_reason || ''}`)
    push(`  - Evidence: ${fmtRefs(b.evidence_refs)}`)
  }
  push('')

  push('## 5. Representation transitions')
  push('')
  for (const r of comp.representation_boundaries || []) {
    push(`- **${r.before} → ${r.after}** at ${r.where} (evidence: ${fmtRefs(r.evidence_refs)})`)
  }
  push('')

  if (d.canonical_example) {
    push('## 6. Canonical example')
    push('')
    push(`Provenance: ${d.canonical_example.provenance?.kind || 'n/a'} — ${d.canonical_example.provenance?.source || 'n/a'}`)
    push('')
    if (typeof d.canonical_example.initial_state === 'string') push(`Initial state: ${d.canonical_example.initial_state}`)
    for (const [i, t] of (d.canonical_example.execution_trace || []).entries()) {
      const frame = typeof t === 'string' ? t : t.description || t.state || JSON.stringify(t)
      push(`${i + 1}. ${frame}`)
    }
    if (typeof d.canonical_example.result === 'string') push(`Result: ${d.canonical_example.result}`)
    push('')
  }

  if ((d.decisions || []).length > 0) {
    push('## 7. Key decisions')
    push('')
    for (const dec of d.decisions) {
      push(`- **${dec.question}** — ${dec.condition}`)
      if (dec.reason) push(`  - ${dec.reason}`)
      push(`  - Evidence: ${fmtRefs(dec.evidence_refs)}`)
    }
    push('')
  }

  if ((d.invariants || []).length > 0 || (d.constraints || []).length > 0) {
    push('## 8. System invariants and constraints')
    push('')
    for (const i of d.invariants || []) push(`- Invariant: ${i.statement} (${i.status || 'n/a'})`)
    for (const c of d.constraints || []) push(`- Constraint: ${c.statement} (${c.status || 'n/a'})`)
    push('')
  }

  if ((d.boundaries || []).length > 0 || (comp.conflicts || []).length > 0) {
    push('## 9. System boundaries and open conflicts')
    push('')
    for (const b of d.boundaries || []) push(`- [${b.category}] ${b.statement}`)
    for (const c of comp.conflicts || []) {
      push(`- Conflict ${c.conflict_id} (${c.kind}): ${c.description} — status: ${c.status}`)
      if (c.resolution) push(`  - Resolution: ${c.resolution}`)
    }
    push('')
  }

  push('## 10. Evidence and child dossier index')
  push('')
  push(`Parent ledger: ${ev.records.length} record(s).`)
  for (const imp of comp.imports || []) {
    push(`- Import \`${imp.alias}\` → child bundle \`${imp.bundle}\` (subject ${imp.subject_id})`)
  }
  for (const c of (comp.components || []).filter((x) => x.child_bundle)) {
    push(`- Child dossier: \`${c.child_bundle}\`${c.child_subject_id ? ` (subject ${c.child_subject_id})` : ''}`)
  }
  push('')
  if ((h.appendix_topics || []).length > 0 || (comp.components || []).some((c) => c.child_bundle)) {
    push('### Deferred to child dossiers (the system story deliberately does not answer these)')
    push('')
    for (const c of (comp.components || []).filter((x) => x.child_bundle)) {
      push(`- **${c.component_id}** (${c.disposition}): internal mechanism, legality detail, and worked internals — see \`${c.child_bundle}\``)
    }
    for (const t of h.appendix_topics || []) {
      push(`- Appendix topic: ${t}`)
    }
    push('')
  }
  push(`Evidence index (${(h.evidence_index || []).length}):`)
  for (const e of h.evidence_index || []) {
    const rec = ev.records.find((r) => r.id === e.id)
    push(`- \`${e.id}\` ${rec ? `(${rec.class}) ${rec.statement}` : '(imported — resolves via composition imports)'}`)
  }
  push('')

  const md = `${lines.join('\n')}\n`
  const outPath = resolve(out || join(load.dir, 'system-story.md'))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, md)
  return { ok: true, rendered: outPath, bytes: md.length }
}

function fmtRefs(refs) {
  return (refs || []).map((r) => `\`${r}\``).join(', ') || '(none)'
}

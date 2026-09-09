/**
 * Semantic visual fidelity validator (Phase T6).
 *
 * Deterministic half of "the diagram says what the algorithm does". It checks
 * that the structured semantics the PRODUCER declared (TeachingDossier
 * mechanism.states / mechanism.control_relations, stage names) are actually
 * CONSUMED by the presentation visuals (PresentationHandoff), and that the
 * visual never contradicts a declared lifecycle. It never reads source, never
 * reasons about C++, and never judges aesthetics.
 *
 * Ownership boundaries (unchanged, ARCHITECTURE §15/§21):
 *   - producer owns semantics: stage model, state entities + lifecycles,
 *     typed control relations, claims about what a visual presents;
 *   - consumer owns geometry: everything here is semantic metadata — no x/y,
 *     width, color, or font may flow through these fields (the schema's
 *     FORBIDDEN_VISUAL_KEYS gate still applies upstream);
 *   - this validator owns neither: it only cross-checks the two artifacts.
 *
 * Deterministic-vs-review boundary: every check below resolves identifiers
 * (stage names, state ids) and compares declared sets. Whether the LABELS read
 * well, whether a merged node's prose is honest, and whether the deck teaches
 * remain agent-review questions (readiness.semantic_review).
 *
 * Checks (all errors are silent-drop / contradiction classes):
 *   stage_coverage            claimed mechanism visual maps or disposes every stage
 *   stage_merge_reason        a node silently absorbing >1 stage is an error
 *   branch_coverage           claimed control/mechanism visual shows a real
 *                             reject/failure path or defers one with a reason
 *   state_contract_gap        mutable_state declared without state entities is
 *                             a PRODUCER contract gap, not a consumer problem
 *   state_lifecycle_coverage  a state-evolution claim must show ≥1 real update
 *                             path (or the claim is decoration)
 *   lifecycle_contradiction   an update claim against an initialization-only
 *                             state (updated_in=[]) is an error
 *   lifecycle_stage_mismatch  state access attributed to a stage the producer
 *                             did not declare for that access
 *   state_role_collapse       one node silently depicting states of different
 *                             roles (e.g. a scheduling queue vs live sequence)
 *   control_relation_coverage a declared relation must be consumed by some
 *                             edge or explicitly deferred with a reason
 * Warnings:
 *   mechanism_claim_missing   stages exist but no visual claims the mechanism
 *                             (legacy bundles stay valid; new decks should claim)
 * Recommendations (never errors):
 *   SPLIT_RECOMMENDED         bounded heuristic: split > semantic compression
 *
 * Anti-overfitting: subject-agnostic by construction — no algorithm, pass, or
 * subsystem vocabulary appears here; the teaching-dogfood scan enforces it.
 *
 * Node-only, stdlib, pure module (no I/O except the CLI entry).
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ─── Bounded vocabularies (the semantic visual contract) ────────────────────

/** What semantic question a visual claims to answer. Obligations bind to claims. */
export const VISUAL_COVERAGE = ['mechanism', 'control_flow', 'state_lifecycle']

/** Edge domains: control vs state vs data are different universes of discourse;
 * kinds are domain-specific so a reject path is never confused with a data
 * dependency. Absent domain defaults to control. */
export const EDGE_DOMAINS = ['control', 'state', 'data']
export const CONTROL_EDGE_KINDS = ['next', 'success', 'failure', 'reject', 'skip', 'requeue', 'retry', 'loop', 'finalize']
export const STATE_EDGE_KINDS = ['create', 'read', 'update', 'finalize']
export const DATA_EDGE_KINDS = ['flow', 'dependency']
export const EDGE_KINDS_BY_DOMAIN = {
  control: CONTROL_EDGE_KINDS,
  state: STATE_EDGE_KINDS,
  data: DATA_EDGE_KINDS,
}

/** State entity families. The validator uses kind equality to detect role
 * collapse (e.g. a scheduling queue silently drawn as the live sequence). */
export const STATE_KINDS = ['work_queue', 'live_sequence', 'analysis', 'derived', 'ir', 'accounting', 'other']

/** Explicit, reasoned non-mapping of a stage inside one visual. */
export const STAGE_DISPOSITIONS = ['deferred', 'merged']

/** Split-recommendation heuristic bounds (deliberately conservative: a
 * recommendation must not fire on ordinary medium figures). */
export const SPLIT_MIN_STAGES = 5
export const SPLIT_MIN_STATE_FAMILIES = 2

const REJECT_FAMILY = ['reject', 'failure', 'skip']
const LOOP_FAMILY = ['loop', 'requeue', 'retry']

const isNonempty = (v) => typeof v === 'string' && v.trim() !== ''
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ─── Small spec readers (tolerant of legacy visuals without the new fields) ──

function edgeDomain(edge) {
  return isNonempty(edge.domain) ? edge.domain : 'control'
}

function edgeKind(edge) {
  return isNonempty(edge.kind) ? edge.kind : undefined
}

function nodeStages(node) {
  return Array.isArray(node.mechanism_stages) ? node.mechanism_stages : []
}

function nodeStates(node) {
  return Array.isArray(node.state_refs) ? node.state_refs : []
}

/** States an edge touches: declared on the edge, or carried by its endpoints. */
function edgeStates(edge, nodesById) {
  if (Array.isArray(edge.states) && edge.states.length > 0) return edge.states
  const a = nodesById.get(edge.from)
  const b = nodesById.get(edge.to)
  return [...new Set([...nodeStates(a || {}), ...nodeStates(b || {})])]
}

function isMutable(stateEntity) {
  return Array.isArray(stateEntity?.updated_in) && stateEntity.updated_in.length > 0
}

// ─── Workstream D: split > semantic compression (recommendation only) ────────

/**
 * Bounded complexity heuristic. A visual that simultaneously carries many
 * control phases, several mutable state families, a loop, and branching is
 * doing several teaching jobs at once; the presentation consumer should
 * prefer 2 related visuals over one semantically compressed figure.
 * Returns a recommendation object or null — never an error.
 */
export function recommendVisualSplit(spec, dossier) {
  if (!isObject(spec)) return null
  const nodesById = new Map((spec.nodes || []).filter((n) => isObject(n) && isNonempty(n.id)).map((n) => [n.id, n]))
  const stages = new Set()
  for (const n of spec.nodes || []) for (const s of nodeStages(n)) stages.add(s)
  const states = new Set()
  for (const n of spec.nodes || []) for (const s of nodeStates(n)) states.add(s)
  for (const e of spec.edges || []) if (isObject(e)) for (const s of edgeStates(e, nodesById)) states.add(s)
  const stateEntities = new Map((dossier?.mechanism?.states || []).filter((s) => isObject(s) && isNonempty(s.id)).map((s) => [s.id, s]))
  const mutableFamilies = new Set()
  for (const id of states) {
    const entity = stateEntities.get(id)
    if (entity && isMutable(entity)) mutableFamilies.add(entity.kind)
  }
  const edges = (spec.edges || []).filter(isObject)
  const hasLoop = edges.some((e) => edgeDomain(e) === 'control' && LOOP_FAMILY.includes(edgeKind(e)))
  const hasBranch = edges.some((e) => edgeDomain(e) === 'control' && REJECT_FAMILY.includes(edgeKind(e)))
  if (stages.size >= SPLIT_MIN_STAGES && mutableFamilies.size >= SPLIT_MIN_STATE_FAMILIES && hasLoop && hasBranch) {
    return {
      id: spec.id || '(visual)',
      recommendation: 'SPLIT_RECOMMENDED',
      reason: `visual carries ${stages.size} mechanism stages, ${mutableFamilies.size} mutable state families, a loop edge, and a reject-family edge — prefer 2 related visuals over semantic compression`,
      metrics: { stages: stages.size, mutable_state_families: mutableFamilies.size, has_loop: hasLoop, has_branch: hasBranch },
    }
  }
  return null
}

// ─── Workstream B: the deterministic semantic fidelity checks ────────────────

/**
 * Cross-check one handoff against one dossier. Both artifacts are plain JSON
 * (already schema-validated upstream); missing fields mean "not declared", and
 * obligations only bind where the producer declared or the visual claimed.
 */
export function checkVisualSemantics({ dossier, handoff } = {}) {
  const errors = []
  const warnings = []
  const recommendations = []
  const err = (check, detail) => errors.push({ check, detail })
  const warn = (check, detail) => warnings.push({ check, detail })

  const mech = (dossier && dossier.mechanism) || {}
  const stageNames = new Set((mech.stages || []).map((s) => s?.name).filter(isNonempty))
  const stateEntities = new Map((mech.states || []).filter((s) => isObject(s) && isNonempty(s.id)).map((s) => [s.id, s]))
  const relations = (mech.control_relations || []).filter(isObject)
  const visuals = ((handoff && handoff.visuals) || []).filter(isObject)
  const hasBranching = mech.has_important_branching === true
  const hasMutableState = mech.mutable_state === true

  const resolveStage = (name, check, where) => {
    if (stageNames.size === 0) return // no stage model declared: nothing to resolve against
    if (!isNonempty(name) || !stageNames.has(name)) err(check, `unknown mechanism stage ${JSON.stringify(name)} referenced by ${where}`)
  }

  const consumedRelations = new Set() // relation index -> consumed by some edge
  const deferredRelations = new Set() // relation index -> deferred with a reason
  let anyMechanismClaim = false

  for (const spec of visuals) {
    const vid = isNonempty(spec.id) ? spec.id : '(visual)'
    const nodesById = new Map((spec.nodes || []).filter((n) => isObject(n) && isNonempty(n.id)).map((n) => [n.id, n]))
    const claims = Array.isArray(spec.covers) ? spec.covers : []
    for (const c of claims) {
      if (!VISUAL_COVERAGE.includes(c)) err('visual_covers', `${vid}: unknown coverage claim ${JSON.stringify(c)} (allowed: ${VISUAL_COVERAGE.join(', ')})`)
    }
    const claimsMechanism = claims.includes('mechanism')
    const claimsControl = claims.includes('control_flow')
    const claimsState = claims.includes('state_lifecycle')
    if (claimsMechanism) anyMechanismClaim = true

    // Stage dispositions: explicit, reasoned non-mappings.
    const disposedStages = new Set()
    for (const d of Array.isArray(spec.stage_dispositions) ? spec.stage_dispositions : []) {
      if (!isObject(d) || !isNonempty(d.stage) || !STAGE_DISPOSITIONS.includes(d.disposition) || !isNonempty(d.reason)) {
        err('stage_dispositions', `${vid}: stage_dispositions entries need stage, disposition (${STAGE_DISPOSITIONS.join('|')}), and reason`)
        continue
      }
      resolveStage(d.stage, 'stage_dispositions', `${vid} stage_dispositions`)
      disposedStages.add(d.stage)
    }

    // Node-level checks.
    const mappedStages = new Set()
    for (const node of spec.nodes || []) {
      if (!isObject(node) || !isNonempty(node.id)) continue
      const stageRefs = nodeStages(node)
      for (const s of stageRefs) resolveStage(s, 'stage_mapping', `${vid} node ${node.id}`)
      if (stageRefs.length > 1 && !isNonempty(node.stage_merge_reason)) {
        err('stage_merge_reason', `${vid}: node ${node.id} maps ${stageRefs.length} stages (${stageRefs.join(', ')}) without stage_merge_reason — silent stage collapse`)
      }
      for (const s of stageRefs) mappedStages.add(s)
      const stateRefs = nodeStates(node)
      for (const s of stateRefs) {
        if (stateEntities.size > 0 && !stateEntities.has(s)) err('state_mapping', `${vid}: node ${node.id} references unknown state ${JSON.stringify(s)}`)
      }
      const kinds = new Set(stateRefs.map((s) => stateEntities.get(s)?.kind).filter(Boolean))
      if (kinds.size > 1 && !isNonempty(node.state_merge_reason)) {
        err('state_role_collapse', `${vid}: node ${node.id} depicts ${stateRefs.length} states of different roles (${[...kinds].join(', ')}) without state_merge_reason`)
      }
    }
    for (const s of disposedStages) mappedStages.add(s)

    // Edge-level checks.
    const edges = (spec.edges || []).filter(isObject)
    let hasMutableUpdateEdge = false
    for (const edge of edges) {
      if (!isNonempty(edge.from) || !isNonempty(edge.to)) continue
      const domain = edgeDomain(edge)
      if (isNonempty(edge.domain) && !EDGE_DOMAINS.includes(edge.domain)) {
        err('edge_domain', `${vid}: edge ${edge.from}->${edge.to} has unknown domain ${JSON.stringify(edge.domain)}`)
      }
      const kind = edgeKind(edge)
      if (kind !== undefined) {
        const allowed = EDGE_KINDS_BY_DOMAIN[domain]
        if (!allowed.includes(kind)) {
          err('edge_kind', `${vid}: edge ${edge.from}->${edge.to} kind ${JSON.stringify(kind)} is not a ${domain} edge kind (${allowed.join(', ')})`)
        }
      }
      if (domain === 'control' && nodesById.has(edge.from) && nodesById.has(edge.to)) {
        const fromStages = nodeStages(nodesById.get(edge.from))
        const toStages = nodeStages(nodesById.get(edge.to))
        relations.forEach((rel, i) => {
          if (kind === rel.kind && fromStages.includes(rel.from) && toStages.includes(rel.to)) consumedRelations.add(i)
        })
      }
      if (domain !== 'state') continue
      const touched = edgeStates(edge, nodesById)
      const sourceNode = nodesById.get(edge.from)
      const sourceStages = sourceNode ? nodeStages(sourceNode) : []
      for (const sid of touched) {
        const entity = stateEntities.get(sid)
        if (stateEntities.size > 0 && !entity) { err('state_mapping', `${vid}: state edge ${edge.from}->${edge.to} references unknown state ${JSON.stringify(sid)}`); continue }
        if (!entity) continue
        if (kind === 'update' || kind === 'create' || kind === 'read' || kind === 'finalize') {
          const declaredField = kind === 'update' ? 'updated_in'
            : kind === 'create' ? 'created_in'
            : kind === 'read' ? 'read_in' : 'finalized_in'
          const declared = entity[declaredField]
          const declaredList = Array.isArray(declared) ? declared : (isNonempty(declared) ? [declared] : [])
          if (kind === 'update' && declaredList.length === 0) {
            err('lifecycle_contradiction', `${vid}: state ${JSON.stringify(sid)} is declared initialization-only (updated_in=[]) but the visual claims an update (${edge.from}->${edge.to})`)
          }
          if (declaredList.length > 0 && sourceStages.length === 1 && !declaredList.includes(sourceStages[0])) {
            err('lifecycle_stage_mismatch', `${vid}: ${kind} of state ${JSON.stringify(sid)} drawn from stage ${JSON.stringify(sourceStages[0])}, but the producer declared ${declaredField} = [${declaredList.join(', ')}]`)
          }
        }
        if (kind === 'update' && isMutable(entity)) hasMutableUpdateEdge = true
      }
    }

    // Claim obligations.
    if (claimsMechanism && stageNames.size > 0) {
      const missing = [...stageNames].filter((s) => !mappedStages.has(s))
      if (missing.length > 0) {
        err('stage_coverage', `${vid}: mechanism visual silently drops stage(s) ${missing.map((s) => JSON.stringify(s)).join(', ')} — map them to nodes or record stage_dispositions with a reason`)
      }
    }
    if ((claimsControl || claimsMechanism) && hasBranching) {
      const hasRejectPath = edges.some((e) => edgeDomain(e) === 'control' && REJECT_FAMILY.includes(edgeKind(e)))
      const deferred = (Array.isArray(spec.deferred_relations) ? spec.deferred_relations : [])
        .filter((d) => isObject(d) && REJECT_FAMILY.includes(d.kind) && isNonempty(d.reason))
      if (!hasRejectPath && deferred.length === 0) {
        err('branch_coverage', `${vid}: claims ${claimsControl ? 'control_flow' : 'mechanism'} while mechanism.has_important_branching=true, but shows no reject/failure/skip path and defers none with a reason`)
      }
    }
    if ((claimsState || claimsMechanism) && hasMutableState) {
      if (stateEntities.size === 0) {
        err('state_contract_gap', `${vid}: claims state semantics while mechanism.mutable_state=true, but the dossier declares no mechanism.states[] — fix the PRODUCER contract (this gate never infers state lifecycles from source)`)
      } else if (claimsState && !hasMutableUpdateEdge) {
        err('state_lifecycle_coverage', `${vid}: claims state_lifecycle over mutable state but shows no state update path (no state-domain update edge touching a mutable state)`)
      }
    }

    const rec = recommendVisualSplit(spec, dossier)
    if (rec) recommendations.push(rec)
  }

  // Deferred relations (any visual): resolve, require a reason, mark consumed-by-deferral.
  visuals.forEach((spec) => {
    const vid = isNonempty(spec.id) ? spec.id : '(visual)'
    for (const d of Array.isArray(spec.deferred_relations) ? spec.deferred_relations : []) {
      if (!isObject(d) || !isNonempty(d.from) || !isNonempty(d.to) || !isNonempty(d.kind)) {
        err('deferred_relations', `${vid}: deferred_relations entries need from, to, and kind`)
        continue
      }
      if (!isNonempty(d.reason)) { err('deferred_relations', `${vid}: deferring relation ${d.from} --${d.kind}--> ${d.to} requires a reason`); continue }
      resolveStage(d.from, 'deferred_relations', `${vid} deferred_relations`)
      resolveStage(d.to, 'deferred_relations', `${vid} deferred_relations`)
      relations.forEach((rel, i) => {
        if (rel.from === d.from && rel.to === d.to && rel.kind === d.kind) deferredRelations.add(i)
      })
    }
  })

  // Declared control relations must be consumed deck-wide or explicitly deferred.
  relations.forEach((rel, i) => {
    if (!isNonempty(rel.from) || !isNonempty(rel.to) || !isNonempty(rel.kind)) {
      err('control_relations', `mechanism.control_relations[${i}] needs from, to, and kind`)
      return
    }
    if (consumedRelations.has(i) || deferredRelations.has(i)) return
    err('control_relation_coverage', `declared control relation ${JSON.stringify(rel.from)} --${rel.kind}--> ${JSON.stringify(rel.to)} is consumed by no visual edge and deferred by none with a reason`)
  })
  relations.forEach((rel, i) => {
    if (stageNames.size === 0) return
    for (const endpoint of [rel.from, rel.to]) {
      if (isNonempty(endpoint) && !stageNames.has(endpoint)) {
        err('control_relations', `mechanism.control_relations[${i}] references unknown stage ${JSON.stringify(endpoint)}`)
      }
    }
  })

  // State lifecycles must reference declared stages (producer self-consistency).
  for (const [sid, entity] of stateEntities) {
    for (const field of ['created_in', 'finalized_in']) {
      if (isNonempty(entity[field]) && stageNames.size > 0 && !stageNames.has(entity[field])) {
        err('state_lifecycle', `mechanism.states[${sid}].${field} references unknown stage ${JSON.stringify(entity[field])}`)
      }
    }
    for (const field of ['read_in', 'updated_in']) {
      for (const s of Array.isArray(entity[field]) ? entity[field] : []) {
        if (stageNames.size > 0 && !stageNames.has(s)) {
          err('state_lifecycle', `mechanism.states[${sid}].${field} references unknown stage ${JSON.stringify(s)}`)
        }
      }
    }
  }

  // Meta-rule (warning only, for backward compatibility with pre-T6 visuals):
  // stages exist and a deck has must-have visuals, but nothing claims the mechanism.
  const mustHave = (handoff && handoff.must_have_visuals) || []
  if (stageNames.size > 0 && mustHave.length > 0 && !anyMechanismClaim) {
    warn('mechanism_claim_missing', 'dossier declares mechanism stages but no visual claims coverage: "mechanism" — stage-loss checking is claim-bound; declare covers:["mechanism"] on the overview visual')
  }

  return { verdict: errors.length === 0 ? 'pass' : 'fail', errors, warnings, recommendations }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--'))
  if (!dir) {
    console.error('usage: node scripts/check-visual-semantics.mjs <bundle-dir>')
    console.error('  bundle-dir must contain dossier.json + handoff.json')
    process.exit(2)
  }
  const root = resolve(dir)
  let dossier, handoff
  try {
    dossier = JSON.parse(readFileSync(join(root, 'dossier.json'), 'utf8'))
  } catch {
    console.error(JSON.stringify({ verdict: 'fail', errors: [{ check: 'bundle', detail: `cannot read ${join(root, 'dossier.json')}` }], warnings: [], recommendations: [] }, null, 1))
    process.exit(1)
  }
  try {
    handoff = JSON.parse(readFileSync(join(root, 'handoff.json'), 'utf8'))
  } catch {
    console.error(JSON.stringify({ verdict: 'fail', errors: [{ check: 'bundle', detail: `cannot read ${join(root, 'handoff.json')}` }], warnings: [], recommendations: [] }, null, 1))
    process.exit(1)
  }
  const report = checkVisualSemantics({ dossier, handoff })
  console.log(JSON.stringify(report, null, 1))
  process.exit(report.verdict === 'pass' ? 0 : 1)
}

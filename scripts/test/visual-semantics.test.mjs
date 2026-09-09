/**
 * Phase T6 semantic visual fidelity tests.
 *
 * Coverage (Goal §13):
 * - 13.1 stage coverage: a claimed mechanism visual that silently drops a
 *   source-derived stage fails — regression on the REAL failing T5 dogfood
 *   visual (fixture) where 7 stages were drawn as 6 nodes and "Maintain &
 *   verify" was folded into the loop;
 * - 13.2 state lifecycle: an update claim against an initialization-only
 *   derived state is a deterministic error; so is attributing state access to
 *   a stage the producer did not declare;
 * - 13.3 worklist vs live sequence: one node silently depicting states of
 *   different roles fails without a merge reason and passes with one;
 * - 13.4 edge kinds: control kinds are consumed per-relation, not degraded
 *   into unlabeled edges; unknown kinds/domains are rejected;
 * - 13.5 loop semantics: a declared requeue/loop relation must survive into
 *   some visual edge or be explicitly deferred with a reason;
 * - 13.6 split recommendation: the bounded complexity profile produces
 *   SPLIT_RECOMMENDED as a recommendation, never an error;
 * - schema integration: new dossier/handoff fields validate, legacy artifacts
 *   stay valid, readiness carries the visual_semantics check, the preflight
 *   digest surfaces the contract;
 * - consumer consumption: state edges render dashed and state nodes render in
 *   the state palette (presentation decisions made by spec_to_diagram.py);
 *   legacy specs are rendered exactly as before.
 *
 * Fixtures may carry dogfood subject terms (regression fixtures are an
 * allowed location); the generic scripts must not (teaching-dogfood scan).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKILL = join(repoRoot, 'skills', 'compiler-architecture-presentation')
const SCRIPTS = join(SKILL, 'scripts')
const fixture = JSON.parse(readFileSync(
  join(repoRoot, 'scripts', 'test', 'fixtures', 'mergevecscope-t5-v2-visual.json'), 'utf-8'))

const { checkVisualSemantics, recommendVisualSplit } = await import('../../scripts/check-visual-semantics.mjs')
const { validateBundle, computeMechanicalReadiness } = await import('../../scripts/teaching-schema.mjs')

// ─── Shared generic scaffolding (no subject terms — this is contract level) ──

const EV = { records: [{ id: 'EV-1', class: 'source_fact', statement: 'fact', refs: [{ file: 'a.cpp', lines: '1-2' }] }] }

function genericDossier(overrides = {}) {
  return {
    subject_id: 'generic-alg', subject_type: 'algorithm', depth: 'presentation',
    mechanism: {
      stages: [{ name: 'S1 initialize', evidence_refs: ['EV-1'] }, { name: 'S2 iterate', evidence_refs: ['EV-1'] }, { name: 'S3 commit', evidence_refs: ['EV-1'] }, { name: 'S4 finalize', evidence_refs: ['EV-1'] }],
      mutable_state: true,
      has_important_branching: true,
      ...overrides,
    },
    ...overrides.dossier,
  }
}

function genericHandoff(extraVisuals = []) {
  return {
    subject_id: 'generic-alg', subject_type: 'algorithm', depth: 'presentation',
    must_have_visuals: ['V1'],
    visuals: [{
      id: 'V1', kind: 'flowchart', title: 'overview',
      covers: ['mechanism', 'control_flow', 'state_lifecycle'],
      nodes: [
        { id: 'n-init', label: 'initialize', mechanism_stages: ['S1 initialize'] },
        { id: 'n-loop', label: 'iterate', mechanism_stages: ['S2 iterate'] },
        { id: 'n-commit', label: 'commit', mechanism_stages: ['S3 commit'] },
        { id: 'n-fin', label: 'finalize', mechanism_stages: ['S4 finalize'] },
        { id: 'st-queue', label: 'work queue', state_refs: ['queue'] },
        { id: 'st-derived', label: 'derived matrix', state_refs: ['derived'] },
      ],
      edges: [
        { from: 'n-init', to: 'n-loop', kind: 'next' },
        { from: 'n-loop', to: 'n-loop', kind: 'requeue', label: 'next candidate' },
        { from: 'n-loop', to: 'n-commit', kind: 'success' },
        { from: 'n-loop', to: 'n-fin', kind: 'reject', label: 'gate fails' },
        { from: 'st-queue', to: 'n-loop', domain: 'state', kind: 'read' },
        { from: 'n-loop', to: 'st-queue', domain: 'state', kind: 'update' },
        { from: 'st-derived', to: 'n-loop', domain: 'state', kind: 'read' },
      ],
    }, ...extraVisuals],
  }
}

function genericStates() {
  return {
    states: [
      { id: 'queue', name: 'work queue', kind: 'work_queue', created_in: 'S1 initialize', read_in: ['S2 iterate'], updated_in: ['S2 iterate'], evidence_refs: ['EV-1'] },
      { id: 'derived', name: 'derived matrix', kind: 'derived', created_in: 'S1 initialize', read_in: ['S2 iterate'], updated_in: [], evidence_refs: ['EV-1'] },
    ],
    control_relations: [
      { from: 'S1 initialize', to: 'S2 iterate', kind: 'next', evidence_refs: ['EV-1'] },
      { from: 'S2 iterate', to: 'S2 iterate', kind: 'requeue', evidence_refs: ['EV-1'] },
      { from: 'S2 iterate', to: 'S3 commit', kind: 'success', evidence_refs: ['EV-1'] },
      { from: 'S2 iterate', to: 'S4 finalize', kind: 'reject', evidence_refs: ['EV-1'] },
    ],
  }
}

function goodBundle() {
  const dossier = genericDossier()
  Object.assign(dossier.mechanism, genericStates())
  return { evidence: EV, dossier, handoff: genericHandoff() }
}

function errorsOf(r, check) {
  return r.errors.filter((e) => e.check === check)
}

// ─── 13.1 Stage coverage (real regression fixture) ───────────────────────────

test('13.1 REGRESSION: the real T5 mechanism-overview visual silently dropped a source-derived stage', () => {
  const dossier = { mechanism: { stages: fixture.stages.map((name) => ({ name })) } }
  const handoff = { must_have_visuals: ['V2'], visuals: [{ ...fixture.visual, covers: ['mechanism'] }] }
  const r = checkVisualSemantics({ dossier, handoff })
  assert.equal(r.verdict, 'fail')
  const stageErrors = errorsOf(r, 'stage_coverage')
  assert.equal(stageErrors.length, 1, JSON.stringify(r.errors))
  assert.match(stageErrors[0].detail, /Maintain & verify/, 'the folded-away stage must be named')
  assert.match(stageErrors[0].detail, /V2/)
})

test('13.1 mapping the missing stage (or a reasoned disposition) repairs the T5 visual', () => {
  const dossier = { mechanism: { stages: fixture.stages.map((name) => ({ name })) } }
  const visual = { ...fixture.visual, covers: ['mechanism'] }
  // the six drawn stage nodes each map the stage they actually depicted
  // (the spec's st1..st3 state nodes stay stage-free)
  visual.nodes = fixture.visual.nodes.map((n) => {
    const m = /^s([1-6])$/.exec(n.id)
    return m ? { ...n, mechanism_stages: [fixture.stages[Number(m[1]) - 1]] } : n
  })
  visual.nodes = [...visual.nodes, { id: 's7', label: 'commit & verify', mechanism_stages: ['Maintain & verify'] }]
  let r = checkVisualSemantics({ dossier, handoff: { must_have_visuals: ['V2'], visuals: [visual] } })
  assert.equal(r.verdict, 'pass', JSON.stringify(r.errors))

  const visual2 = { ...visual, nodes: visual.nodes.slice(0, -1), stage_dispositions: [{ stage: 'Maintain & verify', disposition: 'deferred', reason: 'carried by the commit-state visual instead', to_visual: 'V2B' }] }
  r = checkVisualSemantics({ dossier, handoff: { must_have_visuals: ['V2'], visuals: [visual2] } })
  assert.equal(r.verdict, 'pass', JSON.stringify(r.errors))

  // a disposition without a reason is not a disposition
  const visual3 = { ...visual2, stage_dispositions: [{ stage: 'Maintain & verify', disposition: 'deferred' }] }
  r = checkVisualSemantics({ dossier, handoff: { must_have_visuals: ['V2'], visuals: [visual3] } })
  assert.ok(errorsOf(r, 'stage_dispositions').length === 1)
})

test('13.1 one node silently absorbing several stages fails without stage_merge_reason', () => {
  const dossier = genericDossier()
  Object.assign(dossier.mechanism, genericStates())
  const handoff = genericHandoff()
  handoff.visuals[0].nodes[1].mechanism_stages = ['S2 iterate', 'S3 commit']
  const r = checkVisualSemantics({ dossier, handoff })
  assert.equal(errorsOf(r, 'stage_merge_reason').length, 1)
  handoff.visuals[0].nodes[1].stage_merge_reason = 'loop and commit drawn together: the commit IS the loop tail'
  assert.equal(checkVisualSemantics({ dossier, handoff }).verdict, 'pass')
})

// ─── 13.2 State lifecycle contradiction ──────────────────────────────────────

test('13.2 an update claim on an initialization-only derived state is a deterministic error', () => {
  const bundle = goodBundle()
  // the derived matrix is declared updated_in=[]; claim a per-iteration sync
  bundle.handoff.visuals[0].edges.push({ from: 'n-loop', to: 'st-derived', domain: 'state', kind: 'update' })
  const r = checkVisualSemantics(bundle)
  assert.equal(errorsOf(r, 'lifecycle_contradiction').length, 1)
  assert.match(errorsOf(r, 'lifecycle_contradiction')[0].detail, /initialization-only/)
})

test('13.2 state access attributed to an undeclared stage fails; the declared stage passes', () => {
  const bundle = goodBundle()
  bundle.handoff.visuals[0].edges[5] = { from: 'n-commit', to: 'st-queue', domain: 'state', kind: 'update' }
  let r = checkVisualSemantics(bundle)
  const mismatch = errorsOf(r, 'lifecycle_stage_mismatch')
  assert.equal(mismatch.length, 1, JSON.stringify(r.errors))
  assert.match(mismatch[0].detail, /updated_in = \[S2 iterate\]/)
  bundle.handoff.visuals[0].edges[5] = { from: 'n-loop', to: 'st-queue', domain: 'state', kind: 'update' }
  r = checkVisualSemantics(bundle)
  assert.equal(errorsOf(r, 'lifecycle_stage_mismatch').length, 0)
})

test('13.2 mutable_state declared without state entities is a PRODUCER contract gap, not a consumer guess', () => {
  const dossier = genericDossier() // no states declared
  const r = checkVisualSemantics({ dossier, handoff: genericHandoff() })
  assert.equal(errorsOf(r, 'state_contract_gap').length, 1)
  assert.match(errorsOf(r, 'state_contract_gap')[0].detail, /PRODUCER/)
})

// ─── 13.3 Worklist vs live sequence (state-role collapse) ────────────────────

test('13.3 a node silently collapsing states of different roles fails; an explicit reason is accepted', () => {
  const bundle = goodBundle()
  bundle.handoff.visuals[0].nodes.push({ id: 'st-both', label: 'the VF sequence', state_refs: ['queue', 'derived'] })
  const r = checkVisualSemantics(bundle)
  const collapse = errorsOf(r, 'state_role_collapse')
  assert.equal(collapse.length, 1)
  assert.match(collapse[0].detail, /work_queue.*derived/)
  bundle.handoff.visuals[0].nodes.pop()
  bundle.handoff.visuals[0].nodes.push({ id: 'st-both', label: 'the VF sequence', state_refs: ['queue', 'derived'], state_merge_reason: 'single diagram budget: both families shown as one inventory box, no update edges attach to it' })
  assert.equal(checkVisualSemantics(bundle).verdict, 'pass')
})

// ─── 13.4 Edge kinds ─────────────────────────────────────────────────────────

test('13.4 declared relations of distinct kinds must each be consumed — no unlabeled degeneration', () => {
  const bundle = goodBundle()
  assert.equal(checkVisualSemantics(bundle).verdict, 'pass')
  // drop the reject edge entirely: the reject-family relation goes unconsumed
  bundle.handoff.visuals[0].edges = bundle.handoff.visuals[0].edges.filter((e) => e.kind !== 'reject')
  const r = checkVisualSemantics(bundle)
  assert.equal(errorsOf(r, 'control_relation_coverage').length, 1)
  assert.match(errorsOf(r, 'control_relation_coverage')[0].detail, /reject/)
})

test('13.4 unknown edge kinds and domains are rejected (schema + validator)', () => {
  const bundle = goodBundle()
  bundle.handoff.visuals[0].edges.push({ from: 'n-init', to: 'n-loop', kind: 'maybe' })
  const { errors } = validateBundle(bundle)
  assert.ok(errors.some((e) => e.includes('edge') && e.includes('maybe')), errors.join(';'))
  delete bundle.handoff.visuals[0].edges.at(-1).kind
  bundle.handoff.visuals[0].edges.at(-1).domain = 'quantum'
  const { errors: e2 } = validateBundle(bundle)
  assert.ok(e2.some((e) => e.includes('domain')), e2.join(';'))
})

// ─── 13.5 Loop semantics ─────────────────────────────────────────────────────

test('13.5 a declared requeue relation must survive into the deck or be deferred with a reason', () => {
  const bundle = goodBundle()
  bundle.handoff.visuals[0].edges = bundle.handoff.visuals[0].edges.filter((e) => e.kind !== 'requeue')
  let r = checkVisualSemantics(bundle)
  assert.equal(errorsOf(r, 'control_relation_coverage').length, 1)
  assert.match(errorsOf(r, 'control_relation_coverage')[0].detail, /requeue/)
  bundle.handoff.visuals[0].deferred_relations = [{ from: 'S2 iterate', to: 'S2 iterate', kind: 'requeue', reason: 'loop feedback shown on the follow-up detail visual' }]
  r = checkVisualSemantics(bundle)
  assert.equal(r.verdict, 'pass', JSON.stringify(r.errors))
  bundle.handoff.visuals[0].deferred_relations = [{ from: 'S2 iterate', to: 'S2 iterate', kind: 'requeue' }]
  r = checkVisualSemantics(bundle)
  assert.equal(errorsOf(r, 'deferred_relations').length, 1, 'deferral without a reason is a silent drop in disguise')
})

// ─── 13.6 Split recommendation (split > semantic compression) ────────────────

test('13.6 SPLIT_RECOMMENDED fires on the complexity profile and never as an error', () => {
  const bundle = goodBundle()
  // enrich V1 until it carries 5 stages, 2 mutable families, loop, and reject
  const dossier = genericDossier()
  dossier.mechanism.stages.push({ name: 'S5 verify', evidence_refs: ['EV-1'] })
  Object.assign(dossier.mechanism, genericStates())
  dossier.mechanism.states.push({ id: 'live', name: 'live sequence', kind: 'live_sequence', created_in: 'S1 initialize', read_in: ['S2 iterate'], updated_in: ['S3 commit'], evidence_refs: ['EV-1'] })
  dossier.mechanism.states.push({ id: 'ir', name: 'rewritten IR', kind: 'ir', created_in: 'S1 initialize', updated_in: ['S3 commit'], read_in: ['S5 verify'], evidence_refs: ['EV-1'] })
  const handoff = genericHandoff()
  const v1 = handoff.visuals[0]
  v1.nodes.push({ id: 'n-verify', label: 'verify', mechanism_stages: ['S5 verify'] })
  v1.nodes.push({ id: 'st-live', label: 'live order', state_refs: ['live'] })
  v1.nodes.push({ id: 'st-ir', label: 'IR state', state_refs: ['ir'] })
  v1.edges.push({ from: 'n-commit', to: 'n-verify', kind: 'next' })
  v1.edges.push({ from: 'st-live', to: 'n-commit', domain: 'state', kind: 'update' })
  v1.edges.push({ from: 'st-ir', to: 'n-verify', domain: 'state', kind: 'read' })
  const r = checkVisualSemantics({ dossier, handoff })
  assert.equal(r.verdict, 'pass', 'recommendations must never fail a deck')
  assert.equal(r.recommendations.length, 1)
  assert.equal(r.recommendations[0].recommendation, 'SPLIT_RECOMMENDED')
  assert.ok(r.recommendations[0].metrics.stages >= 5)
  // the standalone policy function agrees, and a simple visual gets nothing
  assert.equal(recommendVisualSplit(v1, dossier)?.recommendation, 'SPLIT_RECOMMENDED')
  assert.equal(recommendVisualSplit(goodBundle().handoff.visuals[0], goodBundle().dossier), null)
})

// ─── Schema integration ──────────────────────────────────────────────────────

const caseADir = join(repoRoot, 'analysis', 'explanations', '2026-09-08-mergevecscope-pass')
function baseBundle() {
  const load = (f) => JSON.parse(readFileSync(join(caseADir, f), 'utf-8'))
  return { subject: load('subject.json'), evidence: load('evidence.json'),
    dossier: load('dossier.json'), handoff: load('handoff.json') }
}

test('schema: semantic contract fields validate on a real bundle; malformed shapes fail', () => {
  const bundle = baseBundle()
  const stageNames = bundle.dossier.mechanism.stages.map((s) => s.name)
  bundle.dossier.mechanism.states = [
    { id: 'queue', name: 'work queue', kind: 'work_queue', created_in: stageNames[0], read_in: [stageNames[3]], updated_in: [stageNames[3]], evidence_refs: ['EV-007'] },
    { id: 'derived', name: 'derived matrix', kind: 'derived', created_in: stageNames[2], read_in: [stageNames[3]], updated_in: [], evidence_refs: ['EV-006'] },
  ]
  bundle.dossier.mechanism.control_relations = stageNames.slice(0, -1)
    .map((name, i) => ({ from: name, to: stageNames[i + 1], kind: 'next', evidence_refs: ['EV-007'] }))
  bundle.handoff.visuals[0].covers = ['mechanism']
  bundle.handoff.visuals[0].nodes[0].mechanism_stages = [stageNames[0]]
  bundle.handoff.visuals[0].edges[0].kind = 'next'
  const { errors } = validateBundle(bundle)
  assert.deepEqual(errors, [])

  const bad = baseBundle()
  bad.dossier.mechanism.states = [{ id: 'x', name: 'x', kind: 'unicorn', evidence_refs: ['EV-001'] }]
  const { errors: e2 } = validateBundle(bad)
  assert.ok(e2.some((e) => /must be one of work_queue/.test(e)), e2.join(';'))

  const bad2 = baseBundle()
  bad2.handoff.visuals[0].covers = ['vibes']
  const { errors: e3 } = validateBundle(bad2)
  assert.ok(e3.some((e) => e.includes('covers')), e3.join(';'))
})

test('readiness: visual_semantics gate passes a contract-carrying deck and fails a contradicting one', () => {
  const bundle = baseBundle()
  // Graft the T6 contract onto the curated bundle, using the bundle's own
  // source-derived stage names so every reference resolves.
  const stageNames = bundle.dossier.mechanism.stages.map((s) => s.name)
  bundle.dossier.mechanism.states = [
    { id: 'queue', name: 'work queue', kind: 'work_queue', created_in: stageNames[0], read_in: [stageNames[3]], updated_in: [stageNames[3]], evidence_refs: ['EV-007'] },
    { id: 'derived', name: 'derived matrix', kind: 'derived', created_in: stageNames[2], read_in: [stageNames[3]], updated_in: [], evidence_refs: ['EV-006'] },
  ]
  bundle.dossier.mechanism.control_relations = stageNames.slice(0, -1)
    .map((name, i) => ({ from: name, to: stageNames[i + 1], kind: 'next', evidence_refs: ['EV-007'] }))
  bundle.handoff.visuals.unshift({
    id: 'V0', kind: 'flowchart', title: 'semantic overview', covers: ['mechanism'],
    nodes: stageNames.map((name, i) => ({ id: `st${i}`, label: name, mechanism_stages: [name] })),
    edges: stageNames.slice(0, -1).map((name, i) => ({ from: `st${i}`, to: `st${i + 1}`, kind: 'next' })),
    deferred_relations: [{ from: stageNames[3], to: stageNames[4], kind: 'reject', reason: 'the gate cascade is the legality visual’s job' }],
  })
  bundle.handoff.must_have_visuals = ['V0', ...bundle.handoff.must_have_visuals]
  const ok = computeMechanicalReadiness(bundle, { depth: 'presentation' })
  assert.equal(ok.checks.find((c) => c.name === 'visual_semantics').status, 'pass', ok.checks.find((c) => c.name === 'visual_semantics').detail)

  // Now make V0 contradict the producer: claim a state update the producer never declared.
  bundle.handoff.visuals[0].nodes.push({ id: 'ghost-state', label: 'derived', state_refs: ['derived'] })
  bundle.handoff.visuals[0].edges.push({ from: 'st1', to: 'ghost-state', domain: 'state', kind: 'update' })
  const fail = computeMechanicalReadiness(bundle, { depth: 'presentation' })
  const sem = fail.checks.find((c) => c.name === 'visual_semantics')
  assert.equal(sem.status, 'fail')
  assert.match(sem.detail, /lifecycle_contradiction/)
})

test('legacy bundles stay valid: the pre-T6 curated bundle still passes the mechanical gate', () => {
  const bundle = baseBundle() // no covers, no states, no relations
  const m = computeMechanicalReadiness(bundle, { depth: 'presentation' })
  assert.equal(m.checks.find((c) => c.name === 'visual_semantics').status, 'pass')
})

test('preflight digest surfaces the semantic visual contract to the consumer', async () => {
  const { preflightHandoff } = await import('../../scripts/preflight-handoff.mjs')
  const dir = mkdtempSync(join(tmpdir(), 't6-preflight-'))
  try {
    const load = (f) => JSON.parse(readFileSync(join(caseADir, f), 'utf-8'))
    const bundle = { subject: load('subject.json'), evidence: load('evidence.json'),
      dossier: load('dossier.json'), handoff: load('handoff.json'), readiness: load('readiness.json') }
    // absolute repository_path so staleness resolves from the tmp copy
    bundle.subject.provenance.repository_path = join(repoRoot, '..', 'AscendNPU-IR')
    const stageNames = bundle.dossier.mechanism.stages.map((s) => s.name)
    bundle.dossier.mechanism.states = [
      { id: 'queue', name: 'work queue', kind: 'work_queue', created_in: stageNames[0], read_in: [stageNames[3]], updated_in: [stageNames[3]], evidence_refs: ['EV-007'] },
      { id: 'derived', name: 'derived matrix', kind: 'derived', created_in: stageNames[2], read_in: [stageNames[3]], updated_in: [], evidence_refs: ['EV-006'] },
    ]
    for (const [f, key] of [['subject.json', 'subject'], ['evidence.json', 'evidence'], ['dossier.json', 'dossier'], ['handoff.json', 'handoff'], ['readiness.json', 'readiness']]) {
      writeFileSync(join(dir, f), JSON.stringify(bundle[key], null, 1))
    }
    const out = preflightHandoff(dir)
    assert.equal(out.verdict, 'CONSUMABLE', JSON.stringify(out.reasons || out))
    const v = out.digest.visuals[0]
    assert.deepEqual(v.covers, [])
    assert.deepEqual(v.stages_mapped, [])
    assert.equal(v.state_edges, 0)
    assert.deepEqual(out.digest.dossier_pointers.mechanism_states.map((s) => s.id), ['queue', 'derived'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Consumer consumption (spec_to_diagram.py) ───────────────────────────────

const py = (args, opts = {}) => {
  const r = spawnSync('python3', args, { encoding: 'utf-8', ...opts })
  if (r.error) throw r.error
  return r
}

function interpret(spec) {
  const dir = mkdtempSync(join(tmpdir(), 't6-'))
  const specPath = join(dir, 'visual.json')
  writeFileSync(specPath, JSON.stringify(spec))
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import spec_to_diagram as m
spec = json.load(open(${JSON.stringify(specPath)}))
print(json.dumps(m.interpret(spec), ensure_ascii=False))
`
  const r = py(['-c', code])
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout.trim())
}

test('consumer: state edges render dashed and state nodes render in the state palette', () => {
  const bundle = goodBundle()
  const out = interpret(bundle.handoff.visuals[0])
  const queueNode = out.nodes.find((n) => n.id === 'st-queue')
  assert.equal(queueNode.color, 'amber', 'state-only nodes render amber')
  const stageNode = out.nodes.find((n) => n.id === 'n-init')
  assert.equal(stageNode.color, 'blue', 'stage-mapped nodes render blue')
  const stateEdge = out.edges.find((e) => e.from === 'st-queue' && e.to === 'n-loop')
  assert.equal(stateEdge.dashed, true, 'state-domain edges render dashed (not control flow)')
  const controlEdge = out.edges.find((e) => e.label === 'gate fails')
  assert.equal(controlEdge.dashed, false, 'control edges stay solid')
})

test('consumer: legacy specs without semantic fields render exactly as before', () => {
  const out = interpret(fixture.visual)
  for (const n of out.nodes) assert.equal(n.color, 'neutral', `legacy node ${n.id} must keep the neutral palette`)
  for (const e of out.edges) assert.equal(e.dashed, false, 'legacy edges stay solid')
})

/**
 * Tests for the Teaching Artifact Protocol v1 validators and the mechanical
 * readiness gate (scripts/teaching-schema.mjs).
 *
 * Coverage maps to the goal requirements: generic schema across subject types
 * (Function / Algorithm / Pass / Subsystem), optional-field tolerance (no
 * pass-centric mandatory fields outside the pass extension), evidence
 * discipline (fact/reasoning separation), the mechanical readiness gate, the
 * readiness != field-completeness rule, and semantic-only visual specs.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateBundle, computeMechanicalReadiness, computeReadiness, computeStaleness,
  assessMentalModel, validateVisualSpec, semanticQuestionsFor, slugify,
} from '../teaching-schema.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// Bundle builders (generic — no compiler-specific concepts in the fixtures'
// *structure*; fixture CONTENT uses neutral subject matter)
// ─────────────────────────────────────────────────────────────────────────────

function evidenceLedger(extra = []) {
  return {
    artifact: 'evidence',
    records: [
      { id: 'EV-001', class: 'source_fact', statement: 'The entry function is defined at core.c:42 and takes a queue reference.', refs: [{ file: 'src/core.c', lines: '42-60' }] },
      { id: 'EV-002', class: 'graph_fact', statement: '1-hop callers found by the knowledge graph: scheduler_main and worker_poll.', tool: 'repomap', command: 'evidence scheduler' },
      { id: 'EV-003', class: 'reasoning', statement: 'The two-phase scan likely exists to keep the latency-critical path allocation-free.', note: 'inference from structure; no comment states it' },
      { id: 'EV-004', class: 'runtime_fact', statement: 'The unit test with a 3-item queue passes and retires all items in order.', refs: [{ file: 'test/queue_test.c', lines: '10-40' }] },
      ...extra,
    ],
  }
}

function subjectBase(overrides = {}) {
  return {
    artifact: 'subject',
    subject_id: 'fair-queue-scheduler-class',
    subject_type: 'class',
    name: 'FairQueueScheduler',
    repository: 'example-runtime',
    source_locations: [{ file: 'src/scheduler.c', lines: '20-400' }],
    scope: 'one scheduling class and its immediate collaborators',
    related_entities: [{ name: 'WorkerPool', relation: 'collaborator' }],
    why_this_subject: 'representative complex class with mutable state and branching',
    provenance: {
      repository: 'example-runtime', repository_path: '/tmp/example-runtime', branch: 'main',
      head: '0123456789abcdef0123456789abcdef01234567', analyzed_at: '2026-09-08T10:00:00Z',
      tool_versions: { driver: 'test' }, runtime_verification: 'partial',
      runtime_verification_note: 'unit test queue_test.c executed',
      source_files: [{ path: 'src/scheduler.c', sha256: 'a'.repeat(64) }],
    },
    ...overrides,
  }
}

function dossierBase(overrides = {}) {
  return {
    artifact: 'teaching_dossier',
    schema_version: 1,
    subject_id: 'fair-queue-scheduler-class',
    subject_type: 'class',
    depth: 'deep',
    mental_model: 'It is a round-based dispatcher that lets every waiting worker make progress before anyone gets a second turn, so no worker can starve behind a hot queue.',
    need: 'Workers otherwise drain one hot queue while others starve.',
    responsibility: 'Pick the next runnable queue per round and hand it to callers.',
    observable_outcome: 'Every active queue is served within one round of becoming runnable.',
    audience_contract: { who: 'runtime engineer', assumed_knowledge: 'basic scheduling', not_assumed: 'this implementation' },
    system_context: {
      triggers: [{ role: 'caller', entity: 'worker_poll', interaction: 'asks for the next queue when idle', evidence_refs: ['EV-002'] }],
      upstream: [{ role: 'producer', entity: 'enqueue_path', interaction: 'inserts runnable queues', evidence_refs: ['EV-001'] }],
      downstream: [{ role: 'consumer', entity: 'worker_pool', interaction: 'executes the handed-off queue', evidence_refs: ['EV-002'] }],
    },
    inputs: [{ name: 'runnable queue list', form: 'intrusive list', description: 'queues ready to run', evidence_refs: ['EV-001'] }],
    outputs: [{ name: 'next queue handle', form: 'pointer', description: 'queue to execute next', evidence_refs: ['EV-001'] }],
    mechanism: {
      summary: 'Two phases per round: refill the rotation from newly runnable queues, then serve one queue per worker in rotation.',
      stages: [
        { name: 'Refill', what: 'move newly runnable queues into the rotation', where: 'scheduler.c:80', key_functions: ['refill_rotation'], evidence_refs: ['EV-001'] },
        { name: 'Serve', what: 'pop the next queue in rotation order', where: 'scheduler.c:120', key_functions: ['serve_next'], evidence_refs: ['EV-001'] },
      ],
      control_flow: ['worker_poll → serve_next → queue run'],
      data_flow: ['queue descriptor moves from rotation list to worker local handle'],
      mutable_state: true,
      has_important_branching: true,
    },
    implementation_view: [
      { aspect: 'rotation list', description: 'doubly-linked ring of runnable queues', evidence_refs: ['EV-001'] },
    ],
    conceptual_view: [
      { aspect: 'fairness', description: 'round order instead of priority order keeps starvation bounded', evidence_refs: ['EV-003'] },
    ],
    canonical_example: {
      provenance: { kind: 'test', source: 'test/queue_test.c:10-40' },
      initial_state: 'three queues A,B,C all runnable',
      inputs: 'worker_poll called 3 times',
      execution_trace: ['serve A', 'serve B', 'serve C'],
      important_states: ['rotation ring after refill: A,B,C'],
      result: 'all three queues served once before any repeat',
    },
    state_transitions: [
      { phase: 'serve', before: 'rotation: [A,B,C]', operation: 'serve_next pops A', after: 'rotation: [B,C,A-tail]', reason: 'round order', evidence_refs: ['EV-001'] },
    ],
    decisions: [
      { id: 'D1', question: 'Serve strict rotation or priority first?', condition: 'queue has priority flag', outcomes: ['priority-first', 'rotation'], reason: 'priority path exists for latency-critical queues', evidence_refs: ['EV-001'], example_refs: ['EV-004'] },
    ],
    contracts: [
      { producer: 'enqueue_path', consumer: 'FairQueueScheduler', subject_side: 'requires', element: 'runnable queue with valid next pointer', form: 'intrusive list node', evidence_refs: ['EV-001'] },
    ],
    constraints: [
      { statement: 'queue must be removed from the rotation before free', status: 'guarded', evidence_refs: ['EV-001'] },
    ],
    invariants: [
      { statement: 'rotation ring has no duplicate queue', status: 'verified', evidence_refs: ['EV-004'] },
    ],
    boundaries: [
      { category: 'supported', statement: 'fair rotation over any number of queues', evidence_refs: ['EV-004'] },
      { category: 'unknown', statement: 'behavior with more queues than rotation slots is not covered by tests', evidence_refs: ['EV-003'] },
    ],
    placement: { applicable: true, why_here: 'sits between enqueue and worker pool where runnable state is known', why_not_earlier: 'enqueue cannot know rotation order', why_not_later: 'workers must not each implement fairness', evidence_refs: ['EV-001'] },
    key_takeaways: ['Round-based fairness bounds starvation', 'Refill/serve split keeps the hot path allocation-free', 'Priority is the only override of rotation order'],
    extensions: {
      class: {
        responsibility: 'single scheduling decision per call',
        owned_state: 'rotation ring head, round counter',
        lifecycle: 'created at pool init, destroyed at pool shutdown',
        public_api: ['serve_next', 'refill_rotation'],
        collaborators: ['WorkerPool'],
      },
    },
    ...overrides,
  }
}

function handoffBase(overrides = {}) {
  return {
    artifact: 'presentation_handoff',
    schema_version: 1,
    subject_id: 'fair-queue-scheduler-class',
    subject_type: 'class',
    depth: 'presentation',
    audience: { who: 'runtime engineers who never read scheduler.c' },
    learning_objectives: ['explain the fairness contract', 'locate the refill/serve boundary'],
    storyline: [
      { position: 1, role: 'why it exists', claim: 'workers starve behind a hot queue', dossier_section: 'need', evidence_refs: ['EV-003'] },
      { position: 2, role: 'core idea', claim: 'round-based rotation', dossier_section: 'mechanism', evidence_refs: ['EV-001'] },
      { position: 3, role: 'worked example', claim: 'A,B,C served once each', dossier_section: 'canonical_example', evidence_refs: ['EV-004'] },
      { position: 4, role: 'boundaries', claim: 'priority is the only override', dossier_section: 'decisions', evidence_refs: ['EV-001'] },
    ],
    visuals: [
      { id: 'V1', kind: 'state_transition', title: 'Rotation ring across one round', purpose: 'show fairness', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'next' }], ordering: ['A before B'] },
    ],
    must_have_visuals: ['V1'],
    optional_visuals: [],
    canonical_example: { summary: 'three queues served once per round', provenance: 'test', key_frames: ['rotation [A,B,C]'] },
    key_takeaways: ['Round fairness', 'Refill/serve split', 'Priority override only'],
    appendix_topics: ['lock-free ring alternatives'],
    evidence_index: [{ id: 'EV-001', statement: 'entry definition', class: 'source_fact', refs: [{ file: 'src/core.c', lines: '42-60' }] }],
    ...overrides,
  }
}

function goodBundle(overrides = {}) {
  return {
    subject: subjectBase(),
    evidence: evidenceLedger(),
    dossier: dossierBase(overrides.dossier),
    handoff: overrides.handoff === undefined ? handoffBase() : overrides.handoff,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic schema across subject types
// ─────────────────────────────────────────────────────────────────────────────

test('valid class bundle (common core + class extension) passes schema validation', () => {
  const { errors } = validateBundle(goodBundle())
  assert.deepEqual(errors, [])
})

test('valid function dossier: no pass-centric fields required anywhere', () => {
  const dossier = {
    artifact: 'teaching_dossier', schema_version: 1, subject_id: 'hash-combine-fn-function',
    subject_type: 'function', depth: 'standard',
    mental_model: 'It mixes two integers so every output bit depends on every input bit, giving cheap hash distribution.',
    need: 'struct keys need a spread-out hash without a library dependency.',
    system_context: {
      triggers: [{ role: 'caller', entity: 'map_insert', interaction: 'computes bucket index', evidence_refs: ['EV-001'] }],
      downstream: [{ role: 'consumer', entity: 'hash table', interaction: 'uses the mixed value as bucket index', evidence_refs: ['EV-001'] }],
    },
    inputs: [{ name: 'two 64-bit values', form: 'uint64 pair', description: 'parts of a key', evidence_refs: ['EV-001'] }],
    outputs: [{ name: 'mixed value', form: 'uint64', description: 'hash contribution', evidence_refs: ['EV-001'] }],
    mechanism: { stages: [{ name: 'Mix', what: 'shift-xor-multiply rounds', where: 'hash.c:12', evidence_refs: ['EV-001'] }] },
    key_takeaways: ['cheap avalanche', 'deterministic', 'no allocation'],
    extensions: {
      function: {
        parameters: ['uint64 a', 'uint64 b'],
        return_values: ['uint64 mixed'],
        callers: [{ role: 'caller', entity: 'map_insert' }],
        callees: [],
      },
    },
  }
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.deepEqual(errors, [])
})

test('valid algorithm dossier without any IR fields (no before_ir/after_ir anywhere)', () => {
  const dossier = {
    artifact: 'teaching_dossier', schema_version: 1, subject_id: 'union-find-algorithm',
    subject_type: 'algorithm', depth: 'deep',
    mental_model: 'It merges equivalence classes with path compression, so later lookups are nearly flat.',
    need: 'alias queries need near-constant merges and finds.',
    system_context: {
      triggers: [{ role: 'caller', entity: 'alias_analyzer', interaction: 'unifies two symbols', evidence_refs: ['EV-001'] }],
      downstream: [{ role: 'consumer', entity: 'alias queries', interaction: 'read class representatives', evidence_refs: ['EV-001'] }],
    },
    inputs: [{ name: 'symbol pairs', form: 'edge list', description: 'must be unified', evidence_refs: ['EV-001'] }],
    outputs: [{ name: 'class representatives', form: 'parent array', description: 'canonical id per symbol', evidence_refs: ['EV-001'] }],
    mechanism: {
      stages: [{ name: 'Unify', what: 'union by rank with path compression', where: 'alias.c:88', evidence_refs: ['EV-001'] }],
      mutable_state: true, has_important_branching: false,
    },
    state_transitions: [{ phase: 'unify', before: 'parent[a]=a, parent[b]=b', operation: 'union(a,b)', after: 'parent[b]=a', reason: 'rank order', evidence_refs: ['EV-001'] }],
    canonical_example: {
      provenance: { kind: 'reconstructed', source: 'RECONSTRUCTED walkthrough of alias.c:88-120' },
      initial_state: 'three separate classes', inputs: 'unify(a,b), unify(b,c)',
      execution_trace: ['find(a)=a', 'find(b)=b', 'link b under a'], result: 'one class {a,b,c}',
    },
    key_takeaways: ['path compression flattens', 'union by rank bounds height'],
    extensions: {
      algorithm: {
        input_model: 'pairwise equivalence edges',
        state_representation: 'parent array + rank array',
        iteration: 'single pass over edges; find loops until root',
        termination: 'find terminates because parents form a forest',
        complexity: { time: 'near O(1) amortized per op', space: 'O(n)', provenance: 'derived from implementation' },
      },
    },
  }
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.deepEqual(errors, [])
})

test('valid pass dossier uses only the pass extension for pipeline/legality/IR fields', () => {
  const dossier = {
    artifact: 'teaching_dossier', schema_version: 1, subject_id: 'dce-pass-pass',
    subject_type: 'pass', depth: 'deep',
    mental_model: 'It deletes computations whose results are never observed, working back from side effects.',
    need: 'dead code wastes registers and confuses later passes.',
    system_context: {
      triggers: [{ role: 'pipeline', entity: 'optimization pipeline', interaction: 'runs the pass after inlining', evidence_refs: ['EV-002'] }],
      upstream: [{ role: 'pass', entity: 'inliner', interaction: 'produces the IR it walks', evidence_refs: ['EV-002'] }],
      downstream: [{ role: 'pass', entity: 'codegen prep', interaction: 'consumes the smaller IR', evidence_refs: ['EV-002'] }],
    },
    inputs: [{ name: 'module IR', form: 'module op', description: 'IR to walk', evidence_refs: ['EV-001'] }],
    outputs: [{ name: 'pruned IR', form: 'module op', description: 'same IR minus dead ops', evidence_refs: ['EV-001'] }],
    mechanism: { stages: [{ name: 'Mark', what: 'mark live roots and transitively live ops', where: 'dce.cpp:40', evidence_refs: ['EV-001'] }, { name: 'Sweep', what: 'erase unmarked ops', where: 'dce.cpp:90', evidence_refs: ['EV-001'] }] },
    canonical_example: { provenance: { kind: 'test', source: 'test/Transforms/dce-basic.mlir' }, initial_state: 'one dead add', inputs: 'module', execution_trace: ['mark live', 'erase dead'], result: 'dead add gone' },
    key_takeaways: ['roots are side effects', 'one walk, no fixpoint'],
    extensions: {
      pass: {
        pass_arg: 'op on module',
        pipeline_placements: [{ pipeline: 'optimization', position: 'after inlining', evidence_refs: ['EV-002'] }],
        ir_contract: { before: 'IR with dead ops', after: 'IR without them', evidence_refs: ['EV-001'] },
        legality: 'only ops without side effects and unused results',
        rewrite: 'erase in reverse dominance order',
      },
    },
  }
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.deepEqual(errors, [])
})

test('valid subsystem dossier with components and external interfaces', () => {
  const dossier = {
    artifact: 'teaching_dossier', schema_version: 1, subject_id: 'queue-subsystem-subsystem',
    subject_type: 'subsystem', depth: 'standard',
    mental_model: 'Three components move work from producers to executors through one bounded queue.',
    need: 'producers and executors must decouple throughput.',
    system_context: {
      triggers: [{ role: 'external', entity: 'frontend', interaction: 'submits work', evidence_refs: ['EV-001'] }],
      upstream: [{ role: 'producer', entity: 'frontend', interaction: 'pushes tasks', evidence_refs: ['EV-001'] }],
      downstream: [{ role: 'consumer', entity: 'executors', interaction: 'pop and run tasks', evidence_refs: ['EV-001'] }],
    },
    inputs: [{ name: 'task descriptors', form: 'ring buffer entries', description: 'work items', evidence_refs: ['EV-001'] }],
    outputs: [{ name: 'task results', form: 'completion slots', description: 'outcomes', evidence_refs: ['EV-001'] }],
    mechanism: { stages: [{ name: 'Submit', what: 'producer pushes a task', where: 'queue.c:30', evidence_refs: ['EV-001'] }, { name: 'Dispatch', what: 'queue hands task to a free executor', where: 'queue.c:70', evidence_refs: ['EV-001'] }] },
    key_takeaways: ['bounded ring', 'backpressure by full ring'],
    extensions: {
      subsystem: {
        components: [{ role: 'component', entity: 'ring buffer' }, { role: 'component', entity: 'dispatcher' }],
        architecture_boundaries: 'ring is the only shared state',
        external_interfaces: [{ role: 'interface', entity: 'frontend submit API' }],
      },
    },
  }
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.deepEqual(errors, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// Optional-field tolerance (Goal §40)
// ─────────────────────────────────────────────────────────────────────────────

test('function without any pipeline fields is valid', () => {
  const bundle = goodBundle()
  assert.equal(bundle.dossier.extensions.pass, undefined)
  assert.equal(bundle.dossier.mechanism.pipeline_position, undefined)
  const { errors } = validateBundle(bundle)
  assert.deepEqual(errors, [])
})

test('pass without strategy comparison is valid', () => {
  const dossier = dossierBase({
    subject_type: 'pass', subject_id: 'dce-pass-pass',
    extensions: { pass: { pipeline_placements: 'optimization pipeline', ir_contract: { before: 'x', after: 'y', evidence_refs: ['EV-001'] }, legality: 'unused and side-effect free', rewrite: 'erase' } },
  })
  assert.equal(dossier.strategies, undefined)
  assert.equal(dossier.comparisons, undefined)
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.deepEqual(errors, [])
})

test('stateless utility without state transitions is valid', () => {
  const dossier = dossierBase({
    subject_id: 'hash-combine-fn-function', subject_type: 'function',
    mechanism: { ...dossierBase().mechanism, mutable_state: false, has_important_branching: false },
    state_transitions: undefined,
    extensions: { function: { parameters: ['uint64 a'], return_values: ['uint64'], callees: [] } },
  })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.deepEqual(errors, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// Evidence discipline
// ─────────────────────────────────────────────────────────────────────────────

test('source_fact without refs is rejected', () => {
  const ledger = evidenceLedger([{ id: 'EV-900', class: 'source_fact', statement: 'no refs here' }])
  const { errors } = validateBundle({ dossier: dossierBase(), evidence: ledger })
  assert.ok(errors.some((e) => e.includes('EV-900') && e.includes('source_fact requires refs')))
})

test('reasoning without tool back-reference cannot masquerade: unknown fields rejected', () => {
  const dossier = dossierBase({ confirmed_by_developer: true })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.ok(errors.some((e) => e.includes('unknown field: confirmed_by_developer')))
})

test('duplicate evidence ids are rejected', () => {
  const ledger = { artifact: 'evidence', records: [
    { id: 'EV-001', class: 'reasoning', statement: 'a' },
    { id: 'EV-001', class: 'reasoning', statement: 'b' },
  ] }
  const { errors } = validateBundle({ dossier: dossierBase(), evidence: ledger })
  assert.ok(errors.some((e) => e.includes('duplicate evidence id: EV-001')))
})

test('primitives must cite evidence: stage without evidence_refs is rejected', () => {
  const dossier = dossierBase()
  dossier.mechanism.stages.push({ name: 'Unwitnessed', what: 'claims without citations' })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.ok(errors.some((e) => e.includes('mechanism.stages[2]') && e.includes('evidence_refs')))
})

test('boundary classification without evidence is rejected (unseen ≠ unsupported)', () => {
  const dossier = dossierBase()
  dossier.boundaries.push({ category: 'unsupported', statement: 'we never saw code for nested queues' })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.ok(errors.some((e) => e.includes('boundaries[2]') && e.includes('evidence_refs')))
})

test('a strategy model requires at least two real strategies', () => {
  const dossier = dossierBase({ strategies: [{ name: 'only one path' }] })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.ok(errors.some((e) => e.includes('strategies') && e.includes('single strategy')))
})

test('extension mismatch: pass extension under a class subject is rejected', () => {
  const dossier = dossierBase({ extensions: { pass: { pipeline_placements: 'x' } } })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.ok(errors.some((e) => e.includes('does not match subject_type class')))
})

test('unknown extension field is rejected', () => {
  const dossier = dossierBase({ extensions: { class: { ...dossierBase().extensions.class, before_ir: '...' } } })
  const { errors } = validateBundle({ dossier, evidence: evidenceLedger() })
  assert.ok(errors.some((e) => e.includes('unknown extension field: before_ir')))
})

test('provenance is required on the subject', () => {
  const subject = subjectBase()
  delete subject.provenance
  const { errors } = validateBundle({ subject, evidence: evidenceLedger(), dossier: dossierBase() })
  assert.ok(errors.some((e) => e.includes('provenance is required')))
})

test('historical_fact requires a commit or refs; graph_fact requires its tool', () => {
  const ledger = evidenceLedger([
    { id: 'EV-910', class: 'historical_fact', statement: 'said to be old' },
    { id: 'EV-911', class: 'graph_fact', statement: 'edge from nowhere' },
  ])
  const { errors } = validateBundle({ dossier: dossierBase(), evidence: ledger })
  assert.ok(errors.some((e) => e.includes('EV-910') && e.includes('historical_fact requires')))
  assert.ok(errors.some((e) => e.includes('EV-911') && e.includes('graph_fact requires')))
})

// ─────────────────────────────────────────────────────────────────────────────
// Mental model heuristic
// ─────────────────────────────────────────────────────────────────────────────

test('mental model symbol dump is detected', () => {
  const verdict = assessMentalModel('MergeVecScope tryMerge visitOperation mergeVFScopeVFList OneShotBufferize getAnalysis mergeLevels VFList')
  assert.equal(verdict.symbol_dump, true)
})

test('a good domain-language mental model passes the heuristic floor', () => {
  const verdict = assessMentalModel('It is a round-based dispatcher that lets every waiting worker make progress before anyone gets a second turn, so no worker can starve.')
  assert.equal(verdict.symbol_dump, false)
  assert.ok(verdict.sentences >= 1 && verdict.sentences <= 3)
})

test('over-long mental model is flagged as too_long', () => {
  const verdict = assessMentalModel('First sentence is here. Second sentence is here. Third sentence is here. Fourth sentence is here.')
  assert.equal(verdict.too_long, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// Mechanical readiness gate
// ─────────────────────────────────────────────────────────────────────────────

test('good deep bundle passes the mechanical gate', () => {
  const result = computeMechanicalReadiness(goodBundle(), { depth: 'deep' })
  assert.equal(result.verdict, 'pass', result.failures.join('; '))
})

test('missing mental model fails', () => {
  const bundle = goodBundle({ dossier: dossierBase({ mental_model: undefined }) })
  const result = computeMechanicalReadiness(bundle, { depth: 'deep' })
  assert.equal(result.verdict, 'fail')
  assert.ok(result.failures.some((f) => f.startsWith('mental_model')))
})

test('symbol-dump mental model fails the mechanical floor', () => {
  const bundle = goodBundle({ dossier: dossierBase({ mental_model: 'MergeVecScope tryMerge visitOperation mergeVFScopeVFList OneShotBufferize getAnalysis mergeLevels' }) })
  const result = computeMechanicalReadiness(bundle, { depth: 'deep' })
  assert.ok(result.failures.some((f) => f.startsWith('mental_model') && f.includes('symbol dump')))
})

test('important branching without decision explanation fails (not_ready case)', () => {
  const bundle = goodBundle({ dossier: dossierBase({ decisions: undefined }) })
  const result = computeMechanicalReadiness(bundle, { depth: 'deep' })
  assert.equal(result.verdict, 'fail')
  assert.ok(result.failures.some((f) => f.startsWith('decisions')))
})

test('mutable state without state transitions fails', () => {
  const bundle = goodBundle({ dossier: dossierBase({ state_transitions: undefined }) })
  const result = computeMechanicalReadiness(bundle, { depth: 'deep' })
  assert.ok(result.failures.some((f) => f.startsWith('state_transitions')))
})

test('stateless subject without transitions and without branching is mechanically clean', () => {
  const dossier = dossierBase({
    subject_id: 'hash-combine-fn-function', subject_type: 'function',
    mechanism: { ...dossierBase().mechanism, mutable_state: false, has_important_branching: false },
    state_transitions: undefined, decisions: undefined,
    extensions: { function: { parameters: ['uint64 a'], return_values: ['uint64'], callees: [] } },
  })
  const result = computeMechanicalReadiness({ dossier, evidence: evidenceLedger() }, { depth: 'standard' })
  const st = result.checks.find((c) => c.name === 'state_transitions')
  const dec = result.checks.find((c) => c.name === 'decisions')
  assert.equal(st.status, 'not_applicable')
  assert.equal(dec.status, 'not_applicable')
})

test('pass subject without required pass context fails (extension check)', () => {
  const bundle = goodBundle({
    dossier: dossierBase({
      subject_id: 'dce-pass-pass', subject_type: 'pass',
      extensions: undefined,
    }),
  })
  const result = computeMechanicalReadiness(bundle, { depth: 'deep' })
  assert.ok(result.failures.some((f) => f.startsWith('extension_pass')))
})

test('canonical example required for pass/algorithm types at standard+ depth', () => {
  const bundle = goodBundle({
    dossier: dossierBase({ subject_id: 'union-find-algorithm', subject_type: 'algorithm', canonical_example: undefined, extensions: dossierBase().extensions }),
  })
  const result = computeMechanicalReadiness(bundle, { depth: 'standard' })
  assert.ok(result.failures.some((f) => f.startsWith('canonical_example')))
})

test('canonical example optional for function at any depth (not forced)', () => {
  const dossier = dossierBase({
    subject_id: 'hash-combine-fn-function', subject_type: 'function',
    canonical_example: undefined,
    extensions: { function: { parameters: ['uint64 a'], return_values: ['uint64'], callees: [] } },
  })
  const result = computeMechanicalReadiness({ dossier, evidence: evidenceLedger() }, { depth: 'deep' })
  const ce = result.checks.find((c) => c.name === 'canonical_example')
  assert.equal(ce.status, 'not_applicable')
})

test('no fact-class evidence fails the gate (reasoning alone is not enough)', () => {
  const ledger = { artifact: 'evidence', records: [{ id: 'EV-003', class: 'reasoning', statement: 'only reasoning' }] }
  const bundle = goodBundle({ evidence: ledger })
  const result = computeMechanicalReadiness(bundle, { depth: 'deep' })
  assert.ok(result.failures.some((f) => f.startsWith('fact_evidence')))
})

test('presentation depth requires handoff with storyline and visuals', () => {
  const bundle = goodBundle({ dossier: dossierBase({ depth: 'presentation' }), handoff: undefined })
  const result = computeMechanicalReadiness(bundle, { depth: 'presentation' })
  assert.ok(result.failures.some((f) => f.startsWith('handoff_storyline')))
})

test('must_have_visuals referencing an undefined visual fails', () => {
  const handoff = handoffBase({ must_have_visuals: ['V1', 'V-missing'] })
  const bundle = goodBundle({ dossier: dossierBase({ depth: 'presentation' }), handoff })
  const result = computeMechanicalReadiness(bundle, { depth: 'presentation' })
  assert.ok(result.failures.some((f) => f.startsWith('handoff_visuals') && f.includes('undefined visual')))
})

// ─────────────────────────────────────────────────────────────────────────────
// Readiness = mechanical + semantic (Goal §30/§31)
// ─────────────────────────────────────────────────────────────────────────────

function semanticReview(verdict = 'ready', overrides = {}) {
  return {
    reviewer: 'test', reviewed_at: '2026-09-08T11:00:00Z', verdict,
    audience_questions: semanticQuestionsFor('class').map((question) => ({ question, answer: 'covered by dossier', sufficient: true })),
    notes: 'a runtime engineer could follow this without the source',
    ...overrides,
  }
}

test('mechanical pass alone never yields READY', () => {
  const bundle = goodBundle()
  const { verdict, reasons } = computeReadiness(bundle, { depth: 'deep' })
  assert.equal(verdict, 'not_ready')
  assert.ok(reasons.some((r) => r.includes('semantic review missing')))
})

test('mechanical pass + full ready semantic review yields READY', () => {
  const bundle = goodBundle({ readiness: { artifact: 'readiness_report', subject_id: 'fair-queue-scheduler-class', semantic_review: semanticReview('ready') } })
  const { verdict, reasons } = computeReadiness(bundle, { depth: 'deep' })
  assert.equal(verdict, 'ready', reasons.join('; '))
})

test('semantic review with insufficient answers blocks READY', () => {
  const questions = semanticQuestionsFor('class').map((question, i) => ({ question, sufficient: i !== 4 }))
  const bundle = goodBundle({ readiness: { artifact: 'readiness_report', subject_id: 'x', semantic_review: semanticReview('ready', { audience_questions: questions }) } })
  const { verdict, reasons } = computeReadiness(bundle, { depth: 'deep' })
  assert.equal(verdict, 'not_ready')
  assert.ok(reasons.some((r) => r.includes('insufficient')))
})

test('semantic review with too few answered questions blocks READY', () => {
  const bundle = goodBundle({ readiness: { semantic_review: semanticReview('ready', { audience_questions: [{ question: '它是什么？', sufficient: true }] }) } })
  const { verdict, reasons } = computeReadiness(bundle, { depth: 'deep' })
  assert.equal(verdict, 'not_ready')
  assert.ok(reasons.some((r) => r.includes('audience questions')))
})

test('mechanical failure propagates into not_ready', () => {
  const bundle = goodBundle({ dossier: dossierBase({ mental_model: undefined }) })
  const bundle2 = { ...bundle, readiness: { semantic_review: semanticReview('ready') } }
  const { verdict } = computeReadiness(bundle2, { depth: 'deep' })
  assert.equal(verdict, 'not_ready')
})

// ─────────────────────────────────────────────────────────────────────────────
// Visual specs: semantic only
// ─────────────────────────────────────────────────────────────────────────────

test('layout/pixel/color keys are rejected in visual specs', () => {
  const errors = []
  validateVisualSpec({ id: 'V9', kind: 'pipeline', title: 't', nodes: [{ id: 'n', label: 'N', x: 100, color: 'blue' }], edges: [] }, errors, 'visuals[0]')
  assert.ok(errors.some((e) => e.includes('forbidden — visual specs are semantic only') && e.includes('x')))
  assert.ok(errors.some((e) => e.includes('color')))
})

test('semantic visual spec with nodes/edges/ordering validates', () => {
  const errors = []
  validateVisualSpec({ id: 'V1', kind: 'decision_tree', title: 'branch', nodes: [{ id: 'q', label: 'has priority?' }], edges: [{ from: 'q', to: 'yes', label: 'priority-first' }], ordering: ['priority before rotation'] }, errors, 'visuals[0]')
  assert.deepEqual(errors, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// Staleness
// ─────────────────────────────────────────────────────────────────────────────

test('head drift and changed file hashes both mark staleness', () => {
  const prov = subjectBase().provenance
  const same = computeStaleness({ provenance: prov, currentHead: prov.head, currentFileHashes: { 'src/scheduler.c': 'a'.repeat(64) } })
  assert.equal(same.stale, false)
  const headDrift = computeStaleness({ provenance: prov, currentHead: 'f'.repeat(40), currentFileHashes: { 'src/scheduler.c': 'a'.repeat(64) } })
  assert.equal(headDrift.head_stale, true)
  assert.equal(headDrift.stale, true)
  const fileDrift = computeStaleness({ provenance: prov, currentHead: prov.head, currentFileHashes: { 'src/scheduler.c': 'b'.repeat(64) } })
  assert.deepEqual(fileDrift.stale_files, ['src/scheduler.c'])
})

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────

test('slugify produces safe bundle slugs', () => {
  assert.equal(slugify('work_queue_list_to_device_tensor'), 'work-queue-list-to-device-tensor')
  assert.equal(slugify('MergeVecScope'), 'mergevecscope')
})

test('semantic questions are adaptive per subject type', () => {
  const passQ = semanticQuestionsFor('pass')
  const fnQ = semanticQuestionsFor('function')
  assert.equal(passQ.length, 12)
  assert.equal(fnQ.length, 12)
  assert.notDeepEqual(passQ.slice(10), fnQ.slice(10))
})

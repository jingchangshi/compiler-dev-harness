/**
 * Phase T3 composition tests: the System Story Composition layer
 * (scripts/composition-schema.mjs + compiler-compose-driver.mjs + the
 * composition hooks in the Teaching Artifact Protocol owner).
 *
 * Coverage maps to the goal requirements:
 *   - composition preflight: READY+FRESH consumed, NOT_READY/STALE/unsupported
 *     schema/duplicate subject id/different repository/incompatible HEAD refused
 *   - cross-bundle evidence imports: namespaced refs resolve, missing refs and
 *     hash drift fail, the child's original fact class is preserved, and an
 *     imported reasoning record never becomes a fact
 *   - composition integrity: requested-component coverage, bridge evidence,
 *     conflicts block readiness, context-only components allowed, child detail
 *     deferred by reference
 *   - system readiness: mental model / end-to-end flow / cross-component
 *     contract / boundary accounting are mechanically required
 *   - presentation regression: a system handoff passes the existing T2
 *     preflight unchanged, and child staleness propagates to it
 *   - heterogeneous generalization: class + function children compose through
 *     the same engine with zero engine changes
 *
 * Fixtures are fully generic (schedulers/queues/caches — no compiler concepts).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { preflightHandoff } = await import('../../scripts/preflight-handoff.mjs')
const compose = await import('../../compiler-compose-driver.mjs')
const explain = await import('../../compiler-explain-driver.mjs')
const schema = await import('../teaching-schema.mjs')
const { AUDIENCE_QUESTIONS, FACT_CLASSES } = schema

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders — generic system: JobScheduler (class) + RetryQueue
// (function child) composed into a workflow system story
// ─────────────────────────────────────────────────────────────────────────────

/** Temp git repo holding the "analyzed" source files; returns {root, head, hashOf}. */
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 't3-repo-'))
  writeFileSync(join(root, 'scheduler.c'), 'struct JobScheduler { int jobs; };\n')
  writeFileSync(join(root, 'queue.c'), 'int retry_enqueue(struct JobScheduler *s) { return s->jobs; }\n')
  writeFileSync(join(root, 'server.c'), 'void handle_request(void) { /* creates scheduler, submits work */ }\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'sources'], { cwd: root })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
  return { root, head, hashOf: (rel) => sha256(readFileSync(join(root, rel))) }
}

function childEvidence(extra = []) {
  return {
    artifact: 'evidence',
    records: [
      { id: 'EV-101', class: 'source_fact', statement: 'The scheduler struct is defined in scheduler.c with a job counter field.', refs: [{ file: 'scheduler.c', lines: '1' }] },
      { id: 'EV-102', class: 'runtime_fact', statement: 'The scheduler unit test passes and drains three jobs in order.', refs: [{ file: 'test/scheduler_test.c', lines: '10-40' }] },
      { id: 'EV-103', class: 'reasoning', statement: 'The job counter is probably bumped under an internal lock.', note: 'inference from structure; no comment states it' },
      ...extra,
    ],
  }
}

function childDossier({ subjectId, subjectType, name, depth = 'standard' }) {
  const d = {
    artifact: 'teaching_dossier',
    schema_version: 1,
    subject_id: subjectId,
    subject_type: subjectType,
    depth,
    mental_model: 'A scheduler that keeps one bounded queue of pending jobs and retires them oldest-first.',
    need: 'Callers need jobs executed in submission order without double execution.',
    responsibility: 'Owns the pending-job queue and the retirement ordering.',
    system_context: {
      upstream: [{ role: 'submitter', entity: 'ApiHandler', interaction: 'enqueues jobs at request time', evidence_refs: ['EV-101'] }],
      downstream: [{ role: 'consumer', entity: 'WorkerPool', interaction: 'dequeues retired jobs', evidence_refs: ['EV-101'] }],
    },
    inputs: [{ name: 'job requests', form: 'queue entries', description: 'submitted by callers', evidence_refs: ['EV-101'] }],
    outputs: [{ name: 'retired jobs', form: 'ordered callbacks', description: 'delivered to workers', evidence_refs: ['EV-101'] }],
    mechanism: {
      summary: 'Enqueue appends; a drain loop retires jobs oldest-first.',
      stages: [
        { name: 'enqueue', what: 'appends the job to the pending queue', where: 'scheduler.c', evidence_refs: ['EV-101'] },
        { name: 'drain', what: 'retires queued jobs oldest-first', where: 'scheduler.c', evidence_refs: ['EV-101'] },
      ],
      mutable_state: false,
      has_important_branching: false,
    },
    constraints: [{ statement: 'A job is retired at most once per drain pass.', status: 'verified', evidence_refs: ['EV-102'] }],
    boundaries: [{ category: 'supported', statement: 'Supports only single-queue scheduling.', evidence_refs: ['EV-101'] }],
    key_takeaways: ['Ordered retirement', 'One bounded queue', 'No external locks'],
  }
  if (depth === 'presentation') {
    d.implementation_view = [{ aspect: 'queue layout', description: 'ring buffer with head and tail indices', evidence_refs: ['EV-101'] }]
    d.conceptual_view = [{ aspect: 'ordering guarantee', description: 'submission order equals retirement order', evidence_refs: ['EV-102'] }]
  }
  if (subjectType === 'class') {
    d.extensions = { class: { responsibility: 'owns the pending queue', owned_state: 'the pending job queue', lifecycle: 'created by the handler at startup, retired at shutdown', public_api: ['enqueue', 'drain'], collaborators: [{ name: 'WorkerPool', relation: 'dequeues retired jobs' }] } }
  }
  if (subjectType === 'function') {
    d.extensions = { function: { parameters: ['scheduler reference'], return_values: ['enqueue result code'], callers: [{ name: 'JobScheduler', relation: 'hands back failed retirements' }], callees: [{ name: 'JobScheduler', relation: 're-enqueues through the queue API' }] } }
  }
  return d
}

function childSubject({ subjectId, subjectType, name, repo, anchorFile }) {
  return {
    artifact: 'subject',
    schema_version: 1,
    subject_id: subjectId,
    subject_type: subjectType,
    name,
    repository: 'fixture-runtime',
    repository_path: repo.root,
    source_locations: [{ file: anchorFile, lines: '1' }],
    scope: `one ${subjectType} and its immediate collaborators`,
    why_this_subject: 'fixture for composition tests',
    provenance: {
      repository: 'fixture-runtime',
      repository_path: repo.root,
      branch: 'main',
      head: repo.head,
      analyzed_at: '2026-09-08T10:00:00Z',
      tool_versions: { driver: 'test' },
      runtime_verification: 'none',
      source_files: [{ path: anchorFile, sha256: repo.hashOf(anchorFile) }],
    },
  }
}

function readySemanticReview() {
  return {
    verdict: 'ready',
    audience_questions: AUDIENCE_QUESTIONS.map((q) => ({ question: q, answer: 'answerable from the bundle alone', sufficient: true })),
    reviewed_at: '2026-09-08T10:00:00Z',
  }
}

/** Write a READY child bundle; returns its dir name. */
function writeChildBundle(workspace, repo, { dirName, subjectId, subjectType, name, anchorFile, depth = 'standard' }) {
  const dir = join(workspace, dirName)
  writeJson(join(dir, 'subject.json'), childSubject({ subjectId, subjectType, name, repo, anchorFile }))
  writeJson(join(dir, 'evidence.json'), childEvidence())
  writeJson(join(dir, 'dossier.json'), childDossier({ subjectId, subjectType, name, depth }))
  writeJson(join(dir, 'readiness.json'), {
    artifact: 'readiness_report', schema_version: 1, subject_id: subjectId, depth,
    verdict: 'ready', reasons: [],
    semantic_review: readySemanticReview(),
    evaluated_at: '2026-09-08T10:00:00Z',
  })
  return dir
}

/** Composition bundle parts: parent evidence (fresh cross-component facts),
 * composition.json, system dossier (workflow, presentation depth), handoff. */
function parentEvidence() {
  return {
    artifact: 'evidence',
    records: [
      { id: 'SYS-EV-001', class: 'source_fact', statement: 'The request handler creates the scheduler before any enqueue can run.', refs: [{ file: 'server.c', lines: '10-30' }] },
      { id: 'SYS-EV-002', class: 'runtime_fact', statement: 'The end-to-end smoke test submits three requests and observes ordered retirement.', refs: [{ file: 'test/e2e_test.c', lines: '5-60' }] },
    ],
  }
}

function parentComposition({ imports = [], childDirs }) {
  return {
    artifact: 'composition',
    schema_version: 1,
    system_subject_id: 'job-pipeline-workflow',
    requested_components: ['JobScheduler', 'RetryQueue'],
    components: [
      { component_id: 'jobscheduler-class', requested_as: 'JobScheduler', disposition: 'core', role: 'establishes ordered pending work so the retry path sees a stable queue', child_bundle: childDirs[0], child_subject_id: 'jobscheduler-class' },
      { component_id: 'retryqueue-fn', requested_as: 'RetryQueue', disposition: 'supporting', role: 're-enqueues failed jobs so ordering survives retries', child_bundle: childDirs[1], child_subject_id: 'retryqueue-fn' },
    ],
    context_nodes: [
      { node_id: 'api-handler', role: 'drives the pipeline: creates the scheduler and submits work', note: 'context-only: not requested for deep explanation', evidence_refs: ['SYS-EV-001'] },
    ],
    bridges: [
      {
        bridge_id: 'handler-creates-scheduler', from: 'api-handler', to: 'jobscheduler-class',
        relation: 'creates', flow_type: 'control_flow',
        contract: 'an initialized scheduler instance before any request is served',
        ordering_matters: true, why_order_matters: 'enqueue requires an initialized queue',
        evidence_refs: ['SYS-EV-001'], epistemic_status: 'fact', unresolved: false,
      },
      {
        bridge_id: 'scheduler-feeds-retry', from: 'jobscheduler-class', to: 'retryqueue-fn',
        relation: 'produces-for', flow_type: 'data_flow',
        contract: 'retired job records that failed, handed back for re-enqueue',
        ordering_matters: true, why_order_matters: 'retry ordering depends on the original queue order',
        representation_before: 'pending queue entries', representation_after: 'retry queue entries',
        evidence_refs: ['SYS-EV-001', 'jobscheduler-class::EV-101'], epistemic_status: 'fact', unresolved: false,
      },
    ],
    representation_boundaries: [
      { boundary_id: 'queue-entry-handoff', before: 'pending queue entry', after: 'retry queue entry', where: 'scheduler → retry queue boundary', evidence_refs: ['SYS-EV-001'] },
    ],
    imports,
    conflicts: [],
    composed_at: '2026-09-08T12:00:00Z',
    repository: 'fixture-runtime',
    source_head: undefined,
  }
}

function systemDossier({ extraStages = 0 } = {}) {
  const stages = [
    { name: 'submit', what: 'the handler receives a request and creates/uses the scheduler', where: 'server.c', evidence_refs: ['SYS-EV-001'] },
    { name: 'schedule', what: 'the scheduler queues and retires jobs oldest-first', where: 'scheduler.c', evidence_refs: ['jobscheduler-class::EV-101'] },
    { name: 'retry', what: 'failed retirements re-enter the retry queue in original order', where: 'queue.c', evidence_refs: ['retryqueue-fn::EV-101'] },
    { name: 'deliver', what: 'workers receive retired jobs in stable order', where: 'worker.c', evidence_refs: ['SYS-EV-002'] },
  ]
  if (extraStages > 0) stages.push(...Array.from({ length: extraStages }, (_, i) => ({ name: `extra-${i}`, what: 'pad stage', where: 'server.c', evidence_refs: ['SYS-EV-001'] })))
  return {
    artifact: 'teaching_dossier',
    schema_version: 1,
    subject_id: 'job-pipeline-workflow',
    subject_type: 'workflow',
    depth: 'presentation',
    mental_model: 'One request path: submit work, order it, survive failures by re-queueing, deliver in order.',
    need: 'A reliable ordered execution pipeline for background jobs.',
    purpose: 'Connect submission, ordering, retry, and delivery into one dependable flow.',
    observable_outcome: 'Requests produce ordered, at-most-once job execution.',
    system_context: {
      upstream: [{ role: 'client', entity: 'ExternalCaller', interaction: 'issues requests', evidence_refs: ['SYS-EV-001'] }],
      downstream: [{ role: 'ops', entity: 'Monitoring', interaction: 'observes execution records', evidence_refs: ['SYS-EV-002'] }],
    },
    inputs: [{ name: 'requests', form: 'API calls', description: 'from clients', evidence_refs: ['SYS-EV-001'] }],
    outputs: [{ name: 'execution records', form: 'ordered logs', description: 'consumed by monitoring', evidence_refs: ['SYS-EV-002'] }],
    mechanism: { summary: 'Submit → schedule → retry → deliver.', stages, mutable_state: false, has_important_branching: false },
    implementation_view: [{ aspect: 'pipeline wiring', description: 'handler constructs scheduler and retry queue once', evidence_refs: ['SYS-EV-001'] }],
    conceptual_view: [{ aspect: 'why this order', description: 'ordering must exist before retries can preserve it', evidence_refs: ['SYS-EV-002'] }],
    canonical_example: {
      provenance: { kind: 'reconstructed', source: 'synthetic fixture trace (labeled RECONSTRUCTED)' },
      initial_state: 'empty queues',
      execution_trace: [
        { description: 'submit request r1 (frame from e2e_test.c)' },
        { description: 'schedule r1 (imported child detail: jobscheduler-class::EV-101)' },
        { description: 'retry r1 after a simulated failure (frame from queue.c test)' },
      ],
      result: 'three ordered execution records',
    },
    contracts: [{ producer: 'jobscheduler-class', consumer: 'retryqueue-fn', subject_side: 'retry boundary', element: 'failed retirement records', form: 'queue entries', evidence_refs: ['SYS-EV-001'] }],
    constraints: [{ statement: 'Execution order is stable across retries.', status: 'verified', evidence_refs: ['SYS-EV-002'] }],
    invariants: [{ statement: 'Submission order equals delivery order.', status: 'verified', evidence_refs: ['SYS-EV-002'] }],
    boundaries: [{ category: 'unsupported', statement: 'The pipeline cannot preserve order across multiple scheduler instances.', evidence_refs: ['SYS-EV-001'] }],
    key_takeaways: ['Order first, retry second', 'One queue, one order', 'Failures re-enter, never reorder'],
  }
}

function systemHandoff() {
  return {
    artifact: 'presentation_handoff',
    schema_version: 1,
    subject_id: 'job-pipeline-workflow',
    subject_type: 'workflow',
    depth: 'presentation',
    audience: { who: 'backend engineers' },
    learning_objectives: ['Explain the pipeline order', 'Name the cross-component contract'],
    storyline: [
      { position: 1, role: 'why this pipeline exists', claim: 'ordered background execution needs submission, ordering, retry, delivery as one flow', dossier_section: 'mental_model', evidence_refs: ['SYS-EV-002'] },
      { position: 2, role: 'end-to-end flow', claim: 'submit → schedule → retry → deliver, each stage handing a concrete artifact to the next', dossier_section: 'mechanism', evidence_refs: ['SYS-EV-001', 'jobscheduler-class::EV-101'] },
      { position: 3, role: 'critical contract', claim: 'the scheduler hands failed retirements to the retry queue without reordering', dossier_section: 'contracts', evidence_refs: ['SYS-EV-001', 'jobscheduler-class::EV-101'] },
    ],
    visuals: [
      { id: 'V1', kind: 'pipeline', title: 'job pipeline stages', nodes: [{ id: 'n1', label: 'submit' }, { id: 'n2', label: 'schedule' }, { id: 'n3', label: 'retry' }], edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }], ordering: ['n1 before n2 before n3'] },
    ],
    must_have_visuals: ['V1'],
    key_takeaways: ['Order first, retry second', 'One queue, one order'],
    evidence_index: [
      { id: 'SYS-EV-001' },
      { id: 'SYS-EV-002' },
      { id: 'jobscheduler-class::EV-101' },
    ],
  }
}

function importEntries(workspace, childDirs, { breakHash = false } = {}) {
  return childDirs.map((dir) => {
    const subject = readJson(join(dir, 'subject.json'))
    const evidenceHash = sha256(readFileSync(join(dir, 'evidence.json')))
    return {
      alias: subject.subject_id,
      bundle: dir.split('/').pop(),
      subject_id: subject.subject_id,
      evidence_sha256: breakHash ? 'f'.repeat(64) : evidenceHash,
      head: subject.provenance.head,
    }
  })
}

/** Full system bundle: children + composition + dossier + handoff (+ readiness when asked). */
function buildSystemBundle(workspace, repo, { imports = [], childDirs, withReadiness = true, dossierOverrides = {}, compositionOverrides = {} } = {}) {
  const dir = join(workspace, '2026-09-08-job-pipeline-workflow')
  const composition = { ...parentComposition({ childDirs }), ...compositionOverrides, source_head: repo.head }
  if (imports.length > 0 || compositionOverrides.imports !== undefined) composition.imports = imports
  writeJson(join(dir, 'composition.json'), composition)
  writeJson(join(dir, 'subject.json'), childSubject({ subjectId: 'job-pipeline-workflow', subjectType: 'workflow', name: 'Job Pipeline', repo, anchorFile: 'server.c' }))
  writeJson(join(dir, 'evidence.json'), parentEvidence())
  writeJson(join(dir, 'dossier.json'), { ...systemDossier(), ...dossierOverrides })
  writeJson(join(dir, 'handoff.json'), systemHandoff())
  if (withReadiness) {
    writeJson(join(dir, 'readiness.json'), {
      artifact: 'readiness_report', schema_version: 1, subject_id: 'job-pipeline-workflow', depth: 'presentation',
      verdict: 'ready', reasons: [], semantic_review: readySemanticReview(), evaluated_at: '2026-09-08T12:00:00Z',
    })
  }
  return dir
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 't3-ws-'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition preflight
// ─────────────────────────────────────────────────────────────────────────────

test('compose-preflight: all children READY+FRESH → CONSUMABLE', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' })
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.verdict, 'CONSUMABLE', JSON.stringify(out.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-preflight: one NOT_READY child → refused with reasons', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' })
  // break child b: remove its recorded semantic review → readiness not ready
  const rb = readJson(join(b, 'readiness.json'))
  delete rb.semantic_review
  writeJson(join(b, 'readiness.json'), rb)
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.verdict, 'NOT_CONSUMABLE')
  assert.ok(out.reasons.some((r) => r.includes('child-b')), JSON.stringify(out.reasons))
  assert.equal(out.children.find((c) => c.dir === b).verdict, 'NOT_CONSUMABLE')
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-preflight: one STALE child → STALE, refresh demanded (never ignored)', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' })
  writeFileSync(join(repo.root, 'queue.c'), 'int retry_enqueue(struct JobScheduler *s) { return s->jobs + 1; }\n')
  execFileSync('git', ['-C', repo.root, 'commit', '-aqm', 'mutate queue'])
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.verdict, 'NOT_CONSUMABLE')
  assert.equal(out.children.find((c) => c.dir === b).verdict, 'STALE')
  assert.ok(out.children.find((c) => c.dir === b).reasons.some((r) => r.toLowerCase().includes('stale')))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-preflight: unsupported child handoff schema version → UNSUPPORTED_SCHEMA', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' })
  writeJson(join(b, 'handoff.json'), { artifact: 'presentation_handoff', schema_version: 99, subject_id: 'retryqueue-fn', subject_type: 'function' })
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.children.find((c) => c.dir === b).verdict, 'UNSUPPORTED_SCHEMA')
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-preflight: duplicate child subject id → refused', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'same-id', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'same-id', subjectType: 'class', name: 'JobSchedulerCopy', anchorFile: 'queue.c' })
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.verdict, 'NOT_CONSUMABLE')
  assert.ok(out.reasons.some((r) => r.includes('duplicate child subject id')), JSON.stringify(out.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-preflight: different repositories → refused in v0 (one repository only)', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' })
  const sb = readJson(join(b, 'subject.json'))
  sb.provenance.repository = 'other-runtime'
  writeJson(join(b, 'subject.json'), sb)
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.verdict, 'NOT_CONSUMABLE')
  assert.ok(out.reasons.some((r) => r.includes('multiple repositories')), JSON.stringify(out.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-preflight: child analyzed at an incompatible HEAD → refused/refresh', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const a = writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })
  const b = writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' })
  // move the repository forward without touching child b's anchored file
  writeFileSync(join(repo.root, 'notes.txt'), 'unrelated\n')
  execFileSync('git', ['-C', repo.root, 'add', '.'])
  execFileSync('git', ['-C', repo.root, 'commit', '-qm', 'unrelated commit'])
  const out = compose.compositionPreflight([a, b], { repoRoot: repo.root })
  assert.equal(out.verdict, 'NOT_CONSUMABLE')
  assert.ok(out.reasons.some((r) => r.includes('different HEADs') || r.includes('repository is now at')), JSON.stringify(out.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-bundle evidence imports
// ─────────────────────────────────────────────────────────────────────────────

function fullSystem(ws, repo, opts = {}) {
  const childDirs = [
    writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' }),
    writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' }),
  ]
  const imports = importEntries(ws, childDirs, opts)
  return buildSystemBundle(ws, repo, { childDirs, imports, ...opts })
}

test('imports: valid namespaced ref resolves and the composition is READY', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  const out = compose.validateCompositionBundleDir(sys)
  assert.equal(out.valid, true, JSON.stringify(out.errors))
  assert.equal(out.imports_resolved, true)
  const readiness = explain.readinessForBundle(sys, readySemanticReview())
  assert.equal(readiness.report.verdict, 'ready', JSON.stringify(readiness.report.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('imports: missing child ref → fails validation', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo, { dossierOverrides: {} })
  // add a dangling namespaced ref into the system handoff storyline
  const h = readJson(join(sys, 'handoff.json'))
  h.storyline[0].evidence_refs = ['SYS-EV-002', 'jobscheduler-class::EV-404']
  writeJson(join(sys, 'handoff.json'), h)
  const out = compose.validateCompositionBundleDir(sys)
  assert.equal(out.valid, false)
  assert.ok(out.errors.some((e) => e.includes('EV-404')), JSON.stringify(out.errors))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('imports: child evidence hash mismatch → unresolvable import (re-compose required)', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo, { breakHash: true })
  const out = compose.validateCompositionBundleDir(sys)
  assert.equal(out.imports_resolved, false)
  assert.ok(out.errors.some((e) => e.includes('hash mismatch')), JSON.stringify(out.errors))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('imports: import preserves the original evidence class — reasoning never becomes fact', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const childDirs = [
    writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' }),
    writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' }),
  ]
  const imports = importEntries(ws, childDirs)
  const dir = buildSystemBundle(ws, repo, { childDirs, imports })
  // a bridge marked "fact" whose only evidence is the child's REASONING record
  const comp = readJson(join(dir, 'composition.json'))
  comp.bridges.push({
    bridge_id: 'bad-fact-bridge', from: 'api-handler', to: 'jobscheduler-class',
    relation: 'requires', flow_type: 'control_flow', contract: 'a lock discipline',
    evidence_refs: ['jobscheduler-class::EV-103'], epistemic_status: 'fact', unresolved: false,
  })
  writeJson(join(dir, 'composition.json'), comp)
  const out = compose.validateCompositionBundleDir(dir)
  // shape stays valid — the discipline is a readiness-level composition check
  const evCheck = out.mechanical.checks.find((c) => c.name === 'bridge_evidence')
  assert.equal(evCheck.status, 'fail', JSON.stringify(evCheck))
  assert.ok(evCheck.detail.includes('bad-fact-bridge'))
  // the same bridge honestly marked reasoning validates
  comp.bridges[2].epistemic_status = 'reasoning'
  writeJson(join(dir, 'composition.json'), comp)
  const out2 = compose.validateCompositionBundleDir(dir)
  assert.equal(out2.mechanical.checks.find((c) => c.name === 'bridge_evidence').status, 'pass', JSON.stringify(out2.mechanical.checks))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Composition integrity
// ─────────────────────────────────────────────────────────────────────────────

test('integrity: requested component silently absent → fail', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const childDirs = [writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' })]
  const imports = importEntries(ws, childDirs)
  const dir = buildSystemBundle(ws, repo, {
    childDirs,
    imports,
    compositionOverrides: {
      components: [
        { component_id: 'jobscheduler-class', requested_as: 'JobScheduler', disposition: 'core', role: 'orders work', child_bundle: childDirs[0], child_subject_id: 'jobscheduler-class' },
      ],
    },
  })
  const out = compose.validateCompositionBundleDir(dir)
  const cov = out.mechanical.checks.find((c) => c.name === 'requested_coverage')
  assert.equal(cov.status, 'fail')
  assert.ok(cov.detail.includes('RetryQueue'))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('integrity: bridge without evidence → fail', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const childDirs = [
    writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' }),
    writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' }),
  ]
  const imports = importEntries(ws, childDirs)
  const dir = buildSystemBundle(ws, repo, { childDirs, imports })
  const comp = readJson(join(dir, 'composition.json'))
  comp.bridges[1].evidence_refs = []
  writeJson(join(dir, 'composition.json'), comp)
  const out = compose.validateCompositionBundleDir(dir)
  assert.equal(out.valid, false)
  assert.ok(out.errors.some((e) => e.includes('bridge_evidence') || e.includes('evidence_refs')), JSON.stringify(out.errors))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('integrity: open composition conflict → not ready (never narrated past)', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const childDirs = [
    writeChildBundle(ws, repo, { dirName: 'child-a', subjectId: 'jobscheduler-class', subjectType: 'class', name: 'JobScheduler', anchorFile: 'scheduler.c' }),
    writeChildBundle(ws, repo, { dirName: 'child-b', subjectId: 'retryqueue-fn', subjectType: 'function', name: 'RetryQueue', anchorFile: 'queue.c' }),
  ]
  const imports = importEntries(ws, childDirs)
  const dir = buildSystemBundle(ws, repo, {
    childDirs,
    imports,
    compositionOverrides: {
      conflicts: [{ conflict_id: 'order-conflict', kind: 'pipeline-order conflict', description: 'child A claims it calls the retry queue; child B claims the reverse', involved: ['jobscheduler-class', 'retryqueue-fn'], status: 'open' }],
    },
  })
  const readiness = explain.readinessForBundle(dir, readySemanticReview())
  assert.equal(readiness.report.verdict, 'not_ready')
  const conflictCheck = readiness.report.mechanical.checks.find((c) => c.name === 'composition_conflicts')
  assert.equal(conflictCheck.status, 'fail')
  // resolved with a recorded resolution → ready again
  const comp = readJson(join(dir, 'composition.json'))
  comp.conflicts[0].status = 'resolved'
  comp.conflicts[0].resolution = 'cross-component source evidence shows the handler drives both; the child claims were partial'
  comp.conflicts[0].evidence_refs = ['SYS-EV-001']
  writeJson(join(dir, 'composition.json'), comp)
  const readiness2 = explain.readinessForBundle(dir, readySemanticReview())
  assert.equal(readiness2.report.verdict, 'ready', JSON.stringify(readiness2.report.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('integrity: context-only component is allowed and bridges can route through it', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  const out = compose.validateCompositionBundleDir(sys)
  const disp = out.mechanical.checks.find((c) => c.name === 'component_dispositions')
  assert.equal(disp.status, 'pass', JSON.stringify(disp))
  assert.ok(JSON.stringify(out.composition.components) !== JSON.stringify([]))
  // the api-handler context node participates in a bridge without any dossier
  assert.ok(out.composition.bridges.some((b) => b.from === 'api-handler'))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('integrity: child detail may be deferred — the parent cites child evidence instead of restating it', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  const d = readJson(join(sys, 'dossier.json'))
  // the mechanism stage defers to the child dossier by reference (namespaced ref)
  assert.ok(JSON.stringify(d.mechanism.stages).includes('jobscheduler-class::EV-101'))
  const out = compose.validateCompositionBundleDir(sys)
  assert.equal(out.valid, true, JSON.stringify(out.errors))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// System readiness
// ─────────────────────────────────────────────────────────────────────────────

test('system readiness: no overall mental model → NOT_READY', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo, { dossierOverrides: { mental_model: undefined } })
  const readiness = explain.readinessForBundle(sys, readySemanticReview())
  assert.equal(readiness.report.verdict, 'not_ready')
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('system readiness: no end-to-end flow (single stage) → NOT_READY', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo, { dossierOverrides: {} })
  const d = readJson(join(sys, 'dossier.json'))
  d.mechanism.stages = d.mechanism.stages.slice(0, 1)
  writeJson(join(sys, 'dossier.json'), d)
  const readiness = explain.readinessForBundle(sys, readySemanticReview())
  assert.equal(readiness.report.verdict, 'not_ready')
  assert.ok(readiness.report.mechanical.checks.find((c) => c.name === 'end_to_end_flow').detail.includes('end-to-end flow'))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('system readiness: no cross-component contract (no bridges) → NOT_READY', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo, { compositionOverrides: { bridges: [] } })
  const readiness = explain.readinessForBundle(sys, readySemanticReview())
  assert.equal(readiness.report.verdict, 'not_ready')
  const bridge = readiness.report.mechanical.checks.find((c) => c.name === 'bridge_evidence')
  assert.equal(bridge.status, 'fail')
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('system readiness: no system boundary/unknown accounting → NOT_READY', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo, { dossierOverrides: { boundaries: [] } })
  const readiness = explain.readinessForBundle(sys, readySemanticReview())
  assert.equal(readiness.report.verdict, 'not_ready')
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Presentation regression (existing T2 consumer, zero special-casing)
// ─────────────────────────────────────────────────────────────────────────────

test('presentation regression: system handoff → existing T2 preflight CONSUMABLE', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  const out = preflightHandoff(sys, { subjectId: 'job-pipeline-workflow' })
  assert.equal(out.verdict, 'CONSUMABLE', JSON.stringify(out.reasons))
  assert.equal(out.digest.storyline.length, 3)
  assert.ok(out.digest.evidence_index.some((e) => e.id === 'jobscheduler-class::EV-101'))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('presentation regression: child staleness propagates → STALE_PRESENTATION_INPUT', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  // mutate a child's anchored source file after composition
  writeFileSync(join(repo.root, 'scheduler.c'), 'struct JobScheduler { long jobs; };\n')
  execFileSync('git', ['-C', repo.root, 'commit', '-aqm', 'mutate scheduler'])
  const out = preflightHandoff(sys, { subjectId: 'job-pipeline-workflow' })
  assert.equal(out.verdict, 'STALE_PRESENTATION_INPUT', JSON.stringify(out.reasons))
  assert.ok(out.reasons.some((r) => r.includes('child bundle stale')), JSON.stringify(out.reasons))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('staleness: composed system is fresh before any mutation', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  const stale = explain.stalenessForBundle(sys)
  assert.equal(stale.ok, true)
  assert.equal(stale.staleness.stale, false, JSON.stringify(stale.staleness))
  assert.ok(Array.isArray(stale.staleness.composition.children))
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Heterogeneous generalization + compose-render
// ─────────────────────────────────────────────────────────────────────────────

test('heterogeneous: class + function children compose through the same engine (already covered above); renderer derives system-story.md', () => {
  const repo = tempRepo()
  const ws = makeWorkspace()
  const sys = fullSystem(ws, repo)
  const rendered = compose.renderSystemStory(sys)
  assert.equal(rendered.ok, true)
  const md = readFileSync(rendered.rendered, 'utf8')
  assert.ok(md.includes('# System Story: job-pipeline-workflow'))
  for (const section of ['System mental model', 'Components and roles', 'End-to-end flow', 'Cross-component bridges', 'Representation transitions', 'Canonical example', 'Evidence and child dossier index']) {
    assert.ok(md.includes(section), `missing section: ${section}`)
  }
  assert.ok(md.includes('jobscheduler-class::EV-101'), 'rendered view must carry the namespaced child references')
  assert.ok(md.includes('RECONSTRUCTED'), 'reconstructed example provenance stays labeled')
  rmSync(ws, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true })
})

test('compose-plan: scaffold carries requested components and reuse rules', () => {
  const plan = compose.planComposition({ subject_type: 'component_group', name: 'order pipeline', requested_components: ['Reader', 'Merger', 'Writer'] })
  assert.equal(plan.ok, true)
  assert.equal(plan.composition_skeleton.requested_components.length, 3)
  assert.equal(plan.composition_skeleton.components.length, 3)
  assert.ok(plan.reuse_rules.some((r) => r.includes('never copy child evidence')))
  const bad = compose.planComposition({ subject_type: 'component_group', name: 'x', requested_components: [] })
  assert.equal(bad.ok, false)
})

test('generic layer anti-overfitting: composition modules are subject-agnostic', () => {
  const banned = /MergeVecScope|AutoVectorizeV2|FlattenOps|RegBase|HFusion|HIVM|tryMerge|mergeLevel|bufferiz|VecScope/i
  for (const file of [join(repoRoot, 'scripts', 'composition-schema.mjs'), join(repoRoot, 'compiler-compose-driver.mjs')]) {
    const source = readFileSync(file, 'utf8')
    assert.equal(banned.test(source), false, `${file} contains subject-specific content`)
  }
})

test('evidence id space: namespaced parse + class preservation (pure helpers)', async () => {
  const { makeEvidenceIdSpace, parseNamespacedRef } = await import('../composition-schema.mjs')
  assert.deepEqual(parseNamespacedRef('child::EV-7'), { alias: 'child', id: 'EV-7' })
  assert.equal(parseNamespacedRef('plain-id'), undefined)
  const parent = new Map([['EV-1', 'source_fact']])
  const space = makeEvidenceIdSpace(parent, [{ alias: 'child', classes: new Map([['EV-7', 'reasoning'], ['EV-8', 'graph_fact']]) }])
  assert.equal(space.has('EV-1'), true)
  assert.equal(space.has('child::EV-7'), true)
  assert.equal(space.has('child::EV-9'), false)
  assert.equal(space.has('unknown::EV-7'), false)
  assert.equal(space.classOf('EV-1'), 'source_fact')
  assert.equal(space.classOf('child::EV-7'), 'reasoning')
  assert.equal(FACT_CLASSES.includes(space.classOf('child::EV-8')), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// Real dogfood regression (committed T3 artifacts — mirrors teaching-dogfood)
// ─────────────────────────────────────────────────────────────────────────────

const isNonempty = (v) => typeof v === 'string' && v.trim() !== ''
const sysBundle = join(repoRoot, 'analysis', 'explanations', '2026-09-09-regbase-vector-pipeline-pipeline')
const sysProject = join(repoRoot, 'analysis', 'presentations', '2026-09-09-regbase-vector-pipeline-pipeline')

test('dogfood system bundle: schema valid, imports resolved, composition checks pass', () => {
  const out = compose.validateCompositionBundleDir(sysBundle)
  assert.equal(out.ok, true)
  assert.equal(out.valid, true, JSON.stringify(out.errors))
  assert.equal(out.imports_resolved, true)
  const checks = out.mechanical.checks
  for (const name of ['requested_coverage', 'component_dispositions', 'bridge_evidence', 'composition_conflicts', 'representation_boundaries', 'end_to_end_flow', 'child_inputs']) {
    const c = checks.find((c) => c.name === name)
    assert.equal(c.status, 'pass', `${name}: ${c.detail}`)
  }
  // staleness is asserted only when the analyzed repository is present at the
  // recorded HEAD (same environment-honesty rule as the T2 tests)
  if (existsSync('/home/shijingchang/workspace/AscendNPU-IR')) {
    assert.equal(out.staleness.stale, false, JSON.stringify(out.staleness?.composition?.reasons))
  }
})

test('dogfood system bundle: coverage and bridge scope meet the T3 floor', () => {
  const comp = readJson(join(sysBundle, 'composition.json'))
  assert.equal(comp.requested_components.length, 6)
  assert.equal(comp.components.length, 6)
  assert.ok(comp.bridges.length >= 3)
  assert.ok(comp.representation_boundaries.length >= 1)
  // every bridge cites resolvable evidence and carries a contract
  const ev = readJson(join(sysBundle, 'evidence.json'))
  const parentIds = new Set(ev.records.map((r) => r.id))
  for (const b of comp.bridges) {
    assert.ok(b.evidence_refs.length >= 1, b.bridge_id)
    assert.ok(isNonempty(b.contract), b.bridge_id)
    for (const ref of b.evidence_refs) {
      const ns = /^([A-Za-z0-9][A-Za-z0-9_-]*)::(.+)$/.exec(ref)
      if (!ns) assert.ok(parentIds.has(ref), `${b.bridge_id}: ${ref}`)
    }
  }
  // no child evidence copy-paste: parent ledger stays small and composition-only
  assert.ok(ev.records.length <= 20, `parent ledger too large (${ev.records.length}) — child evidence must be imported, not copied`)
})

test('dogfood system bundle: readiness verdict is ready', () => {
  const r = readJson(join(sysBundle, 'readiness.json'))
  assert.equal(r.verdict, 'ready')
  assert.ok((r.semantic_review?.audience_questions || []).length >= 10)
})

test('dogfood system handoff: committed bundle passes the T2 preflight when fresh', () => {
  if (!existsSync('/home/shijingchang/workspace/AscendNPU-IR')) return
  const out = preflightHandoff(sysBundle, { subjectId: 'regbase-vector-pipeline-pipeline' })
  assert.equal(out.verdict, 'CONSUMABLE', JSON.stringify(out.reasons))
  assert.ok(out.digest.storyline.length >= 3)
})

test('dogfood system deck: manifest coverage checker passes on the committed project', () => {
  const checker = join(sysProject, 'scripts', 'check_project.py')
  if (!existsSync(checker)) return
  const res = spawnSync('python3', [checker, '.'], { cwd: sysProject, encoding: 'utf8' })
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.ok(res.stdout.includes('coverage complete'), res.stdout)
})

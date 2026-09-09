/**
 * Phase T4 orchestration control-plane regression: catalog, resolver,
 * REUSE/REFRESH/CREATE lifecycle, execution DAG, resume, idempotency,
 * runtime-store cleanliness, the final gate, and the derived renderer.
 *
 * Fixtures build synthetic READY bundles in temp git repositories so the
 * tests never depend on dogfood state, plus one guarded probe against the
 * committed curated fixtures for cross-origin discovery. The control plane
 * itself stays subject-agnostic (asserted by the anti-overfitting test).
 */

import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  buildCatalog, classifySubject, findReusableComposition, normalizeName, planRun,
  renderExplanation, repoSlugFor, resolveSubjects, runFinalize, runStatus,
  runtimeExplanationsRoot,
} from '../../compiler-orchestrate-driver.mjs'
import { hashSourceFiles } from '../../compiler-explain-driver.mjs'
import { AUDIENCE_QUESTIONS } from '../../scripts/teaching-schema.mjs'

const harnessRoot = process.cwd()

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function makeTempRepo() {
  const root = mkdtempSync(join(tmpdir(), 't4-orch-repo-'))
  writeFileSync(join(root, 'a.cpp'), 'int step() { return 1; }\n')
  git(root, ['init'])
  git(root, ['config', 'user.email', 'fixture@example.test'])
  git(root, ['config', 'user.name', 'fixture'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'init'])
  return { root, name: basename(root) }
}

let envBackup
function useRuntimeStore(dir) {
  envBackup = process.env.COMPILER_DEV_EXPLAIN_DIR
  process.env.COMPILER_DEV_EXPLAIN_DIR = dir
}
function restoreRuntimeStore() {
  if (envBackup === undefined) delete process.env.COMPILER_DEV_EXPLAIN_DIR
  else process.env.COMPILER_DEV_EXPLAIN_DIR = envBackup
}

const audienceQuestions = () => AUDIENCE_QUESTIONS.map((q) => ({ question: q, answer: 'covered by the fixture dossier', sufficient: true }))

function evidenceLedger() {
  return {
    artifact: 'evidence',
    records: [
      { id: 'EV-001', class: 'source_fact', statement: 'The step function is declared in the fixture source file.', refs: [{ file: 'a.cpp', lines: '1' }] },
      { id: 'EV-002', class: 'runtime_fact', statement: 'The fixture program exits zero when executed.', tool: 'fixture-runner' },
      { id: 'EV-003', class: 'reasoning', statement: 'The behavior is expected to stay stable for unchanged inputs.' },
    ],
  }
}

function dossierFor({ subjectId, subjectType, depth, passArg }) {
  const d = {
    artifact: 'teaching_dossier', schema_version: 1,
    subject_id: subjectId, subject_type: subjectType, depth,
    mental_model: 'It keeps the shared table consistent while several callers update it, so readers never observe a half applied change.',
    need: 'Callers need a reliable shared view of the data.',
    responsibility: 'Owns the update order for the shared table.',
    system_context: {
      upstream: [{ role: 'caller', entity: 'the writer module', interaction: 'pushes updates before queries', evidence_refs: ['EV-001'] }],
      downstream: [{ role: 'consumer', entity: 'the reader module', interaction: 'queries the table after updates', evidence_refs: ['EV-001'] }],
    },
    inputs: [{ name: 'update batch', form: 'list of edits', description: 'applied in order', evidence_refs: ['EV-001'] }],
    outputs: [{ name: 'consistent table', form: 'read model', description: 'visible after the batch', evidence_refs: ['EV-001'] }],
    mechanism: {
      summary: 'Two phases keep the table consistent.',
      stages: [
        { name: 'Collect', what: 'gather incoming edits into a pending list', where: 'a.cpp:1', evidence_refs: ['EV-001'] },
        { name: 'Apply', what: 'swap the pending list into the table at once', where: 'a.cpp:1', evidence_refs: ['EV-001'] },
      ],
    },
    constraints: [{ statement: 'Updates are applied in batch order.', status: 'guarded', evidence_refs: ['EV-001'] }],
    boundaries: [{ category: 'supported', statement: 'Single writer only.', evidence_refs: ['EV-001'] }],
    key_takeaways: ['Batched apply keeps readers consistent.', 'Order comes from the batch.', 'One writer at a time.'],
  }
  if (depth === 'deep' || depth === 'presentation') {
    d.implementation_view = [{ aspect: 'implementation', description: 'A pending list is swapped in atomically.', evidence_refs: ['EV-001'] }]
    d.conceptual_view = [{ aspect: 'conceptual', description: 'Readers see either the old or the new table, never between.', evidence_refs: ['EV-001'] }]
    d.placement = { why_here: 'The table must exist before any reader runs.', evidence_refs: ['EV-001'] }
  }
  if (depth === 'presentation') {
    d.canonical_example = {
      provenance: { kind: 'test', source: 'fixture test run' },
      initial_state: 'empty table',
      execution_trace: ['collect two edits', 'apply them at once'],
      result: 'consistent table with both edits',
    }
  }
  if (subjectType === 'pass') {
    d.extensions = { pass: {
      pass_arg: passArg || subjectId.replace(/-pass$/, ''),
      pipeline_placements: ['after the earlier normalization stage'],
      ir_contract: { before: 'loose form', after: 'compact form' },
      legality: 'Only rewrites when the pattern matches.',
      rewrite: 'Collapses the matched region into one op.',
    } }
    if (depth !== 'overview') d.canonical_example = { provenance: { kind: 'test', source: 'fixture test run' }, initial_state: 'loose form', execution_trace: ['match', 'rewrite'], result: 'compact form' }
  }
  return d
}

function handoffFor(subjectId, subjectType) {
  return {
    artifact: 'presentation_handoff', schema_version: 1,
    subject_id: subjectId, subject_type: subjectType, depth: 'presentation',
    storyline: [
      { position: 1, role: 'the problem', claim: 'Readers observe torn updates.', evidence_refs: ['EV-001'] },
      { position: 2, role: 'the idea', claim: 'Batch the edits and swap once.', evidence_refs: ['EV-001'] },
      { position: 3, role: 'the guarantee', claim: 'Every reader sees a consistent table.', evidence_refs: ['EV-002'] },
    ],
    visuals: [{ id: 'viz-main', kind: 'flowchart', title: 'Main flow', nodes: [{ id: 'n1', label: 'Collect' }, { id: 'n2', label: 'Apply' }], edges: [{ from: 'n1', to: 'n2' }] }],
    must_have_visuals: ['viz-main'],
    key_takeaways: ['Batched apply.', 'One swap.', 'Consistent reads.'],
    evidence_index: [{ id: 'EV-001' }, { id: 'EV-002' }],
  }
}

function writeReadyBundle(storeRoot, { name, repo, depth = 'standard', subjectType = 'other', subjectName, passArg }) {
  const dir = join(storeRoot, name)
  mkdirSync(dir, { recursive: true })
  const head = git(repo.root, ['rev-parse', 'HEAD'])
  const subjectId = normalizeName(subjectName || name) + (subjectType === 'other' ? '' : `-${subjectType}`)
  const subject = {
    artifact: 'subject', schema_version: 1,
    subject_id: subjectId, subject_type: subjectType, name: subjectName || name,
    repository: repo.name, repository_path: repo.root,
    source_locations: [{ file: 'a.cpp', lines: '1' }],
    why_this_subject: 'fixture subject',
    provenance: {
      repository: repo.name, repository_path: repo.root, branch: git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      head, analyzed_at: new Date().toISOString(),
      source_files: hashSourceFiles(repo.root, [{ file: 'a.cpp' }]),
    },
  }
  const dossier = dossierFor({ subjectId, subjectType, depth, passArg })
  writeFileSync(join(dir, 'subject.json'), JSON.stringify(subject, null, 2))
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidenceLedger(), null, 2))
  writeFileSync(join(dir, 'dossier.json'), JSON.stringify(dossier, null, 2))
  if (depth === 'presentation') writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoffFor(subjectId, subjectType), null, 2))
  writeFileSync(join(dir, 'readiness.json'), JSON.stringify({
    artifact: 'readiness_report', schema_version: 1, subject_id: subjectId, depth,
    verdict: 'ready', semantic_review: { verdict: 'ready', audience_questions: audienceQuestions() },
  }, null, 2))
  return { dir, name, subjectId, head }
}

function writeReadyComposition(storeRoot, { name, repo, children, requested }) {
  const dir = join(storeRoot, name)
  mkdirSync(dir, { recursive: true })
  const head = git(repo.root, ['rev-parse', 'HEAD'])
  const systemSubjectId = normalizeName(name)
  const childNames = children.map((c) => c.name)
  const composition = {
    artifact: 'composition', schema_version: 1,
    system_subject_id: systemSubjectId,
    requested_components: requested,
    components: children.map((c, i) => ({
      component_id: normalizeName(requested[i]), requested_as: requested[i],
      disposition: i === 0 ? 'core' : 'supporting',
      role: `provides the ${requested[i]} part of the flow`,
      child_bundle: c.name, child_subject_id: c.subjectId,
    })),
    bridges: [{
      bridge_id: 'first-to-second', from: normalizeName(requested[0]), to: normalizeName(requested[1]),
      relation: 'produces-for', flow_type: 'data_flow', contract: 'the consistent table',
      ordering_matters: true, why_order_matters: 'readers need the applied state',
      representation_before: 'pending edits', representation_after: 'applied table',
      evidence_refs: ['EV-001'], epistemic_status: 'fact',
    }],
    representation_boundaries: [{
      boundary_id: 'apply-boundary', before: 'pending edits', after: 'applied table',
      where: 'between the two components', evidence_refs: ['EV-001'],
    }],
    imports: children.map((c, i) => ({
      alias: `child${i}`, bundle: c.name, subject_id: c.subjectId,
      evidence_sha256: createHash('sha256').update(readFileSync(join(c.dir, 'evidence.json'))).digest('hex'),
      head: c.head,
    })),
    conflicts: [],
    composed_at: new Date().toISOString(),
    repository: repo.name, source_head: head,
  }
  const dossier = dossierFor({ subjectId: systemSubjectId, subjectType: 'component_group', depth: 'presentation' })
  dossier.canonical_example = {
    provenance: { kind: 'reconstructed', source: 'fixture walkthrough (RECONSTRUCTED)' },
    initial_state: 'pending edits', execution_trace: ['collect', 'apply', 'read'], result: 'consistent table',
  }
  writeFileSync(join(dir, 'subject.json'), JSON.stringify({
    artifact: 'subject', schema_version: 1, subject_id: systemSubjectId, subject_type: 'component_group',
    name: name, repository: repo.name, repository_path: repo.root,
    source_locations: [{ file: 'a.cpp', lines: '1' }], why_this_subject: 'fixture system story',
    provenance: { repository: repo.name, repository_path: repo.root, branch: 'main', head, analyzed_at: new Date().toISOString(), source_files: hashSourceFiles(repo.root, [{ file: 'a.cpp' }]) },
  }, null, 2))
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidenceLedger(), null, 2))
  writeFileSync(join(dir, 'dossier.json'), JSON.stringify(dossier, null, 2))
  writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoffFor(systemSubjectId, 'component_group'), null, 2))
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition, null, 2))
  writeFileSync(join(dir, 'readiness.json'), JSON.stringify({
    artifact: 'readiness_report', schema_version: 1, subject_id: systemSubjectId, depth: 'presentation',
    verdict: 'ready', semantic_review: { verdict: 'ready', audience_questions: audienceQuestions() },
  }, null, 2))
  return { dir, name, subjectId: systemSubjectId, head }
}

function writePresentationManifest(presentationsRoot, { bundle, repoName, hashHandoff = true, composition = undefined }) {
  const projectDir = join(presentationsRoot, basename(repoName || 'repo'), bundle.name)
  mkdirSync(projectDir, { recursive: true })
  const manifest = {
    artifact: 'presentation_manifest', schema_version: 1,
    input: {
      bundle_id: bundle.name, bundle_dir: bundle.dir,
      subject_id: bundle.subjectId, subject_type: 'other',
      handoff_sha256: hashHandoff ? createHash('sha256').update(readFileSync(join(bundle.dir, 'handoff.json'))).digest('hex') : '0'.repeat(64),
      dossier_sha256: createHash('sha256').update(readFileSync(join(bundle.dir, 'dossier.json'))).digest('hex'),
      source_head: bundle.head, readiness_verdict: 'ready', preflight: 'CONSUMABLE',
    },
    consumed: { storyline: [] },
  }
  if (composition) {
    manifest.input.composition_sha256 = createHash('sha256').update(readFileSync(join(composition.dir, 'composition.json'))).digest('hex')
  }
  writeFileSync(join(projectDir, 'presentation-manifest.json'), JSON.stringify(manifest, null, 2))
  return projectDir
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

test('catalog discovers runtime artifacts, extracts metadata, and distinguishes origin', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const bundle = writeReadyBundle(join(store, 'explanations', repo.name), { name: '2026-09-09-alpha-other', repo, subjectName: 'Alpha Tool', depth: 'standard' })
    const catalog = buildCatalog({ repoRoot: repo.root })
    const entry = catalog.bundles.find((b) => b.bundle_id === bundle.name)
    assert.ok(entry, 'runtime bundle discovered')
    assert.equal(entry.artifact_origin, 'runtime')
    assert.equal(entry.subject_id, 'alpha-tool')
    assert.equal(entry.subject_type, 'other')
    assert.equal(entry.name, 'Alpha Tool')
    assert.equal(entry.repository, repo.name)
    assert.equal(entry.head, bundle.head)
    assert.equal(entry.depth, 'standard')
    assert.equal(entry.readiness, 'ready')
    assert.equal(entry.freshness.state, 'fresh')
    assert.equal(entry.is_composition, false)
    assert.equal(entry.handoff_present, false)
    assert.ok(catalog.bundles.some((b) => b.artifact_origin === 'curated'), 'curated bundles also discovered')
  } finally { restoreRuntimeStore() }
})

test('catalog is derived on every call — no persistent index (removing a bundle changes it)', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const bundle = writeReadyBundle(join(store, 'explanations', repo.name), { name: '2026-09-09-beta-other', repo, subjectName: 'Beta Tool' })
    const before = buildCatalog({ repoRoot: repo.root }).bundles.filter((b) => b.bundle_id === bundle.name).length
    rmSync(bundle.dir, { recursive: true, force: true })
    const after = buildCatalog({ repoRoot: repo.root }).bundles.filter((b) => b.bundle_id === bundle.name).length
    assert.equal(before, 1)
    assert.equal(after, 0, 'catalog reflects the filesystem — no cached index')
    assert.ok(!existsSync(join(store, 'catalog.db')), 'no persistent catalog artifact is created')
  } finally { restoreRuntimeStore() }
})

test('catalog detects unreadable artifacts instead of skipping them (BLOCKED material)', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const bundle = writeReadyBundle(join(store, 'explanations', repo.name), { name: '2026-09-09-gamma-other', repo, subjectName: 'Gamma Tool' })
    writeFileSync(join(bundle.dir, 'subject.json'), '{not json')
    const catalog = buildCatalog({ repoRoot: repo.root })
    const entry = catalog.bundles.find((b) => b.bundle_id === bundle.name)
    assert.ok(entry, 'broken bundle still catalog-visible')
    assert.ok(entry.error, 'entry carries the read error')
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

function setupResolverFixture() {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  const bundles = [
    writeReadyBundle(join(store, 'explanations', repo.name), { name: '2026-09-09-id-tool-other', repo, subjectName: 'Id Tool' }),
    writeReadyBundle(join(store, 'explanations', repo.name), { name: '2026-09-09-pass-one-pass', repo, subjectName: 'Pass One', subjectType: 'pass', passArg: 'canonical-pass-arg' }),
  ]
  return { repo, store, bundles }
}

test('resolver: exact subject id, exact name, and normalized name all resolve', () => {
  const { repo, store, bundles } = setupResolverFixture()
  try {
    const catalog = buildCatalog({ repoRoot: repo.root })
    for (const [query, expectId] of [['id-tool', 'id-tool'], ['Id Tool', 'id-tool'], ['ID TOOL', 'id-tool']]) {
      const [r] = resolveSubjects([query], catalog, { repository: repo.name })
      assert.equal(r.status, 'RESOLVED', `${query} should resolve`)
      assert.equal(r.subject_id, expectId)
    }
    assert.equal(bundles.length, 2)
  } finally { restoreRuntimeStore() }
})

test('resolver: type-specific canonical identifier resolves (pass_arg)', () => {
  const { repo, store } = setupResolverFixture()
  try {
    const catalog = buildCatalog({ repoRoot: repo.root })
    const [r] = resolveSubjects(['canonical-pass-arg'], catalog, { repository: repo.name })
    assert.equal(r.status, 'RESOLVED')
    assert.equal(r.subject_id, 'pass-one-pass')
  } finally { restoreRuntimeStore() }
})

test('resolver: multiple distinct identities → AMBIGUOUS with candidates, never auto-selected', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    // Two bundles, two subject identities, both recording the same canonical
    // identifier → the query deterministically matches both → AMBIGUOUS.
    writeReadyBundle(root, { name: '2026-09-09-dup-one-pass', repo, subjectName: 'Dup One', subjectType: 'pass', passArg: 'dup-tool' })
    writeReadyBundle(root, { name: '2026-09-09-dup-two-pass', repo, subjectName: 'Dup Two', subjectType: 'pass', passArg: 'dup-tool' })
    const catalog = buildCatalog({ repoRoot: repo.root })
    const [r] = resolveSubjects(['dup-tool'], catalog, { repository: repo.name })
    assert.equal(r.status, 'AMBIGUOUS')
    assert.equal(r.candidates.length, 2)
    assert.deepEqual([...new Set(r.candidates.map((c) => c.subject_id))].sort(), ['dup-one-pass', 'dup-two-pass'])
    const cls = classifySubject(r, { requestedDepth: 'standard', repository: repo.name })
    assert.equal(cls.action, 'AMBIGUOUS', 'planner must not silently pick between distinct subjects')
  } finally { restoreRuntimeStore() }
})

test('resolver: no deterministic match → CREATE (no fuzzy guessing)', () => {
  const { repo, store } = setupResolverFixture()
  try {
    const catalog = buildCatalog({ repoRoot: repo.root })
    const [r] = resolveSubjects(['Totally Unrelated Subject'], catalog, { repository: repo.name })
    assert.equal(r.status, 'UNRESOLVED')
    assert.equal(classifySubject(r, { requestedDepth: 'standard', repository: repo.name }).action, 'CREATE')
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle classification
// ─────────────────────────────────────────────────────────────────────────────

test('lifecycle: READY+FRESH at compatible depth → REUSE; deeper existing also REUSEs', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    writeReadyBundle(root, { name: '2026-09-09-std-other', repo, subjectName: 'Reuse Me', depth: 'standard' })
    writeReadyBundle(root, { name: '2026-09-09-deep-other', repo, subjectName: 'Deep One', depth: 'presentation' })
    const catalog = buildCatalog({ repoRoot: repo.root })
    const std = classifySubject(resolveSubjects(['Reuse Me'], catalog, { repository: repo.name })[0], { requestedDepth: 'standard', repository: repo.name })
    assert.equal(std.action, 'REUSE')
    // request standard, existing presentation → still REUSE (depth compatible)
    const deep = classifySubject(resolveSubjects(['Deep One'], catalog, { repository: repo.name })[0], { requestedDepth: 'standard', repository: repo.name })
    assert.equal(deep.action, 'REUSE')
    assert.equal(deep.selected.depth, 'presentation')
  } finally { restoreRuntimeStore() }
})

test('lifecycle: HEAD drift (stale) → REFRESH', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    writeReadyBundle(root, { name: '2026-09-09-stale-other', repo, subjectName: 'Stale One' })
    writeFileSync(join(repo.root, 'a.cpp'), 'int step() { return 2; }\n')
    git(repo.root, ['add', '-A'])
    git(repo.root, ['commit', '-m', 'drift'])
    const catalog = buildCatalog({ repoRoot: repo.root })
    const cls = classifySubject(resolveSubjects(['Stale One'], catalog, { repository: repo.name })[0], { requestedDepth: 'standard', repository: repo.name })
    assert.equal(cls.action, 'REFRESH')
    assert.ok(cls.reasons.join(' ').includes('head drift') || cls.reasons.join(' ').includes('source changed'), `reason mentions drift: ${cls.reasons.join('; ')}`)
  } finally { restoreRuntimeStore() }
})

test('lifecycle: insufficient depth → REFRESH (upgrade), not silent reuse', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    writeReadyBundle(root, { name: '2026-09-09-shallow-other', repo, subjectName: 'Shallow One', depth: 'overview' })
    const catalog = buildCatalog({ repoRoot: repo.root })
    const cls = classifySubject(resolveSubjects(['Shallow One'], catalog, { repository: repo.name })[0], { requestedDepth: 'standard', repository: repo.name })
    assert.equal(cls.action, 'REFRESH')
    assert.ok(cls.reasons.join(' ').includes('depth'), `reason mentions depth: ${cls.reasons.join('; ')}`)
  } finally { restoreRuntimeStore() }
})

test('lifecycle: unreadable artifacts → BLOCKED', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    const bundle = writeReadyBundle(root, { name: '2026-09-09-broken-other', repo, subjectName: 'Broken One' })
    writeFileSync(join(bundle.dir, 'dossier.json'), '{broken')
    const catalog = buildCatalog({ repoRoot: repo.root })
    const cls = classifySubject(resolveSubjects(['Broken One'], catalog, { repository: repo.name })[0], { requestedDepth: 'standard', repository: repo.name })
    assert.equal(cls.action, 'BLOCKED')
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Composition reuse
// ─────────────────────────────────────────────────────────────────────────────

test('composition reuse: matching component set reuses; changed set recomposes', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    const a = writeReadyBundle(root, { name: '2026-09-09-comp-a-other', repo, subjectName: 'Comp A' })
    const b = writeReadyBundle(root, { name: '2026-09-09-comp-b-other', repo, subjectName: 'Comp B' })
    const c = writeReadyBundle(root, { name: '2026-09-09-comp-c-other', repo, subjectName: 'Comp C' })
    writeReadyComposition(root, { name: '2026-09-09-comp-system', repo, children: [a, b], requested: ['Comp A', 'Comp B'] })
    const catalog = buildCatalog({ repoRoot: repo.root })
    const same = findReusableComposition(catalog, ['comp-a', 'comp-b'], { depth: 'presentation', repository: repo.name })
    assert.equal(same.action, 'REUSE_COMPOSITION', JSON.stringify(same.reasons))
    const changed = findReusableComposition(catalog, ['comp-a', 'comp-b', 'comp-c'], { depth: 'presentation', repository: repo.name })
    assert.equal(changed.action, 'COMPOSE', 'A+B+C is a different component set than A+B')
    const shallow = findReusableComposition(catalog, ['comp-a', 'comp-b'], { depth: 'overview', repository: repo.name })
    assert.equal(shallow.action, 'REUSE_COMPOSITION', 'presentation-depth composition covers an overview request')
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Execution DAG (plan)
// ─────────────────────────────────────────────────────────────────────────────

test('DAG: single subject with documents has no composition node and the doc depends on the subject', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    writeReadyBundle(join(store, 'explanations', repo.name), { name: '2026-09-09-single-other', repo, subjectName: 'Single One' })
    const plan = planRun({ subjects: ['Single One'], depth: 'standard', outputs: ['artifacts', 'documents'], repoRoot: repo.root })
    assert.ok(plan.ok, JSON.stringify(plan.errors))
    const kinds = Object.fromEntries(plan.nodes.map((n) => [n.id, n.kind]))
    assert.equal(kinds['subject:single-one'], 'subject')
    assert.equal(kinds['doc:single-one'], 'document')
    assert.equal(plan.nodes.find((n) => n.kind === 'composition'), undefined)
    const doc = plan.nodes.find((n) => n.id === 'doc:single-one')
    assert.deepEqual(doc.deps, ['subject:single-one'])
    const subject = plan.nodes.find((n) => n.id === 'subject:single-one')
    assert.equal(subject.action, 'REUSE')
  } finally { restoreRuntimeStore() }
})

test('DAG: multi-subject request wires composition and presentation dependencies deterministically', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    writeReadyBundle(root, { name: '2026-09-09-dag-a-other', repo, subjectName: 'Dag A' })
    writeReadyBundle(root, { name: '2026-09-09-dag-b-other', repo, subjectName: 'Dag B' })
    const plan = planRun({ subjects: ['Dag A', 'Dag B'], depth: 'standard', outputs: ['artifacts', 'documents', 'system_story', 'presentation'], repoRoot: repo.root })
    assert.ok(plan.ok, JSON.stringify(plan.errors))
    const byId = Object.fromEntries(plan.nodes.map((n) => [n.id, n]))
    const comp = byId['composition']
    assert.ok(comp, 'composition node exists')
    assert.deepEqual([...comp.deps].sort(), ['subject:dag-a', 'subject:dag-b'])
    assert.deepEqual(byId['doc:system'].deps, ['composition'])
    assert.deepEqual(byId['presentation'].deps, ['composition'])
    assert.deepEqual(byId['doc:dag-a'].deps, ['subject:dag-a'])
    // parallelizable independent child work
    assert.ok(plan.nodes.filter((n) => n.kind === 'subject' && n.parallelizable !== undefined).every((n) => n.parallelizable === (n.action === 'CREATE' || n.action === 'REFRESH')))
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Resume, idempotency, work packets, final gate
// ─────────────────────────────────────────────────────────────────────────────

function setupThreeSubjects() {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  const root = join(store, 'explanations', repo.name)
  return { repo, store, root }
}

test('resume: partial completion → only unfinished nodes remain actionable, finished ones reused', () => {
  const { repo, root } = setupThreeSubjects()
  try {
    writeReadyBundle(root, { name: '2026-09-09-res-a-other', repo, subjectName: 'Res A' })
    writeReadyBundle(root, { name: '2026-09-09-res-b-other', repo, subjectName: 'Res B' })
    // Res C missing → CREATE.
    const plan = planRun({ subjects: ['Res A', 'Res B', 'Res C'], depth: 'standard', outputs: ['artifacts', 'documents'], repoRoot: repo.root })
    assert.ok(plan.ok)
    const status1 = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    const byNode1 = Object.fromEntries(status1.nodes.map((n) => [n.id, n]))
    assert.equal(byNode1['subject:res-a'].state, 'done')
    assert.equal(byNode1['subject:res-a'].observed_action, 'reused')
    assert.equal(byNode1['subject:res-b'].state, 'done')
    assert.equal(byNode1['subject:res-c'].state, 'pending')
    assert.ok(status1.work_packets.some((p) => p.subject === 'Res C'), 'work packet for the missing subject')
    assert.equal(status1.state, 'in_progress')
    // New "session": same request, no run id → resumed, only C outstanding.
    const resumed = planRun({ subjects: ['Res A', 'Res B', 'Res C'], depth: 'standard', outputs: ['artifacts', 'documents'], repoRoot: repo.root })
    assert.equal(resumed.run_id, plan.run_id, 'open run with the same request signature is resumed')
    assert.equal(resumed.resumed, true)
    // After C exists: everything reuses, nothing is re-created.
    writeReadyBundle(root, { name: '2026-09-09-res-c-other', repo, subjectName: 'Res C' })
    const status2 = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    const byNode2 = Object.fromEntries(status2.nodes.map((n) => [n.id, n]))
    assert.equal(byNode2['subject:res-a'].observed_action, 'reused')
    assert.equal(byNode2['subject:res-b'].observed_action, 'reused')
    assert.equal(byNode2['subject:res-c'].observed_action, 'created')
    assert.equal(byNode2['doc:res-a'].state, 'done')
    assert.equal(byNode2['doc:res-c'].state, 'done')
    assert.equal(status2.state, 'ready_to_finalize')
  } finally { restoreRuntimeStore() }
})

test('idempotency: repeating the same request reuses everything and creates no duplicate bundles', () => {
  const { repo, root } = setupThreeSubjects()
  try {
    writeReadyBundle(root, { name: '2026-09-09-idem-other', repo, subjectName: 'Idem One' })
    const first = planRun({ subjects: ['Idem One'], depth: 'standard', outputs: ['artifacts', 'documents'], repoRoot: repo.root })
    const second = planRun({ subjects: ['Idem One'], depth: 'standard', outputs: ['artifacts', 'documents'], repoRoot: repo.root })
    assert.equal(first.run_id, second.run_id, 'same request → same open run')
    assert.equal(second.nodes.find((n) => n.id === 'subject:idem-one').action, 'REUSE')
    const bundlesAfter = buildCatalog({ repoRoot: repo.root }).bundles.filter((b) => b.subject_id === 'idem-one').length
    assert.equal(bundlesAfter, 1, 'no duplicate bundle creation')
  } finally { restoreRuntimeStore() }
})

test('final gate: missing child readiness fails; complete outputs pass and the run closes', () => {
  const { repo, root, store } = setupThreeSubjects()
  try {
    const gate = writeReadyBundle(root, { name: '2026-09-09-gate-other', repo, subjectName: 'Gate One', depth: 'presentation' })
    const plan = planRun({ subjects: ['Gate One'], depth: 'presentation', outputs: ['artifacts', 'documents', 'presentation'], repoRoot: repo.root })
    assert.ok(plan.ok)
    // Invalidate the bundle: drift the repo → subject no longer fresh.
    writeFileSync(join(repo.root, 'a.cpp'), 'int step() { return 3; }\n')
    git(repo.root, ['add', '-A'])
    git(repo.root, ['commit', '-m', 'drift after plan'])
    const bad = runFinalize({ repoRoot: repo.root, runId: plan.run_id })
    assert.equal(bad.complete, false)
    assert.equal(bad.state, 'blocked_at_child')
    assert.ok(bad.failures.some((f) => f.startsWith('subject Gate One')))
    // Restore freshness by re-committing the original content (new HEAD, but
    // source hash changed too — simulate a proper refresh instead: revert).
    writeFileSync(join(repo.root, 'a.cpp'), 'int step() { return 1; }\n')
    git(repo.root, ['add', '-A'])
    git(repo.root, ['commit', '-m', 'refresh'])
    // Still stale: HEAD moved. Simulate the agent refreshing the bundle:
    writeReadyBundle(root, { name: '2026-09-09-gate2-presentation', repo, subjectName: 'Gate One', depth: 'presentation' })
    const plan2 = planRun({ subjects: ['Gate One'], depth: 'presentation', outputs: ['artifacts', 'documents', 'presentation'], repoRoot: repo.root })
    assert.ok(plan2.ok)
    // Presentation manifest with a STALE handoff hash → presentation gate fails.
    writePresentationManifest(join(store, 'presentations'), { bundle: { name: '2026-09-09-gate2-presentation', dir: join(root, '2026-09-09-gate2-presentation'), subjectId: 'gate-one', head: plan2.head }, repoName: repo.name, hashHandoff: false })
    const badPres = runFinalize({ repoRoot: repo.root, runId: plan2.run_id })
    assert.equal(badPres.complete, false)
    assert.equal(badPres.state, 'presentation_invalid')
    // Correct manifest → everything passes.
    rmSync(join(process.env.COMPILER_DEV_EXPLAIN_DIR, 'presentations', repo.name), { recursive: true, force: true })
    writePresentationManifest(join(store, 'presentations'), { bundle: { name: '2026-09-09-gate2-presentation', dir: join(root, '2026-09-09-gate2-presentation'), subjectId: 'gate-one', head: plan2.head }, repoName: repo.name })
    const good = runFinalize({ repoRoot: repo.root, runId: plan2.run_id })
    assert.equal(good.complete, true, JSON.stringify(good.failures))
    assert.equal(good.state, 'complete')
    assert.ok(good.checks.some((c) => c.check.startsWith('subject Gate One') && c.ok))
    assert.ok(good.checks.some((c) => c.check.startsWith('document') && c.ok))
    assert.ok(good.checks.some((c) => c.check === 'presentation' && c.ok))
    assert.ok(existsSync(join(root, '2026-09-09-gate2-presentation', 'explanation.md')), 'derived document rendered')
  } finally { restoreRuntimeStore() }
})

test('final gate: presentation reuse — same handoff hash reuses the recorded deck', () => {
  const { repo, root, store } = setupThreeSubjects()
  try {
    const bundle = writeReadyBundle(root, { name: '2026-09-09-pres-other', repo, subjectName: 'Pres One', depth: 'presentation' })
    writePresentationManifest(join(store, 'presentations'), { bundle, repoName: repo.name })
    const plan = planRun({ subjects: ['Pres One'], depth: 'presentation', outputs: ['artifacts', 'presentation'], repoRoot: repo.root })
    assert.ok(plan.ok)
    const status = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    const pres = status.nodes.find((n) => n.kind === 'presentation')
    assert.equal(pres.state, 'done')
    assert.equal(pres.observed_action, 'reused')
    assert.equal(pres.checker, 'unavailable', 'deck without a checker stays compatible')
    const fin = runFinalize({ repoRoot: repo.root, runId: plan.run_id })
    assert.equal(fin.complete, true, JSON.stringify(fin.failures))
    assert.equal(fin.result_summary.presentation, 'reused')
  } finally { restoreRuntimeStore() }
})

test('final gate (T5): deck project checker failure blocks presentation COMPLETE', () => {
  const { repo, root, store } = setupThreeSubjects()
  try {
    const bundle = writeReadyBundle(root, { name: '2026-09-09-pres-other', repo, subjectName: 'Pres One', depth: 'presentation' })
    const projectDir = writePresentationManifest(join(store, 'presentations'), { bundle, repoName: repo.name })
    // a deck project whose own deterministic checker fails (broken QMD/geometry)
    mkdirSync(join(projectDir, 'scripts'), { recursive: true })
    writeFileSync(join(projectDir, 'scripts', 'check_project.py'),
      'import sys\nprint("ERROR: .footnote[...] is not Quarto syntax", file=sys.stderr)\nsys.exit(1)\n')
    const plan = planRun({ subjects: ['Pres One'], depth: 'presentation', outputs: ['artifacts', 'presentation'], repoRoot: repo.root })
    const status = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    const pres = status.nodes.find((n) => n.kind === 'presentation')
    assert.equal(pres.state, 'pending', 'a failing deck checker must not count as done')
    assert.equal(pres.checker, 'fail')
    assert.ok(pres.reasons.some((r) => r.includes('presentation checker failed')), JSON.stringify(pres.reasons))
    const fin = runFinalize({ repoRoot: repo.root, runId: plan.run_id })
    assert.equal(fin.complete, false, 'finalize must refuse COMPLETE while the checker fails')

    // fixing the deck (checker passes) unblocks the node
    writeFileSync(join(projectDir, 'scripts', 'check_project.py'),
      'print("OK: project structure checks passed")\n')
    const status2 = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    const pres2 = status2.nodes.find((n) => n.kind === 'presentation')
    assert.equal(pres2.state, 'done')
    assert.equal(pres2.checker, 'pass')
  } finally { restoreRuntimeStore() }
})

test('final gate: open composition conflict blocks the run at composition', () => {
  const { repo, root } = setupThreeSubjects()
  try {
    const a = writeReadyBundle(root, { name: '2026-09-09-cfl-a-other', repo, subjectName: 'Cfl A' })
    const b = writeReadyBundle(root, { name: '2026-09-09-cfl-b-other', repo, subjectName: 'Cfl B' })
    const sys = writeReadyComposition(root, { name: '2026-09-09-cfl-system', repo, children: [a, b], requested: ['Cfl A', 'Cfl B'] })
    // Introduce an open conflict.
    const compPath = join(sys.dir, 'composition.json')
    const comp = JSON.parse(readFileSync(compPath, 'utf8'))
    comp.conflicts = [{ conflict_id: 'cfl-1', kind: 'ordering disagreement', description: 'The two fixtures disagree about the apply order.', status: 'open' }]
    writeFileSync(compPath, JSON.stringify(comp, null, 2))
    const plan = planRun({ subjects: ['Cfl A', 'Cfl B'], depth: 'standard', outputs: ['artifacts', 'system_story'], repoRoot: repo.root })
    assert.ok(plan.ok)
    const status = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    assert.equal(status.state, 'blocked_at_composition')
    assert.ok(status.blockers.some((bl) => bl.node === 'composition'))
    const fin = runFinalize({ repoRoot: repo.root, runId: plan.run_id })
    assert.equal(fin.complete, false)
    assert.equal(fin.state, 'blocked_at_composition')
  } finally { restoreRuntimeStore() }
})

test('system story document renders through the run and gates on currency', () => {
  const { repo, root } = setupThreeSubjects()
  try {
    const a = writeReadyBundle(root, { name: '2026-09-09-sys-a-other', repo, subjectName: 'Sys A' })
    const b = writeReadyBundle(root, { name: '2026-09-09-sys-b-other', repo, subjectName: 'Sys B' })
    writeReadyComposition(root, { name: '2026-09-09-sys-system', repo, children: [a, b], requested: ['Sys A', 'Sys B'] })
    const plan = planRun({ subjects: ['Sys A', 'Sys B'], depth: 'standard', outputs: ['artifacts', 'system_story'], repoRoot: repo.root })
    assert.ok(plan.ok)
    const status = runStatus({ repoRoot: repo.root, runId: plan.run_id })
    const comp = status.nodes.find((n) => n.kind === 'composition')
    assert.equal(comp.state, 'done')
    assert.equal(comp.observed_action, 'reused')
    const doc = status.nodes.find((n) => n.id === 'doc:system')
    assert.equal(doc.state, 'done', JSON.stringify(doc.reasons))
    assert.ok(existsSync(doc.doc_path), 'system-story.md rendered')
    const fin = runFinalize({ repoRoot: repo.root, runId: plan.run_id })
    assert.equal(fin.complete, true, JSON.stringify(fin.failures))
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Runtime store cleanliness — the hard productionization acceptance item
// ─────────────────────────────────────────────────────────────────────────────

test('runtime store: a normal run writes only under the runtime store and never dirties the harness tree', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const before = git(harnessRoot, ['status', '--porcelain'])
    const plan = planRun({ subjects: ['No Such Subject Here'], depth: 'standard', outputs: ['artifacts', 'documents', 'system_story', 'presentation'], repoRoot: repo.root })
    assert.ok(plan.ok)
    runStatus({ repoRoot: repo.root, runId: plan.run_id })
    runFinalize({ repoRoot: repo.root, runId: plan.run_id })
    const after = git(harnessRoot, ['status', '--porcelain'])
    assert.equal(after, before, 'harness tracked tree unchanged')
    // Runtime state lives in the store.
    assert.ok(existsSync(join(store, 'runs', repoSlugFor(repo.root))), 'run state under the runtime store')
    assert.ok(runtimeExplanationsRoot().startsWith(store), 'runtime explanations root inside the store')
  } finally { restoreRuntimeStore() }
})

test('runtime store: the default runtime root is gitignored', () => {
  delete process.env.COMPILER_DEV_EXPLAIN_DIR
  try {
    const gitignore = readFileSync(join(harnessRoot, '.gitignore'), 'utf8')
    assert.ok(gitignore.includes('analysis/runtime/'), 'analysis/runtime/ is gitignored')
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

test('renderer: explanation.md is a derived, adaptive view — renders only present sections and never claims new facts', () => {
  const repo = makeTempRepo()
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const root = join(store, 'explanations', repo.name)
    const bundle = writeReadyBundle(root, { name: '2026-09-09-rend-other', repo, subjectName: 'Rend One', depth: 'presentation' })
    const out = renderExplanation(bundle.dir, { write: false })
    assert.ok(out.ok)
    assert.ok(out.markdown.includes('# rend-one: Rend One'))
    assert.ok(out.markdown.includes('## Mental model'))
    assert.ok(out.markdown.includes('## Mechanism'))
    assert.ok(out.markdown.includes('## Key takeaways'))
    assert.ok(out.markdown.includes('source of truth'))
    // Adaptive: no strategies/decisions sections exist in this dossier.
    assert.ok(!out.markdown.includes('## Strategies'))
    assert.ok(!out.markdown.includes('## Decisions'))
    const passBundle = writeReadyBundle(root, { name: '2026-09-09-rend-pass', repo, subjectName: 'Rend Pass', subjectType: 'pass', depth: 'presentation' })
    const passOut = renderExplanation(passBundle.dir, { write: false })
    assert.ok(passOut.markdown.includes('## Type extension: pass'))
    assert.ok(passOut.markdown.includes('pass_arg'))
    // Deterministic: same artifacts → same markdown.
    const again = renderExplanation(bundle.dir, { write: false })
    assert.equal(again.markdown, out.markdown)
    // Write + currency.
    const written = renderExplanation(bundle.dir)
    assert.equal(written.changed, true)
    const rewritten = renderExplanation(bundle.dir)
    assert.equal(rewritten.changed, false)
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-origin discovery (guarded on the committed curated fixtures)
// ─────────────────────────────────────────────────────────────────────────────

const ascendRoot = '/home/shijingchang/workspace/AscendNPU-IR'
const hasAscend = existsSync(ascendRoot)

test('cross-origin: curated system bundle is reusable composition evidence when the target repo is fresh', { skip: !hasAscend && 'AscendNPU-IR checkout not available' }, () => {
  const store = mkdtempSync(join(tmpdir(), 't4-orch-store-'))
  useRuntimeStore(join(store, 'explanations'))
  try {
    const catalog = buildCatalog({ repoRoot: ascendRoot })
    const comp = catalog.bundles.find((b) => b.is_composition && b.artifact_origin === 'curated')
    assert.ok(comp, 'curated composition discovered')
    assert.equal(comp.readiness, 'ready')
    const reuse = findReusableComposition(catalog, comp.child_subject_ids, { depth: comp.depth, repository: comp.repository })
    assert.equal(reuse.action, 'REUSE_COMPOSITION', JSON.stringify(reuse.reasons))
    const mutated = findReusableComposition(catalog, [...comp.child_subject_ids, 'extra-subject'], { depth: comp.depth, repository: comp.repository })
    assert.equal(mutated.action, 'COMPOSE', 'changed component set forces recomposition')
  } finally { restoreRuntimeStore() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Anti-overfitting: the generic orchestration layer stays subject-agnostic
// ─────────────────────────────────────────────────────────────────────────────

test('anti-overfitting: no dogfood-specific concepts in the generic orchestration driver', () => {
  const source = readFileSync(join(harnessRoot, 'compiler-orchestrate-driver.mjs'), 'utf8')
  for (const banned of ['MergeVecScope', 'AutoVectorize', 'RegBase', 'HFusion', 'HIVM', 'bufferization', 'stride', 'memref', 'AscendNPU', 'pass_arg=']) {
    assert.ok(!source.includes(banned), `generic orchestration must not contain "${banned}"`)
  }
})

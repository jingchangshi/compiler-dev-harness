/**
 * Tests for the compiler_explain tool surface: the plugin registration
 * (compiler-explain-v2.cjs), the plan/validate/readiness/stale commands
 * (compiler-explain-driver.mjs), and bundle persistence under a redirected
 * explanation root (COMPILER_DEV_EXPLAIN_DIR).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../../compiler-explain-v2.cjs')

const {
  planTeaching, loadBundle, validateBundleDir, readinessForBundle, saveReadiness,
  stalenessForBundle, repositoryProvenance, hashSourceFiles, explainRoot,
} = await import('../../compiler-explain-driver.mjs')

// ─────────────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────────────

test('plugin registers the compiler_explain tool and the always-on policy section', () => {
  const sections = []
  const tools = []
  plugin.apply({ systemPrompt: { section: (s) => sections.push(s) }, tools: { register: (t) => tools.push(t) } })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'compiler_explain')
  assert.equal(tools[0].parameters.required[0], 'command')
  assert.deepEqual([...tools[0].parameters.properties.command.enum],
    ['plan', 'validate', 'readiness', 'stale', 'compose-preflight', 'compose-plan', 'compose-validate', 'compose-render'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'code-explanation-policy')
  assert.ok(sections[0].text.includes('presentation handoff'))
  assert.ok(typeof tools[0].execute === 'function')
})

test('tool execute dispatches commands and reports unknown/missing inputs', async () => {
  const tools = []
  plugin.apply({ systemPrompt: { section: () => {} }, tools: { register: (t) => tools.push(t) } })
  const execute = tools[0].execute
  const plan = await execute({ command: 'plan', subject_type: 'function', name: 'demo_fn' })
  assert.equal(plan.ok, true)
  assert.equal(plan.command, 'plan')
  const bad = await execute({ command: 'plan', subject_type: 'nope', name: 'x' })
  assert.equal(bad.ok, false)
  const noDir = await execute({ command: 'validate' })
  assert.equal(noDir.ok, false)
  assert.ok(noDir.error.includes('bundle_dir'))
  const unknown = await execute({ command: 'teleport' })
  assert.equal(unknown.ok, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// plan
// ─────────────────────────────────────────────────────────────────────────────

test('plan scaffolds a bundle with evidence plan, extension fields, checklist, and audience questions', () => {
  const plan = planTeaching({ subject_type: 'pass', name: 'MyPass', depth: 'presentation', why_this_subject: 'complexity' })
  assert.equal(plan.ok, true)
  assert.ok(plan.bundle.id.endsWith('-pass'))
  assert.ok(plan.bundle.dir.includes(join('analysis', 'explanations')))
  assert.equal(plan.subject_skeleton.subject_type, 'pass')
  assert.equal(plan.subject_skeleton.why_this_subject, 'complexity')
  const steps = plan.evidence_plan.map((s) => s.step)
  assert.ok(steps.includes('graph-review'))
  assert.ok(steps.includes('identity-and-scope'))
  assert.ok(steps.includes('history'))
  assert.ok(plan.extension_fields.fields.includes('pipeline_placements'))
  assert.ok(plan.readiness_checklist.by_type.includes('pipeline placement'))
  assert.ok(plan.audience_questions.length >= 10)
  assert.ok(plan.notes.some((n) => n.includes('canonical_example is mechanically required')))
})

test('plan rejects unknown subject types and depths', () => {
  assert.equal(planTeaching({ subject_type: 'pass', name: 'X', depth: 'everything' }).ok, false)
  assert.equal(planTeaching({ subject_type: 'tensor', name: 'X' }).ok, false)
  assert.equal(planTeaching({ subject_type: 'pass', name: '' }).ok, false)
})

test('plan for a function does not require a canonical example note', () => {
  const plan = planTeaching({ subject_type: 'function', name: 'demo_fn', depth: 'deep' })
  assert.ok(!plan.notes.some((n) => n.includes('mechanically required')))
  assert.ok(plan.extension_fields.fields.includes('callers'))
})

// ─────────────────────────────────────────────────────────────────────────────
// validate / readiness on a real bundle dir
// ─────────────────────────────────────────────────────────────────────────────

function writeBundle(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
}

function minimalGoodBundle() {
  return {
    'subject.json': {
      artifact: 'subject', subject_id: 'demo-fn-function', subject_type: 'function', name: 'demo_fn',
      repository: 'example-repo', source_locations: [{ file: 'src/demo.c', lines: '1-40' }],
      provenance: { repository: 'example-repo', branch: 'main', head: 'a'.repeat(40), analyzed_at: '2026-09-08T10:00:00Z' },
    },
    'evidence.json': { artifact: 'evidence', records: [
      { id: 'EV-001', class: 'source_fact', statement: 'demo_fn is defined at src/demo.c:1 and returns 0 on empty input.', refs: [{ file: 'src/demo.c', lines: '1-40' }] },
      { id: 'EV-002', class: 'runtime_fact', statement: 'demo_fn_test passes.', refs: [{ file: 'test/demo_test.c', lines: '1-20' }] },
    ] },
    'dossier.json': {
      artifact: 'teaching_dossier', schema_version: 1, subject_id: 'demo-fn-function', subject_type: 'function', depth: 'standard',
      mental_model: 'It returns the first non-empty entry in a list so callers never see a null handle.',
      need: 'callers repeat the empty-check everywhere.',
      system_context: {
        triggers: [{ role: 'caller', entity: 'poll_loop', interaction: 'calls once per tick', evidence_refs: ['EV-001'] }],
        downstream: [{ role: 'consumer', entity: 'dispatch', interaction: 'consumes the returned handle', evidence_refs: ['EV-001'] }],
      },
      inputs: [{ name: 'entry list', form: 'linked list', description: 'candidates', evidence_refs: ['EV-001'] }],
      outputs: [{ name: 'first entry handle', form: 'pointer', description: 'or NULL', evidence_refs: ['EV-001'] }],
      mechanism: { stages: [{ name: 'Scan', what: 'walk until non-empty', where: 'src/demo.c:5', evidence_refs: ['EV-001'] }], mutable_state: false, has_important_branching: false },
      constraints: [{ statement: 'list must not be mutated during the scan', status: 'assumed', evidence_refs: ['EV-001'] }],
      boundaries: [{ category: 'supported', statement: 'empty list returns NULL', evidence_refs: ['EV-001'] }],
      key_takeaways: ['first non-empty', 'NULL on empty', 'no allocation'],
      extensions: { function: { parameters: ['entry_list *list'], return_values: ['entry *'], callees: [] } },
    },
  }
}

test('validate accepts a good bundle and rejects a broken one', () => {
  const root = mkdtempSync(join(tmpdir(), 'explain-validate-'))
  try {
    const good = join(root, 'good')
    writeBundle(good, minimalGoodBundle())
    const goodOut = validateBundleDir(good)
    assert.equal(goodOut.valid, true, JSON.stringify(goodOut.errors))
    assert.deepEqual(goodOut.loaded, ['subject.json', 'evidence.json', 'dossier.json'])

    const bad = join(root, 'bad')
    const files = minimalGoodBundle()
    files['dossier.json'].mental_model = undefined
    files['dossier.json'].mechanism.stages[0].evidence_refs = ['EV-404']
    writeBundle(bad, files)
    const badOut = validateBundleDir(bad)
    assert.equal(badOut.valid, false)
    assert.ok(badOut.errors.some((e) => e.includes('EV-404')))

    const missing = join(root, 'nope')
    assert.equal(validateBundleDir(missing).ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readiness without semantic review is not ready and lists open questions; with review it persists readiness.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'explain-readiness-'))
  process.env.COMPILER_DEV_EXPLAIN_DIR = root
  try {
    const dir = join(root, '2026-09-08-demo-fn-function')
    writeBundle(dir, minimalGoodBundle())

    const mechanical = readinessForBundle(dir)
    assert.equal(mechanical.ok, true)
    assert.equal(mechanical.result.verdict, 'not_ready')
    assert.ok(mechanical.result.reasons.some((r) => r.includes('semantic review missing')))
    assert.ok(!existsSync(join(dir, 'readiness.json')))

    const questions = mechanical.report.mechanical.checks // sanity: mechanical checks enumerated
    assert.ok(questions.length > 5)

    const saved = saveReadiness(dir, {
      verdict: 'ready',
      audience_questions: [
        { question: '它是什么？', answer: 'first non-empty entry selector', sufficient: true },
        { question: '为什么存在？', answer: 'removes repeated empty checks', sufficient: true },
        { question: '它处在什么上下文？', answer: 'poll_loop → demo_fn → dispatch', sufficient: true },
        { question: '输入和输出是什么？', answer: 'list → handle or NULL', sufficient: true },
        { question: '核心机制是什么？', answer: 'single scan', sufficient: true },
        { question: '哪些状态最重要？', answer: 'none (stateless)', sufficient: true },
        { question: '哪些决策决定行为？', answer: 'none — no important branching', sufficient: true },
        { question: '与哪些组件交互？', answer: 'poll_loop and dispatch', sufficient: true },
        { question: '什么情况下不能工作或选择另一条路径？', answer: 'empty list → NULL', sufficient: true },
        { question: '最值得记住的 3～5 点是什么？', answer: 'the takeaways', sufficient: true },
      ],
      notes: 'a caller-side engineer can follow this without the source',
    })
    assert.equal(saved.result.verdict, 'ready', saved.result.reasons.join('; '))
    assert.ok(existsSync(join(dir, 'readiness.json')))
    const persisted = JSON.parse(readFileSync(join(dir, 'readiness.json'), 'utf8'))
    assert.equal(persisted.verdict, 'ready')
    assert.equal(persisted.mechanical.verdict, 'pass')
  } finally {
    delete process.env.COMPILER_DEV_EXPLAIN_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

test('readiness respects a not_ready semantic verdict even when mechanical passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'explain-notready-'))
  try {
    const dir = join(root, 'bundle')
    writeBundle(dir, minimalGoodBundle())
    const out = readinessForBundle(dir, { verdict: 'not_ready', blockers: ['mental model is still symbol soup'] })
    assert.equal(out.result.verdict, 'not_ready')
    assert.ok(out.result.reasons.some((r) => r.includes('semantic review concluded not_ready')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// stale (real git repo)
// ─────────────────────────────────────────────────────────────────────────────

function initGitRepo(root) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  writeFileSync(join(root, 'src.txt'), 'original\n')
  execFileSync('git', ['add', 'src.txt'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
}

test('stale detects HEAD drift and changed source files', () => {
  const repo = mkdtempSync(join(tmpdir(), 'explain-git-'))
  try {
    const head1 = initGitRepo(repo)
    const bundleDir = join(repo, 'bundle')
    writeBundle(bundleDir, {
      'subject.json': {
        artifact: 'subject', subject_id: 'demo-fn-function', subject_type: 'function', name: 'demo_fn',
        repository: repo,
        source_locations: [{ file: 'src.txt' }],
        provenance: {
          repository: repo, branch: 'main', head: head1, analyzed_at: '2026-09-08T10:00:00Z',
          source_files: hashSourceFiles(repo, [{ file: 'src.txt' }]),
        },
      },
    })
    const fresh = stalenessForBundle(bundleDir, repo)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.staleness.stale, false)

    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'unrelated drift'], { cwd: repo })
    const headDrift = stalenessForBundle(bundleDir, repo)
    assert.equal(headDrift.staleness.head_stale, true)
    assert.equal(headDrift.staleness.stale, true)

    const head2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
    writeFileSync(join(repo, 'bundle', 'subject.json'), JSON.stringify({
      artifact: 'subject', subject_id: 'demo-fn-function', subject_type: 'function', name: 'demo_fn',
      repository: repo, source_locations: [{ file: 'src.txt' }],
      provenance: { repository: repo, branch: 'main', head: head2, analyzed_at: '2026-09-08T10:00:00Z', source_files: hashSourceFiles(repo, [{ file: 'src.txt' }]) },
    }))
    writeFileSync(join(repo, 'src.txt'), 'changed\n')
    const fileDrift = stalenessForBundle(bundleDir, repo)
    assert.equal(fileDrift.staleness.head_stale, false)
    assert.deepEqual(fileDrift.staleness.stale_files, ['src.txt'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// misc
// ─────────────────────────────────────────────────────────────────────────────

test('explainRoot honors COMPILER_DEV_EXPLAIN_DIR', () => {
  const before = process.env.COMPILER_DEV_EXPLAIN_DIR
  process.env.COMPILER_DEV_EXPLAIN_DIR = '/tmp/explain-custom'
  assert.equal(explainRoot(), '/tmp/explain-custom')
  if (before === undefined) delete process.env.COMPILER_DEV_EXPLAIN_DIR
  else process.env.COMPILER_DEV_EXPLAIN_DIR = before
})

test('loadBundle reports invalid JSON and missing bundles', () => {
  const root = mkdtempSync(join(tmpdir(), 'explain-load-'))
  try {
    assert.equal(loadBundle(join(root, 'missing')).ok, false)
    const dir = join(root, 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'subject.json'), '{not json')
    const out = loadBundle(dir)
    assert.equal(out.ok, false)
    assert.ok(out.error.includes('invalid JSON'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repositoryProvenance reads head and branch from a git repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'explain-prov-'))
  try {
    initGitRepo(repo)
    const prov = repositoryProvenance(repo)
    assert.equal(prov.branch, 'main')
    assert.match(prov.head, /^[0-9a-f]{40}$/)
    assert.ok(prov.analyzed_at)
    assert.equal(prov.repository, repo.split('/').pop())
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

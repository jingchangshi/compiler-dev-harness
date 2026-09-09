/**
 * Phase T5 presentation-fidelity tests: deterministic layout + geometry QA.
 *
 * Coverage:
 * - spec_to_diagram.py: every VISUAL_KIND maps to a real layout; box sizes are
 *   measured (long CJK labels never overlap); band wrapping bounds width;
 *   wrap/non-adjacent edges carry waypoints (no straight line across rows).
 * - check_diagram_geometry.py: the REAL failed dogfood deck's visual specs
 *   (fixture) regenerate into diagrams that pass all geometry gates — this is
 *   the regression for the 4204×510 / overlap / edge-through-node failure;
 * - the OLD straight-line geometry pattern (no routing) is rejected by the
 *   checker (G2) — the failure mode the fix removes;
 * - check_project.py: `.footnote[` and `·`-prose lists fail; canonical footer
 *   + real lists pass;
 * - template scripts and harness canonical scripts stay byte-identical.
 *
 * Fixtures may carry dogfood subject terms (regression fixtures are an
 * allowed location); the generic scripts must not (anti-overfitting scan).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKILL = join(repoRoot, 'skills', 'compiler-architecture-presentation')
const SCRIPTS = join(SKILL, 'scripts')
const TEMPLATE = join(SKILL, 'assets', 'quarto-project-template')
const specToDiagram = join(SCRIPTS, 'spec_to_diagram.py')
const geometryChecker = join(SCRIPTS, 'check_diagram_geometry.py')

const py = (args, opts = {}) => {
  const r = spawnSync('python3', args, { encoding: 'utf-8', ...opts })
  if (r.error) throw r.error
  return r
}

const fixture = JSON.parse(readFileSync(
  join(repoRoot, 'scripts', 'test', 'fixtures', 'mergevecscope-failed-deck-visuals.json'), 'utf-8'))

/** Interpret one visual spec into a positioned spec via the module API. */
function interpret(spec) {
  const dir = mkdtempSync(join(tmpdir(), 't5-'))
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

function checkGeometry(...targets) {
  return py([geometryChecker, ...targets])
}

function rectsOf(positioned) {
  return positioned.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.width, h: n.height }))
}

test('every handoff visual kind maps to a non-grid layout (no silent fallback for kinds in the dogfood fixture)', () => {
  const handled = new Set(['pipeline', 'sequence', 'state_transition', 'before_after',
    'comparison', 'decision_tree', 'flowchart', 'control_flow', 'data_flow',
    'dependency_graph', 'architecture'])
  for (const v of fixture.visuals) {
    assert.ok(handled.has(v.kind), `kind ${v.kind} (visual ${v.id}) silently grid-falls back`)
  }
})

test('measured boxes: CJK-wide labels produce wider boxes than the old fixed NODE_W', () => {
  const spec = {
    kind: 'pipeline',
    nodes: [{ id: 'a', label: '规范化与校验（含同步指令检查）' }, { id: 'b', label: '输出' }],
    edges: [{ from: 'a', to: 'b' }],
  }
  const out = interpret(spec)
  const wide = out.nodes.find((n) => n.id === 'a')
  assert.ok(wide.width > 200, `label-measured width expected, got ${wide.width}`)
  assert.ok(wide.lines.length >= 1 && wide.lines.every((l) => l.length > 0))
})

test('band wrapping: a 12-node pipeline wraps instead of exceeding the width bound', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `阶段节点 ${i + 1}` }))
  const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }))
  const out = interpret({ kind: 'pipeline', nodes, edges })
  const rects = rectsOf(out)
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  assert.ok(maxX <= 1600, `content width ${maxX} must stay bounded by wrap`)
  const ys = new Set(rects.map((r) => r.y))
  assert.ok(ys.size >= 2, 'wrapped chain must occupy more than one row')
  // the row-crossing connector must be routed (waypoints), not a straight diagonal
  const wrapEdge = out.edges.find((e) => e.waypoints && e.waypoints.length > 0)
  assert.ok(wrapEdge, 'wrap connector must carry waypoints through the gutter')
})

test('decision_tree with reject roles: reject nodes form their own column and edges are routed', () => {
  const spec = {
    kind: 'decision_tree',
    nodes: [
      { id: 'root', label: '入口闸门' },
      { id: 'g1', label: '条件一成立？' }, { id: 'g2', label: '条件二成立？' },
      { id: 'ok', label: '执行主路径', role: 'outcome' },
      { id: 'r1', label: '拒绝：条件一', role: 'reject' },
      { id: 'r2', label: '拒绝：条件二', role: 'reject' },
    ],
    edges: [
      { from: 'root', to: 'g1', label: '通过' },
      { from: 'g1', to: 'g2', label: '是' }, { from: 'g1', to: 'r1', label: '否' },
      { from: 'g2', to: 'ok', label: '是' }, { from: 'g2', to: 'r2', label: '否' },
    ],
    ordering: ['root'],
  }
  const out = interpret(spec)
  const rects = Object.fromEntries(rectsOf(out).map((r) => [r.id, r]))
  assert.ok(rects.r1.x > rects.g2.x, 'reject column sits right of main columns')
  const rejectEdges = out.edges.filter((e) => e.to.startsWith('r') && e.waypoints.length > 0)
  assert.ok(rejectEdges.length >= 1, 'reject edges are elbow-routed, not straight through the chain')
})

test('REGRESSION: real failed-deck visual specs regenerate into geometry-clean diagrams', () => {
  const dir = mkdtempSync(join(tmpdir(), 't5-fixture-'))
  try {
    const paths = []
    for (const v of fixture.visuals) {
      const out = interpret(v)
      // direct structural assertions, independent of the checker:
      const rects = rectsOf(out)
      for (const a of rects) {
        for (const b of rects) {
          if (a.id >= b.id) continue
          const overlap = a.x + a.w > b.x + 2 && b.x + b.w > a.x + 2 &&
            a.y + a.h > b.y + 2 && b.y + b.h > a.y + 2
          assert.ok(!overlap, `${v.id}: nodes ${a.id} and ${b.id} overlap`)
        }
      }
      if (v.id === 'V4') {
        const maxX = Math.max(...rects.map((r) => r.x + r.w))
        const maxY = Math.max(...rects.map((r) => r.y + r.h))
        assert.ok(maxX / Math.max(maxY, 1) < 6,
          `V4 aspect ${maxX / maxY} must be far below the failed 10.1`)
      }
      const p = join(dir, `${v.id}.excalidraw`)
      const positioned = join(dir, `${v.id}.json`)
      writeFileSync(positioned, JSON.stringify(out))
      const r = py([join(SCRIPTS, 'make_excalidraw_diagram.py'), positioned,
        '--excalidraw', p, '--svg', join(dir, `${v.id}.svg`)])
      assert.equal(r.status, 0, r.stderr)
      paths.push(p)
    }
    const check = checkGeometry(...paths)
    assert.equal(check.status, 0, `geometry checker rejected regenerated diagrams:\n${check.stdout}\n${check.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('geometry checker rejects the OLD failure pattern: straight edges crossing nodes (G2) and unreadable projection (G4)', () => {
  // hand-built excalidraw replicating the failed deck: 4000px-wide chain whose
  // reject edges are two-point straight lines across other boxes
  const rect = (id, x, y) => ({
    id, type: 'rectangle', x, y, width: 260, height: 64, strokeColor: '#343a40',
    backgroundColor: '#ffffff', isDeleted: false,
  })
  const els = []
  const xs = Array.from({ length: 13 }, (_, i) => i * 310)
  xs.forEach((x, i) => els.push(rect(`n${i}`, x, 0)))
  // straight edge from box 0 to the last box passing through all intermediates
  els.push({
    id: 'edge0', type: 'arrow', x: 260, y: 32, width: xs[12] - 260, height: 0,
    points: [[0, 0], [xs[12] - 260, 0]], isDeleted: false,
  })
  els.push({
    id: 't0', type: 'text', x: xs[0] + 10, y: 8, width: 240, height: 48,
    text: '闸门条件标签文本', fontSize: 18, isDeleted: false,
  })
  const doc = { type: 'excalidraw', version: 2, elements: els, files: {} }
  const dir = mkdtempSync(join(tmpdir(), 't5-old-'))
  try {
    const p = join(dir, 'old.excalidraw')
    writeFileSync(p, JSON.stringify(doc))
    const check = checkGeometry(p)
    assert.equal(check.status, 1, 'old pattern must fail')
    assert.match(check.stdout, /G2 edge crosses node/)
    assert.match(check.stdout, /G4 projected text/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check_project.py: .footnote[ and ·-prose fail; canonical footer + real lists pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 't5-qmd-'))
  try {
    for (const name of ['slides.qmd', '_quarto.yml', 'styles.scss', 'Makefile']) {
      writeFileSync(join(dir, name), readFileSync(join(TEMPLATE, name)))
    }
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'diagrams'), { recursive: true })
    for (const f of ['check_project.py', 'validate_manifest.py', 'check_diagram_geometry.py']) {
      writeFileSync(join(dir, 'scripts', f), readFileSync(join(TEMPLATE, 'scripts', f)))
    }
    for (const f of ['pipeline.svg', 'algorithm.svg', 'legality.svg']) {
      writeFileSync(join(dir, 'diagrams', f), readFileSync(join(TEMPLATE, 'diagrams', f)))
    }
    // canonical template content passes
    let r = py([join(dir, 'scripts', 'check_project.py')], { cwd: dir })
    assert.equal(r.status, 0, `template content must pass: ${r.stderr}`)

    // break it: footnote syntax + ·-prose
    const qmd = readFileSync(join(dir, 'slides.qmd'), 'utf-8')
    writeFileSync(join(dir, 'slides.qmd'),
      qmd + '\n## 附录\n\n.footnote[证据：EV-001]\n\n段落一 · 段落二 · 段落三 · 段落四\n')
    r = py([join(dir, 'scripts', 'check_project.py')], { cwd: dir })
    assert.equal(r.status, 1, 'defective QMD must fail')
    assert.match(r.stderr, /\.footnote\[/)
    assert.match(r.stderr, /parallel items/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('template scripts and harness canonical scripts stay byte-identical', () => {
  for (const f of ['check_diagram_geometry.py']) {
    const a = readFileSync(join(SCRIPTS, f))
    const b = readFileSync(join(TEMPLATE, 'scripts', f))
    assert.ok(a.equals(b), `${f} copies diverged`)
  }
})

test('geometry checker passes the committed template diagrams', () => {
  const diagrams = join(TEMPLATE, 'diagrams')
  assert.ok(existsSync(join(diagrams, 'pipeline.excalidraw')))
  const r = checkGeometry(diagrams)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// ─── Workstream C: worked-example closure ───────────────────────────────────

const { validateBundle, computeMechanicalReadiness } = await import('../../scripts/teaching-schema.mjs')
const manifestValidator = join(TEMPLATE, 'scripts', 'validate_manifest.py')
const { createHash } = await import('node:crypto')
const sha256 = (d) => createHash('sha256').update(d).digest('hex')

// Real curated presentation bundle (Case A) — the tests graft T5 fields onto it
// so they exercise the full v1 schema, not a hand-rolled subset.
const caseADir = join(repoRoot, 'analysis', 'explanations', '2026-09-08-mergevecscope-pass')
function baseBundle() {
  const load = (f) => JSON.parse(readFileSync(join(caseADir, f), 'utf-8'))
  return { subject: load('subject.json'), evidence: load('evidence.json'),
    dossier: load('dossier.json'), handoff: load('handoff.json') }
}

test('workstream C: handoff worked_examples validate and reach the preflight digest shape', () => {
  const bundle = baseBundle()
  bundle.handoff.worked_examples = [{ id: 'WE-1', title: '门控链实例', summary: 'walks the gate chain' }]
  bundle.dossier.worked_examples = [{
    title: '门控链实例',
    provenance: { kind: 'test', source: 'test/a.mlir' },
    steps: [
      { label: 'S1', action: 'collect', mechanism_stage: 'Collect & order', evidence_refs: ['EV-001'] },
      { label: 'S2', action: 'gate check fails', evidence_refs: ['EV-002'] },
    ],
  }]
  const { errors: errs } = validateBundle(bundle)
  assert.deepEqual(errs, [])

  const bad = baseBundle()
  bad.handoff.worked_examples = [{ title: 'no id, no summary' }]
  const { errors: errs2 } = validateBundle(bad)
  assert.ok(errs2.some((e) => e.includes('worked_examples[0].id')), errs2.join(';'))
})

test('workstream C: legacy step shapes ({description}/{state}) stay valid', () => {
  const bundle = baseBundle()
  bundle.dossier.canonical_example = {
    provenance: { kind: 'test', source: 'test/a.mlir' },
    execution_trace: [{ description: 'step one' }, { state: 'mid' }, 'step three'],
  }
  delete bundle.dossier.worked_examples
  const { errors: errs } = validateBundle(bundle)
  assert.deepEqual(errs, [])
})

test('workstream C: presentation depth requires a worked example (≥3 steps)', () => {
  const mk = (trace, depth = 'presentation') => {
    const bundle = baseBundle()
    bundle.dossier.depth = depth
    bundle.dossier.canonical_example = { provenance: { kind: 'test', source: 'test/a.mlir' }, execution_trace: trace }
    return bundle
  }
  const fail = computeMechanicalReadiness(mk([
    { description: 'only one step' },
  ]), { depth: 'presentation' })
  const failCheck = fail.checks.find((c) => c.name === 'canonical_example')
  assert.equal(failCheck.status, 'fail')

  const ok = computeMechanicalReadiness(mk([
    { description: 's1' }, { description: 's2' }, { description: 's3' },
  ]), { depth: 'presentation' })
  const okCheck = ok.checks.find((c) => c.name === 'canonical_example')
  assert.equal(okCheck.status, 'pass')

  // standard depth keeps the old provenance-only floor
  const std = computeMechanicalReadiness(mk([{ description: 'one step' }], 'standard'), { depth: 'standard' })
  assert.equal(std.checks.find((c) => c.name === 'canonical_example').status, 'pass')
})

test('workstream C: manifest checker enforces worked-example mapping (missing mapping fails)', () => {
  const dir = mkdtempSync(join(tmpdir(), 't5-we-'))
  try {
    const handoff = baseBundle().handoff
    handoff.worked_examples = [{ id: 'WE-1', title: '实例一', summary: 's' }]
    const handoffPath = join(dir, 'handoff.json')
    writeFileSync(handoffPath, JSON.stringify(handoff))
    writeFileSync(join(dir, 'slides.qmd'), '# x\n\n## 实例一\n')
    mkdirSync(join(dir, 'diagrams'), { recursive: true })
    writeFileSync(join(dir, 'diagrams', 'dummy.svg'), '<svg/>')
    // full story + visual coverage so ONLY the worked-example rules can fire
    const coverage = {
      storyline: (handoff.storyline || []).map((s0) => ({
        position: s0.position, disposition: 'consumed', slides: ['## 实例一'] })),
      must_have_visuals: (handoff.must_have_visuals || []).map((id) => ({
        id, assets: ['diagrams/dummy.svg'], slides: ['## 实例一'] })),
      evidence_ids: [],
    }
    const manifest = {
      artifact: 'presentation_manifest', schema_version: 1,
      input: { bundle_id: 'b', subject_id: handoff.subject_id, subject_type: handoff.subject_type,
        handoff_schema_version: 1, handoff_sha256: sha256(readFileSync(handoffPath)),
        source_head: 'h', readiness_verdict: 'ready', preflight: 'CONSUMABLE' },
      consumed: coverage,
    }
    const mpath = join(dir, 'presentation-manifest.json')
    const write = (obj) => writeFileSync(mpath, JSON.stringify(obj))

    // 1: missing example mapping entirely → fail
    write(manifest)
    let r = py([manifestValidator, '--manifest', 'presentation-manifest.json', '--handoff', handoffPath], { cwd: dir })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /worked example WE-1: declared in handoff but not mapped/)

    // 2: mapped with a slide → pass
    write({ ...manifest, consumed: { ...manifest.consumed, worked_examples: [{ id: 'WE-1', slides: ['## 实例一'] }] } })
    r = py([manifestValidator, '--manifest', 'presentation-manifest.json', '--handoff', handoffPath], { cwd: dir })
    assert.equal(r.status, 0, r.stderr)

    // 3: deferred without reason → fail; with reason → pass
    write({ ...manifest, consumed: { ...manifest.consumed, worked_examples: [{ id: 'WE-1', disposition: 'appendix', slides: [] }] } })
    r = py([manifestValidator, '--manifest', 'presentation-manifest.json', '--handoff', handoffPath], { cwd: dir })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /appendix requires a recorded reason/)
    write({ ...manifest, consumed: { ...manifest.consumed, worked_examples: [{ id: 'WE-1', disposition: 'appendix', slides: [], reason: 'kept for the appendix session' }] } })
    r = py([manifestValidator, '--manifest', 'presentation-manifest.json', '--handoff', handoffPath], { cwd: dir })
    assert.equal(r.status, 0, r.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

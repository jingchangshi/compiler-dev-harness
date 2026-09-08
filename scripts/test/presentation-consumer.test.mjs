/**
 * Phase T2 consumer-contract tests: the handoff-first preflight gate
 * (scripts/preflight-handoff.mjs), the presentation-manifest coverage checker
 * (skills/compiler-architecture-presentation/assets/quarto-project-template/
 * scripts/validate_manifest.py), and the non-Pass presentation regression on
 * the committed Dogfood B artifacts.
 *
 * The preflight tests refresh provenance into a temp git repo so they are
 * deterministic regardless of the target compiler repository's future state.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundleA = join(repoRoot, 'analysis', 'explanations', '2026-09-08-mergevecscope-pass')
const projectB = join(repoRoot, 'analysis', 'presentations', '2026-09-08-memref-alias-state-class')
const { preflightHandoff } = await import('../../scripts/preflight-handoff.mjs')
const manifestValidator = join(repoRoot, 'skills', 'compiler-architecture-presentation', 'assets', 'quarto-project-template', 'scripts', 'validate_manifest.py')

const sha = (data) => createHash('sha256').update(data).digest('hex')

/** Copy the committed dogfood A bundle, refreshing provenance against a temp
 * git repo so freshness is deterministic. */
function freshTempBundle(dir) {
  mkdirSync(dir, { recursive: true })
  for (const f of ['subject.json', 'evidence.json', 'dossier.json', 'handoff.json', 'readiness.json']) {
    copyFileSync(join(bundleA, f), join(dir, f))
  }
  // temp git repo holding the analyzed source files at matching hashes
  const repo = mkdtempSync(join(tmpdir(), 't2-repo-'))
  const src = join(repo, 'bishengir', 'lib', 'x.cpp')
  mkdirSync(dirname(src), { recursive: true })
  writeFileSync(src, 'int merge_pair(void) { return 1; }\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'src'], { cwd: repo })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
  const subject = JSON.parse(readFileSync(join(dir, 'subject.json'), 'utf8'))
  subject.provenance = {
    repository: repo, repository_path: repo, branch: 'main', head,
    analyzed_at: new Date().toISOString(),
    source_files: [{ path: 'bishengir/lib/x.cpp', sha256: sha(readFileSync(src)) }],
  }
  writeFileSync(join(dir, 'subject.json'), JSON.stringify(subject, null, 2))
  return { dir, repo, head, src }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Consumer contract (preflight)
// ─────────────────────────────────────────────────────────────────────────────

test('preflight: READY + FRESH handoff is CONSUMABLE and carries the digest', () => {
  const t = mkdtempSync(join(tmpdir(), 't2-preflight-'))
  try {
    const { dir } = freshTempBundle(join(t, 'bundle'))
    const out = preflightHandoff(dir, { subjectId: 'mergevecscope-pass' })
    assert.equal(out.verdict, 'CONSUMABLE', JSON.stringify(out.reasons))
    assert.equal(out.readiness.verdict, 'ready')
    assert.ok(out.digest.storyline.length >= 7)
    assert.ok(out.digest.must_have_visuals.includes('V1'))
    assert.ok(out.digest.evidence_index.length > 0)
    assert.match(out.handoff_sha256, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('preflight: NOT_READY bundle refuses handoff-first consumption', () => {
  const t = mkdtempSync(join(tmpdir(), 't2-notready-'))
  try {
    const { dir } = freshTempBundle(join(t, 'bundle'))
    rmSync(join(dir, 'readiness.json'))
    const out = preflightHandoff(dir)
    assert.equal(out.verdict, 'NOT_CONSUMABLE')
    assert.ok(out.reasons.some((r) => r.includes('semantic review missing')))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('preflight: STALE bundle refuses with STALE_PRESENTATION_INPUT', () => {
  const t = mkdtempSync(join(tmpdir(), 't2-stale-'))
  try {
    const { dir, repo } = freshTempBundle(join(t, 'bundle'))
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'drift'], { cwd: repo })
    const out = preflightHandoff(dir)
    assert.equal(out.verdict, 'STALE_PRESENTATION_INPUT')
    assert.ok(out.reasons.some((r) => r.includes('refresh the explanation bundle')))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('preflight: unsupported handoff schema version fails clearly', () => {
  const t = mkdtempSync(join(tmpdir(), 't2-schema-'))
  try {
    const { dir } = freshTempBundle(join(t, 'bundle'))
    const h = JSON.parse(readFileSync(join(dir, 'handoff.json'), 'utf8'))
    h.schema_version = 99
    writeFileSync(join(dir, 'handoff.json'), JSON.stringify(h, null, 2))
    const out = preflightHandoff(dir)
    assert.equal(out.verdict, 'UNSUPPORTED_SCHEMA')
    assert.ok(out.reasons[0].includes('not supported'))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

test('preflight: subject id mismatch refuses', () => {
  const t = mkdtempSync(join(tmpdir(), 't2-id-'))
  try {
    const { dir } = freshTempBundle(join(t, 'bundle'))
    const out = preflightHandoff(dir, { subjectId: 'some-other-subject' })
    assert.equal(out.verdict, 'NOT_CONSUMABLE')
    assert.ok(out.reasons.some((r) => r.includes('subject id mismatch')))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// B/C/D. Story coverage, visual coverage, evidence traceability (manifest)
// ─────────────────────────────────────────────────────────────────────────────

const hasPython = spawnSync('python3', ['--version']).status === 0

function makeProject(dir, { manifest, handoff, storyline, qmd, assets }) {
  mkdirSync(join(dir, 'diagrams'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(manifestValidator, join(dir, 'scripts', 'validate_manifest.py'))
  writeFileSync(join(dir, 'slides.qmd'), qmd)
  if (handoff) {
    writeFileSync(join(dir, 'handoff.json'), JSON.stringify(handoff, null, 2))
    manifest.input.handoff_sha256 = sha(readFileSync(join(dir, 'handoff.json')))
  }
  for (const a of assets) writeFileSync(join(dir, a), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dir, 'presentation-manifest.json'), JSON.stringify(manifest, null, 2))
}

function baseManifest() {
  return {
    artifact: 'presentation_manifest',
    schema_version: 1,
    input: { bundle_id: 'b', subject_id: 's', subject_type: 'pass', handoff_schema_version: 1,
      handoff_sha256: sha('handoff'), dossier_sha256: sha('d'), source_head: 'a'.repeat(40),
      readiness_verdict: 'ready', preflight: 'CONSUMABLE' },
    consumed: {
      storyline: [
        { position: 1, role: 'r1', disposition: 'consumed', slides: ['S1'] },
        { position: 2, role: 'r2', disposition: 'consumed', slides: ['S2'] },
      ],
      must_have_visuals: [{ id: 'V1', assets: ['diagrams/V1.svg'], slides: ['S1'] }],
      optional_visuals: [{ id: 'V2', used: false }],
      key_takeaways: ['S2'],
      evidence_ids: ['EV-001'],
      canonical_example: { summary: 'x', slide: 'S1' },
    },
    adaptations: [],
    generated: { qmd: 'slides.qmd', diagrams: ['diagrams/V1.svg'], rendered: null },
  }
}

const baseHandoff = {
  artifact: 'presentation_handoff', schema_version: 1, subject_id: 's', subject_type: 'pass',
  storyline: [{ position: 1, role: 'r1', claim: 'c1' }, { position: 2, role: 'r2', claim: 'c2' }],
  visuals: [{ id: 'V1', kind: 'pipeline', title: 't' }, { id: 'V2', kind: 'flowchart', title: 'u' }],
  must_have_visuals: ['V1'], optional_visuals: ['V2'],
  evidence_index: [{ id: 'EV-001', statement: 'x', class: 'source_fact' }],
}

function runValidator(dir, extra = []) {
  return spawnSync('python3', [join(dir, 'scripts', 'validate_manifest.py'),
    '--manifest', join(dir, 'presentation-manifest.json'), ...extra], { encoding: 'utf8', cwd: dir })
}

test('manifest validator: fully covered manifest passes, optional visual may be absent', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-ok-'))
  try {
    makeProject(dir, {
      manifest: baseManifest(),
      handoff: baseHandoff,
      qmd: '## S1\n\n## S2\n',
      assets: ['diagrams/V1.svg'],
    })
    const r = runValidator(dir, ['--handoff', join(dir, 'handoff.json')])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes('2 storyline entries'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manifest validator: silently dropped storyline step fails', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-drop-'))
  try {
    const m = baseManifest()
    m.consumed.storyline = m.consumed.storyline.slice(0, 1) // step 2 disappears
    makeProject(dir, { manifest: m, handoff: baseHandoff, qmd: '## S1\n', assets: ['diagrams/V1.svg'] })
    const r = runValidator(dir, ['--handoff', join(dir, 'handoff.json')])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('silently dropped'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manifest validator: appendix/omission requires a recorded reason', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-appendix-'))
  try {
    const m = baseManifest()
    m.consumed.storyline[1] = { position: 2, role: 'r2', disposition: 'appendix', slides: [] } // no reason
    makeProject(dir, { manifest: m, handoff: baseHandoff, qmd: '## S1\n', assets: ['diagrams/V1.svg'] })
    const r = runValidator(dir)
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('appendix requires a recorded reason'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manifest validator: unmapped must-have visual fails; optional absent passes', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-visual-'))
  try {
    const m = baseManifest()
    m.consumed.must_have_visuals = [] // V1 unmapped
    makeProject(dir, { manifest: m, handoff: baseHandoff, qmd: '## S1\n\n## S2\n', assets: [] })
    const r = runValidator(dir, ['--handoff', join(dir, 'handoff.json')])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('must-have visual V1 has no mapping'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manifest validator: manifest evidence ids must exist in the handoff evidence index', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-evidence-'))
  try {
    const m = baseManifest()
    m.consumed.evidence_ids = ['EV-999']
    makeProject(dir, { manifest: m, handoff: baseHandoff, qmd: '## S1\n\n## S2\n', assets: ['diagrams/V1.svg'] })
    const r = runValidator(dir, ['--handoff', join(dir, 'handoff.json')])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('EV-999 not in handoff evidence_index'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manifest validator: recorded handoff hash mismatch fails', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-hash-'))
  try {
    const m = baseManifest()
    makeProject(dir, { manifest: m, handoff: baseHandoff, qmd: '## S1\n\n## S2\n', assets: ['diagrams/V1.svg'] })
    // corrupt the recorded hash AFTER generation, as a tampered manifest would be
    m.input.handoff_sha256 = 'f'.repeat(64)
    writeFileSync(join(dir, 'presentation-manifest.json'), JSON.stringify(m, null, 2))
    const r = runValidator(dir, ['--handoff', join(dir, 'handoff.json')])
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('handoff_sha256 does not match'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manifest validator: unsupported manifest schema version fails clearly', { skip: hasPython ? false : 'python3 unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't2-manifest-schema-'))
  try {
    const m = baseManifest()
    m.schema_version = 2
    makeProject(dir, { manifest: m, handoff: baseHandoff, qmd: '## S1\n\n## S2\n', assets: ['diagrams/V1.svg'] })
    const r = runValidator(dir)
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('unsupported manifest schema_version'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// E. Non-Pass regression on the committed Dogfood B presentation
// ─────────────────────────────────────────────────────────────────────────────

test('non-Pass presentation carries no fabricated pass sections', () => {
  const qmd = readFileSync(join(projectB, 'slides.qmd'), 'utf8')
  for (const banned of ['## Pipeline', 'IR Before', 'IR 前后', '## Legality', '合法性门', 'Before/After IR']) {
    assert.ok(!qmd.includes(banned), `non-Pass deck must not contain forced section: ${banned}`)
  }
  for (const expected of ['它是什么：memref 值上的并查集', '生命周期与所有权', '状态演化：seed → 合并 → 查询', '边界']) {
    assert.ok(qmd.includes(expected), `class deck should be class-shaped: missing ${expected}`)
  }
  const manifest = JSON.parse(readFileSync(join(projectB, 'presentation-manifest.json'), 'utf8'))
  assert.equal(manifest.input.subject_type, 'class')
  const handoff = JSON.parse(readFileSync(join(projectB.replace('presentations', 'explanations'), 'handoff.json'), 'utf8'))
  for (const step of handoff.storyline) {
    assert.ok(!['pipeline-position', 'ir-before-after', 'legality'].includes(step.role), 'storyline roles must not be pass-fallback roles')
  }
})

test('committed dogfood A presentation manifest covers its handoff (structural)', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'analysis', 'presentations', '2026-09-08-mergevecscope-pass', 'presentation-manifest.json'), 'utf8'))
  const handoff = JSON.parse(readFileSync(join(bundleA, 'handoff.json'), 'utf8'))
  const covered = new Set(manifest.consumed.storyline.map((s) => s.position))
  for (const s of handoff.storyline) {
    assert.ok(covered.has(s.position ?? handoff.storyline.indexOf(s) + 1), `step ${s.role} uncovered`)
  }
  const mapped = new Set(manifest.consumed.must_have_visuals.map((v) => v.id))
  for (const id of handoff.must_have_visuals) assert.ok(mapped.has(id), `must-have ${id} unmapped`)
  const indexIds = new Set(handoff.evidence_index.map((e) => e.id))
  for (const eid of manifest.consumed.evidence_ids) assert.ok(indexIds.has(eid), `${eid} not in handoff evidence index`)
  assert.ok(existsSync(join(repoRoot, 'analysis', 'presentations', '2026-09-08-mergevecscope-pass', 'diagrams', 'V1.svg')))
})

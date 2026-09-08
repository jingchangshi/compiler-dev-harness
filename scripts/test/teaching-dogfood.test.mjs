/**
 * Dogfood regression for the Teaching Artifact Protocol: asserts the semantic
 * structure of the committed explanation bundles under analysis/explanations/
 * (never markdown snapshots) and mechanically checks that the generic layer
 * stayed subject-agnostic.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBundle, computeReadiness } from '../../scripts/teaching-schema.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const explanations = join(repoRoot, 'analysis', 'explanations')
const caseA = join(explanations, '2026-09-08-mergevecscope-pass')
const caseB = join(explanations, '2026-09-08-memref-alias-state-class')

function loadBundle(dir) {
  const bundle = {}
  for (const file of ['subject.json', 'evidence.json', 'dossier.json', 'handoff.json', 'readiness.json']) {
    const path = join(dir, file)
    if (existsSync(path)) bundle[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(path, 'utf8'))
  }
  return bundle
}

// ─────────────────────────────────────────────────────────────────────────────
// Case A — complex pass (MergeVecScope), presentation depth
// ─────────────────────────────────────────────────────────────────────────────

test('dogfood A bundle is schema-valid and READY', () => {
  const bundle = loadBundle(caseA)
  const { errors } = validateBundle(bundle)
  assert.deepEqual(errors, [])
  const { verdict } = computeReadiness(bundle, { depth: 'presentation' })
  assert.equal(verdict, 'ready', JSON.stringify(bundle.readiness?.reasons))
})

test('dogfood A: fact/reasoning separation is actually exercised', () => {
  const classes = new Set(bundleA().evidence.records.map((r) => r.class))
  for (const c of ['source_fact', 'graph_fact', 'runtime_fact', 'historical_fact', 'reasoning']) {
    assert.ok(classes.has(c), `evidence ledger should contain ${c}`)
  }
  // reasoning entries are distinct from fact entries and never cited where facts are required
  const ledger = bundleA().evidence.records
  const byId = new Map(ledger.map((r) => [r.id, r]))
  for (const stage of bundleA().dossier.mechanism.stages) {
    assert.ok(stage.evidence_refs.some((id) => byId.get(id).class !== 'reasoning'), 'mechanism stages must rest on non-reasoning evidence')
  }
})

test('dogfood A: mechanism is source-derived, not source-order narration', () => {
  const stages = bundleA().dossier.mechanism.stages
  assert.ok(stages.length >= 7)
  assert.ok(stages.every((s) => s.where && /MergeVecScope\.cpp:\d+/.test(s.where)), 'stages carry file:line provenance')
  assert.ok(stages.some((s) => s.evidence_refs.includes('EV-015') || s.evidence_refs.includes('EV-016')))
})

test('dogfood A: two real strategies with a comparison; handoff storyline is adaptive', () => {
  const d = bundleA().dossier
  assert.equal(d.strategies.length, 2)
  assert.equal(d.comparisons.length, 1)
  const roles = bundleA().handoff.storyline.map((s) => s.role)
  assert.ok(roles.length >= 7 && new Set(roles).size === roles.length, 'storyline roles are distinct and adaptive')
  // every storyline step carries evidence
  assert.ok(bundleA().handoff.storyline.every((s) => (s.evidence_refs || []).length > 0))
})

test('dogfood A: pipeline placement and legality live ONLY in the pass extension', () => {
  const d = bundleA().dossier
  assert.equal(d.extensions.pass.pipeline_placements.length, 2)
  assert.ok(typeof d.extensions.pass.legality === 'string' && d.extensions.pass.legality.length > 0)
  assert.ok(typeof d.extensions.pass.rewrite === 'string' && d.extensions.pass.rewrite.length > 0)
  // no pass-specific keys leaked into the common core
  for (const banned of ['pipeline_position', 'legality', 'before_ir', 'after_ir', 'pass_option']) {
    assert.equal(banned in d, false, `${banned} must not be a core field`)
  }
})

test('dogfood A: canonical example provenance is an executed test; runtime facts cite the binary', () => {
  const d = bundleA().dossier
  assert.equal(d.canonical_example.provenance.kind, 'test')
  const exec = bundleA().evidence.records.filter((r) => r.class === 'runtime_fact')
  assert.ok(exec.length >= 2 && exec.every((r) => r.tool === 'bishengir-opt'))
})

// ─────────────────────────────────────────────────────────────────────────────
// Case B — structurally different subject (analysis state class), standard depth
// ─────────────────────────────────────────────────────────────────────────────

function bundleA() { return loadBundle(caseA) }

test('dogfood B bundle is schema-valid and READY (upgraded to presentation depth with a handoff in T2)', () => {
  const bundle = loadBundle(caseB)
  assert.ok(bundle.handoff, 'T2 upgraded bundle B to presentation depth: handoff.json must exist')
  assert.equal(bundle.dossier.depth, 'presentation')
  const { errors } = validateBundle(bundle)
  assert.deepEqual(errors, [])
  const { verdict } = computeReadiness(bundle, { depth: 'presentation' })
  assert.equal(verdict, 'ready', JSON.stringify(bundle.readiness?.reasons))
})

test('dogfood B: same common core, class extension only, no pass concepts', () => {
  const d = loadBundle(caseB).dossier
  assert.equal(d.subject_type, 'class')
  assert.deepEqual(Object.keys(d.extensions), ['class'])
  assert.ok(d.extensions.class.lifecycle && d.extensions.class.owned_state && d.extensions.class.public_api)
  for (const banned of ['pipeline_placements', 'ir_contract', 'legality', 'rewrite']) {
    assert.equal(banned in d.extensions, false)
  }
  // strategies absent: the class has no real multi-path story (fabrication forbidden)
  assert.equal(d.strategies, undefined)
  assert.equal(d.comparisons, undefined)
})

test('dogfood B: state transitions are real (union-find) and the reconstructed example is labeled', () => {
  const d = loadBundle(caseB).dossier
  assert.equal(d.mechanism.mutable_state, true)
  assert.ok(d.state_transitions.length >= 2)
  assert.equal(d.canonical_example.provenance.kind, 'reconstructed')
  assert.ok(d.canonical_example.provenance.source.includes('RECONSTRUCTED'))
})

// ─────────────────────────────────────────────────────────────────────────────
// Anti-overfitting: the generic layer must be subject-agnostic
// ─────────────────────────────────────────────────────────────────────────────

test('generic layer source contains no subject-specific concepts', () => {
  const genericSources = [
    join(repoRoot, 'scripts', 'teaching-schema.mjs'),
    // T3 composition layer: composition schema + compose driver
    join(repoRoot, 'scripts', 'composition-schema.mjs'),
    join(repoRoot, 'compiler-compose-driver.mjs'),
    join(repoRoot, 'compiler-explain-driver.mjs'),
    join(repoRoot, 'compiler-explain-v2.cjs'),
    // T2 consumer layer: preflight gate + presentation-side tooling
    join(repoRoot, 'scripts', 'preflight-handoff.mjs'),
    join(repoRoot, 'skills', 'compiler-architecture-presentation', 'scripts', 'spec_to_diagram.py'),
    join(repoRoot, 'skills', 'compiler-architecture-presentation', 'assets', 'quarto-project-template', 'scripts', 'validate_manifest.py'),
    join(repoRoot, 'skills', 'compiler-architecture-presentation', 'assets', 'quarto-project-template', 'scripts', 'check_project.py'),
    join(repoRoot, 'skills', 'compiler-architecture-presentation', 'SKILL.md'),
  ]
  const banned = /MergeVecScope|AutoVectorizeV2|FlattenOps|RegBase|HFusion|HIVM|tryMerge|mergeLevel|bufferiz/i
  for (const file of genericSources) {
    const source = readFileSync(file, 'utf8')
    assert.equal(banned.test(source), false, `${file} contains subject-specific content`)
  }
})

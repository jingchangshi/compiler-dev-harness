/**
 * Phase R1.5 tests: honest experimental rollout semantics, the
 * discovery-after-inspect measurement, first-class context-stream aggregation,
 * bundle export of context evidence, and the offline evaluation surface.
 *
 * All fixtures are synthetic; no real Ripwire installation or production
 * session is required.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBackendPolicy } from '../../compiler-context-backend.mjs'
import { inspectCompilerRepository } from '../../compiler-inspect-driver.mjs'
import { analyzeRecords, formatReport } from '../analyze-session.mjs'
import { aggregate } from '../summarize-feedback.mjs'
import { evaluate } from '../evaluate-context-backend.mjs'

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url))

// ── session-log helpers (synthetic records in the analyzer's format) ───────

let nextTime = 1730000000000
const seqTime = (seq) => nextTime + seq

function toolCall(seq, name, args, callId) {
  return { type: 'tool/call', seq, time: seqTime(seq), data: { turn: 1, step: seq, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }
}

function toolResult(seq, callId, text) {
  return {
    type: 'tool/result', seq, time: seqTime(seq),
    data: { turn: 1, step: seq, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } },
  }
}

const SESSION_HEADER = { type: 'session', data: { id: 'session-r15-test', agentPreset: 'compiler-dev' } }

const ROUTE_ARGS = { route: 'pass-review', knowledge_expected: true, confidence: 'high', reason: 'named-pass' }
const ROUTE_RESULT_TEXT = '{"correlation_id":"kr15test00000001","route":"pass-review","knowledge_expected":true,"logged":true}'

function ripwireResultText() {
  return [
    'Repository: /repo (main; clean)',
    'Anchors: files=none; symbols=FooPass',
    'Context backend: ripwire (fallback: none) | weak=false ambiguous=0 truncated=false counts_floor=false',
    '',
    'Source context (Ripwire generic retrieval/ranking evidence — approximate 1-hop, name-based; NOT an mlir-repomap semantic fact):',
    '- Ranked #1 FooPass @ src/a.cpp:42 — struct FooPass',
  ].join('\n')
}

function legacyFallbackResultText() {
  return [
    'Repository: /repo (main; clean)',
    'Context backend: legacy-rg (fallback: ripwire-not-found) | weak=true ambiguous=0 truncated=false counts_floor=false',
    'Definitions:\n- src/a.cpp:42: struct FooPass',
  ].join('\n')
}

const bundleRecords = (entries) => [SESSION_HEADER, ...entries]

// ── rollout semantics (Workstream A) ───────────────────────────────────────

test('rollout: explicit input overrides the environment override', () => {
  const env = { COMPILER_INSPECT_BACKEND: 'ripwire' }
  assert.equal(resolveBackendPolicy({ backend: 'legacy' }, env).policy, 'legacy')
  assert.equal(resolveBackendPolicy({ backend: 'legacy' }, env).source, 'input')
})

test('rollout: environment override applies when no input is given', () => {
  assert.equal(resolveBackendPolicy({}, { COMPILER_INSPECT_BACKEND: 'ripwire' }).source, 'env')
  assert.equal(resolveBackendPolicy({}, { COMPILER_INSPECT_BACKEND: 'auto' }).policy, 'auto')
})

test('rollout: the repository default stays legacy while Ripwire is experimental', () => {
  const policy = resolveBackendPolicy({}, {})
  assert.equal(policy.policy, 'legacy')
  assert.equal(policy.source, 'repository-default')
})

test('rollout: backend choice is visible in the result and the rendered bundle', { skip: !execFileSync('which', ['git']).toString().trim() || !execFileSync('which', ['rg']).toString().trim() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'r15-rollout-'))
  try {
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'a.cpp'), 'struct FooPass { void runOnOperation(); };\n')
    execFileSync('git', ['init', '-q'], { cwd: root })
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'] }, undefined, { env: { ...process.env } })
    assert.equal(bundle.backend, 'legacy-rg')
    assert.equal(bundle.fallback, false)
    assert.equal(bundle.fallback_reason, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── analyzer: discovery-after-inspect (Workstream C) ───────────────────────

test('analyzer: verification read after a ripwire inspect result is attributed by ordering', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', ripwireResultText()),
    toolCall(5, 'bash', { command: "sed -n '40,50p' src/a.cpp" }, 'b1'),
  ])
  const analysis = analyzeRecords(records)
  assert.equal(analysis.searchClassification.verificationAfterInspect, 1)
  assert.equal(analysis.searchClassification.discoveryAfterInspect, 0)
  assert.deepEqual(analysis.searchAfterInspectByBackend, { ripwire: { discovery: 0, verification: 1 } })
  const group = analysis.routeGroups[0]
  assert.equal(group.inspectCalls, 1)
  assert.equal(group.inspectBackends.ripwire, 1)
  assert.equal(group.firstInspectStep, 3)
  assert.equal(group.verificationAfterInspect, 1)
  assert.equal(group.discoveryAfterInspect, 0)
})

test('analyzer: discovery search after an inspect result is counted, never judged', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', ripwireResultText()),
    toolCall(5, 'bash', { command: 'rg missing_symbol_name' }, 'b1'),
  ])
  const analysis = analyzeRecords(records)
  assert.equal(analysis.searchClassification.discoveryAfterInspect, 1)
  assert.deepEqual(analysis.searchAfterInspectByBackend, { ripwire: { discovery: 1, verification: 0 } })
  assert.equal(analysis.routeGroups[0].discoveryAfterInspect, 1)
})

test('analyzer: discovery BEFORE inspect is not attributed to the backend', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'bash', { command: 'rg missing_symbol_name' }, 'b1'),
    toolCall(4, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(5, 'i1', ripwireResultText()),
  ])
  const analysis = analyzeRecords(records)
  assert.equal(analysis.searchClassification.discoverySearches, 1)
  assert.equal(analysis.searchClassification.discoveryAfterInspect, 0)
  assert.deepEqual(analysis.searchAfterInspectByBackend, {})
})

test('analyzer: knowledge and inspect land in the same route group', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_knowledge', { command: 'review', name: 'MergeVecScopePass' }, 'k1'),
    toolResult(4, 'k1', '{"command":"review","index":{"stale":false},"result":{"pass":{"id":"pass:hfusion-merge-vf"}},"delivery":{"correlation_id":"kr15test00000001"}}'),
    toolCall(5, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(6, 'i1', ripwireResultText()),
  ])
  const analysis = analyzeRecords(records)
  const group = analysis.routeGroups[0]
  assert.equal(group.knowledgeCalls, 1)
  assert.equal(group.inspectCalls, 1)
  assert.equal(group.inspectBackends.ripwire, 1)
})

test('analyzer: multiple inspect calls in one route aggregate per backend', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', ripwireResultText()),
    toolCall(5, 'compiler_inspect', { symbols: ['FooPass'] }, 'i2'),
    toolResult(6, 'i2', legacyFallbackResultText()),
  ])
  const analysis = analyzeRecords(records)
  const group = analysis.routeGroups[0]
  assert.equal(group.inspectCalls, 2)
  assert.deepEqual(group.inspectBackends, { ripwire: 1, 'legacy-rg': 1 })
  assert.deepEqual(group.inspectFallbacks, { 'ripwire-not-found': 1 })
  assert.equal(group.inspectWeakResults, 1)
})

test('analyzer: fallback and weak results stay visible per group and session', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', legacyFallbackResultText()),
  ])
  const analysis = analyzeRecords(records)
  assert.deepEqual(analysis.inspectBackends, { 'legacy-rg': 1 })
  assert.deepEqual(analysis.inspectFallbacks, { 'ripwire-not-found': 1 })
  assert.equal(analysis.inspectWeakResults, 1)
  assert.equal(analysis.routeGroups[0].inspectWeakResults, 1)
})

test('analyzer: historical sessions without backend metadata stay zero/unknown', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(2, 'i1', 'Repository: /repo (main; clean)\nDefinitions:\n- src/a.cpp:1: struct FooPass\nBudget: 12 items/section'),
  ])
  const analysis = analyzeRecords(records)
  assert.equal(analysis.compilerInspectCalls, 1)
  assert.deepEqual(analysis.inspectBackends, {}, 'no Context backend line means no invented metrics')
  assert.equal(analysis.inspectTruncatedResults, 0)
})

test('analyzer: an inspect call before any route declaration is uncorrelated, honestly', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(2, 'i1', ripwireResultText()),
    toolCall(3, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(4, 'r1', ROUTE_RESULT_TEXT),
    toolCall(5, 'bash', { command: 'rg missing_symbol_name' }, 'b1'),
  ])
  const analysis = analyzeRecords(records)
  const group = analysis.routeGroups[0]
  assert.equal(group.inspectCalls, 0, 'the inspect call predates the route window')
  assert.equal(group.discoveryAfterInspect, 0, 'no inspect result inside the window means no attribution')
  assert.equal(analysis.searchAfterInspectByBackend, undefined === analysis.searchAfterInspectByBackend ? undefined : analysis.searchAfterInspectByBackend)
  assert.deepEqual(analysis.searchAfterInspectByBackend, {})
})

test('analyzer: uncertain searches never enter the after-inspect counters', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', ripwireResultText()),
    toolCall(5, 'bash', { command: 'grep x build/out.log' }, 'b1'),
  ])
  const analysis = analyzeRecords(records)
  assert.equal(analysis.searchClassification.uncertain, 1)
  assert.equal(analysis.searchClassification.discoveryAfterInspect, 0)
  assert.equal(analysis.searchClassification.verificationAfterInspect, 0)
  assert.deepEqual(analysis.searchAfterInspectByBackend, {})
})

test('analyzer: report renders the after-inspect lines', () => {
  const records = bundleRecords([
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', ripwireResultText()),
    toolCall(5, 'bash', { command: 'rg missing_symbol_name' }, 'b1'),
  ])
  const report = formatReport(analyzeRecords(records))
  assert.match(report, /after inspect: 1/)
  assert.match(report, /after-inspect by backend \(ordering, not causality\): ripwire: discovery 1, verification 0/)
})

// ── context stream aggregation (Workstream D) ──────────────────────────────

const CONTEXT_LINES = [
  JSON.stringify({ ts: '2026-09-08T10:00:00.000Z', correlation_id: 'kctx000000000001', backend_policy: 'auto', provider: 'ripwire', mode: 'pack-task', duration_ms: 2400, result_chars: 8000, truncated: true, weak: false, fallback: false, fallback_reason: null, repo: 'AscendNPU-IR', file_count: 1, symbol_count: 3, ranked_symbols: 6, bodies: 3, tests: 0, outside_corpus: 1 }),
  JSON.stringify({ ts: '2026-09-08T10:01:00.000Z', correlation_id: 'kctx000000000001', backend_policy: 'auto', provider: 'legacy-rg', mode: 'legacy', duration_ms: 1400, result_chars: 5000, truncated: false, weak: true, fallback: true, fallback_reason: 'ripwire-weak-result', repo: 'AscendNPU-IR', file_count: 1, symbol_count: 3 }),
  'not json at all',
  JSON.stringify({ ts: '2026-09-01T10:00:00.000Z', correlation_id: 'kctx000000000001', backend_policy: 'auto', provider: 'ripwire', mode: 'pack-task', duration_ms: 9000, result_chars: 9000, truncated: false, weak: false, fallback: false, fallback_reason: null, repo: 'AscendNPU-IR' }),
].join('\n')

function makeContextDir(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'r15-context-'))
  writeFileSync(join(dir, '2026-09-08.jsonl'), `${lines}\n`)
  return dir
}

test('summary: context stream aggregates into counts only, tolerating malformed lines', () => {
  const dir = makeContextDir(CONTEXT_LINES)
  try {
    const summary = aggregate({ contextDir: dir })
    assert.equal(summary.context.total, 3, 'the malformed line is skipped, not fatal')
    assert.deepEqual(summary.context.by_provider, { ripwire: 2, 'legacy-rg': 1 })
    assert.equal(summary.context.fallbacks, 1)
    assert.deepEqual(summary.context.fallback_reasons, { 'ripwire-weak-result': 1 })
    assert.equal(summary.context.weak, 1)
    assert.equal(summary.context.truncated, 1)
    assert.equal(summary.context.outside_corpus, 1)
    assert.equal(summary.context.total_duration_ms, 2400 + 1400 + 9000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summary: --since filters context records by their ts prefix', () => {
  const dir = makeContextDir(CONTEXT_LINES)
  try {
    const summary = aggregate({ contextDir: dir, since: '2026-09-08' })
    assert.equal(summary.context.total, 2)
    assert.equal(summary.context.total_duration_ms, 2400 + 1400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── bundle export (Workstream E) ───────────────────────────────────────────

test('bundle: context summary is exported, the raw stream is not, and privacy stays fail-closed', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'r15-bundle-'))
  try {
    mkdirSync(join(workspace, 'context'), { recursive: true })
    writeFileSync(join(workspace, 'context', '2026-09-08.jsonl'), CONTEXT_LINES)
    process.env.COMPILER_DEV_FEEDBACK_DIR = workspace
    const output = join(workspace, 'bundle.tar.gz')
    execFileSync(process.execPath, [join(SCRIPTS, 'export-feedback-bundle.mjs'), '--since', '2026-09-08', '--output', output], { encoding: 'utf8' })
    const listing = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' })
    assert.ok(listing.includes('./context-summary.json'), 'the counts-only context summary ships')
    assert.equal(listing.includes('context/2026-09-08.jsonl'), false, 'the raw context stream never ships')
    const extracted = join(workspace, 'extracted')
    mkdirSync(extracted, { recursive: true })
    execFileSync('tar', ['-xzf', output, '-C', extracted])
    const contextSummary = JSON.parse(readFileSyncSafe(join(extracted, 'context-summary.json')))
    assert.equal(contextSummary.total, 2)
    assert.deepEqual(contextSummary.by_provider, { ripwire: 1, 'legacy-rg': 1 })
    assert.equal(contextSummary.fallbacks, 1)
    const manifest = JSON.parse(readFileSyncSafe(join(extracted, 'manifest.json')))
    assert.ok(manifest.contents.some(entry => entry.path === 'context-summary.json'), 'the manifest lists the context summary')
    assert.equal(manifest.privacy_check, 'passed (fail-closed)')
  } finally {
    delete process.env.COMPILER_DEV_FEEDBACK_DIR
    rmSync(workspace, { recursive: true, force: true })
  }
})

function readFileSyncSafe(path) {
  return readFileSync(path, 'utf8')
}

// ── evaluation surface (Workstream F) ──────────────────────────────────────

test('evaluation: compares observed providers with objective counts and no decision', () => {
  const dir = makeContextDir(CONTEXT_LINES)
  const sessionPath = join(dir, 'fake-session.jsonl')
  writeFileSync(sessionPath, `${JSON.stringify(SESSION_HEADER)}\n${[
    toolCall(1, 'compiler_route', ROUTE_ARGS, 'r1'),
    toolResult(2, 'r1', ROUTE_RESULT_TEXT),
    toolCall(3, 'compiler_inspect', { symbols: ['FooPass'] }, 'i1'),
    toolResult(4, 'i1', ripwireResultText()),
    toolCall(5, 'bash', { command: 'rg missing_symbol_name' }, 'b1'),
    toolCall(6, 'edit', {}, 'e1'),
  ].map(record => JSON.stringify(record)).join('\n')}\n`)
  try {
    const report = evaluate({ sessionPaths: [sessionPath], contextDir: dir })
    assert.match(report.scope.note, /not controlled experiments/)
    assert.match(report.scope.note, /never imply/)
    assert.equal(report.scope.paired_comparison.includes('not implemented'), true)
    const ripwire = report.observation.by_provider.ripwire
    assert.equal(ripwire.calls, 2)
    assert.equal(ripwire.fallback_rate, 0)
    assert.equal(ripwire.truncated_rate, 0.5)
    assert.ok(report.observation.by_provider['legacy-rg'].weak_rate === 1)
    assert.equal(report.adoption.inspect_calls, 1)
    assert.equal(report.adoption.searches_after_inspect.discovery, 1)
    assert.deepEqual(report.adoption.search_by_backend, { ripwire: { discovery: 1, verification: 0 } })
    assert.equal(report.adoption.tasks_with_inspect, 1)
    assert.equal(report.adoption.tasks_with_inspect_and_zero_discovery_after, 0)
    assert.equal(JSON.stringify(report).includes('promote'), false, 'no decision language in the report')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

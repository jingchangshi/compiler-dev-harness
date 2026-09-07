/**
 * Focused tests for the offline session analyzer, run with the Node test
 * runner: `node --test scripts/test/`. Fixtures are small synthetic JSONL
 * logs; the zstd case compresses in-memory so no binary fixture is stored.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { analyzeRecords, classifySearchCommand, extractPointers, formatReport, loadRecords, parseRecords } from '../analyze-session.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))

const fullRecords = parseRecords(loadRecords(`${FIXTURE_DIR}full-session.jsonl`))

test('parseRecords keeps session events and drops malformed lines', () => {
  const parsed = parseRecords(loadRecords(`${FIXTURE_DIR}minimal-session.jsonl`))
  // header + assistant/message survive; "not json at all" is skipped; the
  // unknown future event is kept as a record but ignored by analysis.
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].type, 'session')
})

test('full fixture reports the complete metric set', () => {
  const result = analyzeRecords(fullRecords)
  assert.equal(result.session.id, 'session-test-full')
  assert.equal(result.session.agentPreset, 'compiler-dev')
  assert.equal(result.provider, 'huawei-api-bundle')
  assert.equal(result.model, 'GLM-5.3-Flash')
  assert.equal(result.contextWindow, 1000000)
  assert.equal(result.humanTurns, 1, 'plugin-injected user messages are not human turns')
  assert.equal(result.modelSteps, 2)
  assert.equal(result.toolCalls, 4)
  assert.deepEqual(result.toolCallsByName, { compiler_inspect: 1, bash: 1, skill: 1, edit: 1 })
  assert.equal(result.compilerInspectCalls, 1)
  assert.equal(result.firstCompilerInspectStep, 1)
  assert.equal(result.firstEditWriteStep, 1)
  assert.equal(result.skillLoadFailures, 1)
  assert.equal(result.inputTokens, 1800)
  assert.equal(result.outputTokens, 350)
  assert.equal(result.cacheReadTokens, 110000)
  assert.equal(result.peakRequestTokens, 61300, 'input + cacheRead + cacheWrite')
  assert.equal(result.compactionStarts, 1)
  assert.equal(result.compactionEnds, 1)
  assert.equal(result.compactionErrors, 0)
})

test('tool-result accounting finds the oversized bash result', () => {
  const result = analyzeRecords(fullRecords)
  assert.equal(result.toolResultsOverLargeBytes, 1)
  assert.equal(result.largestToolResults[0].tool, 'bash')
  assert.ok(result.largestToolResults[0].bytes >= 9000)
  assert.ok(result.toolResultBytes > 9000)
  const turn1 = result.turns['1']
  assert.equal(turn1.humanMessages, 1)
  assert.equal(turn1.toolCalls, 3)
  const turn2 = result.turns['2']
  assert.equal(turn2.humanMessages, 0, 'plugin source does not count as human')
  assert.equal(turn2.toolCalls, 1)
})

test('minimal and future-event records analyze without missing-field crashes', () => {
  const parsed = parseRecords(loadRecords(`${FIXTURE_DIR}minimal-session.jsonl`))
  const result = analyzeRecords(parsed)
  assert.equal(result.session.id, 'session-test-min')
  assert.equal(result.modelSteps, 1)
  assert.equal(result.toolCalls, 0)
  assert.equal(result.inputTokens, 0)
  assert.equal(result.peakRequestTokens, 0)
  assert.equal(result.largestToolResults.length, 0)
  assert.equal(result.provider, undefined)
  assert.equal(result.firstCompilerInspectStep, undefined)
})

test('formatReport renders stable human-readable lines', () => {
  const report = formatReport(analyzeRecords(fullRecords))
  assert.match(report, /=== DSH session analysis ===/)
  assert.match(report, /session: session-test-full \(preset: compiler-dev\)/)
  assert.match(report, /model: huawei-api-bundle\/GLM-5.3-Flash \(contextWindow 1,000,000\)/)
  assert.match(report, /compiler_inspect calls: 1 \(first at step 1\)/)
  assert.match(report, /skill load failures: 1/)
  assert.match(report, /peak request context: 61,300 tokens/)
  assert.match(report, /largest tool results:/)
  assert.match(report, /per-turn: turn \| human \| steps \| toolCalls \| toolResultBytes \| tokens/)
})

test('loadRecords decodes a zstd artifact', () => {
  const plain = loadRecords(`${FIXTURE_DIR}minimal-session.jsonl`)
  const dir = mkdtempSync(join(tmpdir(), 'analyze-session-'))
  try {
    const path = join(dir, 'session.jsonl.zstd')
    writeFileSync(path, zstdCompressSync(Buffer.from(plain.join('\n'), 'utf8')))
    assert.deepEqual(parseRecords(loadRecords(path)), parseRecords(plain))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('knowledge queries are counted per command and separated from grep-like bash', () => {
  const result = analyzeRecords(parseRecords(loadRecords(`${FIXTURE_DIR}knowledge-session.jsonl`)))
  assert.equal(result.compilerKnowledgeCalls, 2)
  assert.equal(result.firstCompilerKnowledgeStep, 1)
  assert.deepEqual(result.knowledgeByCommand, { review: 1, 'finding-impact': 1 })
  assert.equal(result.bashGrepLikeCalls, 1, 'grep counts, ninja/docker build does not')
  assert.equal(result.compilerInspectCalls, 0)
  const report = formatReport(result)
  assert.match(report, /compiler_knowledge calls: 2 \(first at step 1\) \[review: 1, finding-impact: 1\]/)
  assert.match(report, /bash grep-like search calls \(heuristic\): 1/)
})

test('classifySearchCommand separates pointed verification from discovery (precision first)', () => {
  const pointed = new Set([
    'bishengir/lib/Dialect/HFusion/Transforms/MergeVecScope.cpp',
    'MergeVecScope.cpp',
  ])
  // Pointed verification reads — normal after a query returned the location.
  assert.equal(classifySearchCommand("sed -n '1390,1420p' bishengir/lib/Dialect/HFusion/Transforms/MergeVecScope.cpp", pointed).category, 'verification-read')
  assert.equal(classifySearchCommand('grep -n guard MergeVecScope.cpp', pointed).category, 'verification-read')
  // Discovery: repo-wide / unscoped searches over non-pointed sources.
  assert.equal(classifySearchCommand('rg AttrName', new Set()).category, 'discovery-search')
  assert.equal(classifySearchCommand('rg AttrName third_party/ascend/backend', new Set()).category, 'discovery-search')
  assert.equal(classifySearchCommand('grep -rn AttrName .', new Set()).category, 'discovery-search')
  // Uncertain: never judged a gap.
  assert.equal(classifySearchCommand("sed -n '10,20p' OtherFile.cpp", new Set()).category, 'uncertain')
  assert.equal(classifySearchCommand('grep -m2 foo build/build.ninja | head -2', new Set()).category, 'uncertain')
  assert.equal(classifySearchCommand('find build -name "*.o"', new Set()).category, 'uncertain')
  assert.equal(classifySearchCommand('awk -F, "{print $1}" /tmp/run.log', new Set()).category, 'uncertain')
  assert.equal(classifySearchCommand('git status --short', new Set()).category, 'uncertain', 'non-search commands are not classified')
})

test('extractPointers collects file:line pointers and JSON file keys only', () => {
  const pointers = extractPointers('guard at bishengir/lib/Conversion/HFusion/MergeVecScope.cpp:1422 moved', new Set())
  extractPointers('{"file": "lib/X/Y.cpp", "lines": "631-634"}', pointers)
  assert.ok(pointers.has('bishengir/lib/Conversion/HFusion/MergeVecScope.cpp'))
  assert.ok(pointers.has('MergeVecScope.cpp'))
  assert.ok(pointers.has('lib/X/Y.cpp'))
  assert.ok(!extractPointers('no pointers here', new Set()).size)
})

const observationRecords = parseRecords(loadRecords(`${FIXTURE_DIR}observation-session.jsonl`))

test('route metrics count declarations, kinds, expected and skips', () => {
  const result = analyzeRecords(observationRecords)
  assert.equal(result.routeDeclarations.length, 3)
  assert.equal(result.routeMetrics.tasksRouted, 3)
  assert.equal(result.routeMetrics.knowledgeExpected, 2)
  assert.equal(result.routeMetrics.knowledgeSkipped, 1)
  assert.deepEqual(result.routeMetrics.byKind, { 'pass-review': 1, 'pipeline-audit': 1, 'single-file-edit': 1 })
  assert.deepEqual(result.routeMetrics.confidence, { low: 0, medium: 0, high: 3 })
})

test('route groups correlate route decisions with knowledge calls and searches', () => {
  const result = analyzeRecords(observationRecords)
  assert.equal(result.routeGroups.length, 3)
  const [review, audit, skip] = result.routeGroups
  assert.equal(review.route, 'pass-review')
  assert.equal(review.correlationId, 'k1111111111111111')
  assert.equal(review.knowledgeCalls, 2)
  assert.deepEqual(review.knowledgeCommands, { review: 1, 'finding-impact': 1 })
  assert.equal(review.verificationReads, 1, 'pointed sed read is verification, not discovery')
  assert.equal(review.searchAfterQuery, 0)
  assert.equal(review.editStep, 5)
  assert.equal(review.operational.staleIndex, true, 'stale index reported from the result envelope')
  assert.equal(review.operational.refreshPerformed, true)
  assert.equal(review.operational.truncated, true)
  assert.deepEqual(review.operational.errorKinds, [])
  assert.equal(audit.route, 'pipeline-audit')
  assert.equal(audit.knowledgeCalls, 0)
  assert.equal(audit.discoverySearches, 1, 'unscoped rg after the route is discovery')
  assert.equal(audit.searchAfterQuery, 0, 'no knowledge query preceded it, so it is not search-after-query')
  assert.equal(skip.knowledgeExpected, false)
  assert.equal(skip.uncertainSearches, 1, 'build.ninja grep is uncertain, never a gap')
})

test('adoption and temporal metrics follow the declared routes', () => {
  const result = analyzeRecords(observationRecords)
  assert.deepEqual(result.adoption, { eligibleTasks: 2, adoptedTasks: 1, missedTasks: 1, ungroupedKnowledgeCalls: 0 })
  assert.equal(result.temporal.firstKnowledgeStep, 2)
  assert.equal(result.temporal.firstInspectStep, undefined)
  assert.equal(result.temporal.firstDiscoverySearchStep, 2)
  assert.equal(result.temporal.firstEditStep, 5)
  assert.equal(result.temporal.knowledgeBeforeSearch, true, 'knowledge query happened before any discovery search')
})

test('search classification totals stay session-wide', () => {
  const result = analyzeRecords(observationRecords)
  assert.equal(result.searchClassification.searchCalls, 3)
  assert.deepEqual(
    [result.searchClassification.discoverySearches, result.searchClassification.verificationReads, result.searchClassification.uncertain],
    [1, 1, 1],
  )
})

test('report renders the phase-2 observation lines', () => {
  const report = formatReport(analyzeRecords(observationRecords))
  assert.match(report, /route decisions: 3 \(knowledge_expected: 2, declared skips: 1\)/)
  assert.match(report, /route kinds: pass-review: 1, pipeline-audit: 1, single-file-edit: 1/)
  assert.match(report, /adoption: eligible 2, adopted 1, missed 1/)
  assert.match(report, /knowledge-before-search: yes/)
  assert.match(report, /discovery 1 \(after knowledge: 0\), verification reads 1, uncertain 1/)
})

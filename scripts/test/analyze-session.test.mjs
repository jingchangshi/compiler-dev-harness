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
import { analyzeRecords, formatReport, loadRecords, parseRecords } from '../analyze-session.mjs'

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

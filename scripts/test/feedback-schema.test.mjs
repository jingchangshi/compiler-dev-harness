/**
 * Tests for the Feedback Protocol v1/v2 validator port (scripts/feedback-schema.mjs).
 * The examples mirror mlir-compiler-harness `adapters/compiler-dev/feedback-schema.md`
 * and ADR-025; the port is kept field-for-field compatible with
 * `mlir_repomap.feedback.validate_feedback`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripRuntimeFields, validateFeedback } from '../feedback-schema.mjs'

const v1Document = {
  feedback: {
    schema_version: 1,
    created_at: '2026-09-06',
    task: { kind: 'compiler-review', target: 'pass:hfusion-merge-vf' },
    query: { command: 'review', args: { name: 'MergeVecScope' } },
    observation: 'review returned pass memory and guards; the verifier location still needed a search.',
    manual_source_search: { performed: true, reason: 'needed the verifier control-flow anchor.' },
    possible_gap: { category: 'evidence-location', statement: 'may lack a verifier location query.' },
    evidence: [{ file: 'lib/Conversion/HFusion/MergeVecScope.cpp', lines: '1422' }],
    sensitivity: { contains_sensitive_content: false },
  },
}

function v2Document(overrides = {}) {
  return {
    feedback: {
      schema_version: 2,
      created_at: '2026-09-07',
      origin: 'automatic',
      observation_kind: 'query-sufficient',
      task: {
        kind: 'compiler-review',
        target: 'pass:hfusion-merge-vf',
        classification: { confidence: 'high', source: 'heuristic' },
      },
      query: { command: 'review', args: { name: 'MergeVecScope' } },
      route: { knowledge_expected: true, kind: 'pass-review', confidence: 'high' },
      usage: { compiler_knowledge_calls: 1, knowledge_commands: { review: 1 }, discovery_search_calls: 0 },
      observation: 'single query answered the review task; no discovery search followed.',
      manual_source_search: { performed: false },
      possible_gap: null,
      evidence: [],
      sensitivity: { contains_sensitive_content: false },
      ...overrides,
    },
  }
}

test('the committed v1 corpus shape validates', () => {
  assert.deepEqual(validateFeedback(v1Document), [])
})

test('the four v2 observation kinds validate in their canonical shapes', () => {
  assert.deepEqual(validateFeedback(v2Document()), [])
  assert.deepEqual(validateFeedback(v2Document({ observation_kind: 'query-insufficient', possible_gap: { category: 'query-coverage', statement: 'discovery searches followed the queries.' } })), [])
  assert.deepEqual(validateFeedback(v2Document({ observation_kind: 'query-operational', operational: { stale_index: true, refresh_performed: true, refresh_duration_ms: 97000 } })), [])
  const missed = v2Document({
    observation_kind: 'adoption-missed',
    query: null,
    usage: { compiler_knowledge_calls: 0 },
  })
  assert.deepEqual(validateFeedback(missed), [])
})

test('adoption-missed enforces query null, knowledge_expected true, zero calls', () => {
  const withQuery = v2Document({ observation_kind: 'adoption-missed' })
  const errors = validateFeedback(withQuery)
  assert.ok(errors.some(error => error.includes('adoption-missed requires query: null')))
  const wrongExpected = v2Document({
    observation_kind: 'adoption-missed',
    query: null,
    route: { knowledge_expected: false, kind: 'other', confidence: 'high' },
    usage: { compiler_knowledge_calls: 0 },
  })
  assert.ok(validateFeedback(wrongExpected).some(error => error.includes('route.knowledge_expected=true')))
  const nonzero = v2Document({
    observation_kind: 'adoption-missed',
    query: null,
    usage: { compiler_knowledge_calls: 2 },
  })
  assert.ok(validateFeedback(nonzero).some(error => error.includes('compiler_knowledge_calls=0')))
})

test('knowledge_expected=false with zero calls is a correct skip, not an error', () => {
  const skip = v2Document({
    route: { knowledge_expected: false, kind: 'single-file-edit', confidence: 'high' },
    usage: { compiler_knowledge_calls: 0 },
  })
  assert.deepEqual(validateFeedback(skip), [])
})

test('v2 strict allowed-fields reject prompt, transcript and source text fields', () => {
  for (const key of ['prompt', 'messages', 'transcript', 'source_text']) {
    const leak = v2Document()
    leak.feedback[key] = 'leak'
    const errors = validateFeedback(leak)
    assert.ok(errors.some(error => error.includes(`unknown field: ${key}`)), key)
  }
})

test('v2 rejects bad route, usage, classification and sensitivity values', () => {
  const badConfidence = v2Document({ route: { knowledge_expected: true, kind: 'pass-review', confidence: 'certain' } })
  assert.ok(validateFeedback(badConfidence).some(error => error.includes('route.confidence')))
  const badSource = v2Document()
  badSource.feedback.task.classification.source = 'model'
  assert.ok(validateFeedback(badSource).some(error => error.includes('task.classification.source')))
  const badUsage = v2Document()
  badSource.feedback.usage.first_knowledge_step = 0
  assert.ok(validateFeedback(badUsage).some(error => error.includes('first_knowledge_step')) === false, 'usage intact')
  badUsage.feedback.usage.first_knowledge_step = 0
  assert.ok(validateFeedback(badUsage).some(error => error.includes('usage.first_knowledge_step')))
  const sensitive = v2Document()
  sensitive.feedback.sensitivity.contains_sensitive_content = true
  assert.ok(validateFeedback(sensitive).some(error => error.includes('contains_sensitive_content must be false')))
  const badCommand = v2Document({ query: { command: 'grep', args: {} } })
  assert.ok(validateFeedback(badCommand).some(error => error.includes('query.command')))
})

test('stripRuntimeFields removes non-protocol fields and keeps the artifact valid', () => {
  const dirty = v2Document()
  dirty.feedback.source_log = '/sessions/session.jsonl'
  dirty.feedback.usage.internal_note = 'extra'
  dirty.feedback.task.free_text = 'task text that must not survive'
  const stripped = stripRuntimeFields(dirty)
  assert.equal(stripped.feedback.source_log, undefined)
  assert.equal(stripped.feedback.usage.internal_note, undefined)
  assert.equal(stripped.feedback.task.free_text, undefined)
  assert.equal(stripped.feedback.observation_kind, 'query-sufficient')
  assert.deepEqual(validateFeedback(stripped), [])
})

test('documents must be a single feedback mapping with schema_version 1 or 2', () => {
  assert.ok(validateFeedback({}).length > 0)
  assert.ok(validateFeedback({ feedback: { schema_version: 3 } }).some(error => error.includes('schema_version')))
  assert.ok(validateFeedback(null).length > 0)
})

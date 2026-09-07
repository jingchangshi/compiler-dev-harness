/**
 * End-to-end tests for the offline observation loop, hermetic via
 * COMPILER_DEV_FEEDBACK_DIR: candidate generation (collect-feedback), the
 * candidate → curated review flow, batch aggregation, the fail-closed privacy
 * bundle export, and the case-regression replay logic.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { collectFromSession, loadQueryRecords } from '../collect-feedback.mjs'
import { aggregate } from '../summarize-feedback.mjs'
import { privacyViolations } from '../export-feedback-bundle.mjs'
import { validateFeedback } from '../feedback-schema.mjs'
import { findSessionLogs, baselineFor } from '../regression-cases.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const SCRIPTS = fileURLToPath(new URL('../', import.meta.url))

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'feedback-workflow-'))
  mkdirSync(join(root, 'queries'), { recursive: true })
  mkdirSync(join(root, 'candidates'), { recursive: true })
  mkdirSync(join(root, 'routes'), { recursive: true })
  return root
}

const QUERY_LINES = [
  { ts: '2026-09-07T10:00:00.000Z', correlation_id: 'k1111111111111111', command: 'review', name: 'MergeVecScope', repo: 'AscendNPU-IR', head: 'd00398bd9be2', refreshed: false, duration_ms: 3510, result_chars: 5779, diagnostics: 0, truncated: false },
  { ts: '2026-09-07T10:00:40.000Z', correlation_id: 'k1111111111111111', command: 'finding-impact', name: 'MVS-001', repo: 'AscendNPU-IR', head: 'd00398bd9be2', refreshed: true, duration_ms: 100400, result_chars: 15147, diagnostics: 2, truncated: true },
].map(line => JSON.stringify(line)).join('\n')

test('collectFromSession generates exactly the conservative candidate set', () => {
  const workspace = makeWorkspace()
  try {
    writeFileSync(join(workspace, 'queries', '2026-09-07.jsonl'), `${QUERY_LINES}\n`)
    const queriesByCorrelation = loadQueryRecords(join(workspace, 'queries'))
    const { candidates } = collectFromSession(
      join(FIXTURE_DIR, 'observation-session.jsonl'),
      queriesByCorrelation,
      '2026-09-07',
    )
    const kinds = candidates.map(candidate => candidate.feedback.observation_kind).sort()
    assert.deepEqual(kinds, ['adoption-missed', 'query-operational', 'query-sufficient'])
    for (const candidate of candidates) {
      assert.deepEqual(validateFeedback(candidate), [], 'candidates must be valid v2 documents')
      assert.equal(candidate.feedback.origin, 'automatic')
      assert.equal(candidate.feedback.sensitivity.contains_sensitive_content, false)
    }
    const sufficient = candidates.find(candidate => candidate.feedback.observation_kind === 'query-sufficient')
    assert.equal(sufficient.feedback.task.target, 'pass:hfusion-merge-vf', 'stable target from the route declaration')
    assert.deepEqual(sufficient.feedback.usage.knowledge_commands, { review: 1, 'finding-impact': 1 })
    assert.equal(sufficient.feedback.usage.search_after_query_calls, 0)
    assert.equal(sufficient.feedback.operational.diagnostic_count, 2, 'operational counts come from the query stream')
    assert.equal(sufficient.feedback.possible_gap, null, 'positive evidence carries no invented gap')
    const missed = candidates.find(candidate => candidate.feedback.observation_kind === 'adoption-missed')
    assert.equal(missed.feedback.query, null)
    assert.equal(missed.feedback.usage.compiler_knowledge_calls, 0)
    assert.equal(missed.feedback.task.target, 'pipeline:ttir_to_linalg')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('query-insufficient fires only on discovery search after queries; skips stay silent', () => {
  const workspace = makeWorkspace()
  try {
    writeFileSync(join(workspace, 'queries', '2026-09-07.jsonl'), `${QUERY_LINES}\n`)
    // A group whose queries are followed by a discovery search.
    const logs = join(workspace, 'sessions')
    mkdirSync(logs, { recursive: true })
    const base = readFileSync(join(FIXTURE_DIR, 'observation-session.jsonl'), 'utf8')
    // Turn 1 gains an unscoped rg AFTER the finding-impact result (seq 11.5 slot).
    const withDiscovery = base.replace(
      /(\{"type":"tool\/call","seq":12,)/,
      '{"type":"tool/call","seq":12,"time":1730000200115,"data":{"turn":1,"step":6,"callId":"c-grep-x","name":"bash","arguments":"{\\"command\\":\\"rg MissingSymbol src/\\"}"}}\n$1',
    )
    const path = join(logs, 'insufficient.jsonl')
    writeFileSync(path, withDiscovery)
    const { candidates } = collectFromSession(path, loadQueryRecords(join(workspace, 'queries')), '2026-09-07')
    const sufficient = candidates.find(candidate => candidate.feedback.observation_kind === 'query-insufficient')
    assert.ok(sufficient, 'discovery after queries → query-insufficient')
    assert.equal(sufficient.feedback.possible_gap.category, 'query-coverage')
    assert.equal(sufficient.feedback.possible_gap.statement.includes('review'), true, 'statement asks for human review')
    assert.equal(sufficient.feedback.usage.search_after_query_calls, 1)
    assert.equal(sufficient.feedback.manual_source_search.performed, true)
    // No prompt/shell text leaks into the candidate.
    const serialized = JSON.stringify(sufficient)
    assert.equal(serialized.includes('rg MissingSymbol'), false, 'shell command text is never copied')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('review-feedback accepts a candidate as curated and rejects into rejected/', () => {
  const workspace = makeWorkspace()
  try {
    writeFileSync(join(workspace, 'queries', '2026-09-07.jsonl'), `${QUERY_LINES}\n`)
    process.env.COMPILER_DEV_FEEDBACK_DIR = workspace
    const { collectFromSession: collect } = importFreshCollect()
    const { candidates } = collect(join(FIXTURE_DIR, 'observation-session.jsonl'), loadQueryRecords(join(workspace, 'queries')), '2026-09-07')
    const candidatePath = join(workspace, 'candidates', 'to-accept.json')
    writeFileSync(candidatePath, `${JSON.stringify(candidates[0], null, 2)}\n`)
    const rejectPath = join(workspace, 'candidates', 'to-reject.json')
    writeFileSync(rejectPath, `${JSON.stringify(candidates[1], null, 2)}\n`)

    const run = (args) => execFileSync(process.execPath, [join(SCRIPTS, 'review-feedback.mjs'), ...args], { encoding: 'utf8', env: { ...process.env } })
    run([candidatePath, '--accept'])
    const curatedName = readdirSync(workspace).filter(name => name.endsWith('.json') && name !== 'to-accept.json' && name !== 'to-reject.json')
    assert.equal(curatedName.length, 1, 'accepted artifact written to the feedback root')
    const curated = JSON.parse(readFileSync(join(workspace, curatedName[0]), 'utf8'))
    assert.equal(curated.feedback.origin, 'curated', 'acceptance marks origin curated')
    assert.deepEqual(validateFeedback(curated), [])
    assert.equal(existsSync(candidatePath), false, 'accepted candidate leaves the pending pool')

    run([rejectPath, '--reject', '--reason', 'duplicate of a curated artifact'])
    assert.equal(existsSync(join(workspace, 'candidates', 'rejected', 'to-reject.json')), true)
    assert.match(readFileSync(join(workspace, 'candidates', 'rejected', 'to-reject.json.reason.txt'), 'utf8'), /duplicate/)
  } finally {
    delete process.env.COMPILER_DEV_FEEDBACK_DIR
    rmSync(workspace, { recursive: true, force: true })
  }
})

function importFreshCollect() {
  // collect-feedback reads the env at call time; a re-import is unnecessary —
  // return the same module for symmetry with the spawned review script.
  // eslint-disable-next-line no-undef
  return { collectFromSession }
}

test('aggregate summarizes sessions, streams and candidates into counts only', () => {
  const workspace = makeWorkspace()
  try {
    writeFileSync(join(workspace, 'queries', '2026-09-07.jsonl'), `${QUERY_LINES}\n`)
    writeFileSync(join(workspace, 'routes', '2026-09-07.jsonl'), `${JSON.stringify({ ts: '2026-09-07T09:00:00.000Z', correlation_id: 'k1111111111111111', route: 'pass-review', knowledge_expected: true, confidence: 'high', reason: 'named-pass' })}\n${JSON.stringify({ ts: '2026-09-07T09:05:00.000Z', correlation_id: 'k3333333333333333', route: 'single-file-edit', knowledge_expected: false, confidence: 'high', reason: 'known-single-file' })}\n`)
    const { candidates } = collectFromSession(join(FIXTURE_DIR, 'observation-session.jsonl'), loadQueryRecords(join(workspace, 'queries')), '2026-09-07')
    candidates.forEach((candidate, index) => {
      writeFileSync(join(workspace, 'candidates', `candidate-${index}.json`), `${JSON.stringify(candidate, null, 2)}\n`)
    })
    const summary = aggregate({
      sessionPaths: [join(FIXTURE_DIR, 'observation-session.jsonl')],
      candidatesDir: join(workspace, 'candidates'),
      queriesDir: join(workspace, 'queries'),
      routesDir: join(workspace, 'routes'),
    })
    assert.equal(summary.sessions, 1)
    assert.deepEqual(summary.tasks, { routed: 3, knowledge_expected: 2, declared_skips: 1 })
    assert.equal(summary.adoption.eligible, 2)
    assert.equal(summary.adoption.adopted, 1)
    assert.equal(summary.adoption.missed, 1, 'the high-confidence route with zero calls counts as missed')
    assert.equal(summary.observation_kinds['query-sufficient'], 1)
    assert.equal(summary.observation_kinds['adoption-missed'], 1)
    assert.equal(summary.observation_kinds['query-operational'], 1)
    assert.equal(summary.queries.total, 2)
    assert.equal(summary.queries.refreshed, 1)
    assert.equal(summary.queries.diagnostics, 2)
    assert.equal(summary.routes.total, 2)
    assert.equal(summary.routes.knowledge_expected, 1)
    assert.equal(summary.temporal.sessions_knowledge_before_search, 1)
    assert.equal(JSON.stringify(summary).includes('prompt'), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('export-feedback-bundle builds a transcript-free bundle and fails closed on leaks', () => {
  const workspace = makeWorkspace()
  try {
    writeFileSync(join(workspace, 'queries', '2026-09-07.jsonl'), `${QUERY_LINES}\n`)
    const { candidates } = collectFromSession(join(FIXTURE_DIR, 'observation-session.jsonl'), loadQueryRecords(join(workspace, 'queries')), '2026-09-07')
    candidates.forEach((candidate, index) => {
      writeFileSync(join(workspace, 'candidates', `candidate-${index}.json`), `${JSON.stringify(candidate, null, 2)}\n`)
    })
    process.env.COMPILER_DEV_FEEDBACK_DIR = workspace
    const output = join(workspace, 'bundle.tar.gz')
    execFileSync(process.execPath, [join(SCRIPTS, 'export-feedback-bundle.mjs'), '--since', '2026-09-07', '--output', output, '--include-candidate-summary'], { encoding: 'utf8' })
    const listing = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' })
    for (const expected of ['./manifest.json', './summary.json', './route-summary.json', './query-summary.json', './candidate-summary.json', './curated-feedback/']) {
      assert.ok(listing.includes(expected), `bundle contains ${expected}`)
    }
    assert.equal(listing.includes('session.jsonl'), false, 'no session transcripts in the bundle')
    const extracted = join(workspace, 'extracted')
    mkdirSync(extracted, { recursive: true })
    execFileSync('tar', ['-xzf', output, '-C', extracted])
    const manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'))
    assert.equal(manifest.privacy_check, 'passed (fail-closed)')
    assert.equal(manifest.curated_artifacts, 0, 'no curated artifacts exist in this workspace yet')

    // Fail closed: a leaking curated artifact aborts the export.
    writeFileSync(join(workspace, 'leaky.json'), JSON.stringify({ feedback: { schema_version: 1, created_at: '2026-09-07', task: { kind: 'other', target: 'pass:x' }, query: { command: 'review', args: {} }, observation: 'ok', manual_source_search: { performed: false }, sensitivity: { contains_sensitive_content: false }, prompt: 'review this pass for me' } }, null, 2))
    let failed
    try {
      execFileSync(process.execPath, [join(SCRIPTS, 'export-feedback-bundle.mjs'), '--output', join(workspace, 'bad.tar.gz')], { encoding: 'utf8' })
    } catch (error) {
      failed = error
    }
    assert.ok(failed !== undefined, 'the leaking bundle export exits non-zero')
    assert.match(String(failed.stderr), /privacy check FAILED.*prompt/)
    assert.equal(existsSync(join(workspace, 'bad.tar.gz')), false, 'no bundle is left behind on failure')
  } finally {
    delete process.env.COMPILER_DEV_FEEDBACK_DIR
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('privacyViolations catches forbidden keys, credentials, user paths and oversized files', () => {
  assert.ok(privacyViolations('x.json', '{"prompt":"leak"}').some(v => v.includes('prompt')))
  assert.ok(privacyViolations('x.json', '{"messages":[]}').some(v => v.includes('messages')))
  assert.ok(privacyViolations('x.json', '{"a":"api_key = AKIAIOSFODNN7EXAMPLE"}').some(v => v.includes('credential')))
  assert.ok(privacyViolations('x.json', '{"p":"/home/alice/session.jsonl"}').some(v => v.includes('/home/<user>')))
  assert.ok(privacyViolations('x.json', '-----BEGIN RSA PRIVATE KEY-----').some(v => v.includes('private key')))
  assert.ok(privacyViolations('x.json', `${'x'.repeat(3 * 1024 * 1024)}`).some(v => v.includes('exceeds')))
  assert.ok(privacyViolations('x.json', 'not json at all').some(v => v.includes('not valid JSON')))
  assert.deepEqual(privacyViolations('ok.json', '{"feedback":{"observation":"clean counts only"}}'), [])
})

test('regression-cases replays a case corpus against its baseline and detects drift', () => {
  const workspace = makeWorkspace()
  try {
    const casesDir = join(workspace, 'cases')
    const caseDir = join(casesDir, 'case-a')
    mkdirSync(caseDir, { recursive: true })
    copyFileSync(join(FIXTURE_DIR, 'full-session.jsonl'), join(caseDir, 'session.jsonl'))
    assert.deepEqual(findSessionLogs(casesDir), [join(caseDir, 'session.jsonl')])
    const baselinePath = join(workspace, 'baseline.json')
    execFileSync(process.execPath, [join(SCRIPTS, 'regression-cases.mjs'), '--cases', casesDir, '--baseline', baselinePath, '--update'], { encoding: 'utf8' })
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.equal(baseline['case-a/session.jsonl'].compilerInspectCalls, 1)
    const first = execFileSync(process.execPath, [join(SCRIPTS, 'regression-cases.mjs'), '--cases', casesDir, '--baseline', baselinePath], { encoding: 'utf8' })
    assert.match(first, /no drift/)
    // A metric-changing analyzer behavior must fail the replay.
    const drifted = JSON.parse(JSON.stringify(baseline))
    drifted['case-a/session.jsonl'].compilerKnowledgeCalls = 7
    writeFileSync(baselinePath, `${JSON.stringify(drifted, null, 2)}\n`)
    let failed
    try {
      execFileSync(process.execPath, [join(SCRIPTS, 'regression-cases.mjs'), '--cases', casesDir, '--baseline', baselinePath], { encoding: 'utf8' })
    } catch (error) {
      failed = error
    }
    assert.ok(failed !== undefined, 'drift makes the replay exit non-zero')
    assert.match(String(failed.stdout), /DRIFT/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('baselineFor derives the metric-only baseline from a session log', () => {
  const baseline = baselineFor(join(FIXTURE_DIR, 'full-session.jsonl'))
  assert.equal(baseline.compilerInspectCalls, 1)
  assert.equal(baseline.compilerKnowledgeCalls, 0)
  assert.equal(baseline.sessionId, 'session-test-full')
  assert.equal(baseline.cwd, undefined, 'no filesystem paths in the baseline')
  assert.equal(JSON.stringify(baseline).includes('/'), false)
})

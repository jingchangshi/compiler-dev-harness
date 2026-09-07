/**
 * Tests for the compiler_knowledge driver and plugin glue.
 *
 * Coverage maps to the 2026-09-07 knowledge integration:
 * - CLI argument building for the four contract commands (query-contract.md)
 *   plus the status probe, with the name/fid/ident requirement enforced;
 * - the strict envelope budget cuts the largest arrays under `result` only and
 *   never drops the contract's `command`/`index`/`result` keys;
 * - the stale-index contract rule: stale worktrees are refreshed
 *   (`index --full`) BEFORE results are served unless refresh_index:false,
 *   which returns an explicit refusal instead of results;
 * - the non-sensitive session-observation log: one JSONL line per served
 *   command with operational fields only — no result content, no prompts.
 *
 * The CLI binary is a stub (MLIR_REPOMAP_BIN) so tests never touch a real
 * index; behavior is steered per test through STUB_* environment variables.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { buildCliArgs, boundEnvelope, runKnowledgeQuery, logQueryRecord } from '../../compiler-knowledge-driver.mjs'

const require = createRequire(import.meta.url)
const plugin = require('../../compiler-knowledge-v1.cjs')

const STUB_TEMPLATE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const env = process.env;
const cmd = args[2] ?? 'status';
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); };
const envelope = (result) => ({ command: cmd, index: { head: env.STUB_HEAD ?? 'a'.repeat(40), branch: 'test', stale: env.STUB_STALE === '1' }, result });
if (cmd === 'status') {
  out(envelope({ index: { head: 'a'.repeat(40), branch: 'test', stale: env.STUB_STALE === '1' }, entity_counts: { pass: 1 }, diagnostics: 0 }));
} else if (cmd === 'index') {
  out({ command: 'index', result: { scanned: 10, reextracted: 9, unchanged: 1, deleted: 0, seconds: 0.5 } });
} else if (cmd === 'review') {
  if (env.STUB_ERROR === '1') {
    out(envelope({ error: 'not found' }));
  } else {
    const items = env.STUB_HUGE === '1' ? Array.from({ length: 400 }, (_, i) => ('row-' + i).padEnd(120, 'x')) : [{ pass: 'hfusion-merge-vf' }];
    out(envelope({ pass: { id: 'pass:hfusion-merge-vf' }, review_records: items, diagnostics: [] }));
  }
} else {
  out(envelope({ error: 'not found' }));
}
`

function makeStubBin(dir) {
  const bin = join(dir, 'stub-mlir-repomap.mjs')
  writeFileSync(bin, STUB_TEMPLATE)
  chmodSync(bin, 0o755)
  return bin
}

function makeLogDir() {
  return mkdtempSync(join(tmpdir(), 'compiler-knowledge-log-'))
}

function readLogLines(dir) {
  const files = readdirSync(dir)
  if (files.length === 0) return []
  return readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

test('buildCliArgs maps the contract commands to CLI argument arrays', () => {
  const root = '/repo'
  assert.deepEqual(buildCliArgs(root, 'review', { name: 'MergeVecScope', since: 'HEAD~5', findings_dir: 'f' }),
    ['--repo', root, 'review', 'MergeVecScope', '--dir', 'f', '--since', 'HEAD~5'])
  assert.deepEqual(buildCliArgs(root, 'finding-impact', { name: 'MVS-001' }),
    ['--repo', root, 'finding-impact', 'MVS-001'])
  assert.deepEqual(buildCliArgs(root, 'pipeline-stages', { name: 'make_ttir' }),
    ['--repo', root, 'pipeline-stages', 'make_ttir'])
  assert.deepEqual(buildCliArgs(root, 'evidence', { name: 'pass:hfusion-merge-vf' }),
    ['--repo', root, 'evidence', 'pass:hfusion-merge-vf'])
  assert.deepEqual(buildCliArgs(root, 'status', {}), ['--repo', root, 'status'])
})

test('buildCliArgs rejects missing names and unknown commands', () => {
  assert.equal(buildCliArgs('/repo', 'review', {}), null)
  assert.equal(buildCliArgs('/repo', 'evidence', { name: '   ' }), null)
  assert.equal(buildCliArgs('/repo', 'findings-list', { name: 'x' }), null)
})

test('boundEnvelope keeps contract keys and cuts the largest arrays when over budget', () => {
  const small = { command: 'review', index: { stale: false }, result: { review_records: [{ a: 1 }] } }
  const first = boundEnvelope(small, 100000)
  assert.equal(first.truncated, false)
  assert.deepEqual(first.envelope.result, small.result)

  const big = {
    command: 'review',
    index: { stale: false },
    result: { review_records: Array.from({ length: 50 }, (_, i) => `row-${i}-`.padEnd(120, 'x')), diagnostics: ['d1'] },
  }
  const second = boundEnvelope(big, 3000)
  assert.equal(second.truncated, true)
  assert.equal(second.envelope.command, 'review')
  assert.ok(second.envelope.index)
  assert.ok(second.envelope.result)
  assert.ok(second.text.length <= 3000, `budget exceeded: ${second.text.length}`)
  assert.ok(second.envelope.result.review_records.length < 50)
  assert.ok(second.notes.some(note => note.includes('review_records')))
})

test('logQueryRecord writes one JSON line with operational fields only', () => {
  const dir = makeLogDir()
  try {
    const ok = logQueryRecord({
      ts: '2026-09-07T00:00:00.000Z', command: 'review', name: 'MergeVecScope', repo: 'AscendNPU-IR',
      head: 'abc', refreshed: false, duration_ms: 120, result_chars: 5000, truncated: false,
    }, dir)
    assert.equal(ok, true)
    const lines = readLogLines(dir)
    assert.equal(lines.length, 1)
    const record = lines[0]
    assert.equal(record.command, 'review')
    assert.equal(record.name, 'MergeVecScope')
    assert.equal(record.result_chars, 5000)
    // Non-sensitive by construction: no result payload, no free text fields.
    for (const key of Object.keys(record)) {
      assert.ok(['ts', 'command', 'name', 'repo', 'head', 'refreshed', 'duration_ms', 'result_chars', 'truncated', 'error'].includes(key), `unexpected field ${key}`)
    }
    assert.equal(JSON.stringify(record).includes('MergeVecScope.cpp'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runKnowledgeQuery serves a fresh query and logs it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiler-knowledge-test-'))
  const logDir = makeLogDir()
  try {
    const bin = makeStubBin(dir)
    const envelope = await runKnowledgeQuery(
      { command: 'review', name: 'MergeVecScope', repo_root: dir },
      undefined,
      logDir,
      { MLIR_REPOMAP_BIN: bin, STUB_STALE: '0' },
    )
    assert.equal(envelope.command, 'review')
    assert.equal(envelope.index.stale, false)
    assert.deepEqual(envelope.result.pass, { id: 'pass:hfusion-merge-vf' })
    assert.equal(envelope.delivery.notes.some(note => note.includes('stale')), false)
    const lines = readLogLines(logDir)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].command, 'review')
    assert.equal(lines[0].refreshed, false)
    assert.equal(lines[0].error, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('runKnowledgeQuery refreshes a stale index before answering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiler-knowledge-test-'))
  const logDir = makeLogDir()
  try {
    const bin = makeStubBin(dir)
    const envelope = await runKnowledgeQuery(
      { command: 'review', name: 'MergeVecScope', repo_root: dir },
      undefined,
      logDir,
      { MLIR_REPOMAP_BIN: bin, STUB_STALE: '1' },
    )
    assert.equal(envelope.command, 'review')
    assert.ok(envelope.delivery.notes.some(note => note.includes('index was stale')), JSON.stringify(envelope.delivery.notes))
    const lines = readLogLines(logDir)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].refreshed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('runKnowledgeQuery refuses stale results when refresh_index is false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiler-knowledge-test-'))
  const logDir = makeLogDir()
  try {
    const bin = makeStubBin(dir)
    const envelope = await runKnowledgeQuery(
      { command: 'review', name: 'MergeVecScope', repo_root: dir, refresh_index: false },
      undefined,
      logDir,
      { MLIR_REPOMAP_BIN: bin, STUB_STALE: '1' },
    )
    assert.equal(envelope.result.error, 'stale-index')
    assert.ok(envelope.delivery.notes.some(note => note.includes('REFUSED')))
    const lines = readLogLines(logDir)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].error, 'refused-stale')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('runKnowledgeQuery bounds oversized results and reports the cut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiler-knowledge-test-'))
  const logDir = makeLogDir()
  try {
    const bin = makeStubBin(dir)
    const envelope = await runKnowledgeQuery(
      { command: 'review', name: 'MergeVecScope', repo_root: dir },
      undefined,
      logDir,
      { MLIR_REPOMAP_BIN: bin, STUB_STALE: '0', STUB_HUGE: '1' },
    )
    assert.equal(envelope.command, 'review')
    assert.equal(envelope.delivery.notes.some(note => note.includes('review_records')), true)
    assert.ok(JSON.stringify(envelope).length < 30000)
    assert.equal(readLogLines(logDir)[0].truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('runKnowledgeQuery requires a name for query commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiler-knowledge-test-'))
  try {
    const bin = makeStubBin(dir)
    await assert.rejects(
      () => runKnowledgeQuery({ command: 'evidence', repo_root: dir }, undefined, undefined, { MLIR_REPOMAP_BIN: bin }),
      /requires a 'name'/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runKnowledgeQuery surfaces CLI error results verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compiler-knowledge-test-'))
  const logDir = makeLogDir()
  try {
    const bin = makeStubBin(dir)
    const envelope = await runKnowledgeQuery(
      { command: 'review', name: 'NoSuchPassXYZ', repo_root: dir },
      undefined,
      logDir,
      { MLIR_REPOMAP_BIN: bin, STUB_ERROR: '1' },
    )
    assert.deepEqual(envelope.result, { error: 'not found' })
    assert.equal(readLogLines(logDir)[0].error, 'not found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('plugin registers the routing section and the compiler_knowledge tool', () => {
  if (plugin.name !== 'compiler-knowledge' || !Array.isArray(plugin.inject)) throw new Error('plugin exports wrong')
  const sections = []
  const tools = []
  plugin.apply({ systemPrompt: { section: s => sections.push(s) }, tools: { register: t => tools.push(t) } })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'compiler-knowledge-routing')
  assert.equal(sections[0].order, 115)
  const tool = tools[0]
  assert.equal(tool.name, 'compiler_knowledge')
  assert.equal(tool.parameters.required[0], 'command')
  assert.deepEqual(tool.parameters.properties.command.enum,
    ['review', 'finding-impact', 'pipeline-stages', 'evidence', 'status'])
  JSON.parse(JSON.stringify(tool.parameters))
  JSON.parse(JSON.stringify(tool.output.schema))
})

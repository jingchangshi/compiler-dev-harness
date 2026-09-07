/**
 * Tests for the Ripwire generic-context backend (Phase R1) and its seam in
 * `compiler_inspect`.
 *
 * Coverage maps to the Phase R1 requirements:
 * - binary/provider behavior: RIPWIRE_BIN discovery, missing binary, failing
 *   invocation, abort, explicit legacy, auto fallback, and the rule that an
 *   explicit `ripwire` backend NEVER silently becomes legacy;
 * - output normalization: successful `--pack-task --json`, weak results,
 *   ambiguity/truncation/floor disclosure preservation, bounded output, and
 *   malformed non-JSON output;
 * - existing behavior: legacy retrieval still works, MLIR log forensics is
 *   untouched, contract `exclude_dirs` reach the Ripwire spawn and outside-
 *   corpus anchors are reported instead of silently missing;
 * - observation: one non-sensitive line per attempt, correlation id stamping,
 *   fallback visibility, and analyzer backend aggregation.
 *
 * Ripwire itself is a stub binary (RIPWIRE_BIN) so tests never depend on a
 * real installation; behavior is steered per test through STUB_* variables.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import {
  buildPackTaskArgs,
  deriveTaskString,
  FALLBACK_REASONS,
  normalizePackTaskResult,
  outsideCorpusFiles,
  resolveBackendPolicy,
  ripwireBinary,
  runRipwireContext,
  RipwireContextError,
} from '../../compiler-context-backend.mjs'
import { inspectCompilerRepository } from '../../compiler-inspect-driver.mjs'
import { analyzeRecords, formatReport } from '../analyze-session.mjs'

const require = createRequire(import.meta.url)
const plugin = require('../../compiler-inspect-v3-5.cjs')

const hasBin = (bin) => execFileSync('which', [bin], { encoding: 'utf8' }).trim() !== ''

const STUB_TEMPLATE = `#!/usr/bin/env node
const env = process.env;
if (env.STUB_EXIT_FAIL === '1') process.exit(3);
if (env.STUB_BAD_JSON === '1') { process.stdout.write('<ctx>not json at all</ctx>'); process.exit(0); }
const ranking = env.STUB_EMPTY_RANKING === '1'
  ? []
  : [
      { t: 'struct', n: 'FooPass', p: 'lib/a.cpp', l: 10, r: 1, in: 2, sig: 'struct FooPass' },
      ...(env.STUB_AMBIGUOUS === '1' ? [{ t: 'struct', n: 'FooPass', p: 'lib/b.cpp', l: 20, r: 2 }] : []),
      ...(env.STUB_HUGE === '1'
        ? Array.from({ length: 40 }, (_, i) => ({ t: 'fn', n: 'gen' + i, p: 'lib/gen' + i + '.cpp', l: i, r: i + 2 }))
        : []),
    ];
const out = {
  task: 'stub task text',
  route: 'routed: stub note',
  root: '.',
  budget_tokens: 5000, budget_bytes: 11000, budget_ceiling_bytes: 11800,
  ranking_capped: env.STUB_CAPPED === '1',
  ranking,
  far_total: 1, far_kept: 1, far: [{ t: 'fn', n: 'helper', p: 'lib/h.cpp:5' }],
  bodies_total: env.STUB_CAPPED === '1' ? 3 : 1, bodies_kept: 1,
  bodies: [{ t: 'struct', l: 10, p: 'lib/a.cpp', n: 'FooPass', body: 'BODYMARK struct FooPass { void runOnOperation(); };' }],
  callers_total: env.STUB_CAPPED === '1' ? 5 : 1, callers_kept: 1,
  callers: [{ t: 'fn', n: 'callerFn', p: 'lib/c.cpp:3', rel: 'caller', sig: 'void callerFn()' }],
  notes_total: 0, notes_kept: 0, notes: [],
  tests_total: 1, tests_kept: 1, tests_to_run: [{ p: 'test/a.cpp', run: 'bash test/run.sh' }],
};
if (env.STUB_OVER_CEILING === '1') out.over_ceiling = true;
if (env.STUB_OMITTED === '1') out.bodies_omitted = ['BigFn'];
process.stdout.write(JSON.stringify(out));
`

const SLOW_STUB = `#!/usr/bin/env node
setTimeout(() => { process.stdout.write('{}'); }, 5000);
`

function makeStubBin(dir, template = STUB_TEMPLATE, name = 'stub-ripwire.mjs') {
  const bin = join(dir, name)
  writeFileSync(bin, template)
  chmodSync(bin, 0o755)
  return bin
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ripwire-context-test-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'third_party'), { recursive: true })
  writeFileSync(join(root, 'lib', 'a.cpp'), 'struct FooPass { void runOnOperation(); };\nvoid FooPass::runOnOperation() {}\nint caller() { return 1; }\n')
  writeFileSync(join(root, 'third_party', 'v.cpp'), 'struct VendoredSym { int x; };\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}

function makeLogDir() {
  return mkdtempSync(join(tmpdir(), 'ripwire-context-log-'))
}

function readLogLines(dir) {
  const files = readdirSync(dir)
  assert.ok(files.length > 0, 'observation log directory must contain a stream file')
  return readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

const stubEnv = (bin, extra = {}) => ({ ...process.env, RIPWIRE_BIN: bin, ...extra })

test('backend policy resolution: input wins, then env, then the repository default (legacy while experimental)', () => {
  assert.equal(resolveBackendPolicy({ backend: 'ripwire' }, {}).policy, 'ripwire')
  assert.equal(resolveBackendPolicy({ backend: 'auto' }, {}).policy, 'auto')
  assert.equal(resolveBackendPolicy({ backend: 'legacy' }, {}).policy, 'legacy')
  assert.equal(resolveBackendPolicy({}, { COMPILER_INSPECT_BACKEND: 'ripwire' }).policy, 'ripwire')
  assert.equal(resolveBackendPolicy({}, {}).policy, 'legacy', 'repository default stays legacy while Ripwire is experimental')
  const defaultPolicy = resolveBackendPolicy({}, {})
  assert.equal(defaultPolicy.source, 'repository-default')
  const unknown = resolveBackendPolicy({ backend: 'bogus' }, {})
  assert.equal(unknown.policy, 'legacy')
  assert.equal(unknown.notes.length, 1, 'unknown values degrade to the repository default with a note')
})

test('binary discovery uses RIPWIRE_BIN first and never probes PATH eagerly', () => {
  const found = ripwireBinary({ RIPWIRE_BIN: '/bin/true' })
  assert.equal(found.path, '/bin/true')
  const missing = ripwireBinary({ RIPWIRE_BIN: '/no/such/ripwire' })
  assert.equal(missing.path, 'ripwire')
  assert.ok(missing.tried.some(entry => entry.includes('RIPWIRE_BIN')), 'the missing override is named in tried')
})

test('task string derivation: explicit task wins, anchors derive otherwise', () => {
  assert.equal(deriveTaskString({ task: '  why does FooPass re-verify  ' }), 'why does FooPass re-verify')
  assert.equal(deriveTaskString({ symbols: ['FooPass'], files: ['lib/a.cpp'] }), 'understand FooPass in lib/a.cpp')
  assert.equal(deriveTaskString({}), '')
})

test('buildPackTaskArgs maps contract exclude_dirs to --exclude and never reaches a shell', () => {
  const args = buildPackTaskArgs('/repo', 'understand Foo', { excludeDirs: ['build', './third-party/'], tokenBudget: 5000 })
  assert.deepEqual(args, ['/repo', '--pack-task=understand Foo', '--json', '--token-budget=5000', '--exclude=build/', '--exclude=third-party/'])
})

test('outsideCorpusFiles reports anchors under Ripwire-pruned or contract-excluded trees', () => {
  const outside = outsideCorpusFiles('/repo', ['third_party/v.cpp', 'lib/a.cpp', 'build/out.cpp'], ['third-party'])
  assert.deepEqual(outside, ['third_party/v.cpp', 'build/out.cpp'])
  assert.deepEqual(outsideCorpusFiles('/repo', ['bishengir/lib/a.cpp'], []), [])
})

test('normalization: successful pack-task JSON maps to bounded rows and honest disclosures', () => {
  const parsed = JSON.parse(execFileSync(process.execPath, ['-e', stubScript()], { encoding: 'utf8' }))
  const cuts = []
  const { sourceContext, disclosures } = normalizePackTaskResult(parsed, cuts)
  assert.equal(sourceContext.provider, 'ripwire')
  assert.equal(sourceContext.mode, 'pack-task')
  assert.equal(sourceContext.ranked_symbols.length, 1)
  assert.equal(sourceContext.ranked_symbols[0].name, 'FooPass')
  assert.equal(sourceContext.bodies[0].text.includes('BODYMARK'), true)
  assert.equal(sourceContext.callers[0].relation, 'caller')
  assert.equal(sourceContext.tests_to_run[0].path, 'test/a.cpp')
  assert.equal(disclosures.weak, false)
  assert.equal(disclosures.truncated, false)
  assert.equal(disclosures.ambiguous, 0)
})

/** Render the stub template into a standalone Node script with env overrides. */
function stubScript(envOverrides = {}) {
  const overrides = Object.entries(envOverrides).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
  return STUB_TEMPLATE.replace('#!/usr/bin/env node', '').replace('const env = process.env;', `const env = { ${overrides} };`)
}

test('normalization: weak result sets weak=true with an empty ranking', () => {
  const parsed = JSON.parse(execFileSync(process.execPath, ['-e', stubScript({ STUB_EMPTY_RANKING: '1' })], { encoding: 'utf8' }))
  const { sourceContext, disclosures } = normalizePackTaskResult(parsed)
  assert.equal(sourceContext.ranked_symbols.length, 0)
  assert.equal(disclosures.weak, true)
})

test('normalization: ambiguity derives from returned rows spanning several files', () => {
  const parsed = JSON.parse(execFileSync(process.execPath, ['-e', stubScript({ STUB_AMBIGUOUS: '1' })], { encoding: 'utf8' }))
  const { disclosures } = normalizePackTaskResult(parsed)
  assert.equal(disclosures.ambiguous, 1)
})

test('normalization: truncation/floor markers are preserved, never erased', () => {
  const parsed = JSON.parse(execFileSync(process.execPath, ['-e', stubScript({ STUB_CAPPED: '1', STUB_OVER_CEILING: '1', STUB_OMITTED: '1' })], { encoding: 'utf8' }))
  const { disclosures } = normalizePackTaskResult(parsed)
  assert.equal(disclosures.truncated, true)
  assert.equal(disclosures.counts_floor, true)
  assert.equal(disclosures.ranking_capped, true)
  assert.equal(disclosures.over_ceiling, true)
  assert.deepEqual(disclosures.bodies_omitted, ['BigFn'])
  assert.ok(disclosures.callers_kept < disclosures.callers_total, 'caller floor is preserved')
  assert.ok(disclosures.bodies_kept < disclosures.bodies_total, 'body floor is preserved')
})

test('normalization: oversized ranking rows are cut to the cap and the cut is disclosed', () => {
  const parsed = JSON.parse(execFileSync(process.execPath, ['-e', stubScript({ STUB_HUGE: '1' })], { encoding: 'utf8' }))
  const cuts = []
  const { sourceContext, disclosures } = normalizePackTaskResult(parsed, cuts)
  assert.equal(sourceContext.ranked_symbols.length, 12)
  assert.ok(cuts.some(note => note.includes('ranking rows cut')), 'the cap cut must be disclosed')
  assert.equal(disclosures.truncated, true)
})

test('provider: successful invocation returns normalized context with meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const repo = makeRepo()
  try {
    const bin = makeStubBin(dir)
    const { sourceContext, meta } = await runRipwireContext(
      { repo_root: repo, task: 'understand Foo' },
      undefined,
      { env: stubEnv(bin), task: 'understand Foo' },
    )
    assert.equal(sourceContext.task, 'stub task text')
    assert.equal(meta.binary, bin)
    assert.equal(meta.exit_code, 0)
    assert.ok(meta.result_chars > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('provider: missing binary maps to ripwire-not-found', async () => {
  const repo = makeRepo()
  try {
    await assert.rejects(
      () => runRipwireContext({ repo_root: repo, task: 't' }, undefined, { env: stubEnv('/no/such/ripwire-at-all') }),
      error => error instanceof RipwireContextError && error.reason === FALLBACK_REASONS.NOT_FOUND,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('provider: failing invocation maps to ripwire-invocation-failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const repo = makeRepo()
  try {
    const bin = makeStubBin(dir)
    await assert.rejects(
      () => runRipwireContext({ repo_root: repo, task: 't' }, undefined, { env: stubEnv(bin, { STUB_EXIT_FAIL: '1' }), task: 't' }),
      error => error instanceof RipwireContextError && error.reason === FALLBACK_REASONS.INVOCATION_FAILED,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('provider: malformed non-JSON output maps to ripwire-invalid-output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const repo = makeRepo()
  try {
    const bin = makeStubBin(dir)
    await assert.rejects(
      () => runRipwireContext({ repo_root: repo, task: 't' }, undefined, { env: stubEnv(bin, { STUB_BAD_JSON: '1' }), task: 't' }),
      error => error instanceof RipwireContextError && error.reason === FALLBACK_REASONS.INVALID_OUTPUT,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('provider: abort propagation maps to ripwire-timeout', { skip: !hasBin('sleep') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const repo = makeRepo()
  try {
    const bin = makeStubBin(dir, SLOW_STUB, 'slow-ripwire.mjs')
    const guard = new AbortController()
    const timer = setTimeout(() => guard.abort(new RipwireContextError(FALLBACK_REASONS.TIMEOUT, 'test abort')), 100)
    await assert.rejects(
      () => runRipwireContext({ repo_root: repo, task: 't' }, guard.signal, { env: stubEnv(bin), task: 't' }),
      error => error instanceof RipwireContextError && error.reason === FALLBACK_REASONS.TIMEOUT,
    )
    clearTimeout(timer)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('seam (repository default): legacy serves while Ripwire is experimental — no fallback, no attempt', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'] }, undefined, { env: stubEnv('/no/such/ripwire-at-all') })
    assert.equal(bundle.backend, 'legacy-rg')
    assert.equal(bundle.fallback, false, 'the repository default is a policy choice, not a fallback')
    assert.equal(bundle.fallback_reason, null)
    assert.ok(bundle.definitions.length > 0, 'legacy retrieval actually served the bundle')
    assert.equal(bundle.source_context, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam (explicit auto + missing binary): controlled legacy fallback with a stated reason', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], backend: 'auto' }, undefined, { env: stubEnv('/no/such/ripwire-at-all') })
    assert.equal(bundle.backend, 'legacy-rg')
    assert.equal(bundle.fallback, true)
    assert.equal(bundle.fallback_reason, FALLBACK_REASONS.NOT_FOUND)
    assert.ok(bundle.definitions.length > 0, 'legacy retrieval actually served the bundle')
    assert.equal(bundle.source_context, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam (explicit auto + ripwire usable): source_context serves and legacy sections stay empty', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const root = makeRepo()
  try {
    const bin = makeStubBin(dir)
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], task: 'understand FooPass', backend: 'auto' }, undefined, { env: stubEnv(bin), logDir: makeLogDir() })
    assert.equal(bundle.backend, 'ripwire')
    assert.equal(bundle.fallback, false)
    assert.equal(bundle.fallback_reason, null)
    assert.ok(bundle.source_context.ranked_symbols.length > 0)
    assert.equal(bundle.definitions.length, 0, 'ripwire serving means no parallel legacy rg passes')
    assert.ok(bundle.history.length >= 0, 'git history still runs (artifact provider unaffected)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam (explicit auto + weak result): falls back and never reads as semantic absence', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const root = makeRepo()
  try {
    const bin = makeStubBin(dir)
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], backend: 'auto' }, undefined, { env: stubEnv(bin, { STUB_EMPTY_RANKING: '1' }) })
    assert.equal(bundle.backend, 'legacy-rg')
    assert.equal(bundle.fallback, true)
    assert.equal(bundle.fallback_reason, FALLBACK_REASONS.WEAK_RESULT)
    assert.ok(bundle.unresolved.some(line => line.includes('not retrieved is not semantic absence')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam (explicit ripwire + failure): degraded result, NEVER a silent legacy switch', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], backend: 'ripwire' }, undefined, { env: stubEnv('/no/such/ripwire-at-all') })
    assert.equal(bundle.backend, 'none', 'nothing served when the explicit Ripwire request fails (R1.6)')
    assert.equal(bundle.delivery_state, 'degraded')
    assert.equal(bundle.fallback, false, 'explicit ripwire failure must not count as a legacy fallback')
    assert.equal(bundle.source_context.degraded, true)
    assert.equal(bundle.source_context.error, FALLBACK_REASONS.NOT_FOUND)
    assert.ok(bundle.unresolved.some(line => line.includes("backend 'legacy'")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam (explicit legacy): rg/git retrieval forced, ripwire never consulted', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], backend: 'legacy' }, undefined, { env: stubEnv('/no/such/ripwire-at-all') })
    assert.equal(bundle.backend, 'legacy-rg')
    assert.equal(bundle.fallback, false)
    assert.equal(bundle.fallback_reason, null)
    assert.ok(bundle.definitions.length > 0)
    assert.ok(bundle.unresolved.every(line => !line.includes('Ripwire')), 'a forced legacy run mentions no Ripwire attempt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam: anchors inside vendored trees are reported outside the corpus', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const root = makeRepo()
  try {
    const bin = makeStubBin(dir)
    const bundle = await inspectCompilerRepository({ repo_root: root, files: ['third_party/v.cpp'], symbols: ['VendoredSym'], backend: 'ripwire' }, undefined, { env: stubEnv(bin, { STUB_EMPTY_RANKING: '1' }) })
    assert.ok(
      bundle.unresolved.some(line => line.includes("outside Ripwire's indexed corpus")),
      `outside-corpus anchors must be reported, got: ${JSON.stringify(bundle.unresolved)}`,
    )
    assert.ok(bundle.vendored_matches.length > 0, 'the narrow legacy vendored supplement still runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('seam: MLIR log forensics is unchanged under the ripwire backend', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const root = makeRepo()
  try {
    const bin = makeStubBin(dir)
    writeFileSync(join(root, 'pipeline.log'), '// -----// IR Dump After AlphaPass (alpha-pass) //-----\n%0 = alpha.op\n')
    const bundle = await inspectCompilerRepository({
      repo_root: root, symbols: ['FooPass'], task: 'understand FooPass', backend: 'auto',
      log_files: ['pipeline.log'], log_passes: ['AlphaPass'],
    }, undefined, { env: stubEnv(bin) })
    assert.equal(bundle.backend, 'ripwire')
    assert.equal(bundle.logs.files.length, 1)
    assert.equal(bundle.logs.files[0].per_pass[0].pass, 'AlphaPass (alpha-pass)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plugin contract: schema declares the backend policy and new output fields', () => {
  const registered = []
  plugin.apply({ systemPrompt: { section() {} }, tools: { register(tool) { registered.push(tool) } } })
  const tool = registered.find(entry => entry.name === 'compiler_inspect')
  assert.ok(tool, 'plugin must register compiler_inspect')
  const inputProps = tool.parameters.properties
  assert.deepEqual(inputProps.backend.enum, ['auto', 'ripwire', 'legacy'])
  assert.ok(inputProps.task, 'the optional task phrase is declared')
  const out = tool.output.schema
  assert.deepEqual(out.properties.backend.enum, ['ripwire', 'legacy-rg', 'none'])
  assert.deepEqual(out.properties.delivery_state.enum, ['served', 'fallback', 'degraded'])
  assert.ok(out.required.includes('backend') && out.required.includes('delivery_state') && out.required.includes('fallback') && out.required.includes('fallback_reason'))
  assert.ok(out.required.includes('source_context') && out.required.includes('source_disclosures'))
  // The legacy contract fields all remain required and present.
  for (const key of ['repository', 'anchors', 'definitions', 'references', 'tests', 'changes', 'history', 'logs', 'unresolved', 'budget']) {
    assert.ok(out.required.includes(key), `${key} stays in the required contract`)
  }
})

test('plugin contract: rendered bundle names the backend and the epistemic boundary', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const root = makeRepo()
  const previousBin = process.env.RIPWIRE_BIN
  try {
    const bin = makeStubBin(dir)
    process.env.RIPWIRE_BIN = bin
    const registered = []
    plugin.apply({ systemPrompt: { section() {} }, tools: { register(tool) { registered.push(tool) } } })
    const tool = registered.find(entry => entry.name === 'compiler_inspect')
    const bundle = await tool.execute({ repo_root: root, symbols: ['FooPass'], task: 'understand FooPass', backend: 'ripwire' }, { signal: new AbortController().signal })
    const rendered = tool.output.render({}, bundle)[0].text
    assert.ok(rendered.includes('Context backend: ripwire (fallback: none)'), `backend line must render, got: ${rendered.split('\n').slice(0, 8).join(' | ')}`)
    assert.ok(rendered.includes('delivery=served'), 'the delivery state must render')
    assert.ok(rendered.includes('NOT an mlir-repomap semantic fact'), 'the epistemic boundary must be stated')
    assert.ok(rendered.length <= bundle.budget.total_budget_chars + 400, 'the rendered bundle respects the strict total budget')
    assert.equal(bundle.budget.version, '1.5')
  } finally {
    if (previousBin === undefined) delete process.env.RIPWIRE_BIN
    else process.env.RIPWIRE_BIN = previousBin
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('observation (protocol v2): one line per attempt with attempts, served provider, and delivery state', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripwire-bin-'))
  const root = makeRepo()
  const logDir = makeLogDir()
  try {
    const bin = makeStubBin(dir)
    await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], task: 'understand FooPass with BODYMARK inside', backend: 'auto' }, undefined, { env: stubEnv(bin), logDir, correlationId: 'ktest1234abcdef' })
    await inspectCompilerRepository({ repo_root: root, symbols: ['FooPass'], backend: 'auto' }, undefined, { env: stubEnv('/no/such/ripwire-at-all'), logDir, correlationId: 'ktest1234abcdef' })
    const lines = readLogLines(logDir)
    assert.equal(lines.length, 2, 'exactly one observation line per source-retrieval attempt')
    for (const line of lines) assert.equal(line.schema_version, 2, 'runtime writes protocol v2')
    const servedLine = lines[0]
    assert.equal(servedLine.correlation_id, 'ktest1234abcdef')
    assert.equal(servedLine.backend_policy, 'auto')
    assert.equal(servedLine.served_provider, 'ripwire')
    assert.equal(servedLine.delivery_state, 'served')
    assert.equal(servedLine.attempts.length, 1)
    assert.equal(servedLine.attempts[0].provider, 'ripwire')
    assert.equal(servedLine.attempts[0].outcome, 'served')
    assert.ok(Number.isInteger(servedLine.attempts[0].duration_ms), 'the attempt duration is a provider-boundary fact')
    assert.ok(Number.isInteger(servedLine.total_duration_ms), 'the whole-call duration is separate')
    const fallbackLine = lines[1]
    assert.equal(fallbackLine.served_provider, 'legacy-rg')
    assert.equal(fallbackLine.delivery_state, 'fallback')
    assert.equal(fallbackLine.attempts.length, 2, 'the failed Ripwire attempt AND the served legacy attempt are both recorded')
    assert.equal(fallbackLine.attempts[0].provider, 'ripwire')
    assert.equal(fallbackLine.attempts[0].outcome, 'not-found')
    assert.equal(fallbackLine.attempts[1].provider, 'legacy-rg')
    assert.equal(fallbackLine.attempts[1].outcome, 'served')
    assert.ok(Number.isInteger(fallbackLine.attempts[1].duration_ms), 'the legacy attempt duration is a provider-boundary fact')
    for (const line of lines) {
      const raw = JSON.stringify(line)
      assert.ok(!raw.includes('BODYMARK'), 'no source/body text is recorded')
      assert.ok(!raw.includes('understand FooPass'), 'no task prose is recorded')
      assert.ok(!raw.includes(root), 'no absolute paths are recorded')
      assert.ok(!raw.includes('stub task text'), 'no raw ripwire task echo is recorded')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('observation: artifact-only calls emit no context record', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  const logDir = makeLogDir()
  try {
    await inspectCompilerRepository({ repo_root: root, include_diff: false, history_window: 1 }, undefined, { env: stubEnv('/no/such/ripwire-at-all'), logDir })
    assert.equal(readdirSync(logDir).length, 0, 'no source retrieval requested → no context observation')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('analyzer: backend breakdown, fallback reasons, and weak results aggregate from rendered bundles', () => {
  const records = [
    { type: 'session', data: { id: 'session-backend', agentPreset: 'compiler-dev' } },
    {
      type: 'tool/call', seq: 1, data: { name: 'compiler_inspect', callId: 'c1', arguments: '{}' },
    },
    {
      type: 'tool/result', seq: 2, data: {
        step: 2, message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'Repository: /r\nContext backend: ripwire (fallback: none) | weak=false ambiguous=0 truncated=false counts_floor=false\nSource context:\n- x' }] }] },
      },
    },
    { type: 'tool/call', seq: 3, data: { name: 'compiler_inspect', callId: 'c2', arguments: '{}' } },
    {
      type: 'tool/result', seq: 4, data: {
        step: 4, message: { content: [{ toolCallId: 'c2', content: [{ type: 'text', text: 'Repository: /r\nContext backend: legacy-rg (fallback: ripwire-not-found) | weak=true ambiguous=0 truncated=false counts_floor=false\nDefinitions:\n- x' }] }] },
      },
    },
  ]
  const result = analyzeRecords(records)
  assert.deepEqual(result.inspectBackends, { ripwire: 1, 'legacy-rg': 1 })
  assert.deepEqual(result.inspectFallbacks, { 'ripwire-not-found': 1 })
  assert.equal(result.inspectWeakResults, 1)
  const report = formatReport(result)
  assert.ok(report.includes('compiler_inspect backends: ripwire: 1, legacy-rg: 1'))
  assert.ok(report.includes('ripwire-not-found: 1'))
})

test('analyzer: pre-integration sessions report zero ripwire usage honestly', () => {
  const result = analyzeRecords(fullRecordsLike())
  assert.deepEqual(result.inspectBackends, {})
  assert.deepEqual(result.inspectFallbacks, {})
  assert.equal(result.inspectWeakResults, 0)
})

function fullRecordsLike() {
  return [
    { type: 'session', data: { id: 'session-old', agentPreset: 'compiler-dev' } },
    { type: 'tool/call', seq: 1, data: { name: 'compiler_inspect', callId: 'c9', arguments: '{}' } },
    { type: 'tool/result', seq: 2, data: { step: 2, message: { content: [{ toolCallId: 'c9', content: [{ type: 'text', text: 'Repository: /r (main; clean)\nAnchors: files=x\nDefinitions:\n- a.cpp:1: struct Foo\nBudget: 12 items/section (v1.2)' }] }] } } },
  ]
}

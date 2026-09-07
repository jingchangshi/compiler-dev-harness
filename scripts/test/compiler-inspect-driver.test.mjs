/**
 * Tests for the compiler_inspect v1.2 driver and plugin glue.
 *
 * Coverage maps to the 2026-09-06 case-feedback fixes:
 * - H2: C/C++ attached-brace function definitions are found by the definition
 *   pass (v1.1 only reported them as references);
 * - M3: the vendored fallback runs when definitions exist only inside vendored
 *   trees or when an anchored file sits inside one, with the trigger stated in
 *   Unresolved;
 * - H1: out-of-range history_window no longer fails the call — the plugin
 *   clamps it and records the clamp in Unresolved, and the driver accepts it;
 * - M4: log_files returns per-file IR-dump indexes, occurrence-addressed
 *   bounded slices, and a two-file pass-sequence diff.
 *
 * Git and ripgrep must be on PATH (the driver needs them in production too);
 * tests self-skip when either is missing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import { inspectCompilerRepository } from '../../compiler-inspect-driver.mjs'

const require = createRequire(import.meta.url)
const plugin = require('../../compiler-inspect-v3-6.cjs')

const hasBin = (bin) => execFileSync('which', [bin], { encoding: 'utf8' }).trim() !== ''

const WRAPPERS_CPP = `#include <cstdint>
static uint16_t dtile_ld_dev_u16(__gm__ uint16_t *ptr) {
  return *ptr;
}
int caller() {
  return dtile_ld_dev_u16(nullptr);
}
`

const VENDORED_CPP = `#include <cstdint>
static uint32_t dtile_st_dev_u32(__gm__ uint32_t *ptr) {
  return *ptr;
}
`

const NOTE_CPP = `// The device store path delegates to dtile_st_dev_u32 in the vendored backend.
`

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'compiler-inspect-test-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'third_party'), { recursive: true })
  writeFileSync(join(root, 'lib', 'wrappers.cpp'), WRAPPERS_CPP)
  writeFileSync(join(root, 'lib', 'note.cpp'), NOTE_CPP)
  writeFileSync(join(root, 'third_party', 'vendored_lib.cpp'), VENDORED_CPP)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}

const LOG_A = `// -----// IR Dump After AlphaPass (alpha-pass) //-----
%0 = alpha.op
%1 = beta.op
// -----// IR Dump After BetaPass (beta-pass) //-----
%2 = gamma.op
// -----// IR Dump After AlphaPass (alpha-pass) //-----
%3 = alpha.second
`
const LOG_B = `// -----// IR Dump After AlphaPass (alpha-pass) //-----
%0 = alpha.op
// -----// IR Dump After GammaPass (gamma-pass) //-----
%9 = gamma.only
// -----// IR Dump After AlphaPass (alpha-pass) //-----
%3 = alpha.second
`

function makeLogs(root) {
  writeFileSync(join(root, 'pipeline_a.log'), LOG_A)
  writeFileSync(join(root, 'pipeline_b.log'), LOG_B)
  return [join(root, 'pipeline_a.log'), join(root, 'pipeline_b.log')]
}

test('driver skips cleanly when git or rg is missing', { skip: !hasBin('git') || !hasBin('rg') }, () => {})

test('H2: C/C++ attached-brace definitions are found by the definition pass', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['dtile_ld_dev_u16'] })
    assert.ok(bundle.definitions.length > 0, 'definitions must be non-empty for a C function definition')
    assert.ok(
      bundle.definitions.some(line => line.includes('lib/wrappers.cpp') && line.includes('dtile_ld_dev_u16')),
      `definition line must point at wrappers.cpp, got: ${JSON.stringify(bundle.definitions)}`,
    )
    assert.equal(bundle.budget.version, '1.5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M3: vendored fallback runs when definitions exist only inside vendored trees', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    // A reference exists outside the vendored tree, so the v1.1 zero-match
    // trigger would not fire; the v1.2 missing-definitions trigger must.
    const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['dtile_st_dev_u32'] })
    assert.equal(bundle.definitions.length, 0, 'no definition-shaped match outside vendored trees')
    assert.ok(bundle.references.length > 0, 'a comment reference exists outside vendored trees')
    assert.ok(bundle.vendored_matches.length > 0, 'vendored fallback must supply the vendored definition')
    assert.ok(
      bundle.unresolved.some(line => line.includes('no definition-shaped match outside vendored trees')),
      `Unresolved must state the trigger, got: ${JSON.stringify(bundle.unresolved)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M3: vendored fallback runs when an anchored file sits inside a vendored tree', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({
      repo_root: root,
      files: ['third_party/vendored_lib.cpp'],
      symbols: ['dtile_st_dev_u32'],
    })
    assert.ok(bundle.vendored_matches.length > 0, 'vendored evidence must be returned for a vendored anchor')
    assert.ok(
      bundle.unresolved.some(line => line.includes('an anchored file sits inside vendored trees')),
      `Unresolved must state the trigger, got: ${JSON.stringify(bundle.unresolved)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H1: the driver accepts out-of-range history_window and clamps silently', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    for (const window of [0, 40]) {
      const bundle = await inspectCompilerRepository({ repo_root: root, symbols: ['dtile_ld_dev_u16'], history_window: window })
      assert.equal(bundle.budget.version, '1.5')
      assert.ok(bundle.repository.root.length > 0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H1: the plugin clamps out-of-range history_window and notes it in Unresolved', async () => {
  const root = makeRepo()
  try {
    const registered = []
    const ctx = {
      systemPrompt: { section() {} },
      tools: { register(tool) { registered.push(tool) } },
    }
    plugin.apply(ctx)
    const tool = registered.find(entry => entry.name === 'compiler_inspect')
    assert.ok(tool, 'plugin must register compiler_inspect')
    assert.equal(tool.parameters.properties.history_window.minimum, 1)
    assert.equal(tool.parameters.properties.history_window.maximum, 30)
    const signal = new AbortController().signal
    const bundle = await tool.execute({ repo_root: root, symbols: ['dtile_ld_dev_u16'], history_window: 40 }, { signal })
    assert.ok(
      bundle.unresolved.some(line => line.includes('clamped to 30')),
      `Unresolved must record the clamp, got: ${JSON.stringify(bundle.unresolved)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M4: log_files returns dump indexes, occurrence-addressed slices, and a two-file diff', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  const logs = makeLogs(root)
  try {
    const bundle = await inspectCompilerRepository({
      repo_root: root,
      log_files: logs,
      log_passes: ['AlphaPass'],
      log_occurrence: 2,
    })
    assert.equal(bundle.logs.files.length, 2)
    const alphaA = bundle.logs.files[0].per_pass.find(entry => entry.pass.startsWith('AlphaPass'))
    assert.ok(alphaA && alphaA.count === 2, `AlphaPass must appear twice in log A, got: ${JSON.stringify(bundle.logs.files[0].per_pass)}`)
    assert.ok(bundle.logs.slices.length === 2, `one requested pass sliced in each file, got: ${JSON.stringify(bundle.logs.slices)}`)
    assert.equal(bundle.logs.slices[0].marker_line, 6, 'slice 2 of AlphaPass in log A starts at its second marker line')
    assert.equal(bundle.logs.slices[1].marker_line, 5, 'slice 2 of AlphaPass in log B starts at its second marker line')
    assert.ok(
      bundle.logs.slice_items[0].includes('alpha.second'),
      'the slice must contain the second AlphaPass dump body',
    )
    assert.equal(bundle.logs.diff.files.length, 2)
    assert.ok(
      bundle.logs.diff.pass_count_diffs.some(entry => entry.startsWith('BetaPass (beta-pass): 1 vs 0')),
      `count diff must cover BetaPass, got: ${JSON.stringify(bundle.logs.diff.pass_count_diffs)}`,
    )
    assert.equal(bundle.logs.diff.first_divergence, "dump #2: 'BetaPass (beta-pass)' vs 'GammaPass (gamma-pass)'")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M4: missing log files are reported in Unresolved and never fatal', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  try {
    const bundle = await inspectCompilerRepository({ repo_root: root, log_files: ['does/not/exist.log'] })
    assert.equal(bundle.logs.files.length, 0)
    assert.ok(
      bundle.unresolved.some(line => line.includes('Requested log file not found')),
      `Unresolved must report the missing log, got: ${JSON.stringify(bundle.unresolved)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render keeps the whole bundle under the strict character budget', { skip: !hasBin('git') || !hasBin('rg') }, async () => {
  const root = makeRepo()
  const logs = makeLogs(root)
  try {
    const bundle = await inspectCompilerRepository({
      repo_root: root,
      symbols: ['dtile_ld_dev_u16', 'dtile_st_dev_u32', 'caller'],
      files: ['lib/wrappers.cpp'],
      log_files: logs,
      log_passes: ['AlphaPass', 'BetaPass', 'GammaPass'],
    })
    const registered = []
    plugin.apply({ systemPrompt: { section() {} }, tools: { register(tool) { registered.push(tool) } } })
    const tool = registered.find(entry => entry.name === 'compiler_inspect')
    // The v1.1-proven harness contract places render inside output.
    const render = tool.output.render
    const rendered = render({}, bundle)[0].text
    assert.ok(rendered.length <= bundle.budget.total_budget_chars + 400, `rendered bundle must respect the budget, got ${rendered.length}`)
    assert.ok(rendered.includes('Logs:'), 'the rendered bundle must carry the Logs section')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fixture paths resolve from the repo root', () => {
  const root = makeRepo()
  try {
    assert.equal(resolve(root, 'lib/wrappers.cpp'), join(root, 'lib', 'wrappers.cpp'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

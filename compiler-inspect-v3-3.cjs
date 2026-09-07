/**
 * compiler-dev preset plugin: the always-on core policy section plus the
 * `compiler_inspect` tool (v1.2). It consumes host services and publishes no
 * service, so its composition row stays outside a realm.
 *
 * The core policy is deliberately always-on: real compiler sessions showed the
 * model does not reliably load a skill first, and the small invariant set that
 * defines this preset (contract-first anchors, one evidence bundle, bounded
 * output, domain boundary) must govern every step. The preset-local
 * `compiler-development` skill carries the detailed, conditional guidance.
 *
 * v1.2 (2026-09-06 case feedback): history_window declares its 1–30 range in
 * the schema and clamps with an Unresolved note instead of failing the call;
 * the policy text gains the task-type rulings the production sessions needed
 * (artifact-first analysis, stale build artifacts, generated-file floods,
 * checkpoint semantics); the driver adds C/C++ definition shapes, a relaxed
 * vendored fallback, and bounded pipeline-log forensics (`log_files`).
 */

exports.name = 'compiler-inspect'
exports.inject = ['tools', 'systemPrompt']

const CORE_POLICY = `Compiler-dev core policy (always on; the compiler-development skill holds the detailed workflow):
1. A human Repository Contract (AGENTS.md or a nearby contract file) and project instructions are authoritative operational knowledge.
2. Do not rediscover documented environment/build/test procedures unless the documented procedure fails at point of use or the task is about that infrastructure.
3. Build only the task-relevant architecture or data-flow model, not repository-wide understanding.
4. Treat latest-N commits as a history search horizon; prefer path- or symbol-scoped history and read full commits only for cross-file design intent.
5. For code review, design review, semantic investigation, pass analysis, API analysis, or recent-history tasks with explicit file or symbol anchors, call compiler_inspect once as the FIRST repository-inspection step, before serial grep/read/git exploration. Skip it when one already-known file answers the task, the task is pure execution of a Repository-Contract build/test command, the task is writing a commit or PR description, or the user says not to use it. Git-mechanics recon (status/fetch/merge-base) and environment validation are not repository-inspection steps, and it is not for build- or environment-only work. When the task starts from artifacts outside the repository (pipeline logs, IR dumps, issue directories), analyze the artifact first and call compiler_inspect as the first step once the investigation moves into the owning repository's source.
6. Keep changes semantically minimal: the smallest patch that satisfies the task; no unrelated refactors, formatting, renames, or dependency changes.
7. Bound verification. Classify each failure as patch-caused, environment, pre-existing, or unknown; when a rebuilt binary and a not-rebuilt tool disagree, suspect a stale build artifact first and confirm what you test was actually rebuilt. After one focused control experiment proves a blocker unrelated, record it and stop investigating it.
8. Do not stream predictably huge output into context (ninja -t commands, full build logs, verbose link lines, broad find, large git show, verbose test listings, grep over generated build files such as build.ninja/CMakeFiles/link.txt, or reads of IR/JSON files that can hold extremely long lines — sense-check with wc -c/wc -L first). Redirect to a temporary log, then extract a bounded slice with grep, head, tail, or sed ranges.
9. Before a design-sensitive edit, after a large discovery phase, and before a long verification phase, retain a one-line checkpoint: Decision; Evidence; Uncertainty; Patch implication. In long implementation or debug loops, re-emit the checkpoint whenever the working hypothesis changes; a decision that exists only in your reasoning does not count as a checkpoint, and a design-freeze checkpoint must reconcile the stated contract against the implementation item by item. Spend long reasoning on checkpoints and structured notes rather than single enormous thinking blocks.
10. Domain boundary: this preset is for compiler repository engineering. If the task becomes modifying DeepSeek Harness itself, agent presets, Cordis plugins, DSH Web/UI, or DSH runtime infrastructure, do not start that investigation here: finish any running compiler build/test, then continue the Harness work in a fresh Creator-mode session. Merely mentioning DSH does not trigger this; only DSH becoming the implementation target does.`

/** Summarize the v1.2 log-forensics object into bounded Logs-section items. */
function logsSectionItems(logs) {
  if (!logs || (logs.files.length === 0 && logs.slices.length === 0 && logs.diff === null)) return []
  const items = []
  for (const file of logs.files) {
    const top = file.per_pass.slice(0, 4).map(entry => `${entry.pass}(${entry.count}@L${entry.first_line})`).join(', ')
    items.push(`${file.path} — ${file.lines} lines, ${file.dump_total} IR dumps; top passes: ${top || 'none'}`)
  }
  if (logs.diff !== null) {
    if (logs.diff.first_divergence !== null) items.push(`First sequence divergence — ${logs.diff.first_divergence}`)
    items.push(...logs.diff.pass_count_diffs.map(entry => `Count diff — ${entry}`))
    items.push(...logs.diff.aligned_first_lines.map(entry => `Aligned first dumps — ${entry}`))
  }
  items.push(...logs.slice_items)
  return items
}

function renderBundle(bundle) {
  const sections = [
    ['Definitions', bundle.definitions],
    ['References', bundle.references],
    ['Vendored matches', bundle.vendored_matches],
    ['Tests', bundle.tests],
    ['Current changes', bundle.changes],
    ['History', bundle.history],
    ['Logs', logsSectionItems(bundle.logs)],
    ['Unresolved', bundle.unresolved],
  ]
  return [
    `Repository: ${bundle.repository.root} (${bundle.repository.branch}; ${bundle.repository.dirty})`,
    `Anchors: files=${bundle.anchors.files.join(', ') || 'none'}; symbols=${bundle.anchors.symbols.join(', ') || 'none'}`,
    ...sections.map(([name, items]) => `${name}:\n${items.length ? items.map(item => `- ${item}`).join('\n') : '- none'}`),
    `Budget: ${bundle.budget.max_items_per_section} items/section, ${bundle.budget.max_line_chars} chars/line, total ${bundle.budget.total_budget_chars} chars${bundle.budget.truncated ? ' (TRUNCATED — inspect specific files for more)' : ''}`,
  ].join('\n\n')
}

exports.apply = function apply(ctx) {
  ctx.systemPrompt.section({ name: 'compiler-development-policy', order: 114, text: CORE_POLICY })
  // The driver runs IN-PROCESS: it is a fixed, read-only script bundled with
  // this preset (git/rg reads only, arguments never reach a shell), so the
  // shell/sandbox round-trip would add failure modes without adding
  // confinement value. A 60s guard bounds each call. The `?v=1.2` query busts
  // the host process's ESM module cache when the driver is edited in place:
  // bump the query (or rename this file) to reload edits.
  const driverPromise = import(new URL('./compiler-inspect-driver.mjs?v=1.2', `file://${__filename}`).href)
  ctx.tools.register({
    name: 'compiler_inspect',
    description: 'Build one bounded evidence bundle for a compiler repository task in a single call: Git state, anchored files and symbols, probable definitions with context, ranked references, likely tests, optional working-tree diff, path/symbol-scoped history, and optional bounded pipeline-log forensics (pass log_files to index `IR Dump After/Before` markers, slice requested passes by occurrence, and diff two logs). For code review, design review, semantic investigation, pass analysis, API analysis, or recent-history tasks with explicit file or symbol anchors, call this FIRST, before serial grep/read/git exploration. history_window accepts 1-30. Not for build or environment discovery, and not for running documented build/test commands.',
    parameters: { type: 'object', additionalProperties: false, properties: { repo_root: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } }, history_window: { type: 'integer', minimum: 1, maximum: 30 }, include_tests: { type: 'boolean' }, include_diff: { type: 'boolean' }, contract_test_dirs: { type: 'array', items: { type: 'string' } }, exclude_dirs: { type: 'array', items: { type: 'string' } }, log_files: { type: 'array', items: { type: 'string' }, maxItems: 4 }, log_passes: { type: 'array', items: { type: 'string' }, maxItems: 8 }, log_occurrence: { type: 'integer', minimum: 1 }, log_slice_lines: { type: 'integer', minimum: 5, maximum: 400 } } },
    output: { schema: { type: 'object', additionalProperties: false, required: ['repository', 'anchors', 'definitions', 'references', 'tests', 'changes', 'history', 'logs', 'unresolved', 'budget'], properties: { repository: { type: 'object', additionalProperties: false, required: ['root', 'branch', 'dirty'], properties: { root: { type: 'string' }, branch: { type: 'string' }, dirty: { type: 'string' } } }, anchors: { type: 'object', additionalProperties: false, required: ['files', 'symbols'], properties: { files: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } } } }, definitions: { type: 'array', items: { type: 'string' } }, references: { type: 'array', items: { type: 'string' } }, vendored_matches: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, changes: { type: 'array', items: { type: 'string' } }, history: { type: 'array', items: { type: 'string' } }, logs: { type: 'object', additionalProperties: false, required: ['files', 'slices', 'slice_items', 'diff', 'truncated'], properties: { files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'lines', 'bytes', 'dump_total', 'per_pass'], properties: { path: { type: 'string' }, lines: { type: 'integer' }, bytes: { type: 'integer' }, dump_total: { type: 'integer' }, per_pass: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pass', 'count', 'first_line'], properties: { pass: { type: 'string' }, count: { type: 'integer' }, first_line: { type: 'integer' } } } } } } }, slices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'pass', 'occurrence', 'marker_line', 'lines'], properties: { file: { type: 'string' }, pass: { type: 'string' }, occurrence: { type: 'integer' }, marker_line: { type: 'integer' }, lines: { type: 'integer' } } } }, slice_items: { type: 'array', items: { type: 'string' } }, diff: { oneOf: [{ type: 'object', additionalProperties: false, required: ['files', 'pass_count_diffs', 'first_divergence', 'aligned_first_lines'], properties: { files: { type: 'array', items: { type: 'string' } }, pass_count_diffs: { type: 'array', items: { type: 'string' } }, first_divergence: { oneOf: [{ type: 'string' }, { type: 'null' }] }, aligned_first_lines: { type: 'array', items: { type: 'string' } } } }, { type: 'null' }] }, truncated: { type: 'boolean' } } }, unresolved: { type: 'array', items: { type: 'string' } }, budget: { type: 'object', additionalProperties: false, required: ['max_items_per_section', 'max_line_chars', 'total_budget_chars', 'truncated', 'version'], properties: { max_items_per_section: { type: 'integer' }, max_line_chars: { type: 'integer' }, total_budget_chars: { type: 'integer' }, truncated: { type: 'boolean' }, version: { type: 'string' } } } } }, render: (_args, value) => [{ type: 'text', text: renderBundle(value) }] },
    async execute(args, exec) {
      const driverArgs = { ...args }
      let clampNote
      if (driverArgs.history_window !== undefined) {
        const clamped = Math.max(1, Math.min(30, Math.floor(driverArgs.history_window)))
        if (clamped !== driverArgs.history_window) {
          clampNote = `history_window ${driverArgs.history_window} is outside its 1-30 range; clamped to ${clamped}.`
          driverArgs.history_window = clamped
        }
      }
      const driver = await driverPromise
      const guard = new AbortController()
      const timeout = setTimeout(() => guard.abort(new Error('compiler_inspect timed out after 60000 ms')), 60000)
      const onAbort = () => guard.abort(exec.signal.reason)
      if (exec.signal.aborted) guard.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const workdir = args.repo_root ?? process.cwd()
        const result = await driver.inspectCompilerRepository({ ...driverArgs, repo_root: workdir }, guard.signal)
        if (clampNote !== undefined) result.unresolved = [clampNote, ...result.unresolved]
        return result
      } finally {
        clearTimeout(timeout)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}

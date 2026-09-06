/**
 * compiler-dev preset plugin: the always-on core policy section plus the
 * `compiler_inspect` tool (v1.1). It consumes host services and publishes no
 * service, so its composition row stays outside a realm.
 *
 * The core policy is deliberately always-on: real compiler sessions showed the
 * model does not reliably load a skill first, and the small invariant set that
 * defines this preset (contract-first anchors, one evidence bundle, bounded
 * output, domain boundary) must govern every step. The preset-local
 * `compiler-development` skill carries the detailed, conditional guidance.
 */

exports.name = 'compiler-inspect'
exports.inject = ['tools', 'systemPrompt']

const CORE_POLICY = `Compiler-dev core policy (always on; the compiler-development skill holds the detailed workflow):
1. A human Repository Contract (AGENTS.md or a nearby contract file) and project instructions are authoritative operational knowledge.
2. Do not rediscover documented environment/build/test procedures unless the documented procedure fails at point of use or the task is about that infrastructure.
3. Build only the task-relevant architecture or data-flow model, not repository-wide understanding.
4. Treat latest-N commits as a history search horizon; prefer path- or symbol-scoped history and read full commits only for cross-file design intent.
5. For code review, design review, semantic investigation, pass analysis, API analysis, or recent-history tasks with explicit file or symbol anchors, call compiler_inspect once as the FIRST repository-inspection step, before serial grep/read/git exploration. Skip it only when one already-known file answers the task, the task is pure execution of a Repository-Contract build/test command, or the user says not to use it. It is not for build- or environment-only work.
6. Keep changes semantically minimal: the smallest patch that satisfies the task; no unrelated refactors, formatting, renames, or dependency changes.
7. Bound verification. Classify each failure as patch-caused, environment, pre-existing, or unknown; after one focused control experiment proves a blocker unrelated, record it and stop investigating it.
8. Do not stream predictably huge output into context (ninja -t commands, full build logs, verbose link lines, broad find, large git show, verbose test listings). Redirect to a temporary log, then extract a bounded slice with grep, head, tail, or sed ranges.
9. Before a design-sensitive edit, after a large discovery phase, and before a long verification phase, retain a one-line checkpoint: Decision; Evidence; Uncertainty; Patch implication.
10. Domain boundary: this preset is for compiler repository engineering. If the task becomes modifying DeepSeek Harness itself, agent presets, Cordis plugins, DSH Web/UI, or DSH runtime infrastructure, do not start that investigation here: finish any running compiler build/test, then continue the Harness work in a fresh Creator-mode session. Merely mentioning DSH does not trigger this; only DSH becoming the implementation target does.`

function renderBundle(bundle) {
  const sections = [
    ['Definitions', bundle.definitions],
    ['References', bundle.references],
    ['Vendored matches', bundle.vendored_matches],
    ['Tests', bundle.tests],
    ['Current changes', bundle.changes],
    ['History', bundle.history],
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
  // confinement value. A 60s guard bounds each call. The `?v=1.1` query busts
  // the host process's ESM module cache when the driver is edited in place:
  // bump the query (or rename this file) to reload edits.
  const driverPromise = import(new URL('./compiler-inspect-driver.mjs?v=1.1', `file://${__filename}`).href)
  ctx.tools.register({
    name: 'compiler_inspect',
    description: 'Build one bounded evidence bundle for a compiler repository task in a single call: Git state, anchored files and symbols, probable definitions with context, ranked references, likely tests, optional working-tree diff, and path/symbol-scoped history. For code review, design review, semantic investigation, pass analysis, API analysis, or recent-history tasks with explicit file or symbol anchors, call this FIRST, before serial grep/read/git exploration. Not for build or environment discovery, and not for running documented build/test commands.',
    parameters: { type: 'object', additionalProperties: false, properties: { repo_root: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } }, history_window: { type: 'integer' }, include_tests: { type: 'boolean' }, include_diff: { type: 'boolean' }, contract_test_dirs: { type: 'array', items: { type: 'string' } }, exclude_dirs: { type: 'array', items: { type: 'string' } } } },
    output: { schema: { type: 'object', additionalProperties: false, required: ['repository', 'anchors', 'definitions', 'references', 'tests', 'changes', 'history', 'unresolved', 'budget'], properties: { repository: { type: 'object', additionalProperties: false, required: ['root', 'branch', 'dirty'], properties: { root: { type: 'string' }, branch: { type: 'string' }, dirty: { type: 'string' } } }, anchors: { type: 'object', additionalProperties: false, required: ['files', 'symbols'], properties: { files: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } } } }, definitions: { type: 'array', items: { type: 'string' } }, references: { type: 'array', items: { type: 'string' } }, vendored_matches: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, changes: { type: 'array', items: { type: 'string' } }, history: { type: 'array', items: { type: 'string' } }, unresolved: { type: 'array', items: { type: 'string' } }, budget: { type: 'object', additionalProperties: false, required: ['max_items_per_section', 'max_line_chars', 'total_budget_chars', 'truncated', 'version'], properties: { max_items_per_section: { type: 'integer' }, max_line_chars: { type: 'integer' }, total_budget_chars: { type: 'integer' }, truncated: { type: 'boolean' }, version: { type: 'string' } } } } }, render: (_args, value) => [{ type: 'text', text: renderBundle(value) }] },
    async execute(args, exec) {
      if (args.history_window !== undefined && (args.history_window < 1 || args.history_window > 30)) throw new Error('history_window must be between 1 and 30')
      const driver = await driverPromise
      const guard = new AbortController()
      const timeout = setTimeout(() => guard.abort(new Error('compiler_inspect timed out after 60000 ms')), 60000)
      const onAbort = () => guard.abort(exec.signal.reason)
      if (exec.signal.aborted) guard.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const workdir = args.repo_root ?? process.cwd()
        return await driver.inspectCompilerRepository({ ...args, repo_root: workdir }, guard.signal)
      } finally {
        clearTimeout(timeout)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}

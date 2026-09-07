/**
 * compiler-dev preset plugin: the `compiler_knowledge` tool plus the always-on
 * compiler knowledge routing section. It consumes host services and publishes
 * no service, so its composition row stays outside a realm.
 *
 * Purpose (2026-09-07 knowledge integration): the 2026-09-06 case feedback
 * showed 9 production sessions with ZERO calls of the four deterministic
 * knowledge queries that mlir-compiler-harness ships for exactly these task
 * shapes — the queries existed but the preset had no routing entry. This row
 * is that routing: knowledge-first for matching task types (repository context
 * → compiler memory → review findings → analyze source), routed by task type,
 * never forced.
 *
 * The tool wraps the mlir-repomap CLI in-process (driver: argument-array spawn,
 * JSON envelope only, stale-index auto-refresh per the query contract, strict
 * output budget, non-sensitive query log under analysis/feedback/queries/).
 */

exports.name = 'compiler-knowledge'
exports.inject = ['tools', 'systemPrompt']

const KNOWLEDGE_POLICY = `Compiler knowledge routing (always on; contract: mlir-compiler-harness adapters/compiler-dev). For pass review, compiler-bug investigation, finding re-check, or pipeline/architecture analysis (including Triton lowering order), work in this order before serial source exploration: (1) understand repository context (Repository Contract / AGENTS.md); (2) query compiler memory with compiler_knowledge; (3) review what it returns — review records, invariant guards, linked findings; (4) analyze only the source the results leave open, using compiler_inspect or targeted reads fed by the returned file:line anchors. Route by task type: compiler bug or pass review starts with review <pass>, then finding-impact on linked findings and evidence on key nodes; architecture or pipeline analysis starts with pipeline-stages <pipeline> (Python compositions — a C++ pipeline reports not-a-Python-composition), then evidence on key stages. Skip knowledge queries for build/test execution, single-known-file edits, commit/PR text, or when the user says not to — the same skip rules as compiler_inspect. Queries are deterministic retrieval, not judgment: treat diagnostics, "not found", and empty memory as real negatives, never guess across unresolved references, and keep the raw JSON with the file:line work record. If a task still needs manual source search the queries should have covered, or expected knowledge came back empty, record one non-sensitive feedback artifact (task, queries used, manual-search reason, possible gap) per adapters/compiler-dev/feedback-schema.md when the task ends.`

exports.apply = function apply(ctx) {
  ctx.systemPrompt.section({ name: 'compiler-knowledge-routing', order: 115, text: KNOWLEDGE_POLICY })
  // The driver runs IN-PROCESS: fixed, read-only script bundled with this
  // preset (argument-array spawns of the mlir-repomap CLI only, arguments never
  // reach a shell). A 240s guard bounds each call — an auto `index --full`
  // after a rebase takes ~100s on AscendNPU-IR. The `?v=` query busts the host
  // process's ESM module cache when the driver is edited in place.
  const driverPromise = import(new URL('./compiler-knowledge-driver.mjs?v=1.0', `file://${__filename}`).href)
  ctx.tools.register({
    name: 'compiler_knowledge',
    description: 'Deterministic compiler-memory queries over the mlir-repomap knowledge graph (mlir-compiler-harness adapters/compiler-dev contract). Commands: review <pass> — pass identity, verbatim review records, invariant guards, linked findings with impact signals; finding-impact <id> — affected entities, evidence-file drift, constraint diffs, review-scope suggestion; pipeline-stages <pipeline> — AST-confirmed Python composition order with file:line evidence (C++ pipelines report not-a-Python-composition); evidence <node-or-edge-id> — file:line evidence rows, structurally matched findings, recent history of the primary file; status — index freshness and entity counts. For pass review / compiler bugs / finding re-checks / pipeline and architecture analysis, query this BEFORE serial source exploration and route by task type (bug → review/finding-impact, architecture → pipeline-stages); skip it for build/test execution, single-known-file edits, or commit/PR text. Retrieval only: never generates reasoning, mutates findings, or writes the graph. A stale index is refreshed automatically (index --full, up to ~2-4 min) unless refresh_index:false; the call is bounded and refuses to serve stale results.',
    parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: {
      command: { type: 'string', enum: ['review', 'finding-impact', 'pipeline-stages', 'evidence', 'status'], description: 'Knowledge query to run.' },
      name: { type: 'string', description: 'Target: pass arg/class/factory name (review), finding id such as MVS-001 (finding-impact), pipeline function name such as make_ttir (pipeline-stages), or node/edge id such as pass:hfusion-merge-vf (evidence). Required for all commands except status.' },
      repo_root: { type: 'string', description: 'Target compiler repository (default: cwd). The repo must have an mlir-repomap index.' },
      refresh_index: { type: 'boolean', description: 'When the index is stale, refresh it in this call (default true). false returns a stale refusal instead of results.' },
      findings_dir: { type: 'string', description: 'review/finding-impact --dir: findings directory override.' },
      docs_dir: { type: 'string', description: 'review --docs-dir: compiler-architecture docs override.' },
      git_repo: { type: 'string', description: 'review/finding-impact --git-repo override.' },
      since: { type: 'string', description: 'review/finding-impact --since ref.' },
    } },
    output: { schema: { type: 'object', additionalProperties: true, required: ['command', 'index', 'result'], properties: {
      command: { type: 'string' },
      index: { type: 'object', description: 'Index envelope: head, branch, stale.' },
      result: { type: 'object', description: 'Command result verbatim from the CLI, bounded by budget.' },
      delivery: { type: 'object', description: 'Driver version, refresh report, truncation notes.' },
    } } },
    async execute(args, exec) {
      const driver = await driverPromise
      const guard = new AbortController()
      const timeout = setTimeout(() => guard.abort(new Error('compiler_knowledge timed out after 240000 ms')), 240000)
      const onAbort = () => guard.abort(exec.signal.reason)
      if (exec.signal.aborted) guard.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await driver.runKnowledgeQuery(args, guard.signal)
      } finally {
        clearTimeout(timeout)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}

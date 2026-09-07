/**
 * compiler-dev preset plugin: the `compiler_knowledge` tool, the new
 * `compiler_route` decision tool, and the always-on compiler knowledge routing
 * section. It consumes host services and publishes no service, so its
 * composition row stays outside a realm.
 *
 * Phase 2 (2026-09-07, production knowledge observation loop): the
 * knowledge-first policy becomes observable. Each real task opens with one
 * compact `compiler_route` decision (route kind, knowledge_expected,
 * confidence, reason category — never task text), which mints the session/task
 * correlation id stamped onto every subsequent `compiler_knowledge` query
 * record. Route decisions and query records land in gitignored runtime
 * streams; the offline analyzer, candidate generator, and bundle exporter
 * correlate them by that id. Routing stays conservative: the goal is correct
 * routing, not a higher call rate.
 *
 * v3 (Phase R1): the minted correlation id is ALSO published to the shared
 * per-agent observation state (compiler-observation-state.mjs) so the
 * `compiler_inspect` context observation stream can stamp the same id without
 * a cross-plugin service. No semantic coupling: nothing about knowledge
 * queries, graphs, or findings crosses this boundary — only the opaque id.
 *
 * State is keyed per agent (Session) because the preset is mounted once under
 * a standing scope and every joined session shares this module instance.
 *
 * The tool wraps the mlir-repomap CLI in-process (driver: argument-array spawn,
 * JSON envelope only, stale-index auto-refresh per the query contract, strict
 * output budget, non-sensitive query log under analysis/feedback/queries/).
 */

exports.name = 'compiler-knowledge'
exports.inject = ['tools', 'systemPrompt']

const ROUTE_KINDS = [
  'pass-review', 'finding-review', 'pipeline-audit', 'anchored-code-analysis',
  'single-file-edit', 'build-test', 'commit-pr', 'environment', 'git-operation',
  'log-forensics', 'other',
]
const ROUTE_REASONS = [
  'named-pass', 'named-pipeline', 'named-finding', 'anchored-analysis',
  'known-single-file', 'execution-only', 'environment-issue', 'git-operation',
  'commit-or-pr-text', 'log-domain', 'user-declined', 'out-of-domain', 'unclear',
]
const CONFIDENCE = ['low', 'medium', 'high']

const KNOWLEDGE_POLICY = `Compiler knowledge routing (always on; contract: mlir-compiler-harness adapters/compiler-dev). For pass review, compiler-bug investigation, finding re-check, or pipeline/architecture analysis (including Triton lowering order), work in this order before serial source exploration: (1) understand repository context (Repository Contract / AGENTS.md); (2) query compiler memory with compiler_knowledge; (3) review what it returns — review records, invariant guards, linked findings; (4) analyze only the source the results leave open, using compiler_inspect or targeted reads fed by the returned file:line anchors. At the start of each real task, emit exactly one compact route decision with compiler_route (route kind, knowledge_expected, confidence, reason category, optional stable target id — never task text or prompt content). Be conservative: only a high-confidence pass/pipeline/finding angle sets knowledge_expected=true; single-known-file edits, build/test execution, environment issues, git operations, commit/PR text, pipeline-log forensics, and out-of-domain work are declared skips. Route by task type: compiler bug or pass review starts with review <pass>, then finding-impact on linked findings and evidence on key nodes; architecture or pipeline analysis starts with pipeline-stages <pipeline> (Python compositions — a C++ pipeline reports not-a-Python-composition), then evidence on key stages. Skip knowledge queries for build/test execution, single-known-file edits, commit/PR text, or when the user says not to — the same skip rules as compiler_inspect. Do not over-query: if the first query already answers the task, stop; query only the minimum the workflow contract needs. Queries are deterministic retrieval, not judgment: treat diagnostics, "not found", and empty memory as real negatives, never guess across unresolved references, and keep the raw JSON with the file:line work record. If a task still needs manual source search the queries should have covered, or expected knowledge came back empty, record one non-sensitive feedback artifact (task, queries used, manual-search reason, possible gap) per adapters/compiler-dev/feedback-schema.md when the task ends — offline tooling generates automatic candidates from the route/query logs, so write an artifact only for a verified gap the automation cannot see.`

// Per-agent (per-Session) route state. The preset is mounted once under a
// standing scope; every joined session shares this module instance, so all
// state MUST be keyed by the executing agent's id. Values are small owned
// objects — no host references are retained.
const routeState = new Map()

// Observation streams default to the preset's gitignored analysis/feedback/;
// tests (and non-standard installs) redirect them with COMPILER_DEV_FEEDBACK_DIR.
// Resolved lazily so tests can set the variable before any call.
function logDirs() {
  const override = process.env.COMPILER_DEV_FEEDBACK_DIR
  if (override === undefined || override === '') return undefined
  const { resolve, join } = require('node:path')
  const root = resolve(override)
  return { routes: join(root, 'routes'), queries: join(root, 'queries') }
}

function stateFor(agentKey) {
  const key = typeof agentKey === 'string' && agentKey !== '' ? agentKey : '(unknown)'
  let state = routeState.get(key)
  if (state === undefined) {
    state = { correlationId: undefined, route: undefined }
    routeState.set(key, state)
  }
  return state
}

/** Compact tool output renderer: JSON only, one bounded block. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }]

exports.apply = function apply(ctx) {
  ctx.systemPrompt.section({ name: 'compiler-knowledge-routing', order: 115, text: KNOWLEDGE_POLICY })
  // The driver runs IN-PROCESS: fixed, read-only script bundled with this
  // preset (argument-array spawns of the mlir-repomap CLI only, arguments never
  // reach a shell). A 240s guard bounds each call — an auto `index --full`
  // after a rebase takes ~100s on AscendNPU-IR. The `?v=` query busts the host
  // process's ESM module cache when the driver is edited in place.
  const driverPromise = import(new URL('./compiler-knowledge-driver.mjs?v=2.0', `file://${__filename}`).href)
  const statePromise = import(new URL('./compiler-observation-state.mjs', `file://${__filename}`).href)

  ctx.tools.register({
    name: 'compiler_route',
    description: 'Declare the task\'s knowledge route decision (one per real task, at task start). Records route kind, whether compiler knowledge is expected, confidence, and a reason category — never task text. Mints the correlation id that links this task\'s route decision, compiler_knowledge query log lines, and offline analysis. Conservative routing: only high-confidence pass/pipeline/finding analysis sets knowledge_expected=true; single-known-file edits, build/test execution, environment issues, git operations, commit/PR text, log forensics, and out-of-domain work are declared skips (knowledge_expected=false). Route decisions are usage observations, not compiler facts.',
    parameters: { type: 'object', additionalProperties: false, required: ['route', 'knowledge_expected', 'confidence', 'reason'], properties: {
      route: { type: 'string', enum: ROUTE_KINDS, description: 'Task shape: pass-review (compiler bug / pass review), finding-review (finding re-check), pipeline-audit (architecture / pipeline / Triton lowering), anchored-code-analysis (anchored source analysis with a knowledge angle), single-file-edit, build-test, commit-pr, environment, git-operation, log-forensics, other.' },
      knowledge_expected: { type: 'boolean', description: 'Whether compiler_knowledge queries are expected for this task (true only for high-confidence pass/pipeline/finding angles).' },
      confidence: { type: 'string', enum: CONFIDENCE, description: 'Confidence in the route classification.' },
      reason: { type: 'string', enum: ROUTE_REASONS, description: 'Reason category (never free text): named-pass, named-pipeline, named-finding, anchored-analysis, known-single-file, execution-only, environment-issue, git-operation, commit-or-pr-text, log-domain, user-declined, out-of-domain, unclear.' },
      target: { type: 'string', description: 'Optional stable target id, e.g. pass:hfusion-merge-vf or finding:MVS-001. Never a prompt excerpt; capped at 120 chars.' },
    } },
    output: { schema: { type: 'object', additionalProperties: false, required: ['correlation_id', 'route', 'knowledge_expected', 'logged'], properties: {
      correlation_id: { type: 'string', description: 'Opaque session/task correlation id stamped onto this task\'s knowledge query records.' },
      route: { type: 'string' },
      knowledge_expected: { type: 'boolean' },
      logged: { type: 'boolean' },
    } }, render: renderJson },
    async execute(args, exec) {
      const [driver, state] = await Promise.all([driverPromise, statePromise])
      const agentKey = exec?.agent?.id
      const state0 = stateFor(agentKey)
      state0.correlationId = driver.newCorrelationId()
      state0.route = {
        kind: args.route,
        knowledgeExpected: args.knowledge_expected === true,
        confidence: args.confidence,
        reason: args.reason,
        target: typeof args.target === 'string' && args.target.trim() !== '' ? args.target.trim().slice(0, 120) : undefined,
      }
      // Publish the id to the shared observation state so the compiler_inspect
      // context stream can correlate with this task (opaque id only).
      state.setAgentCorrelationId(agentKey, state0.correlationId)
      const record = {
        ts: new Date().toISOString(),
        correlation_id: state0.correlationId,
        route: state0.route.kind,
        knowledge_expected: state0.route.knowledgeExpected,
        confidence: state0.route.confidence,
        reason: state0.route.reason,
      }
      if (state0.route.target !== undefined) record.target = state0.route.target
      const logged = driver.logRouteRecord(record, logDirs()?.routes)
      return { correlation_id: state0.correlationId, route: state0.route.kind, knowledge_expected: state0.route.knowledgeExpected, logged }
    },
  })

  ctx.tools.register({
    name: 'compiler_knowledge',
    description: 'Deterministic compiler-memory queries over the mlir-repomap knowledge graph (mlir-compiler-harness adapters/compiler-dev contract). Commands: review <pass> — pass identity, verbatim review records, invariant guards, linked findings with impact signals; finding-impact <id> — affected entities, evidence-file drift, constraint diffs, review-scope suggestion; pipeline-stages <pipeline> — AST-confirmed Python composition order with file:line evidence (C++ pipelines report not-a-Python-composition); evidence <node-or-edge-id> — file:line evidence rows, structurally matched findings, recent history of the primary file; status — index freshness and entity counts. For tasks routed with knowledge_expected=true, query this BEFORE serial source exploration and follow the workflow-contract sequence (bug → review/finding-impact, architecture → pipeline-stages); stop once a query answers the task. Retrieval only: never generates reasoning, mutates findings, or writes the graph. A stale index is refreshed automatically (index --full, up to ~2-4 min) unless refresh_index:false; the call is bounded and refuses to serve stale results.',
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
      delivery: { type: 'object', description: 'Driver version, correlation id, refresh report, truncation notes.' },
    } }, render: renderJson },
    async execute(args, exec) {
      const [driver, state] = await Promise.all([driverPromise, statePromise])
      const agentKey = exec?.agent?.id
      const state2 = stateFor(agentKey)
      if (state2.correlationId === undefined) {
        state2.correlationId = driver.newCorrelationId()
        state.setAgentCorrelationId(agentKey, state2.correlationId)
      }
      const context = {
        correlationId: state2.correlationId,
        route: state2.route?.kind,
        knowledgeExpected: state2.route?.knowledgeExpected,
      }
      const guard = new AbortController()
      const timeout = setTimeout(() => guard.abort(new Error('compiler_knowledge timed out after 240000 ms')), 240000)
      const onAbort = () => guard.abort(exec.signal.reason)
      if (exec.signal.aborted) guard.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await driver.runKnowledgeQuery(args, guard.signal, logDirs()?.queries, undefined, context)
      } finally {
        clearTimeout(timeout)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}

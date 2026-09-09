/**
 * compiler-dev preset plugin: the `compiler_explain` tool and the always-on
 * code-explanation routing section. Same ownership shape as compiler-inspect /
 * compiler-knowledge: model-facing tool and prompt only, consumes host
 * services, publishes no service, so its composition row stays outside a
 * realm.
 *
 * The tool is the deterministic half of the generic Code Explanation
 * capability: it scaffolds teaching artifact bundles (subject / evidence /
 * dossier / handoff / readiness), validates them against the Teaching
 * Artifact Protocol (scripts/teaching-schema.mjs), runs the mechanical part
 * of the presentation-readiness gate, and evaluates artifact staleness.
 * It never generates teaching content — mechanisms, mental models,
 * storylines, and the semantic readiness verdict are agent reasoning recorded
 * in the artifacts and reviewed through the required semantic-review section.
 *
 * v1 (2026-09-08): generic subject model (11 subject types, common core +
 * one type extension), evidence-discipline enforcement, semantic-only visual
 * specs, depth model (overview/standard/deep/presentation).
 * v2 (2026-09-08, Phase T2): always-on policy routes presentation requests to
 * the handoff-first consumer path (compiler-architecture-presentation skill +
 * scripts/preflight-handoff.mjs gate) so Explain → Teach → Handoff → Present
 * is one chain, not two independent re-analyses. No tool-surface change.
 * v2.1 (2026-09-08, Phase T3): system story composition — compose-preflight,
 * compose-plan, compose-validate, compose-render. A system story is a NORMAL
 * teaching bundle (workflow/component_group/subsystem subject) plus one
 * composition.json provenance artifact; READY+FRESH child bundles are the
 * semantic source, cross-component claims cite fresh composition evidence or
 * namespaced child-evidence imports (alias::EV-ID) — never copied child
 * ledgers. Freshness is recursive (system + children + import hashes).
 * v2.2 (2026-09-09, Phase T4): explanation orchestration control plane —
 * catalog (derived artifact catalog over the runtime + curated stores),
 * run-plan (subject resolution with explicit AMBIGUOUS, REUSE/REFRESH/CREATE
 * planning with depth compatibility, execution DAG), run-status (derived node
 * states, NEXT_ACTIONS, compact child work packets, auto-rendered documents),
 * run-finalize (final gate over every requested deliverable), render (derived
 * human-readable single-subject explanation.md). Orchestration never generates
 * semantic content; the agent still owns all reasoning.
 */

exports.name = 'compiler-explain'
exports.inject = ['tools', 'systemPrompt']

const SUBJECT_TYPES = [
  'function', 'class', 'algorithm', 'pass', 'module', 'subsystem', 'pipeline',
  'data_structure', 'workflow', 'component_group', 'other',
]
const DEPTHS = ['overview', 'standard', 'deep', 'presentation']

const EXPLAIN_POLICY = `Code explanation capability (always on). When the user asks to explain, break down, or present a code object — a function, class, algorithm, pass, module, subsystem, pipeline, scheduler, data structure, or cooperating component group ("解释/梳理 X 的机制", "X 是怎么实现的", "我要把 X 讲给别人", "给 X 形成 slides 前置材料") — run the generic teaching workflow once, not a per-subject ad-hoc one: (1) declare the subject with compiler_explain plan (subject_type, name, depth) and record why this subject; (2) gather repository evidence FIRST with the existing deterministic tools — compiler_knowledge for pass/pipeline/finding graph facts, compiler_inspect for definitions/callers/tests/history, real test runs for runtime facts, git for historical facts; keep the raw file:line work record; (3) reconstruct the mechanism as source-derived stages (never source-file order, never preset stage names) and write the teaching dossier: common core (mental model, need/responsibility/outcome, causal context, inputs/outputs, mechanism, state transitions when mutable state exists, decisions when important branching exists, contracts, constraints with status, boundaries classified only where evidence supports them, key takeaways) plus exactly one type extension; (4) at presentation depth derive the presentation handoff — adaptive storyline, learning objectives, semantic visual specs (nodes/edges/roles only, never layout/pixels/colors), evidence index; the handoff is NOT slides and the harness does not do slide layout; (5) finish with compiler_explain readiness: a mechanical pass plus the recorded audience-comprehension review (a domain engineer who never read the source can answer what/why/context/inputs/outputs/mechanism/states/decisions/interactions/takeaways) are both required — field completeness alone never yields READY. Evidence discipline is absolute: cite source/graph/runtime/historical facts to the tool that produced them; label your own inference as reasoning; label reconstructed examples RECONSTRUCTED; "not seen in source" is unknown, never unsupported. Depth: overview (mental model + mechanism summary), standard (+ example, decisions, constraints), deep (+ both views, placement, complexity), presentation (deep enough to teach + structured for the downstream presentation system). Artifacts live under analysis/explanations/<bundle>/ as JSON; declare explanation tasks on compiler_route as anchored-code-analysis (with a pass/pipeline/finding angle) or other. Presentation requests ("做成 slides/演示文稿") are the NEXT step of this same chain, not a separate analysis: once the handoff is READY+FRESH, the compiler-architecture-presentation skill consumes it handoff-first through the deterministic preflight (node scripts/preflight-handoff.mjs <bundle-dir>) — that skill never re-derives the story from source when a READY handoff exists. System story composition ("梳理 A、B、C 以及它们在系统中的协作关系 / 讲清这条 pipeline 为什么这样协作") extends this same chain, not a second framework: run compose-preflight over the candidate child bundles FIRST (all must be READY+FRESH in the same repository at the same current HEAD — refresh or create missing children with the single-subject workflow, incrementally), then compose ONE normal teaching bundle (subject_type workflow/component_group/subsystem/pipeline) whose composition.json records every requested component with an explicit disposition (never a silent drop), context-only nodes, cross-component bridges (each with flow_type data_flow/control_flow, the contract that crosses it, and evidence resolving in the parent ledger or via alias::child-EV-ID imports), representation boundaries, and open conflicts (an unresolved conflict blocks readiness — never narrate past it). READY+FRESH child bundles are the semantic source: consume their recorded knowledge, never re-analyze child internals, and never copy child evidence into the parent ledger. Finish with compiler_explain readiness on the system bundle (same mechanical gate + audience review, plus composition cross-checks), compose-render for the derived system-story.md, then the normal handoff-first presentation path.`

/** Compact tool output renderer: JSON only, one bounded block. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }]

const ORCHESTRATION_POLICY = `Explanation orchestration (always on, Phase T4). Route by what the user asked, in their words: one subject ("解释 X") → single-subject orchestration; several subjects and their relations ("解释/梳理 A、B、C 以及它们之间的关系/协作") → multi-subject orchestration; "形成文档/整理成文档" adds the documents output; "做 slides/形成 slides" adds the presentation output. The user never supplies bundle paths, compose commands, or artifact internals — only subject names and desired outputs. Workflow: (1) compiler_explain run-plan with the subject names verbatim, the target repository (repo_root, default cwd), desired depth, and outputs — the planner builds the artifact catalog (runtime + curated stores), resolves each subject deterministically, classifies REUSE / REFRESH / CREATE (AMBIGUOUS matches are returned for YOUR decision using repository evidence — never auto-picked), and emits the execution DAG; (2) execute only the returned child work packets — delegate independent CREATE/REFRESH subjects to subagents in parallel when available, sequentially otherwise; REUSE subjects are consumed as-is (semantic re-analysis = 0) and REFRESH means incremental update of the existing bundle, never a from-scratch re-derivation; (3) after each child reports done, re-check with compiler_explain run-status — it deterministically re-validates readiness + freshness, renders the derived documents (explanation.md / system-story.md), and emits the next actions; trust the gate, not the child's word; (4) resolve AMBIGUOUS subjects by explicit decision, then re-run run-plan (it resumes the same run); (5) gate the request with compiler_explain run-finalize before claiming completion — COMPLETE requires every requested subject READY+FRESH, every requested document current, the composition recursively fresh with no open conflicts, and the presentation manifest matching the current handoff hash; partial progress is never COMPLETE, it is blocked_at_child / blocked_at_composition / presentation_invalid with reasons. Run state (run.json) lives in the gitignored runtime store (analysis/runtime/, partitioned by repository) — normal use never writes into the curated analysis/explanations/ fixtures and never commits runtime artifacts; curated promotion is an explicit developer action. The low-level primitives (plan/validate/readiness/stale/compose-*) remain first-class for debugging, testing, and expert workflows.`

exports.apply = function apply(ctx) {
  ctx.systemPrompt.section({ name: 'code-explanation-policy', order: 116, text: EXPLAIN_POLICY })
  ctx.systemPrompt.section({ name: 'code-explanation-orchestration-policy', order: 117, text: ORCHESTRATION_POLICY })

  const driverPromise = import(new URL('./compiler-explain-driver.mjs', `file://${__filename}`).href)
  const composeDriverPromise = import(new URL('./compiler-compose-driver.mjs', `file://${__filename}`).href)
  const orchestrateDriverPromise = import(new URL('./compiler-orchestrate-driver.mjs', `file://${__filename}`).href)

  ctx.tools.register({
    name: 'compiler_explain',
    description: 'Deterministic scaffolding, validation, readiness, staleness, system-story composition, and orchestration for code-explanation teaching artifacts (Teaching Artifact Protocol v1 + composition layer + orchestration control plane). Commands: plan — scaffold a teaching bundle for a subject (subject skeleton, evidence plan over the existing deterministic tools, extension fields, readiness checklist, audience questions); validate — validate subject/evidence/dossier/handoff shapes and evidence discipline in a bundle dir; readiness — run the mechanical readiness gate and, when semantic_review is provided, record it and persist readiness.json (READY requires mechanical pass AND a recorded audience-comprehension review); stale — compare the bundle\'s recorded provenance (HEAD, source file hashes) against the repository now (recursively for composition bundles: system + children + import hashes); compose-preflight — deterministic gate over candidate child bundles before any system-level reasoning (READY+FRESH, unique subject ids, same repository, same current HEAD); compose-plan — scaffold a system-story composition (composition skeleton, disposition/bridge/imports models, reuse rules); compose-validate — validate a composition bundle (schema, import resolvability + hash match, coverage/bridges/conflicts, recursive staleness, mechanical readiness); compose-render — render the derived system-story.md view (JSON artifacts stay the source of truth); catalog — derive the artifact catalog (runtime + curated origins, recomputed readiness/freshness, presentation state) without any persistent index; run-plan — plan or resume an explanation run: resolve user subject names deterministically (AMBIGUOUS returned explicitly), classify REUSE/REFRESH/CREATE with depth compatibility, decide composition and presentation reuse, emit the execution DAG and compact child work packets; run-status — derive node states from the artifacts (never trusting run.json), auto-render current documents, and return NEXT_ACTIONS; run-finalize — final gate: every requested deliverable (bundles, documents, system story, presentation) verified fresh/ready/traceable before the run is COMPLETE; render — render the derived human-readable single-subject explanation.md from the JSON artifacts. The tool never generates teaching content: mechanisms, mental models, storylines, bridges, and the semantic verdict are agent reasoning recorded in the artifacts.',
    parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: {
      command: { type: 'string', enum: ['plan', 'validate', 'readiness', 'stale', 'compose-preflight', 'compose-plan', 'compose-validate', 'compose-render', 'catalog', 'run-plan', 'run-status', 'run-finalize', 'render'], description: 'plan (scaffold), validate (schema + evidence discipline), readiness (mechanical gate + semantic review recording), stale (provenance freshness), compose-preflight (child-bundle gate), compose-plan (system-story scaffold), compose-validate (composition bundle validation), compose-render (derived system-story.md), catalog (derived artifact catalog), run-plan (plan/resume an explanation run), run-status (derived run status + next actions), run-finalize (final deliverable gate), render (derived explanation.md).' },
      subject_type: { type: 'string', enum: SUBJECT_TYPES, description: 'plan: what kind of object the subject is. Drives the evidence plan, extension fields, and readiness checks.' },
      name: { type: 'string', description: 'plan: subject name as users refer to it (symbol, file, pipeline, subsystem).' },
      depth: { type: 'string', enum: DEPTHS, description: 'plan/readiness: explanation depth. presentation = deep enough to teach + structured for handoff (requires handoff with storyline).' },
      why_this_subject: { type: 'string', description: 'plan: why this subject was chosen (dogfood provenance).' },
      repo_root: { type: 'string', description: 'plan/stale/compose-*/catalog/run-*: target compiler repository (default cwd).' },
      root_dir: { type: 'string', description: 'plan/compose-plan: bundle root to write into. Orchestration work packets pass the runtime store root (analysis/runtime/explanations/<repository>); omit for the curated default.' },
      bundle_dir: { type: 'string', description: 'validate/readiness/stale/compose-validate/compose-render/render: teaching bundle directory (under analysis/explanations/ or the runtime store).' },
      bundle_dirs: { type: 'array', items: { type: 'string' }, description: 'compose-preflight: child bundle directories to gate for composition.' },
      requested_components: { type: 'array', items: { type: 'string' }, description: 'compose-plan: the components the user asked to have connected — each is held to an explicit disposition in composition.json.' },
      subjects: { type: 'array', items: { type: 'string' }, description: 'run-plan: the subject names exactly as the user referred to them (symbols, files, pipelines, subsystems).' },
      outputs: { type: 'array', items: { type: 'string', enum: ['artifacts', 'documents', 'system_story', 'presentation'] }, description: 'run-plan: requested deliverables. Default: artifacts + documents. system_story/presentation on a multi-subject request add the composition node.' },
      run_id: { type: 'string', description: 'run-plan/run-status/run-finalize: explanation run id. Omitted: run-plan resumes an open run with the same request signature; run-status/run-finalize use the most recent open run for the repository.' },
      current_head: { type: 'string', description: 'compose-preflight: current repository HEAD to compare children against (derived from repo_root when omitted).' },
      semantic_review: { type: 'object', additionalProperties: false, required: ['verdict'], properties: {
        verdict: { type: 'string', enum: ['ready', 'not_ready'], description: 'Reviewer conclusion after answering the audience questions against the dossier.' },
        audience_questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'sufficient'], properties: {
          question: { type: 'string', description: 'The audience-comprehension question (generic ten from the plan, plus type-specific ones).' },
          answer: { type: 'string', description: 'Short answer derived from the dossier alone.' },
          sufficient: { type: 'boolean', description: 'Whether the dossier alone lets a domain engineer answer this.' },
        } }, description: 'Answered audience-comprehension questions.' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'Concrete blockers when not_ready.' },
        notes: { type: 'string', description: 'Reviewer notes (quality judgments the mechanical gate cannot make).' },
      }, description: 'readiness: the recorded semantic review. Required for READY; omitted returns the mechanical verdict plus the open questions.' },
    } },
    output: { schema: { type: 'object', additionalProperties: true, required: ['command', 'ok'], properties: {
      command: { type: 'string' },
      ok: { type: 'boolean' },
    } }, render: renderJson },
    async execute(args) {
      const driver = await driverPromise
      const command = args.command
      if (command === 'plan') {
        const plan = driver.planTeaching(args)
        return { command, ...plan }
      }
      if (command === 'catalog') {
        const orch = await orchestrateDriverPromise
        return { command, ...orch.buildCatalog({ repoRoot: args.repo_root }) }
      }
      if (command === 'run-plan') {
        const orch = await orchestrateDriverPromise
        return { command, ...orch.planRun({ subjects: args.subjects, depth: args.depth, outputs: args.outputs, repoRoot: args.repo_root, runId: args.run_id }) }
      }
      if (command === 'run-status') {
        const orch = await orchestrateDriverPromise
        return { command, ...orch.runStatus({ repoRoot: args.repo_root, runId: args.run_id }) }
      }
      if (command === 'run-finalize') {
        const orch = await orchestrateDriverPromise
        return { command, ...orch.runFinalize({ repoRoot: args.repo_root, runId: args.run_id }) }
      }
      if (command === 'render') {
        const orch = await orchestrateDriverPromise
        if (!args.bundle_dir) return { command, ok: false, error: 'render requires bundle_dir' }
        return { command, ...orch.renderExplanation(args.bundle_dir, { out: args.out }) }
      }
      if (command === 'validate') {
        if (!args.bundle_dir) return { command, ok: false, error: 'validate requires bundle_dir' }
        return { command, ...driver.validateBundleDir(args.bundle_dir) }
      }
      if (command === 'readiness') {
        if (!args.bundle_dir) return { command, ok: false, error: 'readiness requires bundle_dir' }
        const options = { depth: args.depth }
        const out = args.semantic_review !== undefined
          ? driver.saveReadiness(args.bundle_dir, args.semantic_review, options)
          : driver.readinessForBundle(args.bundle_dir, undefined, options)
        return { command, ...out }
      }
      if (command === 'stale') {
        if (!args.bundle_dir) return { command, ok: false, error: 'stale requires bundle_dir' }
        return { command, ...driver.stalenessForBundle(args.bundle_dir, args.repo_root) }
      }
      if (command === 'compose-preflight') {
        const compose = await composeDriverPromise
        return { command, ...compose.compositionPreflight(args.bundle_dirs, { repoRoot: args.repo_root, currentHead: args.current_head }) }
      }
      if (command === 'compose-plan') {
        const compose = await composeDriverPromise
        return { command, ...compose.planComposition(args) }
      }
      if (command === 'compose-validate') {
        if (!args.bundle_dir) return { command, ok: false, error: 'compose-validate requires bundle_dir' }
        const compose = await composeDriverPromise
        return { command, ...compose.validateCompositionBundleDir(args.bundle_dir, { repoRoot: args.repo_root }) }
      }
      if (command === 'compose-render') {
        if (!args.bundle_dir) return { command, ok: false, error: 'compose-render requires bundle_dir' }
        const compose = await composeDriverPromise
        return { command, ...compose.renderSystemStory(args.bundle_dir, { out: args.out }) }
      }
      return { command, ok: false, error: `unknown command: ${command}` }
    },
  })
}

/**
 * JavaScript validation port of mlir-compiler-harness Feedback Protocol v1/v2
 * (`mlir_repomap.feedback.validate_feedback`, ADR-025). The protocol is owned
 * by that repository; this port exists so the offline CompilerDev tooling can
 * validate, generate, review, and bundle feedback artifacts with Node only.
 * It is kept field-for-field compatible with the Python validator — when the
 * sibling harness venv is available, `review-feedback.mjs` cross-checks
 * accepted artifacts against it.
 *
 * Feedback records how the knowledge system was USED — it never enters the
 * compiler graph, never becomes a compiler fact, and never changes finding
 * lifecycle. `sensitivity.contains_sensitive_content` must be strictly false;
 * prompts, transcripts, and source text have no field to live in.
 */

export const QUERY_COMMANDS = ['review', 'finding-impact', 'pipeline-stages', 'evidence']
export const TASK_KINDS = ['compiler-review', 'bug-investigation', 'pipeline-audit', 'other']
export const GAP_CATEGORIES = ['query-coverage', 'evidence-location', 'workflow', 'documentation', 'other']
export const OBSERVATION_KINDS = ['query-sufficient', 'query-insufficient', 'adoption-missed', 'query-operational']
export const ORIGINS = ['automatic', 'agent', 'curated']
export const CONFIDENCE = ['low', 'medium', 'high']
export const CLASSIFICATION_SOURCES = ['heuristic', 'human', 'policy']
export const USAGE_COUNTERS = ['compiler_knowledge_calls', 'discovery_search_calls', 'search_after_query_calls']
export const USAGE_STEPS = ['first_knowledge_step', 'first_discovery_step', 'first_edit_step']
export const OPERATIONAL_BOOLEANS = ['stale_index', 'refresh_performed', 'not_found', 'truncated', 'error']
export const OPERATIONAL_COUNTERS = ['refresh_duration_ms', 'diagnostic_count', 'duration_ms']

const V2_ALLOWED = new Set(['schema_version', 'created_at', 'origin', 'observation_kind', 'task', 'query',
  'route', 'usage', 'operational', 'observation', 'manual_source_search', 'possible_gap', 'evidence', 'sensitivity'])

const isNonempty = (value) => typeof value === 'string' && value.trim() !== ''
const isCounter = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isStep = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0
const isLines = (value) => (typeof value === 'number' && Number.isInteger(value) && value > 0)
  || (typeof value === 'string' && /^\d+(-\d+)?$/.test(value))

function error(errors, source, message) {
  errors.push(`${source}: ${message}`)
}

function unknownFields(errors, source, value, allowed) {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) error(errors, source, `unknown field: ${key}`)
  }
}

function validateTask(task, errors, source, strict = false) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    error(errors, source, 'task must be a mapping')
    return
  }
  if (strict) unknownFields(errors, source, task, ['kind', 'target', 'classification'])
  if (!TASK_KINDS.includes(task.kind)) error(errors, source, `task.kind must be one of ${TASK_KINDS}`)
  if (!isNonempty(task.target)) error(errors, source, 'task.target must be a non-empty stable target')
  const classification = task.classification
  if (classification !== undefined && classification !== null) {
    if (classification === null || typeof classification !== 'object' || Array.isArray(classification)) {
      error(errors, source, 'task.classification must be a mapping')
    } else {
      if (strict) unknownFields(errors, `${source}.classification`, classification, ['confidence', 'source'])
      if (!CONFIDENCE.includes(classification.confidence)) {
        error(errors, source, `task.classification.confidence must be one of ${CONFIDENCE}`)
      }
      if (!CLASSIFICATION_SOURCES.includes(classification.source)) {
        error(errors, source, 'task.classification.source must explicitly be heuristic, human, or policy')
      }
    }
  }
}

function validateQuery(query, errors, source, strict = false) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    error(errors, source, 'query must be a mapping')
    return
  }
  if (strict) unknownFields(errors, source, query, ['command', 'args'])
  if (!QUERY_COMMANDS.includes(query.command)) {
    error(errors, source, `query.command must be one of ${QUERY_COMMANDS}`)
  }
  if (query.args === null || typeof query.args !== 'object' || Array.isArray(query.args)) {
    error(errors, source, 'query.args must be a mapping')
  }
}

function validateManualSourceSearch(value, errors, source, strict = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    error(errors, source, 'manual_source_search must be a mapping')
    return
  }
  if (strict) unknownFields(errors, source, value, ['performed', 'reason'])
  if (typeof value.performed !== 'boolean') {
    error(errors, source, 'manual_source_search.performed must be a boolean')
  } else if (value.performed && !isNonempty(value.reason)) {
    error(errors, source, 'manual_source_search.reason is required when performed')
  }
}

function validateGap(gap, errors, source, strict = false) {
  if (gap === undefined || gap === null) return
  if (typeof gap !== 'object' || Array.isArray(gap)) {
    error(errors, source, 'possible_gap must be a mapping or null')
    return
  }
  if (strict) unknownFields(errors, source, gap, ['category', 'statement'])
  if (!GAP_CATEGORIES.includes(gap.category)) {
    error(errors, source, `possible_gap.category must be one of ${GAP_CATEGORIES}`)
  }
  if (!isNonempty(gap.statement)) error(errors, source, 'possible_gap.statement must be non-empty')
}

function validateEvidence(evidence, errors, source, strict = false) {
  if (!Array.isArray(evidence)) {
    error(errors, source, 'evidence must be a list')
    return
  }
  evidence.forEach((item, number) => {
    const itemSource = `${source}[${number}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item) || !isNonempty(item.file)) {
      error(errors, source, `evidence[${number}] must contain a non-empty file`)
      return
    }
    if (strict) unknownFields(errors, itemSource, item, ['file', 'lines'])
    if (item.lines !== undefined && item.lines !== null && !isLines(item.lines)) {
      error(errors, source, `evidence[${number}].lines must be N or N-M`)
    }
  })
}

function validateSensitivity(sensitivity, errors, source, strict = false) {
  if (sensitivity === null || typeof sensitivity !== 'object' || Array.isArray(sensitivity)
    || sensitivity.contains_sensitive_content !== false) {
    error(errors, source, 'sensitivity.contains_sensitive_content must be false; redact before recording')
    return
  }
  if (strict) unknownFields(errors, source, sensitivity, ['contains_sensitive_content'])
}

function validateRoute(route, errors, source) {
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    error(errors, source, 'route must be a mapping')
    return
  }
  unknownFields(errors, source, route, ['knowledge_expected', 'kind', 'confidence'])
  if (typeof route.knowledge_expected !== 'boolean') {
    error(errors, source, 'route.knowledge_expected must be a boolean')
  }
  if (!isNonempty(route.kind)) error(errors, source, 'route.kind must be a non-empty routing kind')
  if (!CONFIDENCE.includes(route.confidence)) {
    error(errors, source, `route.confidence must be one of ${CONFIDENCE}`)
  }
}

function validateUsage(usage, errors, source) {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    error(errors, source, 'usage must be a mapping')
    return
  }
  unknownFields(errors, source, usage, [...USAGE_COUNTERS, ...USAGE_STEPS, 'knowledge_commands'])
  for (const field of USAGE_COUNTERS) {
    if (field in usage && !isCounter(usage[field])) {
      error(errors, source, `usage.${field} must be a non-negative integer`)
    }
  }
  for (const field of USAGE_STEPS) {
    if (field in usage && !isStep(usage[field])) {
      error(errors, source, `usage.${field} must be a positive integer step`)
    }
  }
  const commands = usage.knowledge_commands
  if (commands !== undefined && commands !== null) {
    if (typeof commands !== 'object' || Array.isArray(commands)) {
      error(errors, source, 'usage.knowledge_commands must be a mapping')
    } else {
      for (const [command, count] of Object.entries(commands)) {
        if (!QUERY_COMMANDS.includes(command) || !isCounter(count)) {
          error(errors, source, 'usage.knowledge_commands must map adapter commands to non-negative integers')
          break
        }
      }
    }
  }
}

function validateOperational(operational, errors, source) {
  if (operational === undefined || operational === null) return
  if (typeof operational !== 'object' || Array.isArray(operational)) {
    error(errors, source, 'operational must be a mapping')
    return
  }
  unknownFields(errors, source, operational, [...OPERATIONAL_BOOLEANS, ...OPERATIONAL_COUNTERS])
  for (const field of OPERATIONAL_BOOLEANS) {
    if (field in operational && typeof operational[field] !== 'boolean') {
      error(errors, source, `operational.${field} must be a boolean`)
    }
  }
  for (const field of OPERATIONAL_COUNTERS) {
    if (field in operational && !isCounter(operational[field])) {
      error(errors, source, `operational.${field} must be a non-negative integer`)
    }
  }
}

function validateV1(feedback, errors, source) {
  validateTask(feedback.task, errors, `${source}.task`)
  validateQuery(feedback.query, errors, `${source}.query`)
  if (!isNonempty(feedback.observation)) error(errors, source, 'missing required field: observation')
  validateManualSourceSearch(feedback.manual_source_search, errors, `${source}.manual_source_search`)
  validateGap(feedback.possible_gap, errors, `${source}.possible_gap`)
  validateEvidence(feedback.evidence ?? [], errors, `${source}.evidence`)
  validateSensitivity(feedback.sensitivity, errors, `${source}.sensitivity`)
}

function validateV2(feedback, errors, source) {
  unknownFields(errors, source, feedback, [...V2_ALLOWED])
  for (const field of ['created_at', 'origin', 'observation_kind', 'task', 'route', 'usage',
    'observation', 'manual_source_search', 'sensitivity']) {
    if (!(field in feedback)) error(errors, source, `missing required field: ${field}`)
  }
  if (!ORIGINS.includes(feedback.origin)) error(errors, source, `origin must be one of ${ORIGINS}`)
  const kind = feedback.observation_kind
  if (!OBSERVATION_KINDS.includes(kind)) {
    error(errors, source, `observation_kind must be one of ${OBSERVATION_KINDS}`)
  }
  validateTask(feedback.task, errors, `${source}.task`, true)
  validateRoute(feedback.route, errors, `${source}.route`)
  validateUsage(feedback.usage, errors, `${source}.usage`)
  validateOperational(feedback.operational, errors, `${source}.operational`)
  if (!isNonempty(feedback.observation)) error(errors, source, 'missing required field: observation')
  validateManualSourceSearch(feedback.manual_source_search, errors, `${source}.manual_source_search`, true)
  validateGap(feedback.possible_gap, errors, `${source}.possible_gap`, true)
  validateEvidence(feedback.evidence ?? [], errors, `${source}.evidence`, true)
  validateSensitivity(feedback.sensitivity, errors, `${source}.sensitivity`, true)

  const query = feedback.query
  if (kind === 'adoption-missed') {
    if (query !== undefined && query !== null) error(errors, source, 'adoption-missed requires query: null')
    const route = feedback.route
    if (route !== null && typeof route === 'object' && route.knowledge_expected !== true) {
      error(errors, source, 'adoption-missed requires route.knowledge_expected=true')
    }
    const usage = feedback.usage
    if (usage === null || typeof usage !== 'object' || usage.compiler_knowledge_calls !== 0) {
      error(errors, source, 'adoption-missed requires usage.compiler_knowledge_calls=0')
    }
  } else {
    if (!('query' in feedback) || query === null || query === undefined) {
      error(errors, source, `${kind ?? 'v2 observation'} requires query`)
    } else {
      validateQuery(query, errors, `${source}.query`, true)
    }
  }
}

/**
 * Validate one feedback artifact (a `{ feedback: {…} }` document); returns a
 * list of error strings — empty means valid. Mirrors the Python validator's
 * v1 (lenient) and v2 (strict allowed-fields) behavior.
 */
export function validateFeedback(data, source = '<feedback>') {
  const errors = []
  if (data === null || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).join(',') !== 'feedback') {
    error(errors, source, "document must be a single top-level 'feedback' mapping")
    return errors
  }
  const feedback = data.feedback
  if (feedback === null || typeof feedback !== 'object' || Array.isArray(feedback)) {
    error(errors, source, "'feedback' must be a mapping")
    return errors
  }
  const version = feedback.schema_version
  if (version !== 1 && version !== 2) {
    error(errors, source, 'schema_version must be 1 or 2')
    return errors
  }
  if (!isNonempty(feedback.created_at)) error(errors, source, 'missing required field: created_at')
  if (version === 1) validateV1(feedback, errors, source)
  else validateV2(feedback, errors, source)
  return errors
}

/** Recursively strip keys outside the protocol allow-lists (runtime-only fields). */
export function stripRuntimeFields(document) {
  const feedback = document?.feedback
  if (feedback === null || typeof feedback !== 'object') return document
  const kept = {}
  for (const key of Object.keys(feedback)) {
    if (V2_ALLOWED.has(key) || feedback.schema_version === 1) kept[key] = feedback[key]
  }
  if (kept.task !== null && typeof kept.task === 'object') {
    kept.task = pick(kept.task, ['kind', 'target', 'classification'])
    if (kept.task?.classification !== null && typeof kept.task?.classification === 'object') {
      kept.task.classification = pick(kept.task.classification, ['confidence', 'source'])
    }
  }
  if (kept.query !== null && typeof kept.query === 'object') kept.query = pick(kept.query, ['command', 'args'])
  if (kept.route !== null && typeof kept.route === 'object') {
    kept.route = pick(kept.route, ['knowledge_expected', 'kind', 'confidence'])
  }
  if (kept.usage !== null && typeof kept.usage === 'object') {
    kept.usage = pick(kept.usage, [...USAGE_COUNTERS, ...USAGE_STEPS, 'knowledge_commands'])
  }
  if (kept.operational !== null && typeof kept.operational === 'object') {
    kept.operational = pick(kept.operational, [...OPERATIONAL_BOOLEANS, ...OPERATIONAL_COUNTERS])
  }
  if (kept.manual_source_search !== null && typeof kept.manual_source_search === 'object') {
    kept.manual_source_search = pick(kept.manual_source_search, ['performed', 'reason'])
  }
  if (kept.possible_gap !== null && typeof kept.possible_gap === 'object') {
    kept.possible_gap = pick(kept.possible_gap, ['category', 'statement'])
  }
  if (Array.isArray(kept.evidence)) {
    kept.evidence = kept.evidence.map(item => (item !== null && typeof item === 'object' ? pick(item, ['file', 'lines']) : item))
  }
  if (kept.sensitivity !== null && typeof kept.sensitivity === 'object') {
    kept.sensitivity = pick(kept.sensitivity, ['contains_sensitive_content'])
  }
  return { feedback: kept }
}

function pick(value, allowed) {
  const kept = {}
  for (const key of Object.keys(value)) if (allowed.includes(key)) kept[key] = value[key]
  return kept
}

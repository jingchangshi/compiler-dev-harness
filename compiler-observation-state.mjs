/**
 * Shared per-agent observation state for the CompilerDev preset plugins.
 *
 * `compiler_route` (compiler-knowledge plugin) mints one correlation id per
 * task and stamps it onto every `compiler_knowledge` record. The
 * `compiler_inspect` context observation stream (compiler-context-backend.mjs)
 * needs the SAME id so routes, queries, and context records join offline — but
 * the two tools live in different plugin modules, so the id crosses through
 * this tiny process-wide registry instead of a cross-plugin service (nothing
 * here is model-facing and nothing publishes into a realm).
 *
 * Keyed by the executing agent's id (the same key the knowledge plugin uses):
 * the preset is mounted once under a standing scope and every joined session
 * shares these module instances, so any other key would correlate across
 * sessions. Values are opaque strings; no prompt, path, or user data.
 */

const correlationByAgent = new Map()

/** Record the current task's correlation id for one agent. */
export function setAgentCorrelationId(agentKey, correlationId) {
  if (typeof agentKey !== 'string' || agentKey === '' || typeof correlationId !== 'string' || correlationId === '') return
  correlationByAgent.set(agentKey, correlationId)
}

/** Read the current task's correlation id for one agent, if a route declared it. */
export function getAgentCorrelationId(agentKey) {
  if (typeof agentKey !== 'string' || agentKey === '') return undefined
  return correlationByAgent.get(agentKey)
}

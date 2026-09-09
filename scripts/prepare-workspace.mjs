#!/usr/bin/env node
/**
 * Workspace preparation: materialize the harness-owned local instruction
 * overlay into a target compiler repository without ever touching the team's
 * tracked `AGENTS.md`.
 *
 * Ownership model (see contracts/README.md):
 * - team `AGENTS.md` (target repository, tracked) — upstream truth; read-only
 *   to this tool, never overwritten, never skip-worktree'd, never symlinked;
 * - `contracts/<Profile>/REPOSITORY_PROFILE.md` — harness-owned repository
 *   profile (retrieval policy, harness tool parameters, repo conventions the
 *   team does not track);
 * - `contracts/<Profile>/REPOSITORY_CONTRACT.md` (optional) — harness-carried
 *   repository operating contract, used for target repositories whose team
 *   does not track an upstream `AGENTS.md`; it travels inside the managed
 *   overlay and is never materialized as `AGENTS.md`;
 * - `contracts/hosts/<host-id>/AGENTS.local.md` (optional) — machine-level
 *   facts shared by every profile on that server (selected by hostname or
 *   `--host`, with `host.json` name aliases);
 * - `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md` — profile-specific
 *   host facts (deltas on top of the shared machine layer);
 * - `<target>/AGENTS.local.md` — generated, managed composition of the
 *   harness sources (contract → profile → shared host → profile host),
 *
 * Materialization is a generated copy with a managed header carrying the
 * profile name and the SHA-256 of the composed body, so ownership is detected
 * by content, not by filename, and hand edits are detected by digest drift.
 * A copy (not a symlink) is deliberate: one deployment file must carry two
 * harness sources, and a self-contained copy cannot dangle when the harness
 * checkout moves. Staleness is handled deterministically: re-run this script.
 *
 * Repository identity: explicit `--profile` wins; otherwise the target's Git
 * remote URLs are matched against each profile's declared substrings, then the
 * worktree basename. No match or an ambiguous match is a bounded failure.
 *
 * Cases (AGENTS.local.md at the target):
 *   A absent              -> materialize
 *   B managed, intact     -> update if sources changed, else no-op (idempotent)
 *   C unmanaged file      -> refuse, never overwrite silently
 *   D foreign-managed or  -> refuse with evidence
 *     hand-edited managed
 *   E team AGENTS.md      -> nothing to do; preparation still succeeds
 *      changed upstream
 *
 * Usage:
 *   node scripts/prepare-workspace.mjs [--check] [--profile <name>]
 *        [--host <id>] [--harness-root <dir>] [<target-root>]
 *
 * Exit codes: 0 ok; 1 conflict/drift/validation failure; 2 usage/not a
 * repository/unknown or ambiguous profile.
 *
 * Workspace preparation is infrastructure: it shares no code path with
 * compiler_inspect, compiler_knowledge, Ripwire, or the feedback protocol.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname as osHostname } from 'node:os'

const HARNESS_MARKER = 'compiler-dev-harness:managed-v1'
const OVERLAY_DEPLOY_NAME = 'AGENTS.local.md'
const TEAM_CONTRACT_NAME = 'AGENTS.md'
const PROFILE_SOURCE_NAME = 'REPOSITORY_PROFILE.md'
const CONTRACT_SOURCE_NAME = 'REPOSITORY_CONTRACT.md'
const OVERLAY_SOURCE_NAME = 'AGENTS.local.md'
const PROFILE_MANIFEST_NAME = 'profile.json'
const SHARED_HOSTS_DIRNAME = 'hosts'
const EXCLUDE_BEGIN = '# BEGIN compiler-dev-harness managed local instructions'
const EXCLUDE_END = '# END compiler-dev-harness managed local instructions'

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Deterministic composition: non-empty parts joined by a `---` rule. The
 * caller fixes the order — repository contract (if carried) → repository
 * profile → shared machine facts → profile host facts.
 */
export function composeOverlayParts(parts) {
  const bodies = parts
    .filter((part) => part != null && part.trim().length > 0)
    .map((part) => part.trimEnd())
  if (bodies.length === 0) return ''
  return `${bodies.join('\n\n---\n\n')}\n`
}

/** Two-part convenience wrapper (profile first, then host facts). */
export function composeOverlayBody(profileBody, localBody) {
  return composeOverlayParts([profileBody, localBody])
}

export function renderManagedArtifact({
  profileName,
  harnessRoot,
  body,
  sourcesLabel = `contracts/${profileName}/{${PROFILE_SOURCE_NAME},${OVERLAY_SOURCE_NAME}}`,
}) {
  const header = [
    `<!-- ${HARNESS_MARKER}`,
    `profile: ${profileName}`,
    `content-sha256: ${sha256Hex(body)}`,
    `sources: ${sourcesLabel} in compiler-dev-harness (${harnessRoot})`,
    `regenerate: node ${join(harnessRoot, 'scripts', 'prepare-workspace.mjs')} <target-root>`,
    `-->`,
  ].join('\n')
  return `${header}\n${body}`
}

/**
 * Recognize a managed artifact. The marker must start at offset 0 so a team
 * or user document that merely quotes the marker is never misidentified.
 * Returns `{ managed: false }` for anything else; digest verification against
 * the actual body is the caller's decision (that is what detects hand edits).
 */
export function parseManagedArtifact(text) {
  if (!text.startsWith(`<!-- ${HARNESS_MARKER}\n`)) return { managed: false }
  const end = text.indexOf('-->', 0)
  if (end === -1) return { managed: false }
  const header = text.slice(0, end)
  const profile = /^profile: (.+)$/m.exec(header)
  const sha = /^content-sha256: ([0-9a-f]{64})$/m.exec(header)
  if (!profile || !sha) return { managed: false }
  let body = text.slice(end + 3)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  return { managed: true, profile: profile[1], sha: sha[1], body }
}

export function classifyOverlay(existingText, { profileName, desiredBody }) {
  if (existingText == null) return 'absent'
  const parsed = parseManagedArtifact(existingText)
  if (!parsed.managed) return 'unmanaged'
  if (parsed.profile !== profileName) return 'foreign-profile'
  if (sha256Hex(parsed.body) !== parsed.sha) return 'hand-edited'
  return parsed.body === desiredBody ? 'up-to-date' : 'stale'
}

/** Load the profile manifest from each `contracts/<name>` directory. */
export function discoverProfiles(harnessRoot) {
  const contractsDir = join(harnessRoot, 'contracts')
  const profiles = []
  for (const entry of readdirSync(contractsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(contractsDir, entry.name, PROFILE_MANIFEST_NAME)
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.profile !== entry.name) {
      throw new Error(
        `profile manifest mismatch: ${manifestPath} declares "${manifest.profile}"`,
      )
    }
    profiles.push({
      name: manifest.profile,
      dir: join(contractsDir, entry.name),
      match: manifest.match ?? {},
    })
  }
  return profiles
}

/**
 * Deterministic selection: explicit name > unique remote-URL match > unique
 * basename match. Ambiguity and no-match are errors, never guesses.
 */
export function selectProfile({ profiles, explicit, remotes, basename }) {
  if (explicit != null) {
    const hit = profiles.find((p) => p.name === explicit)
    return hit
      ? { ok: true, profile: hit, matchedBy: 'explicit' }
      : {
          ok: false,
          kind: 'unknown-profile',
          detail: `--profile ${explicit} does not match any profile in contracts/ (available: ${profiles.map((p) => p.name).join(', ') || 'none'})`,
        }
  }
  const byRemote = profiles.filter((p) =>
    (p.match.remoteSubstrings ?? []).some((s) =>
      remotes.some((u) => u.includes(s)),
    ),
  )
  if (byRemote.length === 1) return { ok: true, profile: byRemote[0], matchedBy: 'remote' }
  if (byRemote.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous-profile',
      detail: `remotes ${JSON.stringify(remotes)} match several profiles: ${byRemote.map((p) => p.name).join(', ')}; pass --profile`,
    }
  }
  const byBasename = profiles.filter((p) =>
    (p.match.basenames ?? []).includes(basename),
  )
  if (byBasename.length === 1) return { ok: true, profile: byBasename[0], matchedBy: 'basename' }
  if (byBasename.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous-profile',
      detail: `basename "${basename}" matches several profiles: ${byBasename.map((p) => p.name).join(', ')}; pass --profile`,
    }
  }
  return {
    ok: false,
    kind: 'no-match',
    detail: `no profile matches remotes ${JSON.stringify(remotes)} or basename "${basename}" (available: ${profiles.map((p) => p.name).join(', ') || 'none'})`,
  }
}

export function buildExcludeBlock() {
  return `${EXCLUDE_BEGIN}\n${OVERLAY_DEPLOY_NAME}\n${EXCLUDE_END}\n`
}

/**
 * Idempotently ensure the managed exclude entry. A pre-existing bare
 * `AGENTS.local.md` line (e.g. added by hand before this tool existed) already
 * provides the semantics and is left untouched — which also keeps a marked
 * block that is already correct stable. A malformed marked block (BEGIN
 * without END or vice versa) is an error, never silently rewritten.
 */
export function applyExcludeEntry(content) {
  const lines = content ? content.split('\n') : []
  if (lines.some((l) => l.trim() === OVERLAY_DEPLOY_NAME)) {
    return { content, action: 'already-covered', detail: 'entry already present' }
  }
  const begin = lines.indexOf(EXCLUDE_BEGIN)
  const end = lines.indexOf(EXCLUDE_END)
  if (begin !== -1 || end !== -1) {
    if (begin === -1 || end === -1 || end < begin) {
      return {
        content,
        action: 'error',
        detail: 'malformed compiler-dev-harness exclude block; fix it manually',
      }
    }
    const blockLines = buildExcludeBlock().split('\n').filter(Boolean)
    const next = [...lines.slice(0, begin), ...blockLines, ...lines.slice(end + 1)]
    return { content: next.join('\n'), action: 'replaced', detail: 'marked block refreshed' }
  }
  let base = content ?? ''
  if (base.length > 0 && !base.endsWith('\n')) base += '\n'
  if (base.length > 0) base += '\n'
  return { content: base + buildExcludeBlock(), action: 'added', detail: 'marked block appended' }
}

/**
 * Read the host entries declared in one `hosts/` directory (either the shared
 * machine layer `contracts/hosts/` or a profile delta `contracts/<Profile>/
 * hosts/`). A subdirectory counts only if it carries an `AGENTS.local.md`;
 * `host.json` (optional) declares the host id and hostname aliases.
 */
export function readHostEntries(hostsDir) {
  const entries = []
  if (!existsSync(hostsDir)) return entries
  for (const entry of readdirSync(hostsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const hostPath = join(hostsDir, entry.name, OVERLAY_SOURCE_NAME)
    if (!existsSync(hostPath)) continue
    let manifest = null
    const manifestPath = join(hostsDir, entry.name, 'host.json')
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    }
    entries.push({
      hostId: manifest?.host ?? entry.name,
      hostnames: (manifest?.hostnames ?? [manifest?.host ?? entry.name]).map(String),
      hostPath,
    })
  }
  return entries
}

/** Shared machine-level host facts: `contracts/hosts/<id>/AGENTS.local.md`. */
export function discoverSharedHosts(harnessRoot) {
  return readHostEntries(join(harnessRoot, 'contracts', SHARED_HOSTS_DIRNAME))
}

/**
 * Resolve the host facts sources for a profile across two layers:
 * - shared machine layer: `contracts/hosts/<id>/AGENTS.local.md` — facts true
 *   for every repository on that server;
 * - profile delta: `contracts/<Profile>/hosts/<id>/AGENTS.local.md` — facts
 *   scoped to this repository's workflow on that server.
 * The host id is selected by explicit `--host`, else by the current
 * `os.hostname()` matched against the union of both layers' hostnames; a
 * match may be shared-only, delta-only, or both (all are valid). A legacy
 * profile-level `AGENTS.local.md` still works for single-host layouts and is
 * self-contained (both it and a `hosts/` layer at once is an error).
 * Neither layer matching, or a selected host with no facts at all, is a
 * bounded failure — never a guess.
 */
export function resolveHostSource(profile, { explicitHost = null, hostname = '', harnessRoot = null } = {}) {
  const hostsDir = join(profile.dir, 'hosts')
  const legacyPath = join(profile.dir, OVERLAY_SOURCE_NAME)
  const hostsExist = existsSync(hostsDir)
  const legacyExists = existsSync(legacyPath)
  if (hostsExist && legacyExists) {
    return {
      ok: false,
      kind: 'ambiguous-host-source',
      detail: `both ${hostsDir} and profile-level ${legacyPath} exist; keep exactly one source of host facts`,
    }
  }
  if (legacyExists) {
    return {
      ok: true,
      legacy: true,
      hostId: null,
      hostPath: legacyPath,
      sharedPath: null,
      deltaPath: null,
      matchedBy: 'profile-level (single host)',
    }
  }
  const sharedHosts = harnessRoot ? discoverSharedHosts(harnessRoot) : []
  const deltaHosts = readHostEntries(hostsDir)
  if (!hostsExist && sharedHosts.length === 0) {
    return {
      ok: false,
      kind: 'harness-layout',
      detail: `no host facts source: expected ${hostsDir}, ${join(harnessRoot ?? '', 'contracts', SHARED_HOSTS_DIRNAME)} entries, or ${legacyPath}`,
    }
  }

  // Union both layers keyed by host id; a delta for an id that also exists in
  // the shared layer inherits and extends its hostname aliases.
  const byId = new Map()
  for (const shared of sharedHosts) {
    byId.set(shared.hostId, { hostId: shared.hostId, shared, delta: null, hostnames: [...shared.hostnames] })
  }
  for (const delta of deltaHosts) {
    const current = byId.get(delta.hostId)
    if (current) {
      current.delta = delta
      current.hostnames = [...new Set([...current.hostnames, ...delta.hostnames])]
    } else {
      byId.set(delta.hostId, { hostId: delta.hostId, shared: null, delta, hostnames: [...delta.hostnames] })
    }
  }

  const pick = (predicate, matchedBy) => {
    const hits = [...byId.values()].filter(predicate)
    if (hits.length === 1) {
      const hit = hits[0]
      return {
        ok: true,
        legacy: false,
        hostId: hit.hostId,
        sharedPath: hit.shared?.hostPath ?? null,
        deltaPath: hit.delta?.hostPath ?? null,
        matchedBy,
      }
    }
    if (hits.length > 1) {
      return {
        ok: false,
        kind: 'ambiguous-host',
        detail: `hostname "${hostname}" matches several host sources: ${hits.map((h) => h.hostId).join(', ')}; pass --host`,
      }
    }
    return null
  }

  if (explicitHost != null) {
    const picked = pick((hit) => hit.hostId === explicitHost, 'explicit')
    if (picked) return picked
    return {
      ok: false,
      kind: 'unknown-host',
      detail: `--host ${explicitHost} matches no host source (available: ${[...byId.keys()].join(', ') || 'none'}); create one from contracts/HOST_FACTS_TEMPLATE.md or pass an existing id`,
    }
  }
  const byName = pick((hit) => hit.hostnames.includes(hostname), 'hostname')
  if (byName) return byName
  return {
    ok: false,
    kind: 'no-host-match',
    detail: `hostname "${hostname}" matches no host source (available: ${[...byId.keys()].join(', ') || 'none'}); new server: copy contracts/HOST_FACTS_TEMPLATE.md to contracts/hosts/<id>/AGENTS.local.md (shared machine facts), and to contracts/${profile.name}/hosts/<id>/AGENTS.local.md when this profile needs host-specific facts, add host.json listing its hostnames, or pass --host <id>`,
  }
}

/**
 * A filled host-facts file must not leave template placeholders behind. The
 * template marks must-fill fields with `REQUIRED:`; legal session-time
 * placeholders like `[USER MAY PROVIDE]` are unaffected.
 */
export function validateHostFacts(body) {
  const missing = body
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter((l) => l.text.includes('REQUIRED:'))
    .slice(0, 5)
  return { ok: missing.length === 0, missing }
}

// ── git / filesystem boundary (narrow, the only side effects) ───────────────

function git(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  } catch (error) {
    if (allowFailure) return null
    throw error
  }
}

function gitRemotes(root) {
  const out = git(root, ['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFailure: true })
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(' ') + 1).trim())
}

function resolveWorktreeRoot(target) {
  const abs = resolve(target)
  if (!existsSync(abs)) {
    return { ok: false, kind: 'usage', detail: `target path does not exist: ${abs}` }
  }
  let out
  try {
    out = git(abs, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    const message = String(error.stderr ?? error.message)
    if (message.includes('bare')) {
      return { ok: false, kind: 'usage', detail: `${abs} is a bare repository; preparation needs a working tree` }
    }
    return { ok: false, kind: 'usage', detail: `${abs} is not inside a Git working tree` }
  }
  return { ok: true, root: resolve(out.trim()) }
}

function teamContractStatus(root) {
  const teamPath = join(root, TEAM_CONTRACT_NAME)
  let stat = null
  try {
    stat = lstatSync(teamPath)
  } catch {
    // absent
  }
  if (!stat) return `${TEAM_CONTRACT_NAME}: absent (team repository owns it; harness never writes it)`
  if (stat.isSymbolicLink()) {
    const readable = existsSync(teamPath)
    return `${TEAM_CONTRACT_NAME}: present as a symlink${readable ? '' : ' (DANGLING — team contract unreadable)'}; the team contract must be a regular tracked file, harness never rewrites it`
  }
  const tracked = git(root, ['ls-files', '--', TEAM_CONTRACT_NAME], { allowFailure: true })
  return `${TEAM_CONTRACT_NAME}: present, ${tracked && tracked.trim() ? 'tracked' : 'untracked'} (untouched)`
}

function readOverlayState(root) {
  const deployPath = join(root, OVERLAY_DEPLOY_NAME)
  let stat
  try {
    stat = lstatSync(deployPath)
  } catch {
    return { state: 'absent', deployPath, existing: null }
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      state: 'not-a-regular-file',
      deployPath,
      existing: null,
      detail: stat.isSymbolicLink()
        ? 'a symlink sits at the deployment path; this tool materializes regular files only — inspect and remove it manually if it is stale'
        : `path exists but is not a regular file (mode ${stat.mode.toString(8)})`,
    }
  }
  return { state: 'present', deployPath, existing: readFileSync(deployPath, 'utf8') }
}

/** Refusal notice appended when only the shared machine layer exists. */
export function renderMissingDeltaNotice(profileName, hostId) {
  return [
    '---',
    '',
    `> Profile-specific host facts for \`${profileName}\` on host \`${hostId}\` are not recorded yet.`,
    `> Add \`contracts/${profileName}/hosts/${hostId}/AGENTS.local.md\` (see`,
    '> `contracts/HOST_FACTS_TEMPLATE.md`). Until then, ask the user for host-specific',
    '> toolchain and environment facts instead of assuming them.',
    '',
  ].join('\n')
}

/**
 * Load every overlay source part in deployment order: repository contract
 * (if the profile carries one) → repository profile → shared machine facts →
 * profile host facts. Host bodies are validated against template
 * placeholders; the managed header label names the exact contributing files.
 */
function loadOverlaySources(profile, hostSelection) {
  const parts = []
  const labelParts = []
  const contractPath = join(profile.dir, CONTRACT_SOURCE_NAME)
  if (existsSync(contractPath)) {
    parts.push(readFileSync(contractPath, 'utf8'))
    labelParts.push(`contracts/${profile.name}/${CONTRACT_SOURCE_NAME}`)
  }
  parts.push(readFileSync(join(profile.dir, PROFILE_SOURCE_NAME), 'utf8'))
  labelParts.push(`contracts/${profile.name}/${PROFILE_SOURCE_NAME}`)

  const hostLayers = []
  if (hostSelection.legacy) {
    hostLayers.push({ path: hostSelection.hostPath, tag: 'profile-level host facts' })
  } else {
    if (hostSelection.sharedPath != null) hostLayers.push({ path: hostSelection.sharedPath, tag: 'shared machine facts' })
    if (hostSelection.deltaPath != null) hostLayers.push({ path: hostSelection.deltaPath, tag: 'profile host facts' })
  }
  for (const layer of hostLayers) {
    const hostBody = readFileSync(layer.path, 'utf8')
    const facts = validateHostFacts(hostBody)
    if (!facts.ok) {
      return {
        error: {
          kind: 'host-facts-incomplete',
          detail: `${layer.path} still contains template placeholders at lines ${facts.missing.map((m) => m.line).join(', ')} — fill every REQUIRED: line (a value or NONE) before materializing`,
        },
      }
    }
    parts.push(hostBody)
    labelParts.push(`${layer.path.replace(/^.*contracts\//, 'contracts/')} (${layer.tag})`)
  }

  let body = composeOverlayParts(parts)
  if (!hostSelection.legacy && hostSelection.sharedPath != null && hostSelection.deltaPath == null) {
    body += renderMissingDeltaNotice(profile.name, hostSelection.hostId)
  }
  return { body, sourcesLabel: labelParts.join(' + ') }
}

function exclusionState(root) {
  const rel = git(root, ['rev-parse', '--git-path', 'info/exclude']).trim()
  const excludePath = resolve(root, rel)
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  return { excludePath, current, applied: applyExcludeEntry(current) }
}

function verifyIgnored(root) {
  try {
    git(root, ['check-ignore', '-q', '--', OVERLAY_DEPLOY_NAME])
    return true
  } catch {
    return false
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

export function prepareWorkspace(options) {
  const {
    check = false,
    explicitProfile = null,
    explicitHost = null,
    harnessRoot: harnessRootOption = null,
    target = process.cwd(),
  } = options
  const harnessRoot = resolve(
    harnessRootOption ?? dirname(fileURLToPath(new URL('.', import.meta.url))),
  )
  const lines = []
  const fail = (code, kind, detail) => ({ ok: false, code, kind, detail, lines })

  const resolved = resolveWorktreeRoot(target)
  if (!resolved.ok) return fail(2, resolved.kind, resolved.detail)
  const root = resolved.root
  lines.push(`target:          ${root}`)

  let profiles
  try {
    profiles = discoverProfiles(harnessRoot)
  } catch (error) {
    return fail(2, 'harness-layout', String(error.message ?? error))
  }
  const selection = selectProfile({
    profiles,
    explicit: explicitProfile,
    remotes: gitRemotes(root),
    basename: root.split('/').pop(),
  })
  if (!selection.ok) return fail(2, selection.kind, selection.detail)
  const { profile, matchedBy } = selection
  lines.push(`profile:         ${profile.name} (matched by ${matchedBy})`)
  lines.push(`team ${teamContractStatus(root)}`)

  const hostSelection = resolveHostSource(profile, {
    explicitHost,
    hostname: osHostname(),
    harnessRoot,
  })
  if (!hostSelection.ok) return fail(2, hostSelection.kind, hostSelection.detail)
  lines.push(
    `host facts:      ${
      hostSelection.legacy
        ? 'profile-level source (single host)'
        : `${hostSelection.hostId} (matched by ${hostSelection.matchedBy})`
    }`,
  )
  if (!hostSelection.legacy) {
    lines.push(
      `host layers:     ${
        [
          hostSelection.sharedPath != null ? 'shared machine facts' : null,
          hostSelection.deltaPath != null ? 'profile host facts' : null,
        ]
          .filter(Boolean)
          .join(' + ') || 'none'
      }`,
    )
  }

  let sources
  try {
    sources = loadOverlaySources(profile, hostSelection)
  } catch (error) {
    return fail(2, 'harness-layout', `profile sources missing under ${profile.dir}: ${String(error.message ?? error)}`)
  }
  if (sources.error) return fail(1, sources.error.kind, sources.error.detail)
  const desiredBody = sources.body
  const desiredArtifact = renderManagedArtifact({
    profileName: profile.name,
    harnessRoot,
    body: desiredBody,
    sourcesLabel: sources.sourcesLabel,
  })

  // Classify before ANY mutation: conflicts must leave the worktree untouched.
  const overlay = readOverlayState(root)
  if (overlay.state === 'not-a-regular-file') {
    return fail(1, 'overlay-conflict', `${overlay.deployPath}: ${overlay.detail}`)
  }
  let classification = classifyOverlay(overlay.existing, {
    profileName: profile.name,
    desiredBody,
  })
  // A body-identical artifact with a stale provenance header (e.g. after the
  // sources-label format changed) is still rewritten so the deployed header
  // stays current; content digests are unaffected.
  if (classification === 'up-to-date' && overlay.existing !== desiredArtifact) {
    classification = 'stale'
  }

  const exclusion = exclusionState(root)
  const exclusionOk =
    exclusion.applied.action === 'already-covered' ||
    exclusion.applied.action === 'replaced' ||
    exclusion.applied.action === 'added'
  const exclusionNeedsWrite =
    exclusionOk && exclusion.applied.action !== 'already-covered'

  const conflictKinds = { unmanaged: true, 'foreign-profile': true, 'hand-edited': true }
  if (conflictKinds[classification]) {
    const hostSourceHint = hostSelection.legacy
      ? `contracts/${profile.name}/${OVERLAY_SOURCE_NAME}`
      : (hostSelection.deltaPath ?? hostSelection.sharedPath ?? `${profile.dir}/${OVERLAY_SOURCE_NAME}`).replace(
          /^.*contracts\//,
          'contracts/',
        )
    const guidance = {
      unmanaged: [
        'an unmanaged AGENTS.local.md already exists; the harness never overwrites it silently',
        `to adopt harness management: move its unique content into ${hostSourceHint} (harness source), delete the target file, then re-run prepare`,
      ],
      'foreign-profile': [
        'the existing file is a managed artifact of a different profile; refusing to replace it',
        'if it is stale, remove it manually and re-run prepare',
      ],
      'hand-edited': [
        'the managed artifact was modified after materialization (content digest mismatch); refusing to discard the edit',
        `re-apply the edit to ${hostSourceHint} if it should persist, delete the target file, then re-run prepare`,
      ],
    }[classification]
    lines.push(`overlay:         ${classification} (${overlay.deployPath})`)
    lines.push(`exclusion:       ${exclusion.applied.action} (unchanged: conflict refused before any mutation)`)
    return fail(1, 'overlay-conflict', `${overlay.deployPath}: ${guidance.join('; ')}`)
  }

  const drift =
    classification === 'absent' || classification === 'stale' || exclusionNeedsWrite
  if (check) {
    lines.push(`overlay:         ${classification} (${overlay.deployPath})`)
    lines.push(`exclusion:       ${exclusion.applied.action} (checked, not written)`)
    if (drift) {
      const why = [
        classification === 'absent' ? 'overlay would be created' : null,
        classification === 'stale' ? 'overlay would be updated' : null,
        exclusionNeedsWrite ? 'exclusion would be added' : null,
      ]
        .filter(Boolean)
        .join('; ')
      return fail(1, 'overlay-drift', `--check: ${why}; run prepare without --check`)
    }
  } else {
    if (exclusionNeedsWrite) writeFileSync(exclusion.excludePath, exclusion.applied.content)
    lines.push(`exclusion:       ${exclusion.applied.action} via ${exclusion.excludePath}`)
    if (!verifyIgnored(root)) {
      return fail(1, 'exclusion-failed', `git check-ignore reports ${OVERLAY_DEPLOY_NAME} is NOT ignored after updating ${exclusion.excludePath}; investigate before trusting the worktree status`)
    }
    if (classification === 'absent' || classification === 'stale') {
      writeFileSync(overlay.deployPath, desiredArtifact)
      lines.push(`overlay:         ${classification === 'absent' ? 'created' : 'updated'} (${overlay.deployPath})`)
    } else {
      lines.push(`overlay:         ${classification} (${overlay.deployPath})`)
    }
    lines.push('validation:      git check-ignore ok; managed artifact digest ok')
  }

  return { ok: true, lines, root, profile: profile.name, classification }
}

function main(argv) {
  let check = false
  let explicitProfile = null
  let explicitHost = null
  let harnessRoot = null
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') check = true
    else if (arg === '--profile') explicitProfile = argv[++i] ?? null
    else if (arg === '--host') explicitHost = argv[++i] ?? null
    else if (arg === '--harness-root') harnessRoot = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/prepare-workspace.mjs [--check] [--profile <name>] [--host <id>] [--harness-root <dir>] [<target-root>]')
      return 0
    } else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`)
      return 2
    } else positional.push(arg)
  }
  if (positional.length > 1) {
    console.error('usage: node scripts/prepare-workspace.mjs [--check] [--profile <name>] [--host <id>] [--harness-root <dir>] [<target-root>]')
    return 2
  }
  const result = prepareWorkspace({
    check,
    explicitProfile,
    explicitHost,
    harnessRoot,
    target: positional[0] ?? process.cwd(),
  })
  for (const line of result.lines) console.log(line)
  if (!result.ok) {
    console.error(`error (${result.kind}): ${result.detail}`)
    return result.code
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)))
}

/**
 * Tests for workspace preparation (scripts/prepare-workspace.mjs).
 *
 * Coverage maps to the workspace-preparation requirements:
 * - basic: prepare into a temporary Git repository with a tracked team
 *   AGENTS.md — team content and tracked status unchanged, managed overlay
 *   materialized, `git status --short` clean;
 * - idempotence: second run changes nothing (no duplicate exclude records,
 *   no rewritten artifact);
 * - team evolution: a changed upstream team AGENTS.md survives exactly —
 *   the harness never restores its own copy;
 * - conflict safety: an unmanaged AGENTS.local.md is never overwritten; a
 *   hand-edited managed artifact is refused on digest evidence; a symlink at
 *   the deployment path is refused;
 * - repair: a stale managed artifact (harness sources changed) is updated;
 *   `--check` reports drift without writing;
 * - worktrees: preparation runs in a linked worktree, the shared
 *   info/exclude entry is not duplicated, the team file stays untouched;
 * - bounded failure: unknown repository/profile, bare repository, non-repo;
 * - pure helpers: composition, managed-artifact parse/render, digest
 *   verification, profile selection precedence, exclude-entry idempotence.
 *
 * Git is exercised for real against throwaway temporary repositories; no
 * network access, no global configuration writes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import {
  applyExcludeEntry,
  buildExcludeBlock,
  classifyOverlay,
  composeOverlayBody,
  composeOverlayParts,
  discoverProfiles,
  discoverSharedHosts,
  parseManagedArtifact,
  renderManagedArtifact,
  renderMissingDeltaNotice,
  resolveHostSource,
  selectProfile,
  sha256Hex,
} from '../prepare-workspace.mjs'

const SCRIPT = resolve(new URL('../prepare-workspace.mjs', import.meta.url).pathname)
const GIT_IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false']

function makeHarnessFixture({ hosts = null, sharedHosts = null, contract = false, omitLegacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wsprep-harness-'))
  const dir = join(root, 'contracts', 'FixProfile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'profile.json'),
    JSON.stringify({ profile: 'FixProfile', match: { remoteSubstrings: ['fixrepo.example/fix-target.git'] } }),
  )
  writeFileSync(
    join(dir, 'REPOSITORY_PROFILE.md'),
    '# Fix Repository Profile (harness-owned)\n\nexclude_dirs: fixture-x\n',
  )
  if (contract) {
    writeFileSync(
      join(dir, 'REPOSITORY_CONTRACT.md'),
      '# Fix Repository Contract (harness-carried)\n\nCanonical build: fixture-build-cmd\n',
    )
  }
  if (sharedHosts != null) {
    const sharedDir = join(root, 'contracts', 'hosts', sharedHosts.hostId)
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(
      join(sharedDir, 'AGENTS.local.md'),
      sharedHosts.incomplete
        ? '# Shared Host Facts\n\nCANN: REQUIRED: fill me\n'
        : '# Shared Host Facts\n\naccelerator: fix-device\n',
    )
    writeFileSync(
      join(sharedDir, 'host.json'),
      JSON.stringify({ host: sharedHosts.hostId, hostnames: sharedHosts.hostnames }),
    )
  }
  if (hosts == null) {
    if (!omitLegacy) {
      writeFileSync(join(dir, 'AGENTS.local.md'), '# Fix Local Host Facts\n\nconda: fix-env\n')
    }
  } else {
    const hostDir = join(dir, 'hosts', hosts.hostId)
    mkdirSync(hostDir, { recursive: true })
    writeFileSync(
      join(hostDir, 'AGENTS.local.md'),
      hosts.incomplete
        ? '# Fix Local Host Facts\n\nCANN: REQUIRED: fill me\n'
        : '# Fix Local Host Facts\n\nconda: fix-env\n',
    )
    if (hosts.hostnames) {
      writeFileSync(
        join(hostDir, 'host.json'),
        JSON.stringify({ host: hosts.hostId, hostnames: hosts.hostnames }),
      )
    }
    if (hosts.alsoProfileLevel) {
      writeFileSync(join(dir, 'AGENTS.local.md'), 'duplicate source\n')
    }
  }
  return root
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' })
}

function runCli(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

function initTargetRepo({ withRemote = true, basenamePrefix = 'wsprep-target-' } = {}) {
  const root = mkdtempSync(join(tmpdir(), basenamePrefix))
  sh('git', ['init', '-q'], root)
  writeFileSync(join(root, 'AGENTS.md'), '# Team Contract\n\nTeam build rule A.\n')
  sh('git', ['add', 'AGENTS.md'], root)
  sh('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'team contract'], root)
  if (withRemote) sh('git', ['remote', 'add', 'origin', 'https://fixrepo.example/fix-target.git'], root)
  return root
}

function excludePath(root) {
  return resolve(root, sh('git', ['rev-parse', '--git-path', 'info/exclude'], root).trim())
}

test('composeOverlayBody joins profile then local facts deterministically', () => {
  const body = composeOverlayBody('Profile\n', 'Local\n')
  assert.equal(body, 'Profile\n\n---\n\nLocal\n')
  assert.equal(composeOverlayBody('A', 'B'), composeOverlayBody('A\n\n', 'B  \n\n'))
})

test('composeOverlayParts joins non-empty parts in order and drops empty ones', () => {
  assert.equal(
    composeOverlayParts(['Contract\n', 'Profile\n', 'Shared\n', 'Delta\n']),
    'Contract\n\n---\n\nProfile\n\n---\n\nShared\n\n---\n\nDelta\n',
  )
  assert.equal(composeOverlayParts([null, 'P', '', '  \n', 'D\n']), composeOverlayBody('P', 'D'))
  assert.equal(composeOverlayParts([]), '')
})

test('discoverSharedHosts reads the shared machine layer with hostname aliases', () => {
  const harnessRoot = makeHarnessFixture({ sharedHosts: { hostId: 'BoxA', hostnames: ['a1', 'a2'] } })
  const shared = discoverSharedHosts(harnessRoot)
  assert.equal(shared.length, 1)
  assert.equal(shared[0].hostId, 'BoxA')
  assert.deepEqual(shared[0].hostnames, ['a1', 'a2'])
  assert.match(shared[0].hostPath, /contracts\/hosts\/BoxA\/AGENTS\.local\.md$/)
  rmSync(harnessRoot, { recursive: true, force: true })
})

test('resolveHostSource composes shared and profile-delta layers by host id', () => {
  const harnessRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'FixHost', hostnames: ['fix-box'] },
    hosts: { hostId: 'FixHost', hostnames: ['fix-box'] },
  })
  const profile = { name: 'FixProfile', dir: join(harnessRoot, 'contracts', 'FixProfile') }
  const both = resolveHostSource(profile, { hostname: 'fix-box', harnessRoot })
  assert.equal(both.ok, true)
  assert.equal(both.hostId, 'FixHost')
  assert.match(both.sharedPath, /contracts\/hosts\/FixHost\/AGENTS\.local\.md$/)
  assert.match(both.deltaPath, /contracts\/FixProfile\/hosts\/FixHost\/AGENTS\.local\.md$/)
  rmSync(harnessRoot, { recursive: true, force: true })

  // A delta-only host (no shared entry) and a shared-only host are both valid.
  const deltaOnlyRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'OtherBox', hostnames: ['other'] },
    hosts: { hostId: 'FixHost', hostnames: ['fix-box'] },
  })
  const deltaProfile = { name: 'FixProfile', dir: join(deltaOnlyRoot, 'contracts', 'FixProfile') }
  const deltaOnly = resolveHostSource(deltaProfile, { explicitHost: 'FixHost', harnessRoot: deltaOnlyRoot })
  assert.equal(deltaOnly.ok, true)
  assert.equal(deltaOnly.sharedPath, null)
  assert.match(deltaOnly.deltaPath, /contracts\/FixProfile\/hosts\/FixHost\/AGENTS\.local\.md$/)
  const sharedOnly = resolveHostSource(deltaProfile, { explicitHost: 'OtherBox', harnessRoot: deltaOnlyRoot })
  assert.equal(sharedOnly.ok, true)
  assert.match(sharedOnly.sharedPath, /contracts\/hosts\/OtherBox\/AGENTS\.local\.md$/)
  assert.equal(sharedOnly.deltaPath, null)
  rmSync(deltaOnlyRoot, { recursive: true, force: true })
})

test('resolveHostSource: a hostname matching two host ids is ambiguous, never a guess', () => {
  const harnessRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'BoxA', hostnames: ['dupe-box'] },
    hosts: { hostId: 'BoxB', hostnames: ['dupe-box'] },
  })
  const profile = { name: 'FixProfile', dir: join(harnessRoot, 'contracts', 'FixProfile') }
  const result = resolveHostSource(profile, { hostname: 'dupe-box', harnessRoot })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'ambiguous-host')
  rmSync(harnessRoot, { recursive: true, force: true })
})

test('managed artifact round-trips and detects tampering', () => {
  const body = composeOverlayBody('P\n', 'L\n')
  const artifact = renderManagedArtifact({ profileName: 'FixProfile', harnessRoot: '/harness', body })
  const parsed = parseManagedArtifact(artifact)
  assert.equal(parsed.managed, true)
  assert.equal(parsed.profile, 'FixProfile')
  assert.equal(parsed.body, body)
  assert.equal(parsed.sha, sha256Hex(body))
  assert.equal(parseManagedArtifact('just a team file').managed, false)
  assert.equal(
    parseManagedArtifact(`some preamble\n<!-- compiler-dev-harness:managed-v1\nprofile: X\ncontent-sha256: ${'0'.repeat(64)}\n-->\nbody`).managed,
    false,
    'marker must start at offset 0 to identify ownership',
  )
  const tampered = artifact.replace('L\n', 'L-edited\n')
  assert.equal(
    classifyOverlay(tampered, { profileName: 'FixProfile', desiredBody: body }),
    'hand-edited',
  )
})

test('classifyOverlay distinguishes absent, unmanaged, foreign, up-to-date, stale', () => {
  const body = composeOverlayBody('P\n', 'L\n')
  const artifact = renderManagedArtifact({ profileName: 'FixProfile', harnessRoot: '/harness', body })
  assert.equal(classifyOverlay(null, { profileName: 'FixProfile', desiredBody: body }), 'absent')
  assert.equal(classifyOverlay('# mine\n', { profileName: 'FixProfile', desiredBody: body }), 'unmanaged')
  assert.equal(
    classifyOverlay(
      renderManagedArtifact({ profileName: 'Other', harnessRoot: '/h', body }),
      { profileName: 'FixProfile', desiredBody: body },
    ),
    'foreign-profile',
  )
  assert.equal(classifyOverlay(artifact, { profileName: 'FixProfile', desiredBody: body }), 'up-to-date')
  assert.equal(classifyOverlay(artifact, { profileName: 'FixProfile', desiredBody: body + 'more\n' }), 'stale')
})

test('selectProfile: explicit > remote > basename, ambiguity and no-match are errors', () => {
  const profiles = [
    { name: 'A', dir: '/a', match: { remoteSubstrings: ['shared'], basenames: ['both'] } },
    { name: 'B', dir: '/b', match: { remoteSubstrings: ['shared'], basenames: ['both'] } },
    { name: 'C', dir: '/c', match: { remoteSubstrings: ['only-c'], basenames: ['c-dir'] } },
  ]
  assert.equal(selectProfile({ profiles, explicit: 'C', remotes: [], basename: 'x' }).matchedBy, 'explicit')
  assert.equal(selectProfile({ profiles, explicit: 'Z', remotes: [], basename: 'x' }).kind, 'unknown-profile')
  assert.equal(selectProfile({ profiles, explicit: null, remotes: ['https://x/only-c.git'], basename: 'zzz' }).profile.name, 'C')
  assert.equal(selectProfile({ profiles, explicit: null, remotes: ['https://x/shared.git'], basename: 'zzz' }).kind, 'ambiguous-profile')
  assert.equal(selectProfile({ profiles, explicit: null, remotes: [], basename: 'c-dir' }).profile.name, 'C')
  assert.equal(selectProfile({ profiles, explicit: null, remotes: [], basename: 'both' }).kind, 'ambiguous-profile')
  assert.equal(selectProfile({ profiles, explicit: null, remotes: [], basename: 'nothing' }).kind, 'no-match')
})

test('applyExcludeEntry is idempotent and preserves pre-existing entries', () => {
  const block = buildExcludeBlock()
  const added = applyExcludeEntry('')
  assert.deepEqual([added.action, added.content], ['added', block])
  const addedAfterOther = applyExcludeEntry('*.log\n')
  assert.equal(addedAfterOther.action, 'added')
  assert.ok(addedAfterOther.content.startsWith('*.log\n\n'))
  const covered = applyExcludeEntry('AGENTS.local.md\n')
  assert.deepEqual([covered.action, covered.content], ['already-covered', 'AGENTS.local.md\n'])
  const blockCovered = applyExcludeEntry(block)
  assert.equal(blockCovered.action, 'already-covered')
  const refreshed = applyExcludeEntry(
    '# BEGIN compiler-dev-harness managed local instructions\nstale-entry\n# END compiler-dev-harness managed local instructions\n',
  )
  assert.equal(refreshed.action, 'replaced')
  assert.ok(refreshed.content.includes('AGENTS.local.md'))
  const malformed = applyExcludeEntry(
    '# BEGIN compiler-dev-harness managed local instructions\nstale-entry\n',
  )
  assert.equal(malformed.action, 'error')
})

test('discoverProfiles rejects a manifest whose name mismatches its directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsprep-bad-'))
  const dir = join(root, 'contracts', 'DirName')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ profile: 'Other', match: {} }))
  assert.throws(() => discoverProfiles(root), /mismatch/)
  rmSync(root, { recursive: true, force: true })
})

test('basic: prepare materializes the overlay and leaves the team file and git status untouched', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  const teamBefore = readFileSync(join(target, 'AGENTS.md'), 'utf8')
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /overlay:         created/)
  assert.match(result.stdout, /matched by remote/)
  assert.match(result.stdout, /AGENTS\.md: present, tracked \(untouched\)/)
  assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), teamBefore)
  assert.match(sh('git', ['ls-files'], target), /AGENTS\.md/)
  const overlay = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  assert.match(overlay, /compiler-dev-harness:managed-v1/)
  assert.match(overlay, /profile: FixProfile/)
  assert.match(overlay, /Fix Repository Profile \(harness-owned\)/)
  assert.match(overlay, /Fix Local Host Facts/)
  assert.equal(sh('git', ['status', '--short'], target), '')
  const exclude = readFileSync(excludePath(target), 'utf8')
  assert.ok(exclude.includes('# BEGIN compiler-dev-harness managed local instructions'))
  assert.ok(sh('git', ['check-ignore', '-q', '--', 'AGENTS.local.md'], target) !== undefined || true)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('idempotence: a second run rewrites nothing and duplicates no exclude records', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  assert.equal(runCli(['--harness-root', harnessRoot, target]).status, 0)
  const overlayAfterFirst = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  const excludeAfterFirst = readFileSync(excludePath(target), 'utf8')
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /overlay:         up-to-date/)
  assert.equal(readFileSync(join(target, 'AGENTS.local.md'), 'utf8'), overlayAfterFirst)
  const excludeAfterSecond = readFileSync(excludePath(target), 'utf8')
  assert.equal(excludeAfterSecond, excludeAfterFirst)
  assert.equal(excludeAfterSecond.split('AGENTS.local.md').length - 1, 1)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('team evolution: upstream team AGENTS.md changes survive preparation exactly', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  assert.equal(runCli(['--harness-root', harnessRoot, target]).status, 0)
  writeFileSync(join(target, 'AGENTS.md'), '# Team Contract\n\nTeam build rule A.\nTeam build rule B (new upstream).\n')
  sh('git', ['add', 'AGENTS.md'], target)
  sh('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'team evolves contract'], target)
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /overlay:         up-to-date/)
  const overlay = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  assert.doesNotMatch(overlay, /Team build rule B/)
  assert.equal(
    readFileSync(join(target, 'AGENTS.md'), 'utf8'),
    '# Team Contract\n\nTeam build rule A.\nTeam build rule B (new upstream).\n',
    'team content must survive byte-exactly; no harness restoration',
  )
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('unmanaged AGENTS.local.md is never overwritten and nothing is mutated', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  writeFileSync(join(target, 'AGENTS.local.md'), '# my personal notes\nkeep me\n')
  const excludeBefore = exists(excludePath(target)) ? readFileSync(excludePath(target), 'utf8') : null
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unmanaged AGENTS\.local\.md/)
  assert.match(result.stderr, /never overwrites/)
  assert.equal(readFileSync(join(target, 'AGENTS.local.md'), 'utf8'), '# my personal notes\nkeep me\n')
  const excludeAfter = exists(excludePath(target)) ? readFileSync(excludePath(target), 'utf8') : null
  assert.equal(excludeAfter, excludeBefore, 'conflict must be refused before any exclusion mutation')
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('hand-edited managed artifact is refused with digest evidence', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  assert.equal(runCli(['--harness-root', harnessRoot, target]).status, 0)
  const materialized = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  writeFileSync(join(target, 'AGENTS.local.md'), materialized + '\nHand edit worth keeping.\n')
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /overlay:         hand-edited/)
  assert.match(result.stderr, /digest mismatch/)
  assert.match(result.stderr, /refusing to discard the edit/)
  assert.match(readFileSync(join(target, 'AGENTS.local.md'), 'utf8'), /Hand edit worth keeping\./)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('a symlink at the deployment path is refused, not followed or replaced', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  symlinkSync(join(target, 'AGENTS.md'), join(target, 'AGENTS.local.md'))
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /symlink/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('stale managed artifact: prepare updates it; --check reports drift without writing', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  assert.equal(runCli(['--harness-root', harnessRoot, target]).status, 0)
  writeFileSync(join(harnessRoot, 'contracts', 'FixProfile', 'AGENTS.local.md'), '# Fix Local Host Facts\n\nconda: fix-env2\nNEW-LOCAL-FACT: yes\n')
  const before = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  const check = runCli(['--check', '--harness-root', harnessRoot, target])
  assert.equal(check.status, 1)
  assert.match(check.stderr, /would be updated/)
  assert.equal(readFileSync(join(target, 'AGENTS.local.md'), 'utf8'), before, '--check must not write')
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /overlay:         updated/)
  assert.match(readFileSync(join(target, 'AGENTS.local.md'), 'utf8'), /NEW-LOCAL-FACT: yes/)
  assert.equal(runCli(['--check', '--harness-root', harnessRoot, target]).status, 0)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('linked worktree: preparation runs there, exclusion stays shared, team file untouched', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo()
  assert.equal(runCli(['--harness-root', harnessRoot, target]).status, 0)
  const excludeAfterMain = readFileSync(excludePath(target), 'utf8')
  const worktree = join(mkdtempSync(join(tmpdir(), 'wsprep-wt-parent-')), 'wt')
  sh('git', ['worktree', 'add', '-q', '-b', 'wtb', worktree], target)
  const result = runCli(['--harness-root', harnessRoot, worktree])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /overlay:         created/)
  assert.match(readFileSync(join(worktree, 'AGENTS.local.md'), 'utf8'), /compiler-dev-harness:managed-v1/)
  assert.equal(
    readFileSync(join(worktree, 'AGENTS.md'), 'utf8'),
    '# Team Contract\n\nTeam build rule A.\n',
    'team file untouched in the worktree',
  )
  assert.equal(sh('git', ['status', '--short'], worktree), '')
  assert.equal(readFileSync(excludePath(worktree), 'utf8'), excludeAfterMain, 'info/exclude is shared; no duplicate entries')
  assert.ok(sh('git', ['check-ignore', '-q', '--', 'AGENTS.local.md'], worktree) !== undefined || true)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(worktree, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('unknown repository is a bounded failure, not a guess', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo({ withRemote: false })
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /no profile matches/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('explicit profile overrides identity evidence; unknown explicit profile fails bounded', () => {
  const harnessRoot = makeHarnessFixture()
  const target = initTargetRepo({ withRemote: false })
  const ok = runCli(['--harness-root', harnessRoot, '--profile', 'FixProfile', target])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /matched by explicit/)
  const missing = runCli(['--harness-root', harnessRoot, '--profile', 'Missing', target])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /unknown-profile/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('bare repositories and non-repositories are rejected with usage errors', () => {
  const harnessRoot = makeHarnessFixture()
  const bare = mkdtempSync(join(tmpdir(), 'wsprep-bare-'))
  sh('git', ['init', '-q', '--bare'], bare)
  const bareResult = runCli(['--harness-root', harnessRoot, bare])
  assert.equal(bareResult.status, 2)
  assert.match(bareResult.stderr, /bare/)
  const plain = mkdtempSync(join(tmpdir(), 'wsprep-plain-'))
  const plainResult = runCli(['--harness-root', harnessRoot, plain])
  assert.equal(plainResult.status, 2)
  assert.match(plainResult.stderr, /not inside a Git working tree/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

test('per-host source: hostname selects the host facts and the header names it', () => {
  const harnessRoot = makeHarnessFixture({ hosts: { hostId: 'FixHost', hostnames: [hostname()] } })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /host facts:      FixHost \(matched by hostname\)/)
  const overlay = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  assert.match(overlay, /hosts\/FixHost\/AGENTS\.local\.md/)
  assert.match(overlay, /Fix Local Host Facts/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('explicit --host overrides hostname matching; unknown host fails bounded', () => {
  const harnessRoot = makeHarnessFixture({ hosts: { hostId: 'FixHost', hostnames: ['other-box'] } })
  const target = initTargetRepo()
  const ok = runCli(['--harness-root', harnessRoot, '--host', 'FixHost', target])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /host facts:      FixHost \(matched by explicit\)/)
  const missing = runCli(['--harness-root', harnessRoot, '--host', 'Ghost', target])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /unknown-host/)
  assert.match(missing.stderr, /HOST_FACTS_TEMPLATE\.md/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('a hostname with no matching host source is a bounded failure with onboarding guidance', () => {
  const harnessRoot = makeHarnessFixture({ hosts: { hostId: 'FixHost', hostnames: ['other-box'] } })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /matches no host source/)
  assert.match(result.stderr, /HOST_FACTS_TEMPLATE\.md/)
  assert.equal(exists(join(target, 'AGENTS.local.md')), false, 'no overlay may be materialized from another host facts')
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('incomplete host facts (leftover REQUIRED:) are refused before materializing', () => {
  const harnessRoot = makeHarnessFixture({ hosts: { hostId: 'FixHost', hostnames: [hostname()], incomplete: true } })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /host-facts-incomplete/)
  assert.match(result.stderr, /REQUIRED: line/)
  assert.equal(exists(join(target, 'AGENTS.local.md')), false)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('profile-level and hosts/ sources at once is an error, never a silent pick', () => {
  const harnessRoot = makeHarnessFixture({
    hosts: { hostId: 'FixHost', hostnames: [hostname()], alsoProfileLevel: true },
  })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /ambiguous-host-source/)
  assert.match(result.stderr, /exactly one source/)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('shared + delta + carried contract: composition order and provenance header', () => {
  const harnessRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'FixHost', hostnames: [hostname()] },
    hosts: { hostId: 'FixHost' },
    contract: true,
  })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /host facts:      FixHost \(matched by hostname\)/)
  assert.match(result.stdout, /host layers:     shared machine facts \+ profile host facts/)
  const overlay = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  const contractAt = overlay.indexOf('Fix Repository Contract (harness-carried)')
  const profileAt = overlay.indexOf('Fix Repository Profile (harness-owned)')
  const sharedAt = overlay.indexOf('Shared Host Facts')
  const deltaAt = overlay.indexOf('Fix Local Host Facts')
  assert.ok(contractAt !== -1 && profileAt !== -1 && sharedAt !== -1 && deltaAt !== -1)
  assert.ok(contractAt < profileAt && profileAt < sharedAt && sharedAt < deltaAt, 'contract → profile → shared → delta order')
  assert.match(overlay, /Canonical build: fixture-build-cmd/)
  assert.match(overlay, /sources: contracts\/FixProfile\/REPOSITORY_CONTRACT\.md \+ contracts\/FixProfile\/REPOSITORY_PROFILE\.md \+ contracts\/hosts\/FixHost\/AGENTS\.local\.md/)
  assert.match(overlay, /contracts\/FixProfile\/hosts\/FixHost\/AGENTS\.local\.md \(profile host facts\)/)
  assert.doesNotMatch(overlay, /not recorded yet/, 'no missing-delta notice when the delta exists')
  assert.equal(sh('git', ['status', '--short'], target), '')
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('shared-only host: materializes shared facts plus the missing-delta notice', () => {
  const harnessRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'FixHost', hostnames: [hostname()] },
    contract: true,
    omitLegacy: true,
  })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /host layers:     shared machine facts/)
  const overlay = readFileSync(join(target, 'AGENTS.local.md'), 'utf8')
  assert.match(overlay, /Shared Host Facts/)
  assert.match(overlay, /not recorded yet/)
  assert.match(overlay, /contracts\/FixProfile\/hosts\/FixHost\/AGENTS\.local\.md/)
  assert.match(overlay, /ask the user for host-specific/)
  assert.equal(renderMissingDeltaNotice('X', 'Y').includes('contracts/X/hosts/Y/AGENTS.local.md'), true)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('incomplete shared host facts (REQUIRED:) are refused before materializing', () => {
  const harnessRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'FixHost', hostnames: [hostname()], incomplete: true },
    omitLegacy: true,
  })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /host-facts-incomplete/)
  assert.match(result.stderr, /contracts\/hosts\/FixHost\/AGENTS\.local\.md/)
  assert.match(result.stderr, /REQUIRED: line/)
  assert.equal(exists(join(target, 'AGENTS.local.md')), false)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

test('a hostname shared by no layer fails bounded with two-layer onboarding guidance', () => {
  const harnessRoot = makeHarnessFixture({
    sharedHosts: { hostId: 'FixHost', hostnames: ['other-box'] },
    omitLegacy: true,
  })
  const target = initTargetRepo()
  const result = runCli(['--harness-root', harnessRoot, target])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /matches no host source/)
  assert.match(result.stderr, /contracts\/hosts\/<id>\/AGENTS\.local\.md \(shared machine facts\)/)
  assert.equal(exists(join(target, 'AGENTS.local.md')), false)
  rmSync(harnessRoot, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

function exists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

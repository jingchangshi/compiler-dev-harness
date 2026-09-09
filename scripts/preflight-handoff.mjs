/**
 * Consumer preflight for handoff-first presentations (Phase T2).
 *
 * ONE deterministic gate that the presentation consumer runs BEFORE any
 * handoff-first generation. It reuses the Teaching Artifact Protocol owner
 * (scripts/teaching-schema.mjs + compiler-explain-driver.mjs) — it does NOT
 * redefine any schema. Output is a bounded consumption digest the
 * presentation skill uses directly as its semantic input, so the deck is
 * derived from the handoff instead of re-deriving it from source.
 *
 * Verdicts:
 *   CONSUMABLE          — schema valid, READY, FRESH, supported schema version
 *   NOT_CONSUMABLE      — bundle invalid / readiness not ready (see reasons)
 *   STALE_PRESENTATION_INPUT — bundle is stale; refresh the explanation bundle first
 *   UNSUPPORTED_SCHEMA  — future/unknown schema version; fail clearly, never guess
 *
 * Usage: node scripts/preflight-handoff.mjs <bundle-dir> [--subject-id <id>] [--repo-root <dir>]
 *
 * Anti-overfitting: this module must stay subject-agnostic (enforced by the
 * teaching-dogfood test's generic-layer scan).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  validateBundle, computeReadiness, computeStaleness, SCHEMA_VERSION,
} from './teaching-schema.mjs'
import { loadBundle, stalenessForBundle, resolveCompositionImports } from '../compiler-explain-driver.mjs'

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function buildDigest(bundle) {
  const h = bundle.handoff || {}
  const d = bundle.dossier || {}
  return {
    subject_id: h.subject_id || d.subject_id,
    subject_type: h.subject_type || d.subject_type,
    storyline: (h.storyline || []).map((s, i) => ({
      position: s.position ?? i + 1,
      role: s.role,
      claim: s.claim,
      dossier_section: s.dossier_section,
      evidence_refs: s.evidence_refs || [],
    })),
    visuals: (h.visuals || []).map((v) => ({ id: v.id, kind: v.kind, title: v.title, nodes: (v.nodes || []).length, edges: (v.edges || []).length, ordering: v.ordering || [] })),
    must_have_visuals: h.must_have_visuals || [],
    optional_visuals: h.optional_visuals || [],
    canonical_example: h.canonical_example || (d.canonical_example ? { summary: 'see dossier.canonical_example', provenance: d.canonical_example.provenance } : undefined),
    // Phase T5 worked examples: semantic references the deck must map to
    // slides (manifest coverage is checker-enforced); full step detail comes
    // from the dossier pointers.
    worked_examples: (h.worked_examples || []).map((w) => ({
      id: w.id, title: w.title, summary: w.summary, evidence_refs: w.evidence_refs || [],
    })),
    worked_examples_full: (d.worked_examples || []).length > 0 ? d.worked_examples : undefined,
    learning_objectives: h.learning_objectives || [],
    key_takeaways: h.key_takeaways || [],
    comparisons: (h.comparisons || []).map((c) => c.id || c.compared?.join(' vs ')).filter(Boolean),
    important_decisions: (h.important_decisions || []).map((x) => x.id || x.question).filter(Boolean),
    evidence_index: (h.evidence_index || []).map((e) => ({ id: e.id, class: e.class, statement: e.statement })),
    audience: h.audience,
    // dossier detail the consumer may read for notes/labels/citations, never to
    // overturn the story:
    dossier_pointers: {
      mental_model: d.mental_model,
      mechanism_stages: (d.mechanism?.stages || []).map((s) => ({ name: s.name, where: s.where })),
      canonical_example_full: d.canonical_example,
      placement: d.placement,
      boundaries: d.boundaries,
      risks: d.risks,
    },
  }
}

export function preflightHandoff(bundleDir, { subjectId, repoRoot } = {}) {
  const reasons = []
  const load = loadBundle(bundleDir)
  if (!load.ok) return { verdict: 'NOT_CONSUMABLE', reasons: [load.error] }
  const bundle = load.bundle
  const dir = load.dir

  // Schema version compatibility: fail clearly on unknown versions.
  const handoffVersion = bundle.handoff?.schema_version
  if (bundle.handoff && handoffVersion !== SCHEMA_VERSION) {
    return {
      verdict: 'UNSUPPORTED_SCHEMA',
      reasons: [`handoff schema_version ${JSON.stringify(handoffVersion)} not supported (supported: ${SCHEMA_VERSION}) — do not guess fields; refresh the explanation bundle with a compatible producer`],
      dir,
    }
  }

  // Composition inputs (Phase T3): when the bundle declares child-bundle
  // imports (composition.json), resolve them so namespaced evidence
  // references validate — this is bundle-level provenance handling, not
  // system-story special-casing. Recursive freshness is already covered: the
  // staleness check below calls the same driver entrypoint that aggregates
  // child-bundle staleness and import hash drift.
  let imports = []
  if (bundle.composition !== undefined) {
    const resolved = resolveCompositionImports(dir)
    if (!resolved.ok) {
      reasons.push(`composition imports unresolvable: ${resolved.errors.slice(0, 4).join('; ')}`)
    } else {
      imports = resolved.imports
    }
  }

  const { errors } = validateBundle(bundle, { imports })
  if (errors.length > 0) reasons.push(`schema invalid: ${errors.slice(0, 8).join('; ')}`)

  // Subject id match (when the consumer declares which subject it is presenting).
  const bundleSubjectId = bundle.subject?.subject_id || bundle.dossier?.subject_id
  if (subjectId !== undefined && bundleSubjectId !== subjectId) {
    reasons.push(`subject id mismatch: bundle has ${JSON.stringify(bundleSubjectId)}, requested ${JSON.stringify(subjectId)}`)
  }

  // Freshness BEFORE anything else — a stale bundle must stop handoff-first
  // consumption even if it happens to be schema-valid.
  const provenance = bundle.subject?.provenance
  if (!provenance) {
    reasons.push('staleness unknown: subject.json has no provenance')
  } else {
    const root = repoRoot || provenance.repository_path || undefined
    const stale = stalenessForBundle(dir, root)
    if (!stale.ok) reasons.push(`staleness unknown: ${stale.error}`)
    else if (stale.staleness.stale) {
      const compositionReasons = stale.staleness.composition?.stale
        ? stale.staleness.composition.reasons
        : []
      return {
        verdict: 'STALE_PRESENTATION_INPUT',
        reasons: [
          `analyzed source changed since analysis (head_at_analysis=${stale.staleness.head_at_analysis}, head_now=${stale.staleness.head_now}, changed_files=${stale.staleness.stale_files.join(', ') || 'none'})`,
          ...compositionReasons,
          'refresh the explanation bundle first — never edit the recorded handoff SHAs to bypass this gate',
        ],
        dir,
        staleness: stale.staleness,
      }
    }
  }

  // Readiness: recompute from the recorded semantic review (never trust a
  // stale verdict field).
  const readiness = computeReadiness({
    subject: bundle.subject, evidence: bundle.evidence, dossier: bundle.dossier,
    handoff: bundle.handoff, readiness: bundle.readiness, composition: bundle.composition,
  }, { depth: bundle.dossier?.depth, imports })
  if (readiness.verdict !== 'ready') reasons.push(...readiness.reasons)

  // Handoff presence is a handoff-first precondition.
  if (!bundle.handoff) reasons.push('no handoff.json in bundle — use Mode B (produce a handoff via the code-explanation workflow) or Mode C (raw input)')

  if (reasons.length > 0) return { verdict: 'NOT_CONSUMABLE', reasons, dir }

  const handoffPath = join(dir, 'handoff.json')
  const dossierPath = join(dir, 'dossier.json')
  return {
    verdict: 'CONSUMABLE',
    dir,
    subject_id: bundleSubjectId,
    subject_type: bundle.dossier?.subject_type,
    depth: bundle.dossier?.depth,
    source_head: provenance?.head,
    handoff_sha256: sha256File(handoffPath),
    dossier_sha256: sha256File(dossierPath),
    readiness: { verdict: 'ready', semantic_reviewed_at: bundle.readiness?.semantic_review?.reviewed_at || bundle.readiness?.evaluated_at },
    digest: buildDigest(bundle),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
  const bundleDir = args.find((a) => !a.startsWith('--'))
  if (!bundleDir) {
    console.error('usage: node scripts/preflight-handoff.mjs <bundle-dir> [--subject-id <id>] [--repo-root <dir>]')
    process.exit(2)
  }
  const out = preflightHandoff(resolve(bundleDir), { subjectId: get('--subject-id'), repoRoot: get('--repo-root') ? resolve(get('--repo-root')) : undefined })
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.verdict === 'CONSUMABLE' ? 0 : 1)
}

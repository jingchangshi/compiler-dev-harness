#!/usr/bin/env python3
"""Consumer-side coverage checker for presentation-manifest.json (Phase T2).

This is NOT a second Teaching Artifact Protocol validator. Protocol gating
(schema validity, READY, FRESH, subject identity) is owned by the harness
preflight (`node scripts/preflight-handoff.mjs <bundle>`), which must have
returned CONSUMABLE before any handoff-first deck is generated. This script
only checks consumer coverage obligations against the manifest:

  - manifest schema_version supported
  - input identity fields present
  - story coverage: every handoff storyline step is consumed by >= 1 slide,
    or explicitly deferred (appendix/omitted) WITH a recorded reason
  - visual coverage: every must_have visual maps to an existing asset
  - optional visuals may be absent
  - evidence traceability: manifest evidence ids are a subset of the handoff
    evidence index (checked when the handoff.json path is provided)
  - generated assets referenced by the manifest exist
  - slide references appear in slides.qmd (header text mapping)

Usage (from a presentation project):
  python3 scripts/validate_manifest.py                 # manifest vs project
  python3 scripts/validate_manifest.py --handoff <path/to/handoff.json>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

SUPPORTED_MANIFEST_SCHEMA = 1
DISPOSITIONS = {"consumed", "split", "merged", "appendix", "omitted"}
DEFERRED = {"appendix", "omitted"}
EXAMPLE_DISPOSITIONS = {"consumed", "appendix", "omitted"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(errors: list, message: str) -> None:
    errors.append(message)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", type=Path, default=Path("presentation-manifest.json"))
    ap.add_argument("--handoff", type=Path, default=None,
                    help="path to the consumed handoff.json for coverage/traceability cross-checks")
    args = ap.parse_args()

    root = Path.cwd()
    errors: list = []

    manifest_path = args.manifest if args.manifest.is_absolute() else root / args.manifest
    if not manifest_path.is_file():
        print("ERROR: no presentation manifest — handoff-first projects require one", file=sys.stderr)
        return 1
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        print(f"ERROR: manifest is not valid JSON: {err}", file=sys.stderr)
        return 1

    # Manifest version: fail clearly on unknown versions.
    if manifest.get("schema_version") != SUPPORTED_MANIFEST_SCHEMA:
        print(f"ERROR: unsupported manifest schema_version {manifest.get('schema_version')!r} "
              f"(supported: {SUPPORTED_MANIFEST_SCHEMA})", file=sys.stderr)
        return 1

    inp = manifest.get("input")
    if not isinstance(inp, dict):
        fail(errors, "input: missing input block")
        inp = {}
    for field in ("bundle_id", "subject_id", "subject_type", "handoff_schema_version",
                  "handoff_sha256", "source_head", "readiness_verdict"):
        if not inp.get(field):
            fail(errors, f"input.{field}: missing")
    if inp.get("readiness_verdict") != "ready":
        fail(errors, f"input.readiness_verdict is {inp.get('readiness_verdict')!r} — "
                     "handoff-first generation requires a READY bundle")
    if inp.get("preflight") not in (None, "CONSUMABLE"):
        fail(errors, f"input.preflight is {inp.get('preflight')!r} — must be CONSUMABLE")

    consumed = manifest.get("consumed") or {}
    storyline = consumed.get("storyline") or []
    visuals = consumed.get("must_have_visuals") or []
    if not storyline:
        fail(errors, "consumed.storyline: empty — nothing was consumed")

    qmd = (root / "slides.qmd").read_text(encoding="utf-8") if (root / "slides.qmd").is_file() else ""
    if not qmd:
        fail(errors, "slides.qmd missing")

    # Cross-checks against the consumed handoff (plain data reads — the protocol
    # gate lives in the preflight, not here).
    handoff = None
    if args.handoff is not None:
        hp = args.handoff if args.handoff.is_absolute() else root / args.handoff
        if not hp.is_file():
            print(f"ERROR: --handoff not found: {hp}", file=sys.stderr)
            return 1
        handoff = json.loads(hp.read_text(encoding="utf-8"))
        recorded = inp.get("handoff_sha256")
        actual = sha256(hp)
        if recorded and recorded != actual:
            fail(errors, f"input.handoff_sha256 does not match {hp} ({recorded[:12]}… != {actual[:12]}…)")

    # Story coverage: no silent drops.
    handoff_positions = None
    if handoff:
        handoff_positions = [s.get("position", i + 1) for i, s in enumerate(handoff.get("storyline", []))]
    seen_positions = set()
    for step in storyline:
        pos = step.get("position")
        if pos is None:
            fail(errors, "consumed.storyline entry without position")
            continue
        seen_positions.add(pos)
        disposition = step.get("disposition")
        if disposition not in DISPOSITIONS:
            fail(errors, f"storyline {pos}: invalid disposition {disposition!r}")
            continue
        slides = step.get("slides") or []
        if disposition in DEFERRED:
            if not step.get("reason"):
                fail(errors, f"storyline {pos}: {disposition} requires a recorded reason")
        elif not slides:
            fail(errors, f"storyline {pos}: disposition {disposition} but no slides listed")
        for title in slides:
            if qmd and title not in qmd:
                fail(errors, f"storyline {pos}: slide reference not found in slides.qmd: {title!r}")
    if handoff_positions is not None:
        for pos in handoff_positions:
            if pos not in seen_positions:
                fail(errors, f"story coverage: handoff step {pos} silently dropped (not in manifest)")

    # Visual coverage: must-have mapped to existing assets; optional optional.
    for vis in visuals:
        vid = vis.get("id")
        if not vid:
            fail(errors, "must_have_visuals entry without id")
            continue
        assets = vis.get("assets") or []
        if not vis.get("slides"):
            fail(errors, f"visual {vid}: no slide mapping")
        if not assets:
            fail(errors, f"visual {vid}: no generated asset recorded")
        for asset in assets:
            p = root / asset
            if not p.is_file():
                fail(errors, f"visual {vid}: asset does not exist: {asset}")
        if handoff:
            handoff_ids = {v.get("id") for v in handoff.get("visuals", [])}
            must = handoff.get("must_have_visuals", [])
            if vid not in handoff_ids:
                fail(errors, f"visual {vid}: not defined in handoff visuals")
            if vid not in must:
                fail(errors, f"visual {vid}: recorded as must-have but handoff lists {must}")
    if handoff:
        mapped = {v.get("id") for v in visuals}
        for vid in handoff.get("must_have_visuals", []):
            if vid not in mapped:
                fail(errors, f"visual coverage: must-have visual {vid} has no mapping")

    # Evidence traceability: manifest ids must exist in the handoff evidence index.
    if handoff is not None:
        index_ids = {e.get("id") for e in (handoff.get("evidence_index") or [])}
        for eid in consumed.get("evidence_ids") or []:
            if eid not in index_ids:
                fail(errors, f"evidence id {eid} not in handoff evidence_index")

    # Worked-example coverage (Phase T5): every worked example the handoff
    # declares must map to a slide or be explicitly deferred with a reason —
    # silent drops of worked examples fail the same way as dropped story steps.
    if handoff is not None:
        declared = handoff.get("worked_examples") or []
        mapped = {}
        for entry in consumed.get("worked_examples") or []:
            wid = entry.get("id")
            if not wid:
                fail(errors, "consumed.worked_examples entry without id")
                continue
            if wid in mapped:
                fail(errors, f"worked example {wid}: duplicate mapping")
            mapped[wid] = entry
            disposition = entry.get("disposition", "consumed")
            if disposition not in EXAMPLE_DISPOSITIONS:
                fail(errors, f"worked example {wid}: invalid disposition {disposition!r} "
                             f"(allowed: {sorted(EXAMPLE_DISPOSITIONS)})")
                continue
            slides = entry.get("slides") or []
            if disposition in DEFERRED:
                if not entry.get("reason"):
                    fail(errors, f"worked example {wid}: {disposition} requires a recorded reason")
            elif not slides:
                fail(errors, f"worked example {wid}: consumed but no slide mapping")
            for title in slides:
                if qmd and title not in qmd:
                    fail(errors, f"worked example {wid}: slide reference not found in slides.qmd: {title!r}")
        for we in declared:
            wid = we.get("id")
            if wid and wid not in mapped:
                fail(errors, f"worked example {wid}: declared in handoff but not mapped in the "
                             "manifest (missing example mapping)")

    # Adaptations must be recorded as source→decision→reason triples.
    for ad in manifest.get("adaptations") or []:
        for field in ("source_element", "presentation_decision", "reason"):
            if not ad.get(field):
                fail(errors, f"adaptation missing {field}: {ad!r}")

    # Generated outputs must exist.
    generated = manifest.get("generated") or {}
    qmd_rel = generated.get("qmd")
    if qmd_rel and not (root / qmd_rel).is_file():
        fail(errors, f"generated.qmd does not exist: {qmd_rel}")
    for asset in generated.get("diagrams") or []:
        if not (root / asset).is_file():
            fail(errors, f"generated.diagram does not exist: {asset}")
    rendered = generated.get("rendered")
    if rendered is not None and not (root / rendered).is_file():
        fail(errors, f"generated.rendered does not exist: {rendered}")

    if errors:
        for e in errors:
            print("ERROR:", e, file=sys.stderr)
        return 1
    print("OK: presentation manifest coverage complete "
          f"({len(storyline)} storyline entries, {len(visuals)} must-have visuals mapped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

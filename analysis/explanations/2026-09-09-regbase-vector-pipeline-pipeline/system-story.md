# System Story: regbase-vector-pipeline-pipeline

> Derived view rendered mechanically from the JSON artifacts in this bundle.
> The JSON artifacts (subject/evidence/dossier/handoff/composition/readiness) are the only source of truth.

- Repository: AscendNPU-IR @ 90037fe3371c
- Composed: 2026-09-08T21:18:28Z
- Subject type: pipeline; depth: presentation

## 1. System mental model

One RegBase compilation path turns shape-irregular tensor computation into aligned vector memory IR: normalize shapes first, vectorize into outlined VF callees, merge those callees to a controllable granularity, switch tensor→memref, then mark and realize buffer alignment. Each stage exists because its output is exactly the input representation the next stage needs.

### Why this system exists

- **Need:** A5-class (RegBase) targets need elementwise computation executed as vector instructions over UB buffers whose strides the hardware can align; no single pass can normalize shapes, choose VF granularity, and align memory at once.
- **Purpose:** Explain why the six passes coexist as one chain: flattening creates the 1-D form vectorization plans over; AutoVectorizeV2 creates the VF callees MergeVecScope merges; bufferization switches representation; the mark/enable pair delivers aligned memory to lowering.
- **Observable outcome:** Device functions whose elementwise chains run as vector functions over flattened iteration domains, with UB buffers allocated at hardware alignment units behind strided logical views.

## 2. Components and roles

### hfusion-flatten-ops-pass — core (child: `2026-09-09-hfusion-flatten-ops-pass`)

Role: shape normalizer: turns multi-dim elementwise computation into 1-D (collapse/expand-bounded) form so vectorization plans over flat last-axis domains

### propagate-reshape-pass — supporting (child: `2026-09-09-propagate-reshape-pass`)

Role: reshape-barrier remover: slides collapse toward outputs / expand toward producers immediately before flattening so the Flattener's collapse-group analysis is sound

### auto-vectorize-v2-pass — core (child: `2026-09-09-auto-vectorize-v2-pass`)

Role: vectorization engine: tiles, fuses and vectorizes flattened chains (plan-then-apply over transform dialect) and — with OutlineVectorFunction — establishes the VF granularity every later stage sees

### mergevecscope-pass — core (child: `2026-09-08-mergevecscope-pass`)

Role: VF-granularity control: re-merges outlined VF scopes at tensor level (L1, pre-bufferization) or memref level (L2, post) so bufferization/lowering plan over fewer, larger VFs
Child deck: `analysis/presentations/2026-09-08-mergevecscope-pass`

### mark-stride-align-pass — core (child: `2026-09-09-mark-stride-align-pass`)

Role: alignment-intent producer: post-bufferization, annotates UB memref operands of hivm ops with storage_align marks at hardware alignment units

### enable-stride-align-pass — core (child: `2026-09-09-enable-stride-align-pass`)

Role: alignment realizer: unions the marks' demands and re-allocates buffers padded behind strided logical views so later lowering sees aligned memory

### outline-vector-function — context-only node

Role: materializes the VF callees immediately after AutoVectorizeV2 — the pair's output is what MergeVecScope consumes
context-only: not requested for deep explanation

### one-shot-bufferize — context-only node

Role: the tensor→memref representation boundary (TensorCopyInsertion + OneShotBufferize) sitting between the two MergeVecScope placements
context-only stage

### pre-mark-stride-align — context-only node

Role: regbase-only pre-marking protection pass before MarkStrideAlign inside alignStoragePipeline

### fold-alloc-reshape — context-only node

Role: folds reshape-of-alloc between marking and enabling so fewer view ops separate a mark from its allocation

### vf-fusion — context-only node

Role: upstream analysis pass producing fusion groups on the Triton path; its callees feed the pre-vectorization world AutoVectorizeV2 plans in

### hivm-flatten-ops — context-only node

Role: the DISTINCT HIVM-level flatten pass (hivm-flatten-ops) after buffer sizing — same name as the requested HFusionFlattenOps but a different pass
kept visible to prevent conflating the two flatten passes

## 3. End-to-end flow

1. **enter with shaped tensor IR** — entry device function holds multi-dim elementwise chains plus reshape noise (HFusion output / pipeline input)
2. **normalize shapes** — PropagateReshape slides reshapes toward producers/outputs; FlattenOps (Tidy, register-based) reduces elementwise bodies to 1-D form bounded by collapse/expand — immediately before AutoVectorizeV2 on the Triton path, earlier in buildHFusionRegBasePipeline otherwise (HFusionRegbasePipelines.cpp:567-592 (buildHFusionRegBasePipeline pre-flatten block) and :414-423 (inside hfusionAutoVectorizePipeline, enableSIMDVFFusion branch))
3. **vectorize and outline** — AutoVectorizeV2 tiles/fuses/vectorizes the flat chains; OutlineVectorFunction materializes them as hivm.vector_function callees with call sites (HFusionRegbasePipelines.cpp:434-451)
4. **merge VF at tensor level (L1, optional)** — when enableVfMergeLevel==1, MergeVecScope merges adjacent VF callees BEFORE bufferization so the bufferization world sees fewer, larger VFs (HIVMRegbasePipelines.cpp:227-232)
5. **switch representation: tensor → memref** — TensorCopyInsertion + OneShotBufferize produce memref IR; this is the largest representation boundary of the chain and the seam between the two merge placements (HIVMRegbasePipelines.cpp:246-261)
6. **merge VF at memref level (L2, optional)** — when enableVfMergeLevel==2 (mutually exclusive with L1), MergeVecScope merges after bufferization where concrete memref aliasing is available (HIVMRegbasePipelines.cpp:262-265)
7. **mark alignment intent** — PreMarkStrideAlign (regbase protections) + MarkStrideAlign annotate UB memref operands of hivm ops with storage_align marks at hardware alignment units (HIVMRegbasePipelines.cpp:487-491 (alignStoragePipeline), post-bufferization via :560)
8. **realize alignment** — FoldAllocReshape first; then EnableStrideAlign unions the marks' demands and re-allocates buffers padded behind strided logical views (no marks → cheap no-op) (HIVMRegbasePipelines.cpp:491-493)
9. **hand to lowering** — aligned memref IR with zero leftover marks is consumed by AFTER_HIVM_STRIDE_ALIGNMENT decompose, InferHIVMDataLayout, and buffer-size constantization (post-alignStoragePipeline lowering pipelines)

## 4. Cross-component bridges and contracts

- **propagate-reshape-pass → hfusion-flatten-ops-pass** (precedes, control_flow, fact)
  - Contract: tensor IR with reshapes propagated (collapse toward outputs, expand toward producers) and dynamic-dim barriers folded before the Flattener's dimension analysis
  - Why order matters: FlattenOps Tidy declines via hasUnpropagateableCase when reshape noise remains — propagation first is what makes collapse-group analysis sound
  - Evidence: `SYS-EV-001`, `reshape::EV-012`, `reshape::EV-015`, `flatten::EV-010`
- **hfusion-flatten-ops-pass → auto-vectorize-v2-pass** (normalizes-for, data_flow, fact)
  - Contract: 1-D elementwise bodies bounded by collapse/expand pairs with unchanged external function signatures (tensor-level normalization; register-based indexing adjustments are the Tidy engine's own concern, see the flatten child dossier)
  - Why order matters: on the Triton path flatten runs immediately before AutoVectorizeV2 inside hfusionAutoVectorizePipeline (:415-423 → :434-450, enableSIMDVFFusion ≡ enableTritonKernelCompile); on the non-Triton regbase path normalization happens earlier in buildHFusionRegBasePipeline — either way the vectorizer consumes post-flatten IR
  - Representation: multi-dim elementwise linalg/hfusion ops → 1-D elementwise ops over collapsed views
  - Evidence: `SYS-EV-002`, `flatten::EV-011`, `flatten::EV-019`, `flatten::EV-014`, `av2::EV-014`
- **auto-vectorize-v2-pass → mergevecscope-pass** (produces-for, data_flow, fact)
  - Contract: outlined functions carrying hivm.vector_function (+no_inline) — exactly the func set MergeVecScope collects (hivm::isVF) and merges
  - Why order matters: without the outlined callees there is nothing for MergeVecScope to merge; the attribute is the entire discovery contract
  - Representation: scalar linalg/hfusion ops inside the entry function → vectorized hivm.vector_function callees with call sites
  - Evidence: `SYS-EV-002`, `SYS-EV-012`, `av2::EV-015`, `mergevecscope::EV-002`, `mergevecscope::EV-003`
- **mergevecscope-pass → one-shot-bufferize** (precedes, control_flow, fact)
  - Contract: a merged (smaller) VF call graph at tensor level, handed to TensorCopyInsertion/OneShotBufferize
  - Why order matters: the L1 placement exists only when enableVfMergeLevel==1 and sits deliberately before bufferization so the memref world plans over fewer allocations/copies; mutually exclusive with L2
  - Evidence: `SYS-EV-003`, `mergevecscope::EV-012`, `mergevecscope::EV-022`
- **one-shot-bufferize → mergevecscope-pass** (enables, control_flow, fact)
  - Contract: concrete memref types and alias structure — the L2 placement (enableVfMergeLevel==2) merges VFs after bufferization where memory-side information exists
  - Why order matters: L2 waits for bufferization deliberately: memory-side merge decisions need concrete memref alias info (child reasoning EV-022; ordering itself is source fact)
  - Representation: tensor-level IR → memref-level IR
  - Evidence: `SYS-EV-003`, `SYS-EV-005`, `mergevecscope::EV-022`
- **mark-stride-align-pass → enable-stride-align-pass** (marks-for, data_flow, fact)
  - Contract: annotation.mark {hivm.stride_align_dims, hivm.stride_align_value_in_byte} with byte value getHWAlignBytes(memory space) on ranked UB memref operands of hivm ops
  - Why order matters: EnableStrideAlign errors on missing/mismatched marks and is a cheap no-op without them — the mark is its only input contract; FoldAllocReshape in between first removes reshape-of-alloc view chains
  - Representation: unannotated memref buffers → storage_align-marked buffers
  - Evidence: `SYS-EV-004`, `SYS-EV-006`, `SYS-EV-010`, `marksa::EV-002`, `marksa::EV-016`, `marksa::EV-019`, `ensa::EV-004`
- **hfusion-flatten-ops-pass → hivm-flatten-ops** (precedes, control_flow, fact)
  - Contract: the HIVM-level flatten (hivm-flatten-ops) runs post-bufferization after buffer sizing on memref IR — a distinct pass, not a repeat of hfusion-flatten-ops
  - Why order matters: keeping the two flatten passes distinct prevents the classic misreading that one pass flattens both the tensor and the memref world
  - Evidence: `SYS-EV-008`

## 5. Representation transitions

- **multi-dim elementwise linalg/hfusion ops → 1-D elementwise bodies over collapsed views** at hfusion-flatten-ops boundary (evidence: `SYS-EV-002`, `SYS-EV-013`, `flatten::EV-013`)
- **scalar elementwise ops in the entry function → outlined hivm.vector_function callees with call sites** at auto-vectorize-v2 + outline-vector-function boundary (evidence: `SYS-EV-012`, `av2::EV-015`)
- **tensor-level IR (VF callees on tensors) → memref-level IR after TensorCopyInsertion + OneShotBufferize** at one-shot-bufferize boundary between MergeVecScope L1 and L2 (evidence: `SYS-EV-003`)
- **unannotated memref.alloc → padded aligned alloc behind strided logical view (e.g. alignment = 64)** at mark-stride-align → enable-stride-align boundary (evidence: `SYS-EV-010`, `SYS-EV-011`, `ensa::EV-012`)

## 6. Canonical example

Provenance: test — STITCHED EXAMPLE — frames from four real bishengir-opt executions of committed tests (flatten, vectorize+outline, mark, enable) plus the child bundle's executed merge-vf runs and a reconstructed bufferization frame; NOT one end-to-end pipeline execution (SYS-EV-016 records this honestly)

Initial state: Entry device function over multi-dim tensors: %a = elemwise over tensor<2x15xf16>-style operands, reshape noise around elementwise chains
1. Frame 1 — normalize (EXECUTED): bishengir-opt --hfusion-flatten-ops on test-drop-unit-extent-dims-and-tidy-flatten.mlir rewrites elementwise chains over collapsed 1-D views (SYS-EV-013); reshape propagation precedes it in the real pipeline (SYS-EV-001)
2. Frame 2 — vectorize + outline (EXECUTED): bishengir-opt --hfusion-auto-vectorize-v2 --outline-vector-function on auto-vectorize-v2.mlir yields func.func @test_hfusion_indirect_load_outlined_vf_0/1/2 attributes {hivm.vector_function, no_inline} (SYS-EV-012)
3. Frame 3 — merge at tensor level, L1 (EXECUTED in the MergeVecScope child bundle): --hfusion-merge-vf merge-level=1 on merge-vf-level-1.mlir produces the merged 4-result call (mergevecscope::EV-015); in the real pipeline this placement sits BEFORE bufferization and requires enableVfMergeLevel==1 (SYS-EV-003)
4. Frame 4 — bufferization (RECONSTRUCTED, not executed): TensorCopyInsertion + OneShotBufferize convert tensor→memref (SYS-EV-003); this is the seam between the two merge placements
5. Frame 5 — merge at memref level, L2 (child-executed demonstration of the merge output): --hfusion-merge-vf merge-level=2 on merge-vf-level-2.mlir shows the merged memref-level call (mergevecscope::EV-016); its pipeline position is AFTER bufferization, mutually exclusive with L1 (SYS-EV-003) — frames 3 and 5 demonstrate the same pass at its two alternative positions, not a sequence
6. Frame 6 — mark (EXECUTED): bishengir-opt --hivm-mark-stride-align on hivm-mark-storage-align.mlir emits annotation.mark {hivm.stride_align_dims = array<i32: 0>, hivm.stride_align_value_in_byte = array<i32: 32>} (SYS-EV-010); 32 bytes is that fixture's BL=VL/8 default
7. Frame 7 — enable (EXECUTED): bishengir-opt -hivm-enable-stride-align on hivm-enable-stride-align-median-kernel.mlir re-allocates with memref.alloc() {alignment = 64} behind strided subviews (SYS-EV-011); 64 is that fixture's unified demand after LCM across marks — mark value (per-op default) and realized alignment (post-unification) come from different fixtures and need not be equal
Result: Final state (stitched): aligned memref IR — flattened→vectorized→(merged)→bufferized→marked→realized — ready for post-alignment lowering; each frame's origin is named, the whole is NOT a single execution

## 7. Key decisions

- **Which MergeVecScope placement runs — L1 before bufferization or L2 after?** — hivmPipelineOptions.enableVfMergeLevel: ==1 → L1 (tensor-level, pre-bufferization), ==2 → L2 (memref-level, post-bufferization); mutually exclusive if/else
  - The option encodes a real design tension: merge early to shrink the bufferization problem, or late to decide with alias information
  - Evidence: `SYS-EV-003`, `SYS-EV-007`, `mergevecscope::EV-022`
- **Is automatic storage alignment active?** — enableHIVMAutoStorageAlign gates the two marking passes (default true); EnableStrideAlign is NOT gated and is a no-op without marks
  - Gating intent but not realization keeps the pipeline correct when the gate is off
  - Evidence: `SYS-EV-004`, `SYS-EV-006`, `marksa::EV-015`, `ensa::EV-002`
- **Does PropagateReshape participate on this target, and where?** — regbase: only the HFusion pre-flatten slots (forRegbased=true); the HIVM-level placements require a NON-reg-based target (anti-regbase conditionals)
  - HIVM's brc/reduce same-rank constraint forces reshape insertion only on the non-regbase conversion path — the pass's presence is target-shaped, and the story must show that honestly
  - Evidence: `SYS-EV-009`, `reshape::EV-013`, `reshape::EV-012`
- **Which flatten mode/variant runs at each site, and on which path?** — both regbase placements fix FlattenMode::Tidy + registerBased=true; inside hfusionAutoVectorizePipeline the VFFusion+FlattenOps block runs only when enableSIMDVFFusion ≡ enableTritonKernelCompile; the non-Triton regbase path flattens earlier (buildHFusionRegBasePipeline :569-588, buildHFusionPipelines preFlattenPass/flattenAndFold); a DISTINCT hivm-flatten-ops runs post-bufferization
  - Same-named passes at two levels plus a path split is a classic misreading trap; the pipeline wiring proves they are different passes with path-conditional adjacency
  - Evidence: `SYS-EV-001`, `SYS-EV-002`, `SYS-EV-008`, `flatten::EV-010`, `flatten::EV-011`, `av2::EV-014`

## 8. System invariants and constraints

- Invariant: Flattening preserves external function signatures — collapse/expand live inside function bodies only (verified)
- Invariant: Reshape propagation preserves element order and element count (legality rejects flip spanning a reassociation group) (verified)
- Invariant: VF callee identity (hivm.vector_function attribute) is the stable contract between vectorization and every later stage (verified)
- Invariant: Marks are never left dangling: the enabler consumes or errors on them, and the membase certification is stamped separately (guarded)
- Constraint: The two MergeVecScope placements are mutually exclusive (enableVfMergeLevel if/else) (verified)
- Constraint: FlattenOps at both regbase sites runs Tidy + register-based; greedy is not the regbase mode (verified)
- Constraint: Alignment demands unify per dim (LCM) and conflicting demands resolve loudly (pass failure) or via explicit copy fallback — never silently (guarded)

## 9. System boundaries and open conflicts

- [unknown] No single committed test executes the full six-pass chain in one pipeline invocation in this repository — the canonical example is stitched from real per-pass frames, not one end-to-end dump
- [partially_supported] The legacy AutoVectorize (V1) branch still exists behind enableAutoVectorizeV2=false (maxVectorizeAxes=2); this story covers the V2 path only
- [partially_supported] The flatten→AutoVectorizeV2 immediate adjacency is Triton-path-specific (enableSIMDVFFusion ≡ enableTritonKernelCompile); on the non-Triton regbase path normalization happens earlier and PreVectorizationFusion + canonicalization precede the vectorizer
- [unsupported] PropagateReshape's HIVM-level placements do not run on reg-based targets — on the A5 path the pass exists only in the HFusion pre-flatten slots
- [unknown] The membase-only hivm.storage_aligned certification stamp has no in-repo reader at this HEAD

## 10. Evidence and child dossier index

Parent ledger: 15 record(s).
- Import `flatten` → child bundle `2026-09-09-hfusion-flatten-ops-pass` (subject hfusion-flatten-ops-pass)
- Import `reshape` → child bundle `2026-09-09-propagate-reshape-pass` (subject propagate-reshape-pass)
- Import `av2` → child bundle `2026-09-09-auto-vectorize-v2-pass` (subject auto-vectorize-v2-pass)
- Import `mergevecscope` → child bundle `2026-09-08-mergevecscope-pass` (subject mergevecscope-pass)
- Import `marksa` → child bundle `2026-09-09-mark-stride-align-pass` (subject mark-stride-align-pass)
- Import `ensa` → child bundle `2026-09-09-enable-stride-align-pass` (subject enable-stride-align-pass)
- Child dossier: `2026-09-09-hfusion-flatten-ops-pass` (subject hfusion-flatten-ops-pass)
- Child dossier: `2026-09-09-propagate-reshape-pass` (subject propagate-reshape-pass)
- Child dossier: `2026-09-09-auto-vectorize-v2-pass` (subject auto-vectorize-v2-pass)
- Child dossier: `2026-09-08-mergevecscope-pass` (subject mergevecscope-pass)
- Child dossier: `2026-09-09-mark-stride-align-pass` (subject mark-stride-align-pass)
- Child dossier: `2026-09-09-enable-stride-align-pass` (subject enable-stride-align-pass)

### Deferred to child dossiers (the system story deliberately does not answer these)

- **hfusion-flatten-ops-pass** (core): internal mechanism, legality detail, and worked internals — see `2026-09-09-hfusion-flatten-ops-pass`
- **propagate-reshape-pass** (supporting): internal mechanism, legality detail, and worked internals — see `2026-09-09-propagate-reshape-pass`
- **auto-vectorize-v2-pass** (core): internal mechanism, legality detail, and worked internals — see `2026-09-09-auto-vectorize-v2-pass`
- **mergevecscope-pass** (core): internal mechanism, legality detail, and worked internals — see `2026-09-08-mergevecscope-pass`
- **mark-stride-align-pass** (core): internal mechanism, legality detail, and worked internals — see `2026-09-09-mark-stride-align-pass`
- **enable-stride-align-pass** (core): internal mechanism, legality detail, and worked internals — see `2026-09-09-enable-stride-align-pass`
- Appendix topic: legacy AutoVectorize V1 fallback 分支(enableAutoVectorizeV2=false)
- Appendix topic: membase(A3 侧)管线的对应 placement 差异
- Appendix topic: vsstb bank-conflict 标注与 PreMarkStrideAlign 的 vload 根保护
- Appendix topic: MergeVecScope tryMerge 内部合法性门(见 child deck)
- Appendix topic: AutoVectorizeV2 的 plan-then-apply 与 clone-commit 纪律(见 child deck)

Evidence index (38):
- `SYS-EV-001` (source_fact) In buildHFusionRegBasePipeline (starts :567), when options.enableFlatten, the order is: PropagateReshape (forRegbased=true) → FoldTensorEmpty → CanonicalizeTensorReshape → canonicalize → FlattenOps (FlattenMode::Tidy, registerBased=true) → canonicalize → FoldTensorEmpty. The same three-pass cleanup block (PropagateReshape → FoldTensorEmpty → CanonicalizeTensorReshape) also precedes FlattenOps inside the buildHFusionPipelines Triton branch (:528-546).
- `SYS-EV-002` (source_fact) hfusionAutoVectorizePipeline (regbase, SIMD VF fusion enabled) runs: VFFusionPass → FlattenOps (Tidy, registerBased) → canonicalization → PreVectorizationFusion → PrepareI1Nx1ForVectorization → AutoVectorizeV2 (gated by enableAutoVectorizeV2) → OutlineVectorFunctionPass → AutoVectorizeVerifierPass; the non-AutoVectorizeV2 branch falls back to legacy AutoVectorize with maxVectorizeAxes=2.
- `SYS-EV-003` (source_fact) bufferizationPipeline places MergeVecScope around bufferization: enableVfMergeLevel==1 adds MergeVecScope(mergeLevel=1) BEFORE SimplifyVFArgs/FoldExtractInsertPair/NormalizeToTensor/TensorCopyInsertion/OneShotBufferize; enableVfMergeLevel==2 adds MergeVecScope(mergeLevel=2) immediately AFTER OneShotBufferize; the two placements are mutually exclusive (if/else on the same option).
- `SYS-EV-004` (source_fact) alignStoragePipeline is: AlignAllocSizePass → (if enableHIVMAutoStorageAlign) PreMarkStrideAlignPass + MarkStrideAlignPass → FoldAllocReshapePass → EnableStrideAlignPass (unconditional tail of the pipeline).
- `SYS-EV-005` (source_fact) hivmPostBufferizationOptimizationPipeline calls alignStoragePipeline(pm, hivmPipelineOptions) (line 560), and buildLowerHIVMPipelines calls bufferizationPipeline before hivmPostBufferizationOptimizationPipeline — so the whole align-storage block runs in the post-bufferization (memref) world.
- `SYS-EV-006` (source_fact) Pass declaration: MarkStrideAlign 'For all hivm ops, annotate their memref operands with storage_align marks automatically' (func::FuncOp); EnableStrideAlign 'Re-allocate memrefs according to annotations of storage_align marks. ModuleOp scope is required so FuncOp-parallel nesting cannot race when aligned allocs propagate through func.call into VF callees.'
- `SYS-EV-008` (source_fact) The HIVM level has its own DISTINCT flatten pass (hivm-flatten-ops on func::FuncOp, createFlattenOpsPass in HIVM/Transforms/FlattenOps.cpp) placed after SetBufferSize inside the post-bufferization optimization pipeline with DecomposePhase::AFTER_HIVM_FLATTEN_OPS — a different pass from the requested hfusion-flatten-ops.
- `SYS-EV-009` (source_fact) PropagateReshape's HIVM-level placements are conditional on the target: hivmPreBufferizationOptimizationPipeline runs it only when NOT isRegBasedArch(target), and buildConvertToHIVMPipeline runs it only when !enableRegBaseHIVMPipe — on the regbase A5 path these two instances do not execute; the pass participates via the HFusion-level regbase placements instead.
- `SYS-EV-010` (runtime_fact) Executed build/bin/bishengir-opt --hivm-mark-stride-align -allow-unregistered-dialect on bishengir/test/Dialect/HIVM/hivm-mark-storage-align.mlir (exit 0): output contains 'annotation.mark %alloc {hivm.stride_align_dims = array<i32: 0>, hivm.stride_align_value_in_byte = array<i32: 32>}' on memref operands — the concrete mark representation MarkStrideAlign leaves.
- `SYS-EV-011` (runtime_fact) Executed build/bin/bishengir-opt -hivm-enable-stride-align on bishengir/test/Dialect/HIVM/hivm-enable-stride-align-median-kernel.mlir (exit 0): output re-allocates with explicit alignment, e.g. 'memref.alloc() {alignment = 64 : i32} : memref<44xi16 ...>' — EnableStrideAlign realizes the marks as aligned allocations.
- `SYS-EV-012` (runtime_fact) Executed build/bin/bishengir-opt --hfusion-auto-vectorize-v2 --outline-vector-function on bishengir/test/Dialect/HFusion/auto-vectorize-v2.mlir (exit 0): output contains outlined functions 'func.func @test_hfusion_indirect_load_outlined_vf_0/1/2(...) attributes {hivm.vector_function, no_inline}' — the scalar→VF-callee representation change AutoVectorizeV2+OutlineVectorFunction establish, which is exactly what MergeVecScope later consumes.
- `SYS-EV-013` (runtime_fact) Executed build/bin/bishengir-opt --hfusion-flatten-ops -allow-unregistered-dialect on bishengir/test/Dialect/HFusion/test-drop-unit-extent-dims-and-tidy-flatten.mlir (exit 0): the pass rewrites hfusion.elemwise_* ops over collapsed shapes (collapse_shape count 2 → 21 in this fixture), i.e. flattening materializes last-axis flattened views that vectorization groups can treat uniformly.
- `SYS-EV-015` (unknown) No single committed test executes the full six-pass chain in one pipeline invocation in this repository; the end-to-end example in the system story is therefore STITCHED from real per-pass executions (SYS-EV-010..013) plus the child bundle's executed merge-vf runs — not one end-to-end dump.
- `flatten::EV-019` (imported — resolves via composition imports)
- `av2::EV-015` (imported — resolves via composition imports)
- `mergevecscope::EV-002` (imported — resolves via composition imports)
- `mergevecscope::EV-022` (imported — resolves via composition imports)
- `marksa::EV-002` (imported — resolves via composition imports)
- `marksa::EV-019` (imported — resolves via composition imports)
- `ensa::EV-004` (imported — resolves via composition imports)
- `ensa::EV-012` (imported — resolves via composition imports)
- `reshape::EV-015` (imported — resolves via composition imports)
- `reshape::EV-016` (imported — resolves via composition imports)
- `flatten::EV-010` (imported — resolves via composition imports)
- `flatten::EV-011` (imported — resolves via composition imports)
- `av2::EV-014` (imported — resolves via composition imports)
- `av2::EV-020` (imported — resolves via composition imports)
- `marksa::EV-014` (imported — resolves via composition imports)
- `marksa::EV-015` (imported — resolves via composition imports)
- `marksa::EV-016` (imported — resolves via composition imports)
- `mergevecscope::EV-012` (imported — resolves via composition imports)
- `reshape::EV-013` (imported — resolves via composition imports)
- `reshape::EV-012` (imported — resolves via composition imports)
- `ensa::EV-002` (imported — resolves via composition imports)
- `flatten::EV-014` (imported — resolves via composition imports)
- `mergevecscope::EV-015` (imported — resolves via composition imports)
- `mergevecscope::EV-016` (imported — resolves via composition imports)
- `SYS-EV-007` (source_fact) Pass declarations: AutoVectorizeV2 'Tile, fuse and vectorize all linalg named ops' (ModuleOp); MergeVecScope 'Merge vf function' with mergeLevel option documented as '0: no merge; 1: merge VFs only without dependency; 2: merge all VFs' and mergeVFNumLimit default 4; FlattenOps 'Flatten linalg and hfusion ops'; PropagateReshape 'Propagate operations through reshape operations' (moves elemwise ops through reshapes).


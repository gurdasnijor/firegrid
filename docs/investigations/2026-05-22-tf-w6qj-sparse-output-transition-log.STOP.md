# tf-w6qj STOP — sparse output transition log needs the unbuilt host-kernel/controller write+arm

**Bead:** `tf-w6qj` (P1, Phase 0C). **Outcome:** **STOPPED per the dispatch/bead STOP rule** before any production edit. No production code changed. The sparse-log *shape* is sound and confirmed below; its required **arm** half has no production substrate, and building that substrate crosses the unresolved host-kernel/controller ownership boundary the bead's own STOP clause names.

## What the bead asks for

> raw output stream remains for UI/session clients/telemetry, while the output appender/projector writes only body-relevant semantic transition events to a workflow-owned sparse output transition log **and arms the owning RuntimeContext workflow using the kernel-owned write+arm class**.

Two coupled halves: (A) a sparse semantic transition log the body consumes instead of the dense raw stream; (B) a **write+arm** that wakes the owning workflow when a sparse event is written.

## The sparse shape is correct (evidence)

`transitionOutputEvent` acts on only three event kinds; everything else falls through to a no-op cursor advance:

- `PermissionRequest` — `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:564`
- `ToolUse` **and** `agentProtocol !== "acp"` — `runtime-context.ts:590`
- `Terminated` — `runtime-context.ts:596`

`Ready`/`TextChunk`/`Status`/`Error`/`TurnComplete` produce `action: { _tag: "None" }` and only bump `lastProcessedOutputSequence` (`runtime-context.ts:559-562`). So the post-#664 dense cursor walks every output row to discard most — the sparse log is the right target. This half, in isolation, is buildable.

## Why this STOPs: half (B) has no production substrate, and building it crosses unresolved ownership

**The "kernel-owned write+arm class" does not exist in production.** A grep across `packages/{runtime,host-sdk,protocol}/src` for `kernelWriteArm` / `KernelCommandTable` / `HostKernelWorkflow` / `writeArm` / `replayPendingWriteArm` returns nothing. It exists only as a tiny-firegrid **reference**: `packages/tiny-firegrid/src/simulations/kernel-owned-write-arm/` (tf-c9r9), whose own FINDING.md states the scope:

> **Reference / target-shape validation only.** … No production engine or runtime-context changes in this slice. (`kernel-owned-write-arm/FINDING.md:60-64`)

**The host-kernel/controller authority is explicitly unresolved.**
- `docs/architecture/2026-05-22-runtime-rearch-closeout.md:29`: *"There is no concrete `HostKernelWorkflow` implementation today."*
- `docs/cannon/sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md:58-65`: the target is *"host-kernel/controller owned write+arm. The host kernel/controller **may evolve from today's `RuntimeContextWorkflowRuntimeLive` authority position**…"* and *"A production runtime-context cutover is a later, separately scoped transactional replacement."* — ownership position and cutover are both open.

**That SDD is input-scoped; output write+arm is explicitly out of scope.** The only write+arm migration spec excludes output cursor work: `SDD_..._INPUT_WRITE_ARM_MIGRATION.md:186` ("does not change output observation cursor work (`tf-aseo`)"). There is no output-side write+arm design at all.

**The variant is itself an open architectural call.** The closeout doc leaves axis-2 as a decision among three write+arm variants (atomic-append-and-arm / recovery-sweep / kernel-owned-writer), to be picked from the S1 result (`2026-05-22-runtime-rearch-closeout.md:86, 111`). S1 confirmed the durability gap is real but the production variant has not been chosen or built.

## Why there is no correctness-preserving sub-slice

Half (A) without half (B) is not a safe partial. If the body consumed a sparse log but kept waking only via the existing input mailbox, a sparse output event written while the body is suspended would not wake it — the exact "table-waits don't auto-recover" gap S1 confirmed (PR #663). Any in-slice arm mechanism is forbidden or out-of-bounds: the output `DurableDeferred` mailbox is explicitly disallowed by the bead; a generic engine suspended-workflow sweep is disallowed and was already rejected (tf-12q9; `kernel-owned-write-arm/FINDING.md:37-43`); an ad-hoc projector→`engine.resume` would be inventing an unsanctioned, unowned write+arm — i.e. crossing the very boundary the STOP clause guards. So the sparse-log consume path is gated on the production write+arm primitive; it cannot land first and stay correct.

## Exact boundary

tf-w6qj's half (B) requires a **production host-kernel/controller write+arm primitive that owns (1) the durable sparse-output-row write and (2) the workflow arm/resume as one recoverable command** — for the **output** fact. Today that primitive (a) is unimplemented in production, (b) has no resolved owner (`RuntimeContextWorkflowRuntimeLive` "may evolve"), (c) has no output-side SDD (the input one excludes output), and (d) has an unmade variant decision. Implementing any of (a)–(d) is out of tf-w6qj's scope and is precisely "crosses unresolved host-kernel/controller ownership."

## Minimal follow-on

1. **New bead — production host-kernel/controller write+arm primitive** (input arm first, per `SDD_..._INPUT_WRITE_ARM_MIGRATION.md`): pick the S1 axis-2 variant, build the owned command table + write+arm + restart recovery in production. **Blocks tf-w6qj.** (No such bead exists today; `tf-c8cy` is only a HostKernelWorkflow *validation* slice.)
2. **Extend the write+arm SDD (or a sibling) to cover the OUTPUT fact** — the sparse output transition log row + arm — since the current SDD scopes input only.
3. **tf-w6qj stays OPEN, re-blocked** on (1)+(2). Once the production write+arm exists, the buildable half (A) (sparse projector + body point-read consume, dense cursor retained only as the #664 bridge) lands as a focused slice that arms via the kernel class. The constraints already validated as honored by the current code and to preserve: no ACP edge-local `Done` synthesis over `TurnComplete` (none exists today in `packages/host-sdk/src/host/acp-stdio-edge.ts`), no output `DurableDeferred` mailbox, no replay scan, no generic engine sweep.

## Sources

- `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:554-606` (`transitionOutputEvent` acts on PermissionRequest / non-ACP ToolUse / Terminated only)
- `packages/tiny-firegrid/src/simulations/kernel-owned-write-arm/FINDING.md` (reference-only scope; engine-sweep rejection)
- `docs/architecture/2026-05-22-runtime-rearch-closeout.md:29,86,111` (no HostKernelWorkflow today; axis-2 variant undecided)
- `docs/cannon/sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md:54-65,90-121,186` (target = host-kernel/controller write+arm; ownership "may evolve"; output out of scope)
- grep: no `kernelWriteArm`/`KernelCommandTable`/`HostKernelWorkflow`/`writeArm` in `packages/{runtime,host-sdk,protocol}/src`

# Runtime Architecture Handoff - 2026-05-22

Purpose: this is the durable handoff for the next architect taking over the
Firegrid runtime shrink / private-beta readiness effort. It records the measured
runtime shape, the target architecture we are testing, what changed during the
effort, where the work is stuck, and the decisions that should not be blurred
into tactical patches.

This is not a generated report. Treat it as the human architectural snapshot
that sits on top of the generated artifacts:

- [runtime-dynamics-map.md](./runtime-dynamics-map.md)
- [runtime-flow.svg](./runtime-flow.svg)
- [runtime-flow.dot](./runtime-flow.dot)
- [runtime-shrink-loop.md](./runtime-shrink-loop.md)
- [runtime-shape-falsification.md](./runtime-shape-falsification.md)
- [SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md](../sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md)

Supersession note: after this handoff was first written, the re-architecture
closeout landed:
[2026-05-22-runtime-rearch-closeout.md](./2026-05-22-runtime-rearch-closeout.md).
That document supersedes this handoff's P3-B / "ordering authority" framing.
The current settled read is that cross-author arrival order is not a workflow
body requirement; the remaining real input-axis question is engine durability
around suspend/restart, to be settled by the S1 simulation. Keep this handoff
for broad state and PR/lane context, but use the closeout as the current action
layer.

## 0. Checkout / Coordination Snapshot

Date of this handoff: 2026-05-22.

Local checkout state when this was written:

```text
main...origin/main [ahead 1, behind 17]
```

The local ahead commit is an architecture/doc commit:

```text
9fb433fdf docs(architecture): runtime shape falsification - stress-test the table-seam
```

Do not blindly reset or rebase this checkout. The local tree is carrying
architecture analysis that is intentionally ahead of origin, while origin has
merged a batch of PRs that are not all reflected in this local filesystem until
someone reconciles the branch.

The work is being coordinated through cmux lanes and Beads. Beads sync is
cron-owned in this repo; do not push `.beads/issues.jsonl` by hand from the
coordinator. Use the wrappers and lane labels in `AGENTS.md`.

Current open PRs at the time of this snapshot:

| PR | State | Reading |
|---|---|---|
| #661 `feat(tf-jvjm): explicit ACP permission policy via CLI/env` | Draft, clean, CI green | Safe permission-policy plumbing. Should be reviewed/merged when ready. |
| #660 `fix(tf-0xe4): durable wait_for_any race over the owning WaitForWorkflow` | Draft, clean, CI green | Tactical durability fix over the current `WaitForWorkflow`. Useful, but not the final shrink shape. |
| #633 `feat(tf-aseo): durable RuntimeContextStateTable loop-state cutover` | Draft, dirty/stale | High-value but stale. Needs architectural re-derivation or careful conflict resolution on current `runtime-context.ts`. |
| #602 `docs(tf-c8cy): frame host-plane cancel route decision` | Draft, clean, old/large | Do not merge mechanically. It is a stale decision frame mixed with code/docs. |

Current lane posture from the latest sweep:

| Lane | State |
|---|---|
| 1 | On `tf-aseo`. Lint fixes were pushed to #633, but rebase was aborted because the output path conflict is design-bearing. The current instruction visible in the lane is to re-derive `tf-aseo` fresh on current main. |
| 2 | Stopped on `tf-vrz6`. Found that durable-stream offsets are non-dense byte/compound positions, so P3-B cannot simply point-read by offset. Recommends firelab derisk before amending SDD text. |
| 3 | Finished #660 and is idle. |
| 4 | Active on `tf-r6br`, implementing protocol-owned route completion metadata / receipt shape. |
| 5 | Finished #661 and is idle. |
| OLA | User-managed. Reported an important warning: the effort has increased contract coverage, but `N` has not structurally moved yet because the table seam is still being falsified. |

`br ready --json` returned no ready work at this snapshot. That does not mean
there is no work. It means the remaining work is either in progress, blocked by
architecture decisions, or being handled through open PR review.

## 1. Executive Summary

The effort has materially improved observability and architectural honesty, but
it has not yet shrunk the runtime.

What improved:

- We now have a runtime-flow instrument that maps actual OTel parent-child span
  flow to source files and overlays that on static imports.
- We have a vocabulary for deciding whether an edge is load-bearing:
  `transform`, `authority`, `durability`, `process`, `concurrency`,
  `ordering`, `bridge_debt`, or `relay`.
- Several high-volume seams now carry contract annotations or at least have the
  machinery to carry them.
- We learned that some paths previously suspected as "dead" are actually
  coverage gaps. Most importantly, `runtime-observation-streams.ts` is live,
  consumed by `wait-for.ts`, and simply was not exercised by the first corpus.
- We found real stop conditions before deleting more production structure.

What has not improved yet:

- The condensation graph has not shrunk. The runtime is still dominated by the
  same strongly-connected execution unit.
- The target table-owned seam is not yet validated on its hard cases.
- The annotation track can make `C` rise, but that is not the same as reducing
  architectural complexity.

The honest headline:

```text
This phase turned "we should shrink runtime-context" into a falsifiable program.
It found substrate and seam problems before production migrated into them.
That is progress, but it is not yet simplification.
```

## 2. The Graph Language To Use

The runtime map is the shared language for the rest of this handoff.

In [runtime-flow.svg](./runtime-flow.svg):

- Node size is proportional to span volume.
- Clusters are packages.
- Red/bold edges are invisible coupling: runtime flow without a static import.
- The useful question is not "which edge is large?" It is "which edge enforces
  an invariant that would be lost if the hop disappeared?"

The current graph says:

| Module | Spans | Self-time | Reading |
|---|---:|---:|---|
| `effect-durable-operators/src/DurableTable.ts` | 47,806 | 98% | Real storage substrate. Fixed mass until the substrate itself changes. |
| `runtime/workflow-engine/internal/engine-runtime.ts` | 19,944 | 52% | Real engine work: claims, resumes, execution, table driving. |
| `runtime/workflow-engine/workflows/runtime-context.ts` | 27,272 | 3% | Coordination shell. High volume, very little own work. |
| `effect-durable-streams/Http.ts` | 5,927 | 9% | Process/network boundary. Low self-time but irreducible. |

The central invisible seam is:

```text
runtime-context.ts -> engine-runtime.ts    13,551 calls
engine-runtime.ts -> runtime-context.ts     5,883 calls
```

This is not a normal dependency. It is a dynamic, Effect-layer / workflow
runtime loop. Static import analysis does not see it. Refactors that touch
either side can break the other side without an import edge changing.

The SCC result matters more than any one count:

```text
engine-runtime
  <-> runtime-context.ts
  <-> runtime_context.workflow
  <-> runtime-control

= one strongly-connected logical unit
```

The condensation graph originally reduced 43 source nodes to 38 logical nodes.
Later work has added contract coverage, but the structural unit remains. The
right architectural move is not "preserve this coupling with a cleaner API."
The right move is to decide whether the unit should be co-located or cleanly
broken by a typed, one-directional table-owned seam.

## 3. Target Architecture Under Test

The target reference SDD says the desired shape is:

```text
channel or edge adapter
  -> channel router
  -> channel binding
  -> workflow-owned DurableTable write/read
  -> workflow body reads table state and applies transitions
  -> channel reads expose production-compatible observations
```

The core rule:

```text
A workflow declares and owns its durable table.
Channels bind to that table.
The workflow reads that table and transitions table state.
```

The SDD explicitly rejects the current bridge-heavy shape for ordinary semantic
workflow input:

```text
channel/client input
  -> request or intent row
  -> dispatcher/reconciler
  -> appendRuntimeInputDeferred
  -> numbered workflow deferred
  -> workflow awaits input/N
```

The target does not say every deferred is wrong. Durable sleeps, waits, clocks,
and Effect workflow internals may still use deferreds where the primitive is
actually a suspended wait. The target rejects deferreds as the ordinary mailbox
for semantic workflow input.

The spec/ACID anchor for the reference is
`features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`, especially
the `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.*` ACIDs named
by the SDD. New behavior should continue to tie back to ACIDs or SDD sections
through `firegrid.contract.id`, not free-floating prose.

## 4. Snapshot Diff: Before, Now, Trend

### Before This Effort

The system had symptoms but no coherent architectural contrast agent:

- Trace-health reports showed obvious bug signals: tool-call balance looked
  open, child-session output was not observable, ACP permission waits could
  hang, output reads were amplified, and parent-child/channel boundaries were
  unclear.
- The architecture discussion was mostly prose plus static imports. That missed
  the biggest runtime seam because it is dynamic.
- `runtime-context.ts` looked important by volume, but there was no language for
  separating "routes a lot" from "does real work."
- Tool-call and wait workflows looked like local cleanup targets, but the
  owning workflow result seam was not yet explicit.
- The table-owned target architecture existed, but it had not been attacked
  against hard cases.

### Now

We have better measurements and several tactical fixes:

- The runtime flow graph identifies the gravitational centers and the invisible
  SCC.
- The shrink loop defines `N` as condensation-node count and `C` as validated
  contract count.
- Contract annotation infrastructure exists, including `Activity.make`
  attribute support.
- DurableTable and workflow engine/body seams have started receiving contract
  annotations.
- The corpus work added deterministic control-plane cancel/close coverage.
- The schedule path has a true-future durable validation.
- ACP permission behavior is being split into forwarding, bounded wait, and
  explicit operator policy.
- The output replay storm has at least one merged tactical mitigation, while
  `tf-aseo` remains the heavier durable output cursor cutover candidate.

Merged PRs most relevant to this snapshot:

| PR | Architectural meaning |
|---|---|
| #646 | Annotated output + ACP session seams. |
| #647 | Annotated workflow engine/body seams. |
| #648 | Annotated DurableTable seam contracts. |
| #649 | Made section-level ACID resolution usable for contract ids. |
| #650 | Versioned the comparable runtime-shrink trace corpus. |
| #651 | Proved table-write-driven workflow resume without a deferred for one wakeup case. |
| #652 | Added `Activity.make` span-attribute hook for contract annotations. |
| #653 | Amended P3 input ordering toward consume-time assignment. |
| #654 | STOP: P3 consume-time ordering cannot rely on PK-sorted `rows()`. |
| #655 | Added deterministic control-plane cancel/close corpus scenario. |
| #656 | Bounded ACP codec permission wait with typed failure. |
| #657 | Linked `ToolCallWorkflow` / `WaitForWorkflow` inventory entries to cutover beads. |
| #658 | Surfaced append offset on `insertOrGet` inserted rows. |
| #659 | Forwarded ACP `PermissionRequest` to Zed native UI. |
| #642 | Validated true-future durable `schedule_me`. |
| #645 | STOP: MCP tool-call cutover blocked on absent owning-workflow tool seam. |

### Trend

Positive trend:

- The runtime is becoming explainable.
- The instrumentation is exposing real boundaries instead of letting code shape
  masquerade as architecture.
- Stop conditions are being found early, not after a half-migration.

Negative or unresolved trend:

- `N` has not moved. The graph is not smaller yet.
- `C` can rise without simplification. Contract coverage is necessary, but it is
  not the win condition.
- The target table seam has not survived its hardest cases yet.
- The active structural PRs are colliding with the most churn-heavy file,
  `runtime-context.ts`.

The next architect should call the current phase "substrate validation and
architecture falsification," not "runtime shrink," until an SCC is actually
merged, cleanly broken, or removed.

## 5. Big Rocks Blocking Real Shrink

### Rock 1: The engine/body SCC is one logical unit

Graph symptom:

```text
runtime-context.ts <-> engine-runtime.ts
```

with a larger SCC containing runtime-control wiring.

Why it matters:

- Adding more bridges across this seam hardens the wrong boundary.
- The current file/package split is not a reliable architectural boundary.
- The SCC can be fixed by co-location or by a one-directional typed seam, but
  not by another dynamic await/deferred crossing.

Decision needed:

- Should the engine/body unit be co-located first, or should the production
  migration create the workflow-owned table seam first and then delete the
  reciprocal dynamic path?

Practical guidance:

- Do not accept a patch whose only move is "make external await into
  `RuntimeContextWorkflow` cleaner" unless it also names the deletion path and
  blocks the old bridge.

### Rock 2: `runtime-context.ts` is a coordination shell, not the destination

Graph symptom:

```text
27,272 spans, 3% self-time
```

Why it matters:

- High traffic through `runtime-context.ts` does not mean logic belongs there.
- It is mostly routing, waiting, recording, and dispatching to real workers.
- Putting more semantic authority there makes future shrink harder.

Decision needed:

- Which responsibilities should move into workflow-owned table state, and which
  should stay as engine lifecycle/wiring?

Practical guidance:

- Treat new code in `runtime-context.ts` as suspicious unless it deletes a
  bridge or moves toward the SDD table seam.

### Rock 3: DurableTable is real mass, but the ordering primitive is not settled

Graph symptom:

```text
DurableTable.ts: 47,806 spans, 98% self-time
```

Current finding:

- `rows()` is primary-key sorted, not arrival sorted.
- #658 surfaced append offsets for inserted rows.
- Lane 2 then found that those offsets are non-dense byte/compound positions,
  so they do not directly become dense point-readable P3 cursors.

Why it matters:

- The P3 workflow-owned input table depends on replaying committed inputs in a
  deterministic order.
- If the cursor model is wrong, the table seam is not merely hard to implement;
  it is underspecified.

Decision needed:

- Validate the P3-B consume shape in firelab before production cutover.
- Decide whether the durable primitive is:
  - a forward read after an opaque offset,
  - a separate dense arrival index/cursor table,
  - a stream-native cursor/read-after-offset API,
  - or an explicit named wakeup/order primitive outside the table.

Practical guidance:

- Amend `SDD_RUNTIME_CONTEXT_WORKFLOW_INPUT_TABLE_CUTOVER.md` only after the
  derisk test proves the shape. Do not keep editing production code around a
  cursor whose semantics are unsettled.

### Rock 4: HC-0 multi-handle visibility is the substrate precondition

This comes from [runtime-shape-falsification.md](./runtime-shape-falsification.md).

The target reference's happy path is single-process and effectively
single-handle. That hides the most fundamental question:

```text
Does a channel write become visible to the workflow body's separate materialized
table handle deterministically, with bounded staleness and a guaranteed resume?
```

Why it matters:

- `DurableTable` writes have a commit barrier.
- Reads are local materialized snapshots.
- Production has writer and reader handles that may not see the same state at
  the same time.

Decision needed:

- Build a multi-handle reference/falsification scenario before treating the
  table seam as validated.

Possible outcomes:

- If it holds, the table seam has its substrate precondition.
- If it needs a wakeup bridge, name that primitive explicitly. Do not hide it
  behind "engine optionally resumes when table writes occur."

### Rock 5: HC-2 tool result correlation is the tf-jpcg / tf-vfq9 blocker

Current STOP:

- #645 says the MCP tool-call cutover is blocked on an absent owning-workflow
  tool seam.
- `tf-vfq9` should remain blocked until that seam is designed.

Hard invariant:

```text
A tool result returns to exactly the caller that issued it, by toolUseId,
exactly once, with N concurrent in-flight calls, surviving replay.
```

Target table expression:

```text
toolCalls table keyed by toolUseId
  requested | running | done
  result/error stored by key
```

Why it matters:

- Deleting `ToolCallWorkflow` by adding an external await into
  `RuntimeContextWorkflow` preserves the bad shape.
- The result seam should be workflow-owned durable state, or the SDD needs a
  named missing primitive.

Decision needed:

- Run the tool-call hard case in the tiny reference.
- If it passes, implement the `toolCalls`-table seam.
- If it fails, amend the SDD with the missing claim/deferred/result primitive
  before production cutover.

### Rock 6: `tf-aseo` is important but stale

Current state:

- PR #633 has lint fixes, but is dirty against current main.
- The conflict is not a trivial text conflict. It is in the output-observation
  path, where merged work has added memoization and seam annotations, while
  `tf-aseo` removes/replaces that path with durable state-table cursor logic.

Why it matters:

- This is the most important output-side structural move still alive.
- It overlaps with the same replay storm that #612 already mitigated more
  cheaply.
- It also interacts with the current contract-count baseline because merged
  annotations may need to move onto replacement seams.

Decision needed:

- Re-derive `tf-aseo` fresh on current main, or consciously abandon it in favor
  of the cheaper merged path plus a smaller durable cursor follow-up.

Practical guidance:

- Do not force-rebase #633 mechanically. The right question is whether its
  replacement seam still matches the target after #612, #647, and the spine
  move.

### Rock 7: Route completion and control-plane receipts are still being shaped

Current state:

- `tf-r6br` is active on protocol-owned route completion metadata and receipt
  schemas.
- #602 is an older draft around host-plane cancel route decisions.

Why it matters:

- Channel routes need a protocol-owned way to say whether a call returns an
  acknowledgement or terminal receipt.
- The ACP edge should consume that descriptor instead of inventing sync flags,
  `isComplete`, or ad hoc await enums.
- Terminal ACP prompt completion likely remains gated on `tf-aseo` or an
  equivalent output-state cutover.

Decision needed:

- Let `tf-r6br` land the protocol-owned descriptor and immediate receipts if
  review confirms it stays below the channel contract.
- Do not merge #602 without reconciling it against the newer route-completion
  work.

### Rock 8: ACP edge correctness is improving, but MCP tool exposure remains a portability gap

Current state:

- Permission forwarding to Zed is merged (#659).
- Bounded permission waits are merged (#656).
- Explicit permission policy config is open (#661).
- OLA is handling `tf-x3sv`: runtime-context MCP tool publication for
  no-refresh clients.

Root cause already established for `tf-x3sv`:

```text
Firegrid publishes runtime-context MCP tools progressively and emits
tools/list_changed repeatedly.
Codex snapshots tools once and does not re-pull.
Claude refreshes on list_changed and sees the full set.
```

Why it matters:

- This is not a Codex mapper filter.
- Any no-refresh MCP client can see a partial Firegrid toolset.

Decision needed:

- Make first `tools/list` stable and complete for the canonical runtime-context
  toolset, or clearly name why runtime-context/MCP lifecycle prevents that.

## 6. Contract Coverage: Useful, But Do Not Let It Become Vanity

The proposed seam schema:

```text
firegrid.seam.kind =
  transform | authority | durability | process | concurrency |
  ordering | bridge_debt | relay

firegrid.contract.id =
  ACID / SDD / decision-doc id that resolves to a real source of truth
```

The purpose of `C` is to ensure every exercised seam names the invariant it
enforces. The annotation track is good because it makes hidden contracts
searchable and reviewable.

But `C` is not architectural shrink. A contract id pointing six different seams
at a broad SDD can pass the mechanical gate while still not stating a precise
invariant. The next version of this practice should tighten resolution
granularity:

- Prefer ACIDs when a feature spec has the invariant.
- Prefer a specific SDD section when the invariant is architectural.
- Do not use generic "runtime architecture" ids for multiple unrelated seams.
- Treat `bridge_debt` as a debt marker with an owner and deletion bead, not as
  a permanent classification.

The annotation track should continue, but the structural track should govern
whether we call the effort successful.

## 7. Recommended Next Sequence

1. Reconcile the local checkout and origin carefully.

   Preserve the local architecture falsification commit while bringing in the
   merged PRs. Avoid any reset that drops the handoff/falsification docs.

2. Review and merge the clean tactical PRs if they still match main.

   Likely candidates: #660 and #661. They are useful and isolated, but keep the
   final PR descriptions honest that they do not complete the structural shrink.

3. Decide the `tf-aseo` path.

   Preferred: re-derive fresh on current main. Do not mechanically rebase #633.
   The output-observation conflict is architecture-bearing.

4. Dispatch or continue P3-B firelab consume derisk.

   This should test forward-read / crash / replay / idempotency / suspend-resume
   behavior with non-dense offsets. It should produce the wording for the SDD
   amendment, not follow it.

5. Dispatch HC-0 multi-handle table visibility falsification.

   This is the substrate precondition. It should not be skipped just because
   the single-handle reference passed.

6. Dispatch HC-2 toolCalls-table seam proof.

   This is the path to unblock `tf-vfq9`. Do not ship an external-await bridge
   and call it shrink.

7. Let `tf-r6br` finish the protocol-owned route completion metadata if it
   stays below the channel boundary.

   Keep terminal prompt completion gated on output-state readiness if needed.

8. Regenerate the runtime map only after the local checkout includes the merged
   annotation/corpus work.

   The local filesystem at this snapshot is behind origin, so local generated
   artifacts may not include all current merged metrics.

## 8. Guardrails For The Next Architect

Use these as review rules:

- Volume is not value. A high-volume edge can be pure overhead.
- A dark file is not dead until consumers are checked. Dark often means corpus
  coverage gap.
- An SCC means the boundary is already wrong. Co-locate or break it cleanly;
  do not preserve it with a prettier bridge.
- `bridge_debt` must have an owner and deletion path.
- Do not land production code that makes the target SDD's stop-condition harder
  to see.
- Do not call contract annotation progress "shrink" unless `N` moves or a named
  SCC disappears.
- Do not move semantic routing into the workflow engine.
- Do not expose engine/table handles to callers to make a tactical path pass.
- Do not recreate request/claim/completion row families for ordinary semantic
  workflow input unless the SDD is amended to say the table seam failed.

## 9. Open Questions To Carry Forward

1. Does the table seam work across separate writer/reader materialized handles,
   or does it need a named wakeup/visibility primitive?

2. What is the correct cursor/order primitive for P3 input consumption now that
   append offsets are known to be non-dense?

3. Should `tf-aseo` be re-derived fresh, or should the merged memoization path
   become the accepted output-side migration step?

4. Can tool calls be represented by workflow-owned `toolCalls` table state keyed
   by `toolUseId`, or do they require a distinct durable result primitive?

5. Which cancellation semantics are required for private beta: cooperative
   cancel at workflow transition points, or preemptive interruption of in-flight
   activity/tool execution?

6. Is route terminal completion a protocol-owned receipt contract now, and
   which routes are acknowledgement-only versus terminal?

7. What is the minimum stable first `tools/list` publication contract for the
   runtime-context MCP server?

8. What is the target `N` for "small enough to hold," and which named SCC is the
   first structural target?

## 10. One-Line State For The Next Architect

The runtime is not smaller yet. It is much better illuminated. The next
architect's job is to keep the table-seam target honest under HC-0/P3-B/HC-2,
avoid hardening bridge debt, and accept only changes that either move the graph
toward workflow-owned durable state or explicitly prove why that target needs a
new primitive.

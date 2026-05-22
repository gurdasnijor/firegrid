# tf-aseo — DurableOutputCursor output-arm cutover: stop-and-re-evaluate (2026-05-22)

**Bead:** `tf-aseo` (P0). **Slice:** #615 Q5 production output-arm cutover, on top of #612.
**Status:** STOP-AND-RE-EVALUATE before production code. Source-verified blocker; no production change made. Branch carries this finding only.
**Why this doc, not a patch:** the slice as scoped ("output-read-only, do not touch input") cannot reach its own goal (durable cursor, skip re-reads, true O(outputs), remove `RuntimeAgentOutputAfterEvents` from the body env) without either **breaking permission correctness** or **regressing cost vs #612**. Per `SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md §5` ("stop-and-re-evaluate if the slice needs …") and `PHASE_0_TARGET_REFERENCE.7`, I'm surfacing the missing primitive instead of coding around it.

## TL;DR

The merged event loop **does not store its progress as durable state**. It threads `RuntimeContextEventState` (sequence cursors **and** `pendingPermissionRequests`/`pendingPermissionResponses`) through **per-event, sequence-keyed memoized transition Activities**, and resets it to `initial` at the top of every `runMergedEventLoop` execution. On each mid-turn replay (the live trace shows ~81 in one turn) the body **re-walks outputs from sequence 0** to re-invoke those (cheap, memoized) transitions and rebuild the in-memory state. #612 made that re-walk cheap (in-process memo of immutable reads); it did **not** remove the re-walk.

The dispatch's actual target — a durable cursor whose `next()` **skips** already-delivered outputs (`SDD …§2 INV-2`, true `O(outputs)`) — requires the threaded state to be **loadable in one durable read**, not reconstructed by re-walking. A cursor that skips the read skips the transition call, so it **drops `pendingPermission` state and breaks permission request/response matching.** Making that state durable is **input-coupled** (it is mutated by `transitionInputEvent`), which the "do not touch input" boundary forbids.

So: **true O(outputs) ⟺ durable loop state ⟺ touches input-coupled permission state ⟺ exceeds this slice.** The clean part of the goal (replace the `events.initial` *scan* with an O(1) point read, removing the scan authority) is reachable, but on its own it does **not** deliver INV-2 and risks regressing #612's cost — see §4.

## Source-verified facts

1. **Loop state is in-memory + activity-memoized, never a durable state row.**
   `RuntimeContextEventState` (`runtime-context.ts:357-364`) holds `lastProcessedInputSequence`, `lastProcessedOutputSequence`, `pendingPermissionRequests`, `pendingPermissionResponses`, `exitEvidence`. It lives in an in-memory `Ref` created fresh each execution: `runMergedEventLoop` → `Ref.make(initialRuntimeContextEventState)` (`:869`, init `:393-398`). A repo-wide grep finds **no** persistence of `RuntimeContextEventState`/`lastProcessedOutputSequence` outside `runtime-context.ts`.

2. **Replay rebuilds that state by re-walking events through memoized transitions.**
   The transition is an Activity whose name keys on the state sequences: `firegrid.runtime-context.state.<ctx>.<attempt>.<side>.<seq>.after.<lastInput>.<lastOutput>` (`transitionActivityName`, `:708-721`; `transitionRuntimeContextEventActivity`, `:735-757`, success schema includes the full `state`). On replay the memoized result returns the cached `{state, action}` — but **only if the body calls the activity for that event**, which requires first **reading that event**. State is threaded, not loaded.

3. **The engine only resumes on `deferredDone`/`execute`/`interrupt`; output appends do neither.**
   `resume` re-runs the body top-to-bottom (`internal/engine-runtime.ts:175-245`); it is invoked from `execute` (`:283`), `interrupt` (`:332`), and `deferredDone` (`:457`). `appendAgentEvent` writes to `RuntimeOutputTable` (`per-context-output.ts:46-70`, codec path `codec-adapter.ts:359`) — a **separate stream** (`firegrid.runtimeOutput`) from the engine table (`firegrid.workflow`, `internal/table.ts:81-84`) — and never calls `deferredDone`/`resume` (grep: no `engine.resume` callers in runtime/host-sdk). So there is **no engine-level output→resume**; the durable wait for the next output must be owned by the cursor's own events tail (which the SDD prescribes, `…§2 Q1`/`Q4`).

4. **Output sequences are contiguous from 0** (`codec-adapter.ts:346` `Stream.mapAccum(0, …)`), so the SDD's `events.get(position+1)` point read (`§2 Q1`) is exact — no gap-tolerance needed. This part of the SDD holds.

5. **Permission matching depends on the rebuilt in-memory state.**
   `transitionInputEvent` routes a `PermissionResponse` to "send" vs "store-pending" based on `state.pendingPermissionRequests.includes(id)` (`:621-645`); `transitionOutputEvent` matches a `PermissionRequest` against `state.pendingPermissionResponses` (`:659-676`). If a replay skips re-reading the earlier `PermissionRequest` **output**, `pendingPermissionRequests` is empty, the response is mis-routed to "store-pending", and the matching output is never re-read → the permission response is never sent → the agent hangs awaiting permission. The machinery is live (referenced by `codecs/acp`, `codecs/stdio-jsonl`, `channels/session-permission`), not vestigial.

## Why each candidate fails the boundary or correctness

| Candidate | INV-2 (skip / true O(outputs))? | Permission-correct? | Removes `RuntimeAgentOutputAfterEvents` from body env? | Cost vs #612 | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. Durable cursor that skips delivered outputs** (the dispatch's literal ask) | yes | **NO** — drops `pendingPermission` state (§ fact 5) | yes | O(D) | **incorrect** |
| **B. Point-get at `pos+1`, keep in-memory `stateRef` re-walk (no skip)** | no (still re-walks) | yes | yes | O(D²) real point reads — **worse than #612's O(D) in-process memo hits** unless a memo is also kept | partial goal only; cost risk |
| **C. Durabilize the whole `RuntimeContextEventState` into a workflow-owned cursor/state row, load once, skip** | yes | yes | yes | O(D) | **correct — but touches input-coupled state (out of slice)** |
| **D. (shipped) #612 in-process memo** | no | yes | no (still uses the scan authority) | O(D) reads, O(D²) cheap memo hits | already live |

Only **C** delivers the dispatch's goal correctly. C is the SDD_TARGET model ("replay reconstructs progress from **table state**", `SDD_TARGET…:300`) — it is a **loop-state-durabilization**, not an output-read swap, and it necessarily touches the permission state that `transitionInputEvent` mutates.

## Recommendation (for the coordinator)

Re-scope `tf-aseo` to one of:

1. **(preferred) Durable loop-state slice.** Authorize durabilizing `RuntimeContextEventState` (sequence cursors + pending-permission sets + exit evidence) into a workflow-owned `RuntimeContextStateTable` row keyed by `(contextId, activityAttempt)`, loaded once per execution and advanced as outputs/inputs are consumed. This is the genuine Phase 0B/0C "replay-from-table-state" cutover and the only correct path to INV-2 / true O(outputs) + removing `RuntimeAgentOutputAfterEvents` from the body env. It **does** touch input-event state-threading, so it needs an explicit boundary expansion beyond "output-read-only" (it does **not** need to touch the input *intents / deferred mailbox* — that stays). Output read becomes `events.get(pos+1)` + events-tail wait per `SDD …§2`.

2. **Type-unexpressibility-only slice (narrow, no INV-2).** Replace the `events.initial` scan with a point-get against `RuntimeOutputTable.events.get` and remove `RuntimeAgentOutputAfterEvents` from `RuntimeContextWorkflowExecutionEnv`, **keeping** the in-process immutability memo from #612 to avoid the O(D²) real-read regression (candidate B+memo). This kills the scan / `agent_output.initial` span and the scan authority in the body env, but explicitly **does not** claim INV-2 / durable cursor; the trace gate would assert "no scan span", not "skip". Smaller, correct, but leaves the durable-cursor goal for slice 1.

3. **Confirm #612 is sufficient for private beta** and defer the structural cursor to the tiny-firegrid reference (`tf-ly2g`) until the loop-state model is durabilized there first.

I recommend **option 1** (it is the real target and unblocks removing the scan authority correctly), with the explicit note that it expands the slice into output-derived loop state (not the input mailbox).

## Boundaries honored

No production code changed. Did **not** touch input intents, the deferred mailbox, the ACP edge, or any input-event handling. This branch carries this finding doc only.

## Source index

`packages/runtime/src/workflow-engine/workflows/runtime-context.ts` (`:357-364` state schema, `:393-398` init, `:621-676` permission transitions, `:708-757` sequence-keyed memoized transition activity, `:795-816` `completedRuntimeContextEvent`, `:863-894` `runMergedEventLoop`, `:126-134` body env, `:308-344` #612 memo'd `completedRuntimeOutput`); `packages/runtime/src/workflow-engine/internal/engine-runtime.ts` (`:175-245` resume, `:415-463` deferredResult/deferredDone); `packages/runtime/src/workflow-engine/internal/table.ts:81-84`; `packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts:46-155`; `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:346-366`; `packages/protocol/src/launch/table.ts:80-93,189-219`; `docs/sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md` (§0, §2 Q1/Q4/Q5, §5).
</content>

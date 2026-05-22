# Q3 — Where does the workflow engine's guarantee boundary actually sit?

**Brief:** CC3 (1 of 4 first-principles research briefs). First-principles reading
of the `DurableStreamsWorkflowEngine` (`packages/runtime/src/workflow-engine/internal/engine-runtime.ts`),
the upstream `@effect/workflow@0.18.1` type surface, and the production-engine tests.
Goal: state precisely what the engine guarantees, where the load-bearing
resume/visibility boundary is, and where the guarantees stop — so the
re-architecture builds on the real contract, not the assumed one.

---

## 1. What's guaranteed

The engine is a `WorkflowEngine.makeUnsafe({...})` implementation
(`engine-runtime.ts:247`) backed by four DurableTables: `executions`,
`activities`, `activityClaims`, `deferreds`, `clockWakeups`. The guarantees are
all *durable-row-mediated*, not in-memory:

**(a) Execution idempotency / completed-result memoization.** `execute` first
point-reads the execution row; `if (existing?.finalResult !== undefined) return
(yield* decodeWorkflowResult(...))` (`engine-runtime.ts:265-268`). A second
`execute` with the same `idempotencyKey`-derived `executionId` returns the
recorded result without re-running the body. Proven by VALIDATION.1: two
`CountWorkflow.execute({ id: "same" })` calls both return `42` while
`expect(runs).toBe(1)` — the activity ran exactly once (test line ~352).

**(b) Activity exactly-once via claim + result row.** `activityExecute`
(`:344`) reads the activity row first and returns its revived result if present
and non-`Suspended` (`:351-354`); otherwise it races a claim through
`activityClaims.insertOrGet` (`claimActivity`, `:62`). Only the worker whose id
matches the claim runs the body; a losing worker returns
`new Workflow.Suspended({})` (`:372-374`). The result is persisted only if no
row exists yet (`Option.isNone(existingActivity)`, `:396`). VALIDATION.6 asserts
"claims a raced activity once across concurrent workers."

**(c) Deferred result durability.** `deferredResult` (`:415`) reads the
`deferreds` row and revives its `Exit`; `deferredDone` (`:431`) writes the exit
row (idempotently — only `if (Option.isNone(existingDeferred))`, `:448`) and
then resumes. VALIDATION.8 proves both failed *deferred* and failed *activity*
exits replay through these reads after engine reconstruction.

**(d) Durable timers with no external clock driver.** `scheduleClock` (`:464`)
persists a `clockWakeups` row with an absolute `deadlineMs`; on engine
construction `recoverPendingClockWakeups` (`:142`, run at `:500`) re-arms every
`status === "pending"` row via `scheduleClockWakeup` → `Effect.delay` →
`fireClockWakeup` → `deferredDone`. VALIDATION.3 proves a `DurableClock.sleep`
"fires it after engine reconstruction without an external clock driver."

**(e) Interrupt is terminal across reconstruction.** `interrupt` (`:322`) sets
`interrupted: true` on the row, and `resume` turns that into `Effect.interrupt`
as the body (`:195-197`). tf-gyxc asserts a user-interrupted workflow does not
re-run (`finalResult` never contains `"should-not-resume"`).

---

## 2. The resume / visibility boundary (load-bearing)

This is the crux for the re-architecture. **`resume` is the single, separable
"wake-up" half of the engine, and it is decoupled from deferreds.**

`deferredDone` is literally *record-the-row-then-resume*: write the deferred
exit (`:449-455`) then `yield* resume(options.executionId)` (`:457`). `interrupt`
also ends in `resume` (`:332`). `clock` fire routes through `deferredDone` →
`resume`. So **`resume` is the universal re-entry point**, and the public
`WorkflowEngine.resume(workflow, executionId)` method (`WorkflowEngine.d.ts:41`;
impl `engine-runtime.ts:343` delegating to `resume` at `:175`) exposes that half
*without* requiring any deferred.

What `resume` does (`:175-236`):
1. Reads the execution row; bails if missing or already `finalResult`-complete
   (`:178`).
2. Bails if the workflow name isn't registered yet (`:179`) — this is why
   VALIDATION.5 "waits for workflow registration before resuming."
3. Bails if a fiber is already running and not in a `Suspended` success state
   (`:181-186`) — guards against double-spawn.
4. Builds a fresh `WorkflowInstance.initial(...)`, re-runs `entry.execute(...)`
   under `Workflow.intoResult`, and on completion **upserts the execution row**
   with `suspended: result._tag === "Suspended"` and a `finalResult` only when
   `Complete` (`:209-221`).

The boundary, stated plainly: **the body re-runs from the top on every resume,
and replays past effects from durable rows (memoized activities, recorded
deferred exits) until it reaches the first effect whose row is still absent — at
which point it must voluntarily `Workflow.suspend(instance)` again.** The engine
does not snapshot a continuation; durability lives entirely in the tables the
body re-reads.

The tf-e5rf / #651 test makes this boundary explicit and proves a critical
generalization: **a body can wait on any workflow-owned table row, not just a
DurableDeferred.** Its body point-reads a `DurableTable` and
`return yield* Workflow.suspend(instance)` when `Option.isNone(row)` (test
`:~960`). Assertions:
- After phase 1: `suspendedRow.value.suspended` is `true`, `finalResult` is
  `undefined`.
- `deferredsWhileSuspended` filtered to the execution **`toHaveLength(0)`** — the
  suspension created *no* deferred mailbox.
- After writing the input row and calling `WakeWorkflow.resume(executionId)`, the
  body re-runs, reads the row, and `expect(completed).toBe("delivered-by-table-write")`.
- `deferredsAfterResume` is still `toHaveLength(0)` — "single explicit resume (no
  polling)."

This validates that the F3 "table-write-driven resume" wakeup primitive
**already exists** in the composition of two upstream primitives:
`Workflow.suspend(instance)` (`Workflow.d.ts:353`, a general voluntary-suspend
not tied to deferreds) + `engine.resume` — and needs no new engine method.

---

## 3. Where the guarantees stop

- **No atomic "write-row-and-resume" across distinct tables.** The engine
  guarantees the *deferreds* row is written-then-resumed atomically inside
  `deferredDone`. For the table-write-driven path (tf-e5rf), the writer does
  `table.inputs.insert(...)` then *separately* `WakeWorkflow.resume(...)` — two
  independent operations. If the process dies between them, the row is durable
  but the resume signal is lost; nothing re-fires it. (tf-e5rf's own commit
  message gates the production cutover on "bead A (atomic append)".)

- **No automatic re-resume of suspended-but-not-deferred executions.** Clock
  rows are re-armed on engine construction (`recoverPendingClockWakeups`).
  *Nothing equivalent re-arms a table-row-waiting suspension.* If a body
  suspended waiting on a table row and the host restarts, no recovery loop calls
  `resume` for it — the wakeup depends on the next external writer remembering to
  resume.

- **Resume is best-effort / fire-and-forget within `execute`.** `execute` calls
  `resume` then joins the fiber if present, else re-reads the row and returns
  `Workflow.Suspended` (`:284-294`). There is no retry schedule wired here beyond
  what upstream `suspendedRetrySchedule` provides; the engine doesn't itself
  re-drive a suspended execution.

- **Replay cost is O(effects-from-top) per resume.** Because the body re-runs
  from the top, every resume re-walks all prior effects (cheap table reads, but
  still linear). This is exactly the amplification the runtime-context work has
  been fighting (`[[project_tf_aseo_output_cursor_blocked_by_loop_state]]`,
  `[[project_tf_q4uz_phase0b_output_replay_oracle]]`); the engine guarantees
  correctness of replay, not bounded replay cost.

- **`orDie` erases table errors at the boundary.** `orDieTable` (`:19-25`)
  converts `DurableTableError` to a defect because the upstream `WorkflowEngine`
  API signatures can't carry table errors. So storage failures surface as
  defects, not typed failures — the guarantee is "the row is the truth," with no
  typed recovery channel for storage faults.

---

## 4. Open questions

1. **Atomic write+resume.** Should the re-architecture introduce a single engine
   primitive that atomically appends a workflow-owned row *and* arms a resume
   (the "bead A atomic append"), closing the tf-e5rf two-step gap? Or is the
   intended pattern a kernel-owned writer that owns both halves
   (`[[project_hostkernelworkflow_control_plane_direction]]`)?

2. **Suspension recovery symmetry.** Clock wakeups recover on construction;
   table-row waits do not. Does the re-arch need a general "pending suspension
   recovery" sweep, or is every non-clock suspension expected to be re-driven by
   a durable external owner (kernel/control-plane)?

3. **Bounded replay.** Given the body re-runs from the top, does the re-arch lean
   on the durable-cursor/loop-state pattern (tf-aseo/tf-zjuf) at the *application*
   layer, or should the engine itself offer a checkpoint/continuation primitive?
   The current engine deliberately does not.

4. **Worker-claim semantics under the new shape.** `activityExecute` returns
   `Suspended` to the losing claimant and relies on the winner's eventual
   `deferredDone`/result write to wake it. If the winning worker dies after
   claiming but before writing the result row, what re-drives the claim? (No
   claim-expiry/lease logic is visible in `claimActivity`.)

5. **Defect vs. typed-failure boundary.** Is `orDieTable`'s erasure of
   `DurableTableError` acceptable for the re-arch's durability guarantees, or does
   the engine need a typed storage-fault channel that bodies/control-plane can
   react to?

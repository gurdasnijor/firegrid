# tf-r06u.28 sleep spike — durable suspension cannot live inside `Activity.make`

Date: 2026-06-01
Owner: tf-r06u.28 (agent2 / lane-b)
Method: direct library-source verification (`@effect/workflow@0.18.1`), the
methodology-blessed ground-truth path for a private-seam question
(`packages/tiny-firegrid/docs/methodology.md` §"Triage rubric": "Categories 1
and 2 need direct-source verification — read the production code"). This is a
`@effect/workflow` + unified-substrate internals question, which the R3 airgap
guard would forbid a tiny-firegrid *driver* from reaching — so the seam is read
at the library source, not a public-surface sim.

## The question

The plan's slice-2 mapping says `sleep → Workflow.sleep / DurableClock.sleep`.
#765's unified `ToolDispatchWorkflow` body (`unified/subscribers/permission-and-tool.ts:228`)
wraps the **entire** injected executor in a single `Activity.make`:

```ts
const resultJson = yield* Activity.make({
  name: `unified.tool.execute/${payload.toolUseId}`,
  success: Schema.String,
  execute: executor.execute(payload),   // ← could this contain DurableClock.sleep?
})
```

Can a suspending primitive (`DurableClock.sleep`, `awaitSignal`,
`DurableDeferred.await`) run **inside** that executor's Activity, or must
suspending tools branch at the workflow-body level?

## Verdict: suspension inside an Activity is structurally invalid — it is retried then killed

`Activity.make` wraps every `execute` in `retryOnInterrupt` before running it
(`@effect/workflow/src/Activity.ts`, `make` → `executeWithoutInterrupt =
retryOnInterrupt(name, policy)(options.execute)`):

```ts
const interruptRetryPolicy = Schedule.exponential(100, 1.5).pipe(
  Schedule.union(Schedule.spaced("10 seconds")),
  Schedule.union(Schedule.recurs(10)),
  Schedule.whileInput((cause) => Cause.isInterrupted(cause))   // ← retries WHILE interrupted
)

const retryOnInterrupt = (name, policy = interruptRetryPolicy) => (effect) =>
  effect.pipe(
    Effect.sandbox,
    Effect.retry(policy),
    Effect.catchAll((cause) => {
      if (!Cause.isInterrupted(cause)) return Effect.failCause(cause)
      return Effect.die(`Activity "${name}" interrupted and retry attempts exhausted`)  // ← dies
    }),
  )
```

`Workflow.suspend` (`@effect/workflow/src/Workflow.ts:702`) suspends a workflow
**by interrupting the current fiber**:

```ts
export const suspend = (instance) =>
  Effect.interruptible(Effect.async<never>(() => {
    instance.suspended = true
    const fiber = Option.getOrThrow(Fiber.getCurrentFiber())
    fiber.unsafeInterruptAsFork(fiber.id())   // ← suspend == interrupt
  }))
```

And the durable path of `DurableClock.sleep` (`@effect/workflow/src/DurableClock.ts`,
the `duration > inMemoryThreshold` branch) ends in `DurableDeferred.await(...)`,
which suspends via that same interrupt mechanism.

These compose adversarially: a suspend-via-interrupt raised **inside** an
Activity's `execute` is caught by that Activity's own `retryOnInterrupt`
(`whileInput(Cause.isInterrupted)`), retried up to ~10× (exponential→spaced),
and then converted to a **defect**: `Activity "<name>" interrupted and retry
attempts exhausted`. The workflow never suspends; it dies. Suspension is valid
**only** at the workflow-body level, outside any `Activity.make`.

This is consistent with the substrate's own precedent: `scheduledPromptBody`
(`unified/subscribers/scheduled-webhook-peer.ts:84`) calls `DurableClock.sleep`
at the **body** level, with only the idempotent table-insert in an `Activity`.

## Two sleep paths inside `DurableClock.sleep` (why "short sleep seems to work")

`DurableClock.sleep` (`DurableClock.ts`) splits on `inMemoryThreshold` (default
60s):
- **≤ threshold:** runs `Effect.sleep(duration)` inside its *own* `Activity.make`
  — a plain timed effect, **no suspend**. (So a short sleep nested in the
  executor's Activity is a redundant *nested Activity*, not a death — but it is
  non-durable: a crash mid-sleep re-runs the Activity and re-sleeps.)
- **> threshold:** `engine.scheduleClock` + `DurableDeferred.await` → **suspend**
  → dies if nested in an Activity per the mechanism above.

So "short sleep appears to work in the Activity" is the in-memory path; it is
*not* crash-durable and it is *not* the suspend path. Durable long sleep
strictly requires body-level placement.

## Consequence for the toolkit (the executor/body boundary)

The `ToolExecutor` abstraction (`execute(payload) => Effect<string>`, run inside
one Activity) is correct for **non-suspending** tools and wrong for
**suspending** ones:

| tool | suspends? | home |
|---|---|---|
| `send`, `call`, `execute`, `session_*` (fire), `schedule_me` (non-blocking start) | no | executor, inside the Activity ✓ |
| `sleep` (durable), `wait_for`, `wait_for_any` | **yes** | **workflow body level**, outside the Activity |

The unified `ToolDispatchWorkflow` body must therefore branch on tool name:
suspending tools call `DurableClock.sleep` / `awaitSignal` directly in the body;
the rest go through the Activity-wrapped executor.

## Recommendation (staged, transactional-cutover-clean)

1. **Green milestone now (no shared-file touch):** the `FiregridAgentToolExecutor`
   `sleep` arm uses plain `Effect.sleep` (the in-memory semantics, non-durable),
   which runs cleanly inside the existing Activity and satisfies the
   `sleep-only-substrate-smoke` acceptance test (MCP `tools/call` is synchronous
   request/response; the durability boundary is the agent connection).
2. **Durable sleep follow-up (file a bead):** give the workflow body a
   body-level `DurableClock.sleep` branch for the wire path's long sleeps. This
   edit touches `permission-and-tool.ts` and so lands **with** the held
   `relayToSession` edit, after Agent1's tf-r06u.5 green-up — one batched,
   additive, post-rebase change to the shared workflow body. Named here as
   explicit durability debt per the transactional-cutover rule.

The same body-level rule governs `wait_for`/`wait_for_any` (they `awaitSignal`),
so this boundary shapes those arms too.

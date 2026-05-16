/**
 * Subscription router — a scoped runtime worker that resolves `wait_for`
 * deferreds when source-collection rows match the wait's trigger.
 *
 * Implements:
 *  - firegrid-durable-tools.SUBSCRIPTION.1 — `subscribeChanges(..., { includeInitialState: true })`
 *    drives a single match-evaluation code path for initial state + live changes
 *  - firegrid-durable-tools.SUBSCRIPTION.2 — no snapshot-then-subscribe
 *  - firegrid-durable-tools.SUBSCRIPTION.3 — write a completion row with the
 *    raw matched-row payload; resolve the workflow-engine deferred with that
 *    raw payload
 *  - firegrid-durable-tools.SUBSCRIPTION.7 — composed as a scoped runtime worker
 *  - firegrid-durable-tools.LIFECYCLE.2/3/5 — per-dispatch wait re-check;
 *    retired waits never dispatch; source-fiber leakage is tolerated
 *  - firegrid-durable-tools.PUBLIC_SURFACE.1 — the router never starts a
 *    workflow execution
 *  - firegrid-durable-tools.BOUNDARIES.3 — discovery channel is
 *    `subscribeChanges`, not `Effect.sleep` polling
 *  - firegrid-durable-tools.EFFECT_IDIOMS.2 — `Clock.currentTimeMillis`
 */

import { WorkflowEngine } from "@effect/workflow"
import {
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect"
import { reconcileCompletions } from "./reconcile.ts"
import {
  SourceCollections,
  type SourceCollectionHandle,
} from "./source-collections.ts"
import { type WaitRow } from "./table.ts"
import { DurableWaitStore } from "../../authorities/index.ts"
import { evaluateFieldEquals } from "./types.ts"
import { matchDeferredFor } from "./wait-for.ts"

/**
 * firegrid-durable-tools.SUBSCRIPTION.3
 *
 * Resolve the wait's match deferred with the raw row payload. Idempotent in
 * the workflow engine — repeated calls with the same deferred name are
 * no-ops after the first.
 */
const completeMatch = (
  wait: WaitRow,
  row: unknown,
  waitStore: DurableWaitStore["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  Effect.gen(function*() {
    // firegrid-durable-tools.LIFECYCLE.2 — re-read at dispatch boundary.
    const current = yield* waitStore.findWait(wait.waitKey)
    if (Option.isNone(current)) {
      return
    }
    if (current.value.status !== "active") {
      return
    }

    if (!evaluateFieldEquals(wait.trigger, row)) return

    // firegrid-durable-tools.TIMEOUT.3 — if a timeout completion was already
    // written for this wait, skip; the timeout path will resolve the
    // workflow's deferred. The final guarantee that exactly one of match /
    // timeout resolves the workflow is `engine.deferredDone`'s Option.isNone
    // guard, which makes the second deferredDone call a no-op.
    const existingCompletion = yield* waitStore.findCompletion(wait.waitKey)
    if (
      Option.isSome(existingCompletion) &&
      existingCompletion.value.outcome === "timeout"
    ) {
      return
    }

    const completedAtMs = yield* Clock.currentTimeMillis
    yield* waitStore.upsertCompletion({
      waitKey: wait.waitKey,
      outcome: "match",
      matchedRowPayload: row,
      completedAtMs,
    })
    yield* waitStore.upsertWait({
      ...current.value,
      status: "completed",
    })
    // firegrid-durable-tools.WAIT_FOR.7
    yield* engine.deferredDone(
      matchDeferredFor(wait.deferredName),
      {
        workflowName: wait.workflowName,
        executionId: wait.executionId,
        deferredName: wait.deferredName,
        exit: Exit.succeed(row),
      },
    )
  })

/**
 * firegrid-durable-tools.SUBSCRIPTION.1/2
 *
 * Attach a single source subscription per (waitKey, sourceName). The handle's
 * `subscribe()` is the canonical includeInitialState stream — the router does
 * not perform any prior snapshot read.
 */
const attachWaitToSource = (
  wait: WaitRow,
  handle: SourceCollectionHandle,
  waitStore: DurableWaitStore["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  Effect.gen(function*() {
    yield* handle.subscribe().pipe(
      Stream.runForEach((row) => {
        return completeMatch(wait, row, waitStore, engine).pipe(
          Effect.catchAll((cause) =>
            Effect.logWarning(
              "[durable-tools] router failed to complete wait",
            ).pipe(Effect.annotateLogs({
              waitName: wait.waitKey.name,
              cause,
            })),
          ),
        )
      }),
    )
  })

/**
 * Forks a source-attached worker for each newly-seen active wait. The
 * `attached` Ref dedupes by the encoded wait key so initial-state replays do
 * not produce duplicate attached subscriptions for the same wait.
 *
 * Lifecycle: the per-dispatch re-check inside `completeMatch` enforces
 * LIFECYCLE.2/3. The forked fibers may persist until host scope close
 * (LIFECYCLE.5).
 */
const startRouter = Effect.gen(function*() {
  const engine = yield* WorkflowEngine.WorkflowEngine
  const waitStore = yield* DurableWaitStore
  const sources = yield* SourceCollections

  // firegrid-durable-tools.WAIT_FOR.7
  yield* reconcileCompletions(waitStore, engine).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning(
        "[durable-tools] reconcile pass failed",
      ).pipe(Effect.annotateLogs({ cause })),
    ),
  )

  const encodeWaitKey = Schema.encodeSync(
    Schema.Struct({
      executionId: Schema.String,
      name: Schema.String,
    }),
  )
  const attached = yield* Ref.make(new Set<string>())

  yield* waitStore.activeWaits.pipe(
    Stream.runForEach((wait) =>
      Effect.gen(function*() {
        const encoded = JSON.stringify(
          encodeWaitKey({
            executionId: wait.waitKey.executionId,
            name: wait.waitKey.name,
          }),
        )
        const set = yield* Ref.get(attached)
        if (set.has(encoded)) return
        // Mark before the awaitHandle so concurrent emits of the same wait
        // do not each fork a waiter. The awaiter resolves when the source
        // registers; until then this per-wait fiber simply suspends inside
        // the runtime-host scope.
        yield* Ref.update(
          attached,
          (s) => new Set([...s, encoded]),
        )
        yield* Effect.forkScoped(
          Effect.gen(function*() {
            const handle = yield* sources.awaitHandle(wait.sourceName)
            yield* attachWaitToSource(wait, handle, waitStore, engine)
          }),
        )
      })),
    Effect.catchAll((cause) =>
      Effect.logError("[durable-tools] router stream failed").pipe(
        Effect.annotateLogs({ cause }),
      )),
    Effect.forkScoped,
  )
})

/**
 * firegrid-durable-tools.SUBSCRIPTION.7
 * firegrid-durable-tools.RUNTIME_BOUNDARY.4
 *
 * Scoped runtime worker. Acquires `WorkflowEngine`, `DurableWaitStore`, and
 * `SourceCollections` and forks the router stream into the host scope.
 */
export const SubscriptionRouterLive = Layer.scopedDiscard(startRouter)

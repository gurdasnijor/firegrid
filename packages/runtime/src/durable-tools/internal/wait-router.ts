/**
 * Wait router — a scoped subscriber driver that resolves `wait_for`
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
  Match,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect"
import { reconcileCompletions } from "./reconcile.ts"
import { RuntimeWaitStreams } from "./runtime-wait-streams.ts"
import { type WaitRow } from "./table.ts"
import {
  DurableWaitCompletionRowLookup,
  DurableWaitCompletionRows,
  DurableWaitCompletionRowUpsert,
  DurableWaitRowLookup,
  DurableWaitRows,
  DurableWaitRowUpsert,
} from "./durable-wait-store.ts"
import { evaluateFieldEquals, type RuntimeWaitSource } from "./types.ts"
import { matchDeferredFor } from "./wait-for.ts"

/**
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.2
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.3
 *
 * Select the concrete runtime observation stream for a persisted typed wait
 * source. Adding a variant is one `Match.tag` arm plus one
 * `RuntimeWaitStreams` field.
 */
const streamForSource = (
  source: RuntimeWaitSource,
): Effect.Effect<
  Stream.Stream<unknown, unknown>,
  never,
  RuntimeWaitStreams
> =>
  Effect.map(RuntimeWaitStreams, (streams) =>
    Match.value(source).pipe(
      Match.tag("AgentOutput", () => streams.agentOutput),
      Match.tag("AgentOutputAfter", source => streams.agentOutputAfter(source)),
      Match.tag("RuntimeRun", () => streams.runtimeRun),
      Match.exhaustive,
    ))

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
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
  completionLookup: DurableWaitCompletionRowLookup["Type"],
  completionUpsert: DurableWaitCompletionRowUpsert["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  Effect.gen(function*() {
    // firegrid-durable-tools.LIFECYCLE.2 — re-read at dispatch boundary.
    const current = yield* waitLookup.find(wait.waitKey)
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
    const existingCompletion = yield* completionLookup.find(wait.waitKey)
    if (
      Option.isSome(existingCompletion) &&
      existingCompletion.value.outcome === "timeout"
    ) {
      return
    }

    const completedAtMs = yield* Clock.currentTimeMillis
    yield* completionUpsert.upsert({
      waitKey: wait.waitKey,
      outcome: "match",
      matchedRowPayload: row,
      completedAtMs,
    })
    yield* waitUpsert.upsert({
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
 * Attach a single subscription per (waitKey, source) to the typed runtime
 * stream selected for the wait. The stream is the canonical
 * includeInitialState observation — the router does not perform any prior
 * snapshot read.
 */
const attachWaitToSource = (
  wait: WaitRow,
  source: Stream.Stream<unknown, unknown>,
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
  completionLookup: DurableWaitCompletionRowLookup["Type"],
  completionUpsert: DurableWaitCompletionRowUpsert["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  Effect.gen(function*() {
    yield* source.pipe(
      Stream.runForEach((row) => {
        return completeMatch(
          wait,
          row,
          waitLookup,
          waitUpsert,
          completionLookup,
          completionUpsert,
          engine,
        ).pipe(
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
  const waitLookup = yield* DurableWaitRowLookup
  const waitUpsert = yield* DurableWaitRowUpsert
  const waitRows = yield* DurableWaitRows
  const completionLookup = yield* DurableWaitCompletionRowLookup
  const completionUpsert = yield* DurableWaitCompletionRowUpsert
  const completionRows = yield* DurableWaitCompletionRows

  // firegrid-durable-tools.WAIT_FOR.7
  yield* reconcileCompletions(
    waitLookup,
    waitUpsert,
    completionRows,
    engine,
  ).pipe(
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

  const completeInitialIfPresent = (
    wait: WaitRow,
  ) =>
    Effect.gen(function*() {
      if (wait.source._tag !== "AgentOutputAfter") return
      const streams = yield* RuntimeWaitStreams
      const row = yield* streams.initialAgentOutputAfter(wait.source)
      if (Option.isNone(row)) return
      yield* completeMatch(
        wait,
        row.value,
        waitLookup,
        waitUpsert,
        completionLookup,
        completionUpsert,
        engine,
      )
    })

  // firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.8
  yield* waitRows.pipe(
    Stream.filter(wait => wait.status === "active"),
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
        // Mark before forking so concurrent emits of the same wait do not
        // each fork a waiter. The typed source stream is always available
        // through the router's Layer requirements; there is no registration
        // rendezvous.
        yield* Ref.update(
          attached,
          (s) => new Set([...s, encoded]),
        )
        yield* completeInitialIfPresent(wait).pipe(
          Effect.catchAll((cause) =>
            Effect.logWarning(
              "[durable-tools] router failed initial wait completion",
            ).pipe(Effect.annotateLogs({
              waitName: wait.waitKey.name,
              cause,
            })),
          ),
        )
        yield* Effect.forkScoped(
          Effect.gen(function*() {
            const source = yield* streamForSource(wait.source)
            yield* attachWaitToSource(
              wait,
              source,
              waitLookup,
              waitUpsert,
              completionLookup,
              completionUpsert,
              engine,
            )
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

type WaitRouterRequirements =
  | DurableWaitCompletionRowLookup
  | DurableWaitCompletionRows
  | DurableWaitCompletionRowUpsert
  | DurableWaitRowLookup
  | DurableWaitRows
  | DurableWaitRowUpsert
  | RuntimeWaitStreams
  | WorkflowEngine.WorkflowEngine

/**
 * firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.3
 * firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.6
 * firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.10
 * firegrid-durable-tools.SUBSCRIPTION.7
 * firegrid-durable-tools.RUNTIME_BOUNDARY.4
 * firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
 * firegrid-typed-wait-source-redesign.WAIT_ROUTER.2
 * firegrid-typed-wait-source-redesign.WAIT_ROUTER.4
 *
 * Scoped subscriber driver. It provides no public service; the `never` output
 * channel makes the wait-router role visible in the Effect type. Source
 * selection is a typed `Match.value` over `RuntimeWaitStreams`, not a string
 * registry lookup.
 */
export const WaitRouterLive: Layer.Layer<
  never,
  never,
  WaitRouterRequirements
> = Layer.scopedDiscard(startRouter)

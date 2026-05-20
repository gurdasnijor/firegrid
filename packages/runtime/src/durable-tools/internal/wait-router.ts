/**
 * Wait router — a scoped subscriber driver that resolves `wait_for`
 * deferreds when source-collection rows match the wait's trigger.
 *
 * Implements:
 *  - firegrid-durable-tools.SUBSCRIPTION.1 — `subscribeChanges(..., { includeInitialState: true })`
 *    drives a single match-evaluation code path for initial state + live changes
 *  - firegrid-durable-tools.SUBSCRIPTION.2 — no snapshot-then-subscribe
 *  - firegrid-durable-tools.SUBSCRIPTION.3 — resolve the workflow-engine deferred
 *    with the raw matched-row payload (Shape C: no completion-row write)
 *  - firegrid-durable-tools.SUBSCRIPTION.7 — composed as a scoped runtime worker
 *  - firegrid-durable-tools.LIFECYCLE.2/3/5 — per-dispatch wait re-check;
 *    retired waits never dispatch; source-fiber leakage is tolerated
 *  - firegrid-durable-tools.PUBLIC_SURFACE.1 — the router never starts a
 *    workflow execution
 *  - firegrid-durable-tools.BOUNDARIES.3 — discovery channel is
 *    `subscribeChanges`, not `Effect.sleep` polling
 *  - firegrid-durable-tools.EFFECT_IDIOMS.2 — `Clock.currentTimeMillis`
 *
 * Shape C Step 2 + Step 3 (docs/research/durable-tools-vs-workflow-engine-convergence.md):
 * the match/timeout arbitration moved onto `DurableDeferred.raceAll`'s race
 * deferred. `completeMatch` no longer writes a `WaitCompletionRow` and no
 * longer reads completions to preempt the timeout — both were a redundant
 * second mechanism given idempotent `engine.deferredDone`. The `completions`
 * table is gone. The router still writes `waits.status: "completed"` after
 * `deferredDone` because the lifecycle re-check
 * (firegrid-durable-tools.LIFECYCLE.2) reads that status to skip
 * already-resolved waits at the dispatch boundary.
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
  Stream,
} from "effect"
import { rowOtelExternalSpan } from "@firegrid/protocol/otel"
import type { ExternalSpan, SpanLink } from "effect/Tracer"
import { encodeWaitKey, waitSpanAttributes } from "./observability.ts"
import { RuntimeWaitStreams } from "./runtime-wait-streams.ts"

// firegrid-row-otel-propagation.ROW_OTEL.2 — the wait router has two causal
// predecessors. Parent = row-arrival; link = wait registrar. Either may be
// missing on legacy rows; the resulting span options simply omit those keys.
const completeMatchSpanOptions = (
  wait: { readonly _otel?: unknown },
  row: unknown,
): {
  readonly parent?: ExternalSpan
  readonly links?: ReadonlyArray<SpanLink>
} => {
  const parent = rowOtelExternalSpan(row)
  const registrarSpan = rowOtelExternalSpan(wait)
  const links: ReadonlyArray<SpanLink> = registrarSpan === undefined
    ? []
    : [
      {
        _tag: "SpanLink",
        span: registrarSpan,
        attributes: { "firegrid.wait.predecessor": "registrar" },
      },
    ]
  return {
    ...(parent === undefined ? {} : { parent }),
    ...(links.length === 0 ? {} : { links }),
  }
}
import { type WaitRow } from "./table.ts"
import {
  DurableWaitRowLookup,
  DurableWaitRows,
  DurableWaitRowUpsert,
} from "./durable-wait-store.ts"
import { emitSpanEvent, waitRowId } from "./span-events.ts"
import { evaluateFieldEquals, type FieldEqualsTrigger } from "./types.ts"
import { matchDeferredFor } from "./wait-for.ts"

const durableWaitBucketAttribute = {
  "firegrid.wait.bucket": "durable",
} as const

/**
 * firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
 *
 * The non-After `AgentOutput` variant carries no contextId on the
 * source itself — the SDD model is "source selects the stream, the
 * `FieldEqualsTrigger` value decides which rows match", and every
 * supported `AgentOutput` wait scopes itself with a `contextId`
 * predicate (the agent-tool schema example, the workflow callers, and
 * the per-context reshape all assume it). Post-#315 there is no
 * host-wide output stream, so the router resolves the per-context
 * output stream by this predicate. Absence is handled by the
 * fail-fast guard at the `wait_for` tool boundary
 * (`tool-use-to-effect.ts`), not here.
 */
const contextIdFromTrigger = (
  trigger: FieldEqualsTrigger,
): Option.Option<string> => {
  const predicate = trigger.find(
    (candidate) =>
      candidate.path.length === 1 &&
      candidate.path[0] === "contextId" &&
      typeof candidate.equals === "string",
  )
  return predicate === undefined
    ? Option.none()
    : Option.some(predicate.equals as string)
}

/**
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.2
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.3
 *
 * Select the concrete runtime observation stream for a persisted typed
 * wait. Adding a variant is one `Match.tag` arm plus one
 * `RuntimeWaitStreams` field. `AgentOutput` is routed to the
 * per-context output stream selected by the wait trigger's contextId
 * predicate (see `contextIdFromTrigger`); the trigger still does the
 * final row matching in `completeMatch`.
 */
const streamForWait = (
  wait: WaitRow,
): Effect.Effect<
  Stream.Stream<unknown, unknown>,
  never,
  RuntimeWaitStreams
> =>
  Effect.map(RuntimeWaitStreams, (streams) =>
    Match.value(wait.source).pipe(
      Match.tag("AgentOutput", () =>
        Option.match(contextIdFromTrigger(wait.trigger), {
          // Degenerate: a contextId-less AgentOutput wait. The tool
          // boundary rejects this shape; internal callers always scope
          // by contextId. Fall back to the (post-#315 empty,
          // documented) host-wide stream rather than guess a context.
          onNone: () => streams.agentOutput,
          onSome: contextId => streams.agentOutputForContext(contextId),
        })),
      Match.tag("AgentOutputAfter", source => streams.agentOutputAfter(source)),
      Match.tag("RuntimeRun", () => streams.runtimeRun),
      // firegrid-typed-wait-source-redesign.CONTEXT.3 — caller-owned fact
      // stream selected by app-chosen name; the trigger still does final
      // row matching in `completeMatch`.
      Match.tag("CallerFact", source => streams.callerFact(source.stream)),
      Match.exhaustive,
    )).pipe(
      Effect.withSpan("firegrid.durable_tools.wait_router.stream_for_wait", {
        kind: "internal",
        attributes: {
          ...durableWaitBucketAttribute,
          ...waitSpanAttributes(wait),
        },
      }),
    )

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

    const matched = evaluateFieldEquals(wait.trigger, row)
    yield* Effect.annotateCurrentSpan({
      "firegrid.wait.trigger_matched": matched,
    })
    if (!matched) return

    const completedAtMs = yield* Clock.currentTimeMillis
    // firegrid-durable-tools.WAIT_FOR.7
    //
    // ORDER IS LOAD-BEARING. `engine.deferredDone` must fire BEFORE the
    // `status: "completed"` write. This guarantees the invariant
    //   status === "completed"  ⟹  deferredDone has already fired.
    //
    // Shape C: there is no completion-row write between these two; the
    // race-vs-timeout arbitration is the `DurableDeferred.raceAll` race
    // deferred in `wait-for.ts` (idempotent first-writer-wins, finding #1
    // of the convergence doc). If a crash lands between this `deferredDone`
    // and the status flip, on restart the wait row is still `active`,
    // the router re-attaches it, the durable source replays via
    // includeInitialState, `completeMatch` re-derives the deterministic
    // match, and idempotent `deferredDone` makes the re-fire a no-op.
    // See docs/research/durable-tools-vs-workflow-engine-convergence.md
    // and test/workflow-engine/deferred-done-idempotency.test.ts.
    yield* engine.deferredDone(
      matchDeferredFor(wait.deferredName),
      {
        workflowName: wait.workflowName,
        executionId: wait.executionId,
        deferredName: wait.deferredName,
        exit: Exit.succeed(row),
      },
    )
    yield* waitUpsert.upsert({
      ...current.value,
      status: "completed",
    })
    const resumeAttributes = {
      "firegrid.workflow.execution_id": wait.waitKey.executionId,
      "firegrid.wait.name": wait.waitKey.name,
      "firegrid.wait.row_id": waitRowId(wait.waitKey),
      "firegrid.wait.source": wait.source._tag,
      "firegrid.wait.elapsed_ms": Math.max(0, completedAtMs - current.value.createdAtMs),
    }
    yield* emitSpanEvent("wait.satisfied", resumeAttributes)
    // SDD_FIREGRID_AGENT_BODY_PLAN §Slice E (acceptance criterion 7):
    // Canonical Fireline record `fireline.agent.resumed` is emitted
    // additively alongside the substrate-shaped `wait.satisfied` event.
    // Both names carry the same payload; consumers may migrate to the
    // canonical name without losing the substrate name.
    yield* emitSpanEvent("fireline.agent.resumed", {
      ...resumeAttributes,
      "firegrid.fireline.operation": "wait_for",
    })
  }).pipe(
    Effect.withSpan("firegrid.durable_tools.wait_router.complete_match", {
      // kind = "consumer": this span is woken by a row arriving from a
      // durable-stream producer (the wait's source). The `parent` from
      // completeMatchSpanOptions makes the producer's span the trace parent;
      // the wait-registrar (a separate causal predecessor) rides as a
      // span link, not a parent.
      kind: "consumer",
      attributes: {
        ...durableWaitBucketAttribute,
        ...waitSpanAttributes(wait),
      },
      ...completeMatchSpanOptions(wait, row),
    }),
  )

/**
 * firegrid-durable-tools.SUBSCRIPTION.1/2
 *
 * Attach a single subscription per (waitKey, source) to the typed runtime
 * stream selected for the wait. The stream is the canonical
 * includeInitialState observation — the router does not perform any prior
 * snapshot read.
 */
// tf-gc7 leaf fix: this function previously wrapped both `source.pipe(...)`
// and the outer gen in `Effect.withSpan("...attach_source", ...)` +
// `Effect.withSpan("...attach_wait", ...)`. Both spans were per-wait and
// long-lived (lifetime = the wait's subscription, which for in-flight waits
// stays open until host scope close). Those spans were the orphan-parent
// shape `wait_router.complete_match` referenced through ambient context when
// the wait outlived the trace's batch-export window — measured 113/125
// (90.4%) orphan parents on the `wait-pre-attach-roundtrip` reproducer.
//
// Each `completeMatch` invocation has its own short-lived
// `Effect.withSpan("...complete_match", { kind: "consumer", parent: ... })`
// in this file; removing the long-lived wrappers shifts complete_match's
// ambient parent up to `wait_router.start` (a one-shot bootstrap span that
// closes once the router forks its main loop — short-lived, exports
// cleanly). The router's registration-replay role (docs/research/durable-
// tools-vs-workflow-engine-convergence.md lines 54-59) is preserved — only
// the observability wrappers go away.
const attachWaitToSource = (
  wait: WaitRow,
  source: Stream.Stream<unknown, unknown>,
  waitLookup: DurableWaitRowLookup["Type"],
  waitUpsert: DurableWaitRowUpsert["Type"],
  engine: WorkflowEngine.WorkflowEngine["Type"],
) =>
  source.pipe(
    Stream.runForEach((row) => {
      return completeMatch(
        wait,
        row,
        waitLookup,
        waitUpsert,
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

  // firegrid-durable-tools.WAIT_FOR.7
  //
  // No crash-recovery reconciler pass. With the completeMatch reorder
  // (deferredDone before the status flip), the completed-but-not-notified
  // gap is unreachable; the remaining still-active-with-completion gap is
  // covered by the live-replay path (active waits are re-attached below,
  // the durable source replays via includeInitialState, completeMatch
  // re-derives the match, idempotent deferredDone makes the re-fire a
  // no-op). See docs/research/durable-tools-vs-workflow-engine-convergence.md.

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
        engine,
      )
    }).pipe(
      Effect.withSpan("firegrid.durable_tools.wait_router.initial_check", {
        kind: "internal",
        attributes: {
          ...durableWaitBucketAttribute,
          ...waitSpanAttributes(wait),
        },
      }),
    )

  // firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.8
  //
  // tf-gc7 leaf fix: this pipe previously started with
  // `Stream.withSpan("...active_wait_rows", ...)`. That span was the
  // outer-router subscription wrapper and was long-lived for the host
  // scope (the router's main loop never naturally completes — it's
  // `Effect.forkScoped`-d at the bottom). Removing it lets the forked
  // fiber inherit ambient from `wait_router.start` (short-lived bootstrap),
  // not from a host-lifetime parent that won't export until shutdown.
  yield* waitRows.pipe(
    Stream.filter(wait => wait.status === "active"),
    Stream.runForEach((wait) =>
      Effect.gen(function*() {
        const encoded = encodeWaitKey(wait.waitKey)
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
            const source = yield* streamForWait(wait)
            yield* attachWaitToSource(
              wait,
              source,
              waitLookup,
              waitUpsert,
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
}).pipe(
  Effect.withSpan("firegrid.durable_tools.wait_router.start", {
    kind: "internal",
    attributes: durableWaitBucketAttribute,
  }),
)

type WaitRouterRequirements =
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

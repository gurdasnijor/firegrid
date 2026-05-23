// Wave C public start facade (#706 non-recursive split + #708 terminal-
// completion ordering).
//
// `startRuntime` and `RuntimeStartCapabilityLive` are the public host-sdk
// surfaces. After this cut they:
//
//   - dispatch start via `HostSessionsStartChannel.binding.call(...)` —
//     validated by #702, registered on `HostPlaneChannelRouter` pre-#703;
//   - observe terminal completion via
//     `SessionLifecycleChannel.forSession(sessionId).binding.stream`
//     filtered to `RuntimeRunEvent` status `exited` | `failed` — validated
//     by #708 as the durable settlement evidence; ingress route registered
//     on `HostPlaneChannelRouter` by this PR alongside the existing
//     factory-keyed session routes;
//   - DO NOT drive the workflow body. The body is driven server-side by
//     `RuntimeControlRequestSideEffectsLive.start` (reconciler-side
//     consumer of the `startRequests` row this facade writes), which
//     calls the private `runtimeContextHostStart` in
//     `./internal/runtime-context-host-start.ts`. The non-recursive split
//     is the #706 contract.
//
// #708 finding: `session.agent_output Terminated` is a codec-emitted
// observation that arrives BEFORE the body's lifecycle row settles. Using
// it as the public-turn completion signal races the durable runs.exited
// row AND breaks duplicate-prevention semantics on concurrent starts.
// `SessionLifecycleChannel` streams `RuntimeRunEvent` rows directly —
// by the time the terminal lifecycle row arrives, the body's full
// lifecycle write has settled, so callers can read runs.exited
// immediately after `startRuntime` returns.
//
// This file no longer imports the legacy body-driver symbols
// (`@firegrid/runtime/kernel`, `@effect/workflow`,
// `runtime-context-workflow-support`), and no host-sdk public/CLI/client
// caller transitively reaches them through `startRuntime` after this cut.
// The body-driver imports are relocated to
// `./internal/runtime-context-host-start.ts` with PARK notes tying their
// deletion to W-D-A body-driver retirement.

import {
  HostSessionsStartChannel,
  SessionLifecycleChannel,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  type HostSessionRow,
  RuntimeControlPlaneTable,
  type RuntimeRunEvent,
  RuntimeStartCapability,
  requireLocalContext,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  makeRuntimeIngressInputRow,
  makeRuntimeInputIntentRow,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/runtime-ingress"
import { Duration, Effect, Layer, Option, Stream } from "effect"
import { RuntimeContextRead } from "@firegrid/runtime/control-plane"
import {
  asRuntimeContextError,
  runtimeIngressError,
  type RuntimeContextError,
  type RuntimeIngressError,
} from "@firegrid/runtime/errors"
import type { StartRuntimeOptions, StartRuntimeResult } from "./types.ts"

type RuntimeIngressAppendEnvironment =
  | RuntimeContextRead
  | RuntimeControlPlaneTable

const runtimeControlPlaneTable: Effect.Effect<
  RuntimeControlPlaneTable["Type"],
  never,
  RuntimeControlPlaneTable
> = RuntimeControlPlaneTable

const insertRuntimeInputIntent = (
  request: RuntimeIngressRequest,
  control: RuntimeControlPlaneTable["Type"],
): Effect.Effect<RuntimeInputIntentRow, RuntimeIngressError> =>
  Effect.gen(function*() {
    const intent = makeRuntimeInputIntentRow(request)
    const stored = yield* control.inputIntents.insertOrGet(intent).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime input intent",
          request.contextId,
          request.inputId,
          cause,
        )),
    )
    return stored._tag === "Found" ? stored.row : intent
  })

// tf-2osu: bounded "context materialized" barrier for host ops that require a
// local context (startRuntime, appendRuntimeIngress).
const contextMaterializationTimeout = Duration.seconds(30)

const awaitContextMaterialized = (
  contextId: string,
): Effect.Effect<void, never, RuntimeControlPlaneTable> =>
  Effect.gen(function*() {
    const control = yield* runtimeControlPlaneTable
    yield* control.contexts.rows().pipe(
      Stream.filter(context => context.contextId === contextId),
      Stream.runHead,
      Effect.timeout(contextMaterializationTimeout),
      Effect.ignore,
    )
  })

const readRuntimeContextForIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<void, RuntimeIngressError, RuntimeContextRead> =>
  Effect.flatMap(RuntimeContextRead, (read) =>
    read.readContext(request.contextId).pipe(
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to resolve runtime context for ingress append",
          request.contextId,
          request.inputId,
          cause,
        )),
      Effect.asVoid,
    ))

const makePendingRuntimeIngressInput = (
  request: RuntimeIngressRequest,
  row: RuntimeInputIntentRow,
): RuntimeIngressInputRow =>
  makeRuntimeIngressInputRow(request, {
    inputId: row.intentId,
    createdAt: row.createdAt,
  })

// Inlined host-binding sanity check (replaces the kernel-barrel
// `requireLocalRuntimeContextWithHostSession`); the only place this file
// reads the context-row binding. Reads via the public `RuntimeContextRead`
// capability; verifies the host binding matches `CurrentHostSession`.
const requireLocalContextWithHostSession = (
  contextRead: RuntimeContextRead["Type"],
  hostSession: HostSessionRow,
  contextId: string,
): Effect.Effect<RuntimeContext, RuntimeContextError> =>
  contextRead.readContext(contextId).pipe(
    Effect.mapError((cause) =>
      asRuntimeContextError(
        "host.runtime_start_capability.read_context",
        "failed to read runtime context for host-binding check",
        contextId,
        cause,
      )),
    Effect.flatMap((maybeContext) =>
      Option.match(maybeContext, {
        onNone: (): Effect.Effect<RuntimeContext, RuntimeContextError> =>
          Effect.fail(
            asRuntimeContextError(
              "host.runtime_start_capability.read_context",
              `runtime context not found: ${contextId}`,
              contextId,
            ),
          ),
        onSome: (context): Effect.Effect<RuntimeContext, RuntimeContextError> =>
          context.host?.hostId === hostSession.hostId
            ? Effect.succeed(context)
            : Effect.fail(
              asRuntimeContextError(
                "host.runtime_start_capability.host_binding",
                `RuntimeContext ${contextId} is not bound to host ${hostSession.hostId}`,
                contextId,
              ),
            ),
      })),
  )

// Wave C terminal-completion observation via `SessionLifecycleChannel`
// (#708 GREEN). The lifecycle ingress streams `RuntimeRunEvent` rows for a
// given `sessionId`; we filter to terminal status (`exited` | `failed`)
// and take the first emission. By the time this row arrives, the body has
// settled the durable runs row — callers can read `runs.exited` /
// `runs.failed` immediately after `startRuntime` returns. The legacy
// `session.agent_output Terminated` settlement (codec-emitted before the
// body's lifecycle write) caused the duplicate-prevention + runs-row-
// timing regressions #708 resolved.
const waitForLifecycleSettlement = (
  lifecycleChannel: SessionLifecycleChannel["Type"],
  contextId: string,
) =>
  lifecycleChannel.forSession(contextId).binding.stream.pipe(
    Stream.filter((event) =>
      event.status === "exited" || event.status === "failed",
    ),
    Stream.runHead,
  )

// Shared channel-call + lifecycle-wait composition used by both the
// public `startRuntime` and the deferred-start `RuntimeStartCapabilityLive`
// closure. Extracted to keep both surfaces routed through identical
// composition (no lint:dup clone).
const dispatchStartAndAwaitSettlement = (
  contextId: string,
  startChannel: HostSessionsStartChannel["Type"],
  lifecycleChannel: SessionLifecycleChannel["Type"],
) =>
  Effect.gen(function* () {
    yield* startChannel.binding.call({ sessionId: contextId })
    const settled = yield* waitForLifecycleSettlement(lifecycleChannel, contextId)
    return yield* startRuntimeResultFromLifecycle(contextId, settled)
  })

const startRuntimeResultFromLifecycle = (
  contextId: string,
  settled: Option.Option<RuntimeRunEvent>,
): Effect.Effect<StartRuntimeResult, RuntimeContextError> =>
  Option.match(settled, {
    onNone: (): Effect.Effect<StartRuntimeResult, RuntimeContextError> =>
      Effect.fail(
        asRuntimeContextError(
          "host.runtime_context.start.lifecycle_stream_ended",
          "session.lifecycle stream ended before a terminal RuntimeRunEvent arrived",
          contextId,
        ),
      ),
    onSome: (event): Effect.Effect<StartRuntimeResult, RuntimeContextError> => {
      if (event.status === "failed") {
        return Effect.fail(
          asRuntimeContextError(
            "host.runtime_context.start.runs_failed",
            event.message ?? "runtime context terminated with failure status",
            contextId,
          ),
        )
      }
      return Effect.succeed({
        contextId,
        activityAttempt: event.activityAttempt,
        exitCode: event.exitCode ?? 0,
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      })
    },
  })

/**
 * Public host-sdk runtime turn entry. After the W-C cutover this:
 *
 *   - dispatches the start request via `HostSessionsStartChannel.binding.call(...)`
 *     (writes the durable `startRequests` row keyed by deterministic
 *     `runtimeStartRequestId(contextId)` — concurrent starts collapse to a
 *     single row via `insertOrGet`);
 *   - waits for terminal settlement on
 *     `SessionLifecycleChannel.forSession(contextId).binding.stream`,
 *     filtered to `RuntimeRunEvent` status `exited` | `failed` (#708 GREEN).
 *     By the time the terminal lifecycle row arrives, the body's durable
 *     `runs` write has settled — callers can read `runs.exited` /
 *     `runs.failed` immediately after `startRuntime` returns.
 *
 * The body executes server-side, driven by
 * `RuntimeControlRequestSideEffectsLive.start` → `runtimeContextHostStart`
 * (private internal primitive in `./internal/runtime-context-host-start.ts`).
 * Non-idempotent dedup of the body invocation is enforced by a first-
 * writer-wins claim on the durable `controlRequestClaims` table inside
 * `runStartRequestSideEffect` (#709), so two parallel public starts always
 * produce exactly one body invocation regardless of how many engine
 * instances observe the start row.
 */
export const startRuntime = (
  options: StartRuntimeOptions,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4
  // firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
  // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
  Effect.gen(function* () {
    yield* awaitContextMaterialized(options.contextId)
    yield* requireLocalContext(options.contextId)

    const startChannel = yield* HostSessionsStartChannel
    const lifecycleChannel = yield* SessionLifecycleChannel

    return yield* dispatchStartAndAwaitSettlement(
      options.contextId,
      startChannel,
      lifecycleChannel,
    )
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.start", {
      kind: "server",
      attributes: {
        "firegrid.context.id": options.contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

/**
 * `RuntimeStartCapability` Live layer for the deferred-start seam. Uses
 * the same channel pair as `startRuntime`. Captures the host substrate
 * context once at Layer-build time so the deferred `start` closure can
 * re-provide it per call.
 */
export const RuntimeStartCapabilityLive = Layer.effect(
  RuntimeStartCapability,
  Effect.gen(function* () {
    const captured = yield* Effect.context<
      | RuntimeControlPlaneTable
      | RuntimeContextRead
      | CurrentHostSession
      | HostSessionsStartChannel
      | SessionLifecycleChannel
    >()
    const contextRead = yield* RuntimeContextRead
    const hostSession = yield* CurrentHostSession
    const startChannel = yield* HostSessionsStartChannel
    const lifecycleChannel = yield* SessionLifecycleChannel
    return RuntimeStartCapability.of({
      start: (options) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "firegrid.context.id": options.contextId,
          })
          yield* requireLocalContextWithHostSession(
            contextRead,
            hostSession,
            options.contextId,
          )
          return yield* dispatchStartAndAwaitSettlement(
            options.contextId,
            startChannel,
            lifecycleChannel,
          )
        }).pipe(
          Effect.provide(captured),
          Effect.withSpan("firegrid.host.runtime_start_capability.start", {
            kind: "server",
            attributes: {
              "firegrid.context.id": options.contextId,
            },
          }),
          Effect.annotateSpans("firegrid.side", "host"),
        ),
    })
  }),
)

export const appendRuntimeIngress = (
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError, RuntimeIngressAppendEnvironment> =>
  awaitContextMaterialized(request.contextId).pipe(
    Effect.zipRight(readRuntimeContextForIngress(request)),
    Effect.zipRight(runtimeControlPlaneTable),
    Effect.flatMap(control => insertRuntimeInputIntent(request, control)),
    Effect.map(row => makePendingRuntimeIngressInput(request, row)),
  )

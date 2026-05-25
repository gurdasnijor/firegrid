// Public host-composition channel facade. Relocated from the deleted
// host-sdk paths `host-sdk/src/host/commands.ts` (Class A: startRuntime,
// appendRuntimeIngress, RuntimeStartCapabilityLive) and `host-sdk/src/
// host/types.ts` (StartRuntimeOptions, StartRuntimeResult,
// RuntimeHostTopologyOptions). Single channel-facade-pure module the
// outer composition (`host-live.ts`) and bin scripts consume.
//
// Wave C public start facade contract (#706 non-recursive split + #708
// terminal-completion ordering) preserved verbatim:
//
//   - `startRuntime` dispatches via `HostSessionsStartChannel.binding.call(...)`
//     and waits on `SessionLifecycleChannel.forSession(contextId).binding.stream`
//     filtered to `RuntimeRunEvent` terminal status.
//   - `RuntimeStartCapabilityLive` is the deferred-start Live for the same
//     channel pair, capturing host context once at Layer-build time.
//   - `appendRuntimeIngress` writes the input-intent row directly via
//     `RuntimeControlPlaneTable.inputIntents.insertOrGet`.
//
// No `@effect/workflow` import. No host-sdk-internal imports. Reachable
// via `@firegrid/runtime/composition/host-public`.

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
import type { DurableTableHeaders } from "effect-durable-operators"
import type { ChannelRegistration } from "@firegrid/protocol/channels"
import type { AcpPermissionPolicy } from "@firegrid/protocol/acp"
import { RuntimeContextRead } from "../tables/runtime-control-plane.ts"
import {
  asRuntimeContextError,
  runtimeIngressError,
  type RuntimeContextError,
  type RuntimeIngressError,
} from "../runtime-errors.ts"
import type {
  LocalProcessSandboxProviderOptions,
} from "../producers/sandbox/index.ts"

// ---- types.ts content (relocated) -----------------------------------

export interface StartRuntimeOptions {
  readonly contextId: string
}

export interface StartRuntimeResult {
  readonly contextId: string
  readonly activityAttempt: number
  readonly exitCode: number
  readonly signal?: string
}

export interface RuntimeHostTopologyOptions {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
  //
  // Stable host identity is required at the programmatic composition
  // boundary. Direct callers of FiregridRuntimeHostLive supply
  // `hostId` explicitly; `FiregridLocalHostLive` derives it
  // deterministically from the namespace. The runtime host does NOT
  // acquire identity from env or disk — a missing hostId is a
  // type-level mistake.
  readonly hostId: string
  // Per-process session identifier. When omitted, the layer assigns
  // a fresh value; durable identity remains hostId.
  readonly hostSessionId?: string
  readonly headers?: DurableTableHeaders
  readonly input?: boolean
  readonly localProcessEnv?: LocalProcessSandboxProviderOptions
  readonly controlRequestReconciler?: boolean
  /** Runtime-context MCP edge string lookup catalog. Not an app-facing registry. */
  readonly mcpChannels?: ReadonlyArray<ChannelRegistration>
  /**
   * Host-plane policy for ACP runtime sessions started by this host. Defaults
   * to the ACP codec's safe `forward` behavior when omitted.
   */
  readonly runtimeContextAcpPermissionPolicy?: AcpPermissionPolicy
}

// ---- commands.ts content (relocated) --------------------------------

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

export const startRuntime = (
  options: StartRuntimeOptions,
) =>
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

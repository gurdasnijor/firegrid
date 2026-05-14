// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4
//
// Host/context Effect-scoped identity and the thin domain operators
// that bind RuntimeContext rows to a host. Re-exported as a single
// surface from this module, but deliberately a set of small
// operators rather than one HostContextAuthority service: there is no
// pass-through repository over `RuntimeControlPlaneTable`.

import {
  HostIdSchema,
  RuntimeControlPlaneTable,
  hostStreamName,
  makeRuntimeContext,
  namespaceRuntimeStreamName,
  type HostSessionRow,
  type HostStreamPrefix,
  type HostStreamSegment,
  type RuntimeContext,
  type RuntimeContextHostBinding,
  type RuntimeContextIntent,
} from "@firegrid/protocol/launch"
import { Clock, Context, Effect, Option, Schema } from "effect"

/**
 * Current host session identity for the host scope.
 *
 * Required `Context.Tag` (no undefined default): code that needs the
 * host session must run inside a scope that provides
 * `CurrentHostSession`. Long-lived host-owned layers — workflow
 * engine, host ingress, host output, durable-tools — read this tag
 * once at acquisition time and derive their backing streams from
 * `session.streamPrefix`.
 *
 * firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
 * firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
 */
export class CurrentHostSession extends Context.Tag(
  "@firegrid/runtime/CurrentHostSession",
)<CurrentHostSession, HostSessionRow>() {}

/**
 * Current runtime context for the request/workflow fiber scope.
 *
 * Required `Context.Tag` (no undefined default). Context-routed
 * services either read this tag at method time or build a fresh
 * per-context layer inside the localized scope. The proposal
 * explicitly forbids capturing a `RuntimeContext` in a shared layer
 * memoized across contexts.
 *
 * firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
 * firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3
 */
export class CurrentRuntimeContext extends Context.Tag(
  "@firegrid/runtime/CurrentRuntimeContext",
)<CurrentRuntimeContext, RuntimeContext>() {}

/**
 * Context authority errors.
 *
 * firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4
 *
 * Schema-tagged so call sites construct canonical tagged errors via
 * `new ContextNotLocal({...})` rather than hand-writing payload objects.
 */
export class ContextNotFound extends Schema.TaggedError<ContextNotFound>()(
  "ContextNotFound",
  {
    contextId: Schema.String,
  },
) {}

export class ContextNotLocal extends Schema.TaggedError<ContextNotLocal>()(
  "ContextNotLocal",
  {
    contextId: Schema.String,
    hostId: HostIdSchema,
    currentHostId: HostIdSchema,
  },
) {}

export class CurrentHostStopped extends Schema.TaggedError<CurrentHostStopped>()(
  "CurrentHostStopped",
  {
    hostId: HostIdSchema,
  },
) {}

/**
 * Resolve a RuntimeContext by id. Fails with `ContextNotFound` for
 * missing contexts. Does NOT require the context to be local — prompt
 * append routes through this operator so it can write durable ingress
 * for a context bound to another host.
 *
 * firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
 */
export const findRuntimeContext = (contextId: string) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const maybe = yield* table.contexts.get(contextId)
    return yield* Option.match(maybe, {
      onNone: () => Effect.fail(new ContextNotFound({ contextId })),
      onSome: Effect.succeed,
    })
  })

const hostBindingFromSession = (
  session: HostSessionRow,
  boundAtMs: number,
): RuntimeContextHostBinding => ({
  hostId: session.hostId,
  streamPrefix: session.streamPrefix,
  boundAtMs,
})

/**
 * Insert a host-bound RuntimeContext row.
 *
 * Reads `CurrentHostSession` to fill the host binding, samples the
 * Effect `Clock` for `boundAtMs`, then upserts the row through the
 * normal `RuntimeControlPlaneTable.contexts` action. The Clock
 * dependency is the standard Effect test-time dependency for
 * deterministic timestamps; it is NOT a Firegrid authority service.
 *
 * Idempotent on `contextId`: an `upsert` matches the proposal's
 * behavior of letting the caller treat fresh-ctx generation as their
 * own concern while keeping the operator transactional with respect
 * to the host binding.
 *
 * firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
 * firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
 */
export const insertLocalRuntimeContext = (
  intent: RuntimeContextIntent,
  options: {
    readonly contextId: string
    readonly createdBy?: string
  },
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const session = yield* CurrentHostSession
    if (session.status !== "running") {
      return yield* Effect.fail(new CurrentHostStopped({ hostId: session.hostId }))
    }
    const createdAtMs = yield* Clock.currentTimeMillis
    const context = makeRuntimeContext({
      contextId: options.contextId,
      createdAtMs,
      ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
      runtime: intent,
      host: hostBindingFromSession(session, createdAtMs),
    })
    yield* table.contexts.upsert(context)
    return context
  })

/**
 * Resolve a RuntimeContext and require its host binding to name the
 * `CurrentHostSession`. Fails with `ContextNotLocal` before any local
 * host services are exposed when the context belongs to another host.
 *
 * firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
 */
export const requireLocalContext = (contextId: string) =>
  Effect.gen(function* () {
    const session = yield* CurrentHostSession
    const context = yield* findRuntimeContext(contextId)
    if (context.host.hostId !== session.hostId) {
      return yield* Effect.fail(
        new ContextNotLocal({
          contextId,
          hostId: context.host.hostId,
          currentHostId: session.hostId,
        }),
      )
    }
    return context
  })

/**
 * Provide a resolved RuntimeContext through `CurrentRuntimeContext`
 * for the rest of the fiber. Callers compose:
 *
 *   yield* program.pipe(provideRuntimeContext(runtimeContext))
 *
 * rather than threading the context value through every host-owned
 * layer constructor.
 *
 * firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
 */
export const provideRuntimeContext =
  (runtimeContext: RuntimeContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CurrentRuntimeContext, runtimeContext))

/**
 * Compose a Durable Streams URL for a stream name under the configured
 * base URL. The base URL may already include `/v1/stream/`; if it
 * does not, the conventional Electric Cloud path is appended. The
 * `streamName` argument MUST come from a sanctioned authority helper
 * (`namespaceRuntimeStreamName`, `hostStreamName`) — not from an
 * inline template literal at the call site.
 *
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
 */
export const durableStreamUrl = (
  baseUrl: string,
  streamName: string,
): string => {
  const trimmed = baseUrl.replace(/\/+$/, "")
  const prefix = trimmed.includes("/v1/stream/")
    ? `${trimmed}/`
    : `${trimmed}/v1/stream/`
  return `${prefix}${encodeURIComponent(streamName)}`
}

/**
 * Convenience accessor: the namespace-scoped runtime control-plane
 * stream URL (where the RuntimeContext index lives).
 *
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
 */
export const runtimeControlPlaneStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}): string =>
  durableStreamUrl(input.baseUrl, namespaceRuntimeStreamName(input.namespace))

/**
 * Convenience accessor: a host-owned operational stream URL derived
 * from the host's schema-encoded stream prefix.
 *
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
 * firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
 */
export const hostOwnedStreamUrl = (input: {
  readonly baseUrl: string
  readonly prefix: HostStreamPrefix
  readonly segment: HostStreamSegment
}): string =>
  durableStreamUrl(input.baseUrl, hostStreamName(input.prefix, input.segment))

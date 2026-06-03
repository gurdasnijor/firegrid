// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4
//
// Host/context Effect-scoped identity and the thin domain operators
// that bind RuntimeContext rows to a host. Lives in @firegrid/protocol
// so the public client (@firegrid/client) can resolve host authority
// without taking a runtime dependency on @firegrid/runtime.

import type { DurableTableError } from "effect-durable-operators"
import { Clock, Context, Effect, Option, Schema } from "effect"
import {
  HostIdSchema,
  type HostSessionRow,
  type RuntimeContextHostBinding,
} from "./authority.ts"
import { makeRuntimeContext, type RuntimeContext, type RuntimeContextIntent } from "./schema.ts"
import { RuntimeControlPlaneTable } from "./table.ts"

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
  "@firegrid/protocol/CurrentHostSession",
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
  "@firegrid/protocol/CurrentRuntimeContext",
)<CurrentRuntimeContext, RuntimeContext>() {}

const runtimeControlPlaneTable: Effect.Effect<
  RuntimeControlPlaneTable["Type"],
  never,
  RuntimeControlPlaneTable
> = RuntimeControlPlaneTable

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
export const findRuntimeContext = (
  contextId: string,
): Effect.Effect<RuntimeContext, ContextNotFound | DurableTableError, RuntimeControlPlaneTable> =>
  Effect.gen(function* () {
    const table = yield* runtimeControlPlaneTable
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

export const makeLocalRuntimeContextForHostSession = (
  session: HostSessionRow,
  intent: RuntimeContextIntent,
  options: {
    readonly contextId: string
    readonly createdAtMs: number
    readonly createdBy?: string
    readonly parentContextId?: string
  },
) =>
  Effect.gen(function* () {
    if (session.status !== "running") {
      return yield* new CurrentHostStopped({ hostId: session.hostId })
    }
    return makeRuntimeContext({
      contextId: options.contextId,
      createdAtMs: options.createdAtMs,
      ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
      ...(options.parentContextId === undefined ? {} : { parentContextId: options.parentContextId }),
      runtime: intent,
      host: hostBindingFromSession(session, options.createdAtMs),
    })
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
 *
 * @deprecated firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.3-2
 */
export const insertLocalRuntimeContext = (
  intent: RuntimeContextIntent,
  options: {
    readonly contextId: string
    readonly createdBy?: string
    readonly parentContextId?: string
  },
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const session = yield* CurrentHostSession
    const createdAtMs = yield* Clock.currentTimeMillis
    const context = yield* makeLocalRuntimeContextForHostSession(session, intent, {
      ...options,
      createdAtMs,
    })
    yield* table.contexts.upsert(context)
    return context
  })

// Durable stream URL composition (`durableStreamUrl`,
// `runtimeControlPlaneStreamUrl`, `hostOwnedStreamUrl`) lives in
// `./authority.ts` next to the canonical `DurableStreamUrlSchema` and
// related authority schemas. The single source of serialization
// means the public client (`@firegrid/client`) and the runtime host
// import from one place.

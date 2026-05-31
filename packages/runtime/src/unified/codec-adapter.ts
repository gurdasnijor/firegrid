/**
 * Production codec adapter — wraps `sources/codecs/{acp,stdio-jsonl}`
 * behind the `RuntimeContextSessionAdapter` Tag.
 *
 * Phase E of SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING. The adapter:
 *
 *   1. Maintains a host-process-level registry of `contextId → live
 *      AgentSession + per-context Scope`. The same `claude-agent-acp`
 *      process serves many inputs across attempts; the registry is
 *      the cross-attempt continuity.
 *   2. On `startOrAttach(contextId, attempt)`: if not in registry,
 *      resolve the context (via the supplied `ContextResolver` Tag,
 *      which can read from `RuntimeControlPlaneTable.contexts` in
 *      production), create a sandbox via `SandboxProvider`, open the
 *      byte pipe, build an `AgentSession` (ACP or stdio-jsonl based on
 *      `agentProtocol`), fork a daemon draining `session.outputs` into
 *      `RuntimeOutputTable.events`. Store in registry.
 *   3. On `send(contextId, attempt, input)`: look up the session,
 *      decode `payloadJson` to an `AgentInputEvent` based on `kind`,
 *      forward via `session.send`.
 *   4. On `deregister(contextId)`: close the per-context Scope (kills
 *      the process, closes the codec session, stops the output drain),
 *      remove from registry.
 *
 * Context resolution is parameterized via the `ContextResolver` Tag so
 * this module does not depend on RuntimeControlPlaneTable directly —
 * production hosts compose the table-backed resolver
 * (`ContextResolverFromControlPlaneTableLive`); tests can provide a
 * static-map resolver.
 *
 * STATUS: structural scaffolding. The adapter Live builds; the
 * dependencies (`SandboxProvider`, `IdGenerator.IdGenerator`,
 * `RuntimeOutputTable`, `ContextResolverTag`) must all be supplied at
 * Layer build time. Production hosts that want this adapter compose
 * it explicitly into `FiregridHost.options.adapter`.
 */

import { IdGenerator } from "@effect/ai"
import {
  RuntimeOutputTable,
  type RuntimeContext,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import { encodeRuntimeAgentOutputEnvelope } from "@firegrid/protocol/session-facade"
import { Context, Effect, Exit, ExecutionStrategy, Layer, Option, Ref, Scope, Stream } from "effect"
import type {
  AgentInputEvent,
  AgentOutputEvent,
} from "../events/contract.ts"
import { AcpSessionLive } from "../sources/codecs/acp/index.ts"
import { StdioJsonlSessionLive } from "../sources/codecs/stdio-jsonl/index.ts"
import {
  AgentSession,
  type AgentSessionService,
  type AgentCodecError,
} from "../sources/codecs/contract.ts"
import {
  SandboxProvider,
  type Sandbox,
  type SandboxProviderError,
} from "../sources/sandbox/SandboxProvider.ts"
import {
  RuntimeContextSessionAdapter,
  type RuntimeContextSessionAdapterService,
  AdapterError,
  type SessionInputPayload,
} from "./adapter.ts"

// ── Context resolution seam ────────────────────────────────────────────────

export interface ContextResolver {
  readonly resolve: (
    contextId: string,
  ) => Effect.Effect<Option.Option<RuntimeContext>, never>
}

export class ContextResolverTag extends Context.Tag(
  "@firegrid/runtime/unified/ContextResolver",
)<ContextResolverTag, ContextResolver>() {}

// ── Per-context registry entry ─────────────────────────────────────────────

interface RegistryEntry {
  readonly session: AgentSessionService
  readonly scope: Scope.CloseableScope
  readonly attempt: number
  readonly sequenceRef: Ref.Ref<number>
}

// ── Input decoding ─────────────────────────────────────────────────────────
//
// Channel bindings (host-side) Schema-encode typed AgentInputEvents into the
// `payloadJson` field. The adapter decodes them here. `kind` filters which
// envelopes reach the codec (terminal short-circuits inside the workflow body;
// peer-event / scheduled-fire are body-level concerns and don't go to codec).

const decodeAgentInputEvent = (
  input: SessionInputPayload,
): Option.Option<AgentInputEvent> => {
  if (input.kind === "terminal" || input.kind === "peer-event" || input.kind === "scheduled-fire") {
    return Option.none()
  }
  try {
    return Option.some(JSON.parse(input.payloadJson) as AgentInputEvent)
  } catch {
    return Option.none()
  }
}

// ── Output pump ────────────────────────────────────────────────────────────

const drainOutputsToJournal = (
  table: RuntimeOutputTable["Type"],
  contextId: string,
  attempt: number,
  sequenceRef: Ref.Ref<number>,
  outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>,
): Effect.Effect<void, never, Scope.Scope> =>
  outputs.pipe(
    Stream.tap((event) =>
      Effect.gen(function*() {
        const sequence = yield* Ref.modify(sequenceRef, (n) => [n, n + 1])
        const receivedAt = new Date().toISOString()
        yield* table.events.insertOrGet({
          eventId: { contextId, activityAttempt: attempt, target: "events", sequence },
          contextId,
          activityAttempt: attempt,
          sequence,
          source: "stdout",
          format: "jsonl",
          receivedAt,
          raw: encodeRuntimeAgentOutputEnvelope(event),
        }).pipe(Effect.orDie, Effect.asVoid)
      }),
    ),
    Stream.runDrain,
    Effect.forkScoped,
    Effect.asVoid,
  )

// ── Sandbox config + command derivation ────────────────────────────────────

const sandboxConfigForContext = (
  context: RuntimeContext,
): {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string | undefined
} => ({
  argv: context.runtime.config.argv,
  cwd: context.runtime.config.cwd,
})

// Env binding resolution is deferred. `RuntimeEnvBinding` carries
// `{name, ref}` where `ref` points to a secret resolver (Vault, KMS,
// etc.). Production hosts compose a secrets-resolving Layer ahead of
// this adapter; the resolved `envVars: Record<string,string>` enters
// the sandbox provider's command. For now, env bindings are left
// unresolved — the sandbox runs with the host process's env.

// ── The adapter Live ───────────────────────────────────────────────────────

const adapterError = (
  op: "startOrAttach" | "send" | "deregister",
  contextId: string,
  message: string,
  cause?: unknown,
): AdapterError =>
  new AdapterError({
    op,
    contextId,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const buildSessionForContext = (
  hostScope: Scope.Scope,
  context: RuntimeContext,
  attempt: number,
  table: RuntimeOutputTable["Type"],
  sandboxProvider: SandboxProvider["Type"],
  idGenerator: IdGenerator.IdGenerator["Type"],
): Effect.Effect<RegistryEntry, AdapterError> =>
  Effect.gen(function*() {
    const contextId = context.contextId
    const ctxScope = yield* Scope.fork(hostScope, ExecutionStrategy.sequential)

    const { argv, cwd } = sandboxConfigForContext(context)
    const sandbox: Sandbox = yield* sandboxProvider.create({
      ...(cwd === undefined ? {} : { workingDir: cwd }),
    }).pipe(
      Effect.mapError((cause: SandboxProviderError) =>
        adapterError("startOrAttach", contextId, "sandbox create failed", cause),
      ),
    )
    const byteStream = yield* sandboxProvider.openBytePipe(sandbox, {
      argv,
      ...(cwd === undefined ? {} : { cwd }),
    }).pipe(
      Scope.extend(ctxScope),
      Effect.mapError((cause: SandboxProviderError) =>
        adapterError("startOrAttach", contextId, "openBytePipe failed", cause),
      ),
    )

    const codecLayer = context.runtime.config.agentProtocol === "raw"
      ? StdioJsonlSessionLive(byteStream)
      : AcpSessionLive(byteStream)

    const session: AgentSessionService = yield* Effect.scoped(
      Effect.provide(AgentSession, codecLayer).pipe(
        Effect.provideService(IdGenerator.IdGenerator, idGenerator),
      ),
    ).pipe(
      Scope.extend(ctxScope),
      Effect.mapError((cause) =>
        adapterError("startOrAttach", contextId, "codec session build failed", cause),
      ),
    )

    const sequenceRef = yield* Ref.make(0)
    yield* drainOutputsToJournal(
      table, contextId, attempt, sequenceRef, session.outputs,
    ).pipe(Scope.extend(ctxScope))

    return { session, scope: ctxScope, attempt, sequenceRef }
  })

export const ProductionCodecAdapterLive = Layer.scoped(
  RuntimeContextSessionAdapter,
  Effect.gen(function*() {
    const hostScope = yield* Effect.scope
    const table = yield* RuntimeOutputTable
    const sandboxProvider = yield* SandboxProvider
    const idGenerator = yield* IdGenerator.IdGenerator
    const resolver = yield* ContextResolverTag

    const registry = yield* Ref.make<Map<string, RegistryEntry>>(new Map())

    const startOrAttach = (
      contextId: string,
      attempt: number,
    ): Effect.Effect<void, AdapterError> =>
      Effect.gen(function*() {
        const existing = yield* Ref.get(registry).pipe(
          Effect.map((m) => m.get(contextId)),
        )
        if (existing !== undefined) return

        const ctx = yield* resolver.resolve(contextId)
        if (Option.isNone(ctx)) {
          return yield* Effect.fail(
            adapterError("startOrAttach", contextId, "context not found"),
          )
        }
        const entry = yield* buildSessionForContext(
          hostScope, ctx.value, attempt, table, sandboxProvider, idGenerator,
        )
        yield* Ref.update(registry, (m) => {
          const next = new Map(m)
          next.set(contextId, entry)
          return next
        })
      }).pipe(
        Effect.withSpan("firegrid.unified.adapter.start_or_attach", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": contextId,
            "firegrid.unified.attempt": attempt,
            "firegrid.unified.adapter.kind": "production-codec",
          },
        }),
      )

    const send = (
      contextId: string,
      attempt: number,
      input: SessionInputPayload,
    ): Effect.Effect<void, AdapterError> =>
      Effect.gen(function*() {
        const entry = yield* Ref.get(registry).pipe(
          Effect.map((m) => m.get(contextId)),
        )
        if (entry === undefined) {
          return yield* Effect.fail(
            adapterError("send", contextId, "session not registered"),
          )
        }
        const maybeEvent = decodeAgentInputEvent(input)
        if (Option.isNone(maybeEvent)) return
        yield* entry.session.send(maybeEvent.value).pipe(
          Effect.mapError((cause) =>
            adapterError("send", contextId, "codec send failed", cause),
          ),
        )
      }).pipe(
        Effect.withSpan("firegrid.unified.adapter.send", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": contextId,
            "firegrid.unified.attempt": attempt,
            "firegrid.unified.input.kind": input.kind,
            "firegrid.unified.adapter.kind": "production-codec",
          },
        }),
      )

    const deregister = (
      contextId: string,
    ): Effect.Effect<void, AdapterError> =>
      Effect.gen(function*() {
        const entry = yield* Ref.get(registry).pipe(
          Effect.map((m) => m.get(contextId)),
        )
        if (entry === undefined) return
        yield* Scope.close(entry.scope, Exit.void)
        yield* Ref.update(registry, (m) => {
          const next = new Map(m)
          next.delete(contextId)
          return next
        })
      }).pipe(
        Effect.withSpan("firegrid.unified.adapter.deregister", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": contextId,
            "firegrid.unified.adapter.kind": "production-codec",
          },
        }),
      )

    return {
      startOrAttach,
      send,
      deregister,
    } satisfies RuntimeContextSessionAdapterService
  }),
)

// ── Convenience: resolver backed by RuntimeControlPlaneTable ───────────────

export const ContextResolverFromControlPlaneTableLive = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId) => control.contexts.get(contextId).pipe(Effect.orDie),
    }
  }),
)

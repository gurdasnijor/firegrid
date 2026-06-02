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
  firegridRuntimeContextMcpDeclaration,
  firegridRuntimeContextMcpName,
  type RuntimeContext,
  isMcpServerHeaderRef,
  type McpServerDeclaration,
} from "@firegrid/protocol/launch"
import { encodeRuntimeAgentOutputEnvelope } from "@firegrid/protocol/session-facade"
import { Context, Effect, Exit, ExecutionStrategy, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
  type AgentOutputEvent,
} from "../events/contract.ts"
import {
  AcpSessionLive,
  type AcpMcpServerDeclaration,
  type AcpSessionOptions,
} from "../sources/codecs/acp/index.ts"
import { StdioJsonlSessionLive } from "../sources/codecs/stdio-jsonl/index.ts"
import {
  AgentSession,
  type AgentSessionService,
  type AgentCodecError,
} from "../sources/codecs/contract.ts"
import {
  RuntimeEnvResolverPolicy,
  resolveSpawnEnvVars,
} from "../sources/sandbox/secrets.ts"
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
import {
  CodecOutputJournalTag,
  type CodecOutputJournal,
  ContextResolverTag,
} from "../tables/codec-adapter-tags.ts"
import {
  FiregridRuntimeContextMcpBaseUrl,
  type FiregridRuntimeContextMcpBaseUrlService,
  runtimeContextMcpUrlForContext,
} from "./mcp-host/runtime-context-mcp-base-url.ts"

export {
  CodecOutputJournalTag,
  type CodecOutputJournal,
  ContextResolverTag,
  type ContextResolver,
} from "../tables/codec-adapter-tags.ts"

// ── Per-context registry entry ─────────────────────────────────────────────

interface RegistryEntry {
  readonly session: AgentSessionService
  readonly scope: Scope.CloseableScope
  readonly attempt: number
  readonly sequenceRef: Ref.Ref<number>
}

const getRegistryEntry = (
  registry: Ref.Ref<Map<string, RegistryEntry>>,
  contextId: string,
) =>
  Ref.get(registry).pipe(
    Effect.map((sessions) => sessions.get(contextId)),
  )

// ── Input decoding ─────────────────────────────────────────────────────────
//
// Channel bindings (host-side) Schema-encode typed AgentInputEvents into the
// `payloadJson` field. The adapter decodes them here. `kind` filters which
// envelopes reach the codec (terminal short-circuits inside the workflow body;
// peer-event / scheduled-fire are body-level concerns and don't go to codec).

const decodeAgentInputEventFromUnknown = Schema.decodeUnknownEither(AgentInputEventSchema)

type DecodeOutcome =
  | { readonly _tag: "Skip" }
  | { readonly _tag: "Decoded"; readonly event: AgentInputEvent }
  | { readonly _tag: "MalformedJson" }
  | { readonly _tag: "SchemaReject"; readonly message: string }

const decodeAgentInputEvent = (input: SessionInputPayload): DecodeOutcome => {
  if (input.kind === "terminal" || input.kind === "peer-event" || input.kind === "scheduled-fire") {
    return { _tag: "Skip" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input.payloadJson)
  } catch {
    return { _tag: "MalformedJson" }
  }
  const decoded = decodeAgentInputEventFromUnknown(parsed)
  if (decoded._tag === "Right") return { _tag: "Decoded", event: decoded.right }
  return { _tag: "SchemaReject", message: decoded.left.message }
}

// ── Output pump ────────────────────────────────────────────────────────────

const drainOutputsToJournal = (
  journal: CodecOutputJournal,
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
        yield* journal.append({
          eventId: { contextId, activityAttempt: attempt, target: "events", sequence },
          contextId,
          activityAttempt: attempt,
          sequence,
          source: "stdout",
          format: "jsonl",
          receivedAt,
          raw: encodeRuntimeAgentOutputEnvelope(event),
        })
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

/**
 * Convert protocol-shaped `McpServerDeclaration[]` to the ACP codec's
 * `AcpMcpServerDeclaration[]` shape. The protocol allows header values
 * to be `{ref: "env:X"}` (secret references); these need separate
 * secret resolution before they can be passed to ACP, which expects
 * literal strings. For now we drop ref-typed headers — production
 * hosts that need refs should resolve them ahead and inject the
 * literal values via a host-side preprocessor. Logged via span
 * attribute when this happens so it's diagnosable from a trace.
 */
const mcpServersForAcp = (
  declarations: ReadonlyArray<McpServerDeclaration> | undefined,
): {
  readonly servers: ReadonlyArray<AcpMcpServerDeclaration>
  readonly droppedRefCount: number
} => {
  if (declarations === undefined || declarations.length === 0) {
    return { servers: [], droppedRefCount: 0 }
  }
  return declarations.reduce<{
    readonly servers: ReadonlyArray<AcpMcpServerDeclaration>
    readonly droppedRefCount: number
  }>((acc, decl) => {
    const headerEntries = Object.entries(decl.server.headers ?? {})
    const droppedRefCount = headerEntries.filter(([, value]) => isMcpServerHeaderRef(value)).length
    const headers = headerEntries.flatMap(([name, value]) =>
      typeof value === "string" ? [{ name, value }] : [])
    return {
      droppedRefCount: acc.droppedRefCount + droppedRefCount,
      servers: [...acc.servers, {
        name: decl.name,
        server: {
          type: "url",
          url: decl.server.url,
          ...(headers.length === 0 ? {} : { headers }),
        },
      }],
    }
  }, { servers: [], droppedRefCount: 0 })
}

const effectiveMcpServerDeclarations = (
  context: RuntimeContext,
  runtimeContextMcpBaseUrl: FiregridRuntimeContextMcpBaseUrlService,
): Effect.Effect<ReadonlyArray<McpServerDeclaration> | undefined, AdapterError> =>
  Effect.gen(function*() {
    const declared = context.runtime.config.mcpServers
    if (context.runtime.config.runtimeContextMcp?.enabled !== true) {
      return declared
    }
    const base = yield* runtimeContextMcpBaseUrl.get
    if (Option.isNone(base)) {
      return yield* adapterError(
        "startOrAttach",
        context.contextId,
        "runtime intent requires runtimeContextMcp but this host has no Firegrid MCP listener bound",
      )
    }
    const injected = firegridRuntimeContextMcpDeclaration(
      runtimeContextMcpUrlForContext(base.value, context.contextId),
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.runtime_context_mcp.enabled": true,
      "firegrid.mcp.bound_address": base.value.address,
      "firegrid.mcp.base_path": String(base.value.basePath),
      "firegrid.mcp.injected_name": injected.name,
      "firegrid.mcp.injected_url": injected.server.url,
    })
    return [
      injected,
      ...(declared ?? []).filter(
        (existing) => existing.name !== firegridRuntimeContextMcpName,
      ),
    ]
  }).pipe(
    Effect.withSpan("firegrid.unified.adapter.resolve_effective_mcp_servers", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime_context_mcp.enabled": context.runtime.config.runtimeContextMcp?.enabled === true,
      },
    }),
  )

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
  journal: CodecOutputJournal,
  sandboxProvider: SandboxProvider["Type"],
  idGenerator: IdGenerator.IdGenerator["Type"],
  envResolverPolicy: RuntimeEnvResolverPolicy["Type"],
  runtimeContextMcpBaseUrl: FiregridRuntimeContextMcpBaseUrlService,
): Effect.Effect<RegistryEntry, AdapterError> =>
  Effect.gen(function*() {
    const contextId = context.contextId
    const ctxScope = yield* Scope.fork(hostScope, ExecutionStrategy.sequential)

    const { argv, cwd } = sandboxConfigForContext(context)
    const envBindings = context.runtime.config.envBindings ?? []
    const envVars = envBindings.length === 0
      ? {}
      : yield* resolveSpawnEnvVars(envBindings).pipe(
        Effect.provideService(RuntimeEnvResolverPolicy, envResolverPolicy),
        Effect.mapError((cause) =>
          adapterError(
            "startOrAttach",
            contextId,
            "env binding resolution failed",
            cause,
          ),
        ),
      )

    // Resolve the marker before opening the process byte pipe. A marked
    // context on a host with no bound MCP listener is a start failure, not a
    // spawn with missing tools.
    const effectiveMcpServers = yield* effectiveMcpServerDeclarations(
      context,
      runtimeContextMcpBaseUrl,
    )
    const { servers: acpMcpServers, droppedRefCount } = mcpServersForAcp(effectiveMcpServers)
    if (droppedRefCount > 0) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.unified.adapter.mcp.headers_dropped_ref_count": droppedRefCount,
      })
    }

    const sandbox: Sandbox = yield* sandboxProvider.create({
      ...(cwd === undefined ? {} : { workingDir: cwd }),
      ...(Object.keys(envVars).length === 0 ? {} : { envVars }),
    }).pipe(
      Effect.mapError((cause: SandboxProviderError) =>
        adapterError("startOrAttach", contextId, "sandbox create failed", cause),
      ),
    )
    const byteStream = yield* sandboxProvider.openBytePipe(sandbox, {
      argv,
      ...(cwd === undefined ? {} : { cwd }),
      ...(Object.keys(envVars).length === 0 ? {} : { envVars }),
    }).pipe(
      Scope.extend(ctxScope),
      Effect.mapError((cause: SandboxProviderError) =>
        adapterError("startOrAttach", contextId, "openBytePipe failed", cause),
      ),
    )

    // ACP receives MCP server declarations via AcpSessionOptions so the
    // claude-agent-sdk loads them at session start. Drop ref-typed
    // headers; they require separate secret resolution (see
    // `mcpServersForAcp` doc). Stdio-jsonl codec has no MCP slot.
    const acpOptions: AcpSessionOptions = {
      ...(cwd === undefined ? {} : { cwd }),
      ...(acpMcpServers.length === 0 ? {} : { mcpServers: acpMcpServers }),
    }
    const codecLayer = context.runtime.config.agentProtocol === "raw"
      ? StdioJsonlSessionLive(byteStream)
      : AcpSessionLive(byteStream, acpOptions)

    // Build the codec Layer INTO ctxScope so the AgentSession stays
    // alive across send/recv. `Effect.scoped` would close the codec
    // immediately. `Layer.buildWithScope` ties the codec's resources
    // to ctxScope — they release when deregister closes ctxScope.
    const codecContext = yield* Layer.buildWithScope(
      codecLayer.pipe(
        Layer.provide(Layer.succeed(IdGenerator.IdGenerator, idGenerator)),
      ),
      ctxScope,
    ).pipe(
      Effect.mapError((cause) =>
        adapterError("startOrAttach", contextId, "codec session build failed", cause),
      ),
    )
    const session: AgentSessionService = Context.get(codecContext, AgentSession)

    const sequenceRef = yield* Ref.make(0)
    yield* drainOutputsToJournal(
      journal, contextId, attempt, sequenceRef, session.outputs,
    ).pipe(Scope.extend(ctxScope))

    return { session, scope: ctxScope, attempt, sequenceRef }
  })

export const ProductionCodecAdapterLive = Layer.scoped(
  RuntimeContextSessionAdapter,
  Effect.gen(function*() {
    const hostScope = yield* Effect.scope
    const journal = yield* CodecOutputJournalTag
    const sandboxProvider = yield* SandboxProvider
    const idGenerator = yield* IdGenerator.IdGenerator
    const resolver = yield* ContextResolverTag
    const envResolverPolicy = yield* RuntimeEnvResolverPolicy
    const runtimeContextMcpBaseUrl = yield* FiregridRuntimeContextMcpBaseUrl

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

        const ctx = yield* resolver.resolve(contextId).pipe(
          Effect.mapError((cause) =>
            adapterError("startOrAttach", contextId, "context resolve failed", cause),
          ),
        )
        if (Option.isNone(ctx)) {
          return yield* adapterError("startOrAttach", contextId, "context not found")
        }
        const entry = yield* buildSessionForContext(
          hostScope,
          ctx.value,
          attempt,
          journal,
          sandboxProvider,
          idGenerator,
          envResolverPolicy,
          runtimeContextMcpBaseUrl,
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
        const entry = yield* getRegistryEntry(registry, contextId)
        if (entry === undefined) {
          return yield* adapterError("send", contextId, "session not registered")
        }
        const outcome = decodeAgentInputEvent(input)
        switch (outcome._tag) {
          case "Skip":
            yield* Effect.annotateCurrentSpan({
              "firegrid.unified.adapter.send.outcome": "skip",
            })
            return
          case "MalformedJson":
            return yield* adapterError("send", contextId, "input payloadJson is not valid JSON")
          case "SchemaReject":
            yield* Effect.annotateCurrentSpan({
              "firegrid.unified.adapter.send.outcome": "schema_reject",
              "firegrid.unified.adapter.send.payload_excerpt": input.payloadJson.slice(0, 400),
              "firegrid.unified.adapter.send.decode_error": outcome.message.slice(0, 400),
            })
            return yield* adapterError(
              "send",
              contextId,
              `input payloadJson failed AgentInputEvent decode: ${outcome.message}`,
            )
          case "Decoded":
            yield* Effect.annotateCurrentSpan({
              "firegrid.unified.adapter.send.outcome": "decoded",
              "firegrid.unified.adapter.send.event_tag": outcome.event._tag,
            })
            yield* entry.session.send(outcome.event).pipe(
              Effect.mapError((cause) =>
                adapterError("send", contextId, "codec send failed", cause),
              ),
            )
            return
        }
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
        const entry = yield* getRegistryEntry(registry, contextId)
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

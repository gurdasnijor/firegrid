/**
 * INV-5: cross-agent `event(name)` choreography (tf-tg8q).
 *
 * Validates body-plan SDD Slice C.2 ("event(name) — peer pheromone")
 * and the SMI-1992 choreography thesis empirically: two distinct
 * claude-agent-acp processes coordinate via a shared CallerFact-backed
 * event stream, with no orchestrator code mediating between them. One
 * agent emits via an `emit_event(name, payload)` tool; the other waits
 * on the same `name` via the existing `wait_for` tool. Discovery is
 * purely indirect through the durable stream.
 *
 * The "append-fact-shaped tool" required by the bead is provided by a
 * sim-local HTTP MCP server defined in this module. It mirrors the
 * compose pattern of `FiregridMcpServerLayer` (separate `NodeHttpServer`
 * binding, same strict-single-response JSON-RPC serializer) and is
 * mounted in addition to the standard host-owned Firegrid runtime-
 * context MCP. Both sessions are wired to both MCP servers via
 * `RuntimeConfig.mcpServers` in the driver.
 *
 * Sim-local scope: production would expose `event(name)` emission via
 * the standard `FiregridAgentToolkit` once Slice C.2 lands; the
 * sim-local MCP exists only to make the thesis testable today (Slices
 * A and C are still upstream of this validation).
 */

import { McpServer, Tool, Toolkit } from "@effect/ai"
import { HttpRouter, HttpServer } from "@effect/platform"
import type { ServeError } from "@effect/platform/HttpServerError"
import { NodeHttpServer } from "@effect/platform-node"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { type FiregridHost, FiregridRuntimeHostLive } from "@firegrid/runtime/composition/host-live"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/producers/sandbox"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import {
  Deferred,
  Effect,
  Layer,
  Logger,
  Schema,
  Stream,
} from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
// durable-lint-allow-control-plane: sim-local HTTP MCP listener factory
import { createServer } from "node:http"
import type { TinyFiregridHostEnv } from "../../types.ts"

// ---------------------------------------------------------------------------
// Shared constants (the driver imports these so its prompts can name the
// stream and the event consistently with what the host wires under the
// hood).
// ---------------------------------------------------------------------------

export const inv5EventStreamName = "inv5.events"
export const inv5PlanReadyEventName = "plan.ready"

// ---------------------------------------------------------------------------
// Durable event table backing the inv5.events CallerFact stream.
// ---------------------------------------------------------------------------

const Inv5EventRowSchema = Schema.Struct({
  eventId: Schema.String.pipe(DurableTable.primaryKey),
  name: Schema.String,
  payload: Schema.Unknown,
  emittedAt: Schema.String,
})

class Inv5EventTable extends DurableTable("inv5", {
  events: Inv5EventRowSchema,
}) {}

const inv5EventTableLayerOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(options.baseUrl, `${options.namespace}.inv5`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

// ---------------------------------------------------------------------------
// Cross-fiber late-bind of the sim-local emit MCP base URL.
//
// The host launches its layer in a separate fiber from the driver (see
// runner/runtime.ts). The two halves share a process but not a Layer
// tree, so a Context.Tag won't bridge them. A process-level Effect
// Deferred — created at module load — is the simplest reliable channel:
// the host fills it on bind, the driver awaits it before creating the
// two ACP sessions, and any second `simulate run inv5-...` invocation
// re-imports the module fresh (each process gets its own Deferred).
// ---------------------------------------------------------------------------

interface Inv5EmitMcpBase {
  readonly url: string
}

const inv5EmitMcpBaseDeferred = Effect.runSync(
  Deferred.make<Inv5EmitMcpBase>(),
)

export const awaitInv5EmitMcpBase = Deferred.await(inv5EmitMcpBaseDeferred)

const fulfillInv5EmitMcpBase = (
  base: Inv5EmitMcpBase,
): Effect.Effect<void> =>
  Deferred.complete(inv5EmitMcpBaseDeferred, Effect.succeed(base)).pipe(
    Effect.asVoid,
  )

// ---------------------------------------------------------------------------
// Sim-local emit_event tool (Effect AI Tool + Toolkit + handler layer).
// ---------------------------------------------------------------------------

const Inv5EmitInputSchema = Schema.Struct({
  name: Schema.String,
  payload: Schema.optional(Schema.Unknown),
})

const Inv5EmitOutputSchema = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  emittedAt: Schema.String,
})

const Inv5EmitFailureSchema = Schema.Struct({
  _tag: Schema.Literal("Inv5EmitFailed"),
  reason: Schema.String,
})

const Inv5EmitEventTool = Tool.make("emit_event", {
  description:
    "Append a named event row to the inv5.events durable stream. Other"
    + " agents observing the same stream via wait_for see the row indirectly"
    + " — no caller identity is exposed.",
})
  .setParameters(Inv5EmitInputSchema)
  .setSuccess(Inv5EmitOutputSchema)
  .setFailure(Inv5EmitFailureSchema)

const Inv5EmitToolkit = Toolkit.make(Inv5EmitEventTool)

const inv5EmitToolkitHandlerLayer = Inv5EmitToolkit.toLayer(
  Effect.map(Inv5EventTable, (table) => ({
    emit_event: (input: Schema.Schema.Type<typeof Inv5EmitInputSchema>) =>
      Effect.gen(function* () {
        const eventId = `inv5:${input.name}:${crypto.randomUUID()}`
        const emittedAt = new Date().toISOString()
        yield* table.events.insertOrGet({
          eventId,
          name: input.name,
          payload: input.payload ?? null,
          emittedAt,
        })
        yield* Effect.annotateCurrentSpan({
          "inv5.event.id": eventId,
          "inv5.event.name": input.name,
        })
        return { eventId, name: input.name, emittedAt }
      }).pipe(
        Effect.withSpan("inv5.tool.emit_event", {
          kind: "internal",
          attributes: {
            "inv5.event.name": input.name,
            "inv5.stream.name": inv5EventStreamName,
          },
        }),
        Effect.mapError((cause) => ({
          _tag: "Inv5EmitFailed" as const,
          reason: String(cause),
        })),
      ),
  })),
).pipe(Layer.annotateSpans("firegrid.side", "inv5-emit-tool"))

// ---------------------------------------------------------------------------
// Sim-local HTTP MCP server hosting `emit_event`.
//
// Mirrors `FiregridMcpServerLayer`'s compose shape with two deliberate
// changes:
//   1. No runtime-context routing — the emit tool is context-free; agents
//      are differentiated downstream by span attributes, not at the
//      tool-call boundary. The MCP mount path is the plain configured
//      base, not `${base}/runtime-context/:contextId`.
//   2. `NodeHttpServer.layer` is `Layer.provide`'d (not `provideMerge`'d)
//      so this sub-tree's bound `HttpServer` doesn't collide with the
//      one `FiregridMcpServerLayer` keeps in scope.
// ---------------------------------------------------------------------------

const inv5McpRpcSerialization = RpcSerialization.RpcSerialization.of({
  contentType: "application/json",
  includesFraming: false,
  unsafeMake: () => {
    const parser = RpcSerialization.jsonRpc().unsafeMake()
    return {
      decode: parser.decode,
      encode: (response) =>
        parser.encode(
          Array.isArray(response) && response.length === 1
            ? response[0]
            : response,
        ),
    }
  },
})

const inv5McpRpcSerializationLayer = Layer.succeed(
  RpcSerialization.RpcSerialization,
  inv5McpRpcSerialization,
)

const publishInv5EmitMcpBase = (basePath: string) =>
  Effect.gen(function* () {
    const address = yield* HttpServer.addressFormattedWith((addr) =>
      Effect.succeed(addr))
    yield* fulfillInv5EmitMcpBase({ url: `${address}${basePath}` })
    yield* Effect.annotateCurrentSpan({
      "inv5.mcp.url": `${address}${basePath}`,
    })
  })

const inv5EmitMcpServerLayer = (options: {
  readonly host: string
  readonly port: number
  readonly path: HttpRouter.PathInput
}) =>
  Layer.mergeAll(
    Layer.scopedDiscard(
      McpServer.registerToolkit(Inv5EmitToolkit).pipe(
        Effect.withSpan("inv5.mcp.register_toolkit", {
          kind: "server",
          attributes: {
            "inv5.mcp.tool_count": Object.keys(Inv5EmitToolkit.tools).length,
            "inv5.mcp.tool_names": Object.keys(Inv5EmitToolkit.tools).sort()
              .join(","),
          },
        }),
      ),
    ),
    HttpRouter.Default.serve(),
    Layer.scopedDiscard(
      publishInv5EmitMcpBase(String(options.path)).pipe(
        Effect.withSpan("inv5.mcp.publish_base", { kind: "server" }),
      ),
    ),
  ).pipe(
    Layer.provide(inv5EmitToolkitHandlerLayer),
    Layer.provide(
      McpServer.layer({
        name: "inv5.emit-event",
        version: "0.0.0",
      }).pipe(
        Layer.provide(
          RpcServer.layerProtocolHttp({ path: options.path }),
        ),
        Layer.provide(inv5McpRpcSerializationLayer),
      ),
    ),
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        port: options.port,
        host: options.host,
      }),
    ),
    Layer.provide(Logger.remove(Logger.defaultLogger)),
  )

// ---------------------------------------------------------------------------
// Host layer composition.
// ---------------------------------------------------------------------------

const inv5EnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    lookupEnv: (name) => env[name],
  })

export const inv5ChoreographyHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const hostId = "host-a"
  const mcpHost = "127.0.0.1"
  const firegridMcpPath = "/mcp"
  const emitMcpPath = "/mcp"

  const tableOptions = inv5EventTableLayerOptions({
    baseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
  })

  // Two `Inv5EventTable.layer(...)` instances point at the same durable
  // stream URL; the underlying rows live in the durable-streams server,
  // not in Effect-instance state. One serves the wait-router's
  // CallerOwnedFactStreams adapter; the other backs the emit-MCP handler.
  // Decoupling the two construction trees keeps the emit-MCP sub-layer
  // self-contained (no NodeHttpServer / HttpRouter.Default collision
  // with the firegrid MCP) while preserving shared semantics.
  const factsForRuntime = Inv5EventTable.layer(tableOptions) as Layer.Layer<
    Inv5EventTable,
    DurableTableError
  >
  const factsForEmitMcp = Inv5EventTable.layer(tableOptions) as Layer.Layer<
    Inv5EventTable,
    DurableTableError
  >

  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(Inv5EventTable, (table) => ({
      streamFor: (stream: string) =>
        stream === inv5EventStreamName ? table.events.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factsForRuntime))

  const appFacts = Layer.mergeAll(factsForRuntime, callerFacts)

  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
    },
    inv5EnvPolicy(env.processEnv),
  ).pipe(Layer.provideMerge(appFacts))

  const firegridMcp = Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(firegridMcpPath),
    }),
  )

  const emitMcp = inv5EmitMcpServerLayer({
    host: mcpHost,
    port: 0,
    path: ensurePathInput(emitMcpPath),
  }).pipe(Layer.provide(factsForEmitMcp))

  return Layer.mergeAll(firegridMcp, emitMcp).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}

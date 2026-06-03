import { IdGenerator, McpServer } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeContextsView,
  runtimeEventsForContextView,
} from "@firegrid/protocol/launch"
import {
  RuntimeAgentOutputObservationSchema,
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
import {
  HostPlaneSessionControlRouterLive,
  makeRuntimeChannelRouter,
  RuntimeChannelRouter,
  sessionAgentOutputObservationRoute,
} from "@firegrid/runtime/channels"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import { AcpContextRows } from "@firegrid/runtime/sources/codecs/acp/stdio-edge"
import {
  ContextResolverTag,
  defaultProductionAdapterLayer,
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  FiregridRuntime,
  ToolDispatchLive,
} from "@firegrid/runtime/unified"
import { Effect, Layer, Option, Stream } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"
import { layerProtocolDurableStreamsServer } from "./transport.ts"

const transportId = "gateway"
const parentExternalKey = {
  source: "tiny-firegrid",
  id: "mcp-durable-parent",
} as const
const parentContextId =
  `session:${parentExternalKey.source}:${parentExternalKey.id}` as const

const GlobalSessionAgentOutputChannelLive = Layer.effect(
  SessionAgentOutputChannel,
  RuntimeOutputTable.pipe(
    Effect.map(output =>
      SessionAgentOutputChannel.of({
        forContext: contextId =>
          makeIngressChannel({
            target: SessionAgentOutputChannelTarget,
            schema: RuntimeAgentOutputObservationSchema,
            sourceClass: "static-source",
            stream: runtimeEventsForContextView(output.events.rows(), contextId).pipe(
              Stream.filterMap(runtimeAgentOutputObservationFromRow),
            ),
          }),
      })),
  ),
)

const GlobalAcpContextRowsLive = Layer.effect(
  AcpContextRows,
  RuntimeControlPlaneTable.pipe(
    Effect.map(control => runtimeContextsView(control.contexts.rows())),
  ),
)

const RuntimeChannelRouterLive = Layer.effect(
  RuntimeChannelRouter,
  Effect.gen(function*() {
    const sessionAgentOutput = yield* SessionAgentOutputChannel
    return makeRuntimeChannelRouter([
      sessionAgentOutputObservationRoute(sessionAgentOutput),
    ])
  }),
)

const contextResolverFromControlPlaneTable = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId: string) => control.contexts.get(contextId),
    }
  }),
)

const DurableMcpFixedContextLayer = Layer.effect(
  FiregridAgentToolContext,
  Effect.gen(function*() {
    const resolver = yield* ContextResolverTag
    return FiregridAgentToolContext.of({
      resolve: Effect.gen(function*() {
        const runtimeContext = yield* resolver.resolve(parentContextId).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new Error(`missing MCP route context ${parentContextId}`)),
            onSome: Effect.succeed,
          })),
        )
        yield* Effect.annotateCurrentSpan({ "firegrid.context.id": parentContextId })
        return { contextId: parentContextId, runtimeContext }
      }).pipe(
        Effect.withSpan("tiny_firegrid.mcp_durable.fixed_context.resolve", {
          kind: "server",
        }),
      ),
    })
  }),
)

const DurableMcpServerLayer = (
  env: TinyFiregridHostEnv,
) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      yield* McpServer.registerToolkit(FiregridAgentToolkit)
      yield* McpServer.run({
        name: "firegrid.agent-tools.durable-streams",
        version: "0.0.0",
      }).pipe(
        Effect.forkScoped,
      )
      yield* Effect.annotateCurrentSpan({
        "firegrid.mcp_durable.transport_id": transportId,
        "firegrid.mcp_durable.protocol": "durable-streams",
        "firegrid.mcp_durable.http_listener": false,
        "firegrid.context.id": parentContextId,
      })
    }).pipe(
      Effect.withSpan("tiny_firegrid.mcp_durable.server.layer", {
        kind: "server",
      }),
    ),
  ).pipe(
    Layer.provide(FiregridAgentToolkitLayer),
    Layer.provide(DurableMcpFixedContextLayer),
    Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
    Layer.provide(McpServer.McpServer.layer),
    Layer.provide(layerProtocolDurableStreamsServer({
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      transportId,
    })),
  )

export const mcpDurableStreamsGatewayHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const host = FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
        lookupEnv: name => env.processEnv[name],
      }),
    ),
  )

  const appRuntimeRoutes = RuntimeChannelRouterLive.pipe(
    Layer.provideMerge(GlobalSessionAgentOutputChannelLive),
  )
  const toolDispatch = ToolDispatchLive.pipe(
    Layer.provideMerge(appRuntimeRoutes),
    Layer.provideMerge(contextResolverFromControlPlaneTable),
    Layer.provideMerge(HostPlaneSessionControlRouterLive),
  )
  const mcp = DurableMcpServerLayer(env).pipe(
    Layer.provideMerge(contextResolverFromControlPlaneTable),
    Layer.provideMerge(toolDispatch),
    Layer.discard,
  )

  return mcp.pipe(
    Layer.merge(GlobalAcpContextRowsLive),
    Layer.provideMerge(host),
  )
}

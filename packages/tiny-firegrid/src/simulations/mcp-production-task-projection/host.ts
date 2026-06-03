import {
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  makeIngressChannel,
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
import { HostPlaneSessionControlRouterLive } from "@firegrid/runtime/channels"
import { AcpContextRows } from "@firegrid/runtime/sources/codecs/acp/stdio-edge"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import {
  ContextResolverTag,
  FiregridMcpServerLayer,
  FiregridRuntime,
  ToolDispatchLive,
  defaultProductionAdapterLayer,
  ensurePathInput,
} from "@firegrid/runtime/unified"
import { Effect, Layer, Stream } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const gatewayContextId = "session:tiny-firegrid:mcp-production-task-projection-parent"
const streamId = "mcp-production-task-projection"

interface McpProductionTaskProjectionHostOptions {
  readonly gatewayContextId: string
  readonly streamId: string
}

const ContextResolverFromControlPlaneTableLive = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId: string) => control.contexts.get(contextId),
    }
  }),
)

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

const AcpContextRowsLive = Layer.effect(
  AcpContextRows,
  RuntimeControlPlaneTable.pipe(
    Effect.map(control => runtimeContextsView(control.contexts.rows())),
  ),
)

export const makeMcpProductionTaskProjectionHost = (
  options: McpProductionTaskProjectionHostOptions,
): ((
  env: TinyFiregridHostEnv,
) => Layer.Layer<FiregridHost, unknown>) =>
  (env: TinyFiregridHostEnv): Layer.Layer<FiregridHost, unknown> => {
    const runtime = FiregridRuntime(
      {
        durableStreamsBaseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      },
      defaultProductionAdapterLayer(
        RuntimeEnvResolverPolicy.withPolicy({
          authorizedBindings: [
            ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
          ],
          lookupEnv: name => env.processEnv[name],
        }),
      ),
    )

    const support = Layer.mergeAll(
      ContextResolverFromControlPlaneTableLive,
      GlobalSessionAgentOutputChannelLive,
      AcpContextRowsLive,
    )

    const mcp = FiregridMcpServerLayer({
      host: "127.0.0.1",
      port: 0,
      path: ensurePathInput("/mcp"),
      durableStreams: {
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        streamId: options.streamId,
        contextId: options.gatewayContextId,
      },
    }).pipe(Layer.discard)

    return mcp.pipe(
      Layer.provideMerge(ToolDispatchLive),
      Layer.provideMerge(HostPlaneSessionControlRouterLive),
      Layer.provideMerge(support),
      Layer.provideMerge(runtime),
    )
  }

export const mcpProductionTaskProjectionHost =
  makeMcpProductionTaskProjectionHost({
    gatewayContextId,
    streamId,
  })

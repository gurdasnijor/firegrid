/**
 * `McpIngressLive` — the uniform MCP ingress (tf-ll90.8.4 / §12 "MCP is the
 * single ingress").
 *
 * Folds the exact MCP-ingress composition `bin/_compose.ts` hand-wired
 * (`FiregridMcpServerLayer` + `ToolDispatchLive` + `HostPlaneSessionControlRouterLive`
 * + the context-resolver / contexts-view / agent-output support) into ONE Live
 * so prod and sims compose the ingress identically instead of each re-rolling a
 * copy. Two transport variants, the dual of `DurableStreamsLive`:
 *
 *   - `http(cfg)` — the agent-facing HTTP listener (what `bin/_compose.ts` uses);
 *     the connecting agent's contextId rides the request URL, so no gateway.
 *   - `durableStreams(cfg)` — the durable-streams transport `@firegrid/client-sdk/mcp`
 *     connects to. It is bound to ONE gateway contextId, so — as the dual of the
 *     HTTP transport's per-request agent context — it OWNS that gateway context,
 *     seeding it (with the caller-supplied runtime) via the existing host-plane
 *     `HostSessionsCreateOrLoadChannel`. `session_new` children inherit it.
 *
 * Requires `RuntimeControlPlaneTable` + `RuntimeOutputTable` + the host-plane
 * channels — all from the `FiregridRuntime` it is composed over.
 */

import {
  HostSessionsCreateOrLoadChannel,
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
} from "@firegrid/protocol/channels"
import {
  type PublicLaunchRuntimeIntent,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeContextsView,
  runtimeEventsForContextView,
} from "@firegrid/protocol/launch"
import {
  RuntimeAgentOutputObservationSchema,
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Stream } from "effect"
import { HostPlaneSessionControlRouterLive } from "../channels/host-plane-router.ts"
import { ContextResolverFromControlPlaneTableLive } from "../tables/codec-adapter-providers.ts"
import { AcpContextRows } from "../sources/codecs/acp/stdio-edge.ts"
import { FiregridMcpServerLayer } from "./mcp-host/mcp-host.ts"
import { ensurePathInput } from "./mcp-host/runtime-context-mcp-base-url.ts"
import { ToolDispatchLive } from "./mcp-host/tool-dispatch.ts"

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

// ToolDispatch needs the context resolver + host-plane router (bin/_compose.ts
// provided both into it); keep that exact shape.
const ToolDispatchLiveWithSupport = ToolDispatchLive.pipe(
  Layer.provideMerge(ContextResolverFromControlPlaneTableLive),
  Layer.provideMerge(HostPlaneSessionControlRouterLive),
)

// The shared ingress composition — exactly as bin/_compose.ts wired it around
// the server layer.
const composeIngress = <ROut, E, RIn>(
  server: Layer.Layer<ROut, E, RIn>,
) =>
  Layer.mergeAll(
    server.pipe(
      Layer.provideMerge(ContextResolverFromControlPlaneTableLive),
      Layer.provideMerge(ToolDispatchLiveWithSupport),
    ),
    GlobalAcpContextRowsLive,
    GlobalSessionAgentOutputChannelLive,
  ).pipe(Layer.provideMerge(HostPlaneSessionControlRouterLive))

export interface McpIngressHttpOptions {
  readonly host?: string
  readonly port?: number
  readonly path?: string
}

export interface McpIngressDurableStreamsOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
  /** The gateway external key; its derived contextId is the ingress's context. */
  readonly gatewayExternalKey: { readonly source: string; readonly id: string }
  /** Runtime the gateway context carries; `session_new` children inherit it. */
  readonly gatewayRuntime: PublicLaunchRuntimeIntent
}

const gatewayContextId = (
  key: McpIngressDurableStreamsOptions["gatewayExternalKey"],
): string => `session:${key.source}:${key.id}`

export const McpIngressLive = {
  /** Agent-facing HTTP MCP ingress (bin edge). */
  http: (options: McpIngressHttpOptions = {}) =>
    composeIngress(
      FiregridMcpServerLayer({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 0,
        path: ensurePathInput(options.path ?? "/mcp"),
      }),
    ),

  /** Durable-streams MCP ingress (the `@firegrid/client-sdk/mcp` transport). */
  durableStreams: (options: McpIngressDurableStreamsOptions) => {
    const contextId = gatewayContextId(options.gatewayExternalKey)
    const server = composeIngress(
      FiregridMcpServerLayer({
        host: "127.0.0.1",
        port: 0,
        path: ensurePathInput("/mcp"),
        durableStreams: {
          baseUrl: options.baseUrl,
          namespace: options.namespace,
          streamId: options.streamId,
          contextId,
        },
      }),
    )
    // The durable-streams ingress owns its bound gateway context (the dual of
    // the HTTP transport's per-request agent context): seed it via the existing
    // host-plane channel so `session_new` has a parent to inherit from.
    const seedGateway = Layer.scopedDiscard(
      Effect.gen(function*() {
        const channel = yield* HostSessionsCreateOrLoadChannel
        yield* channel.binding.call({
          externalKey: options.gatewayExternalKey,
          runtime: options.gatewayRuntime,
          createdBy: "firegrid:mcp-ingress",
        })
      }),
    )
    return Layer.mergeAll(server, seedGateway)
  },
}

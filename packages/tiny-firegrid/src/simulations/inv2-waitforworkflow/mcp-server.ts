/**
 * Custom HTTP MCP server bound on a sim-local port that exposes ONE tool,
 * `wait_for`, whose handler dispatches `WaitForWorkflow.execute(...)` on a
 * dedicated sim-local Firegrid workflow engine.
 *
 * Why this exists for INV-2:
 *   The production agent-tool `wait_for` handler (host-sdk
 *   `tool-use-to-effect.ts`) now lowers onto `WaitForWorkflow.execute`.
 *
 *   INV-2 validates that the engine can handle the racing match/timeout
 *   shape natively (Activity + DurableClock.sleep) — i.e. without the
 *   retired wait-router substrate.
 *   Acceptance (c) is "NO `…wait_router.complete_match` spans" on the
 *   sim's trace.
 *
 *   The sim driver wires the agent (`claude-agent-acp`) to this MCP server
 *   via `mcpServers: [{ name, server: { type: "url", url } }]` on the
 *   runtime config, AND sets `runtimeContextMcp.enabled: false` so the
 *   production runtime-context MCP server is NOT injected by the codec. The
 *   agent therefore only sees THIS `wait_for`.
 */

import { McpServer, Tool, Toolkit } from "@effect/ai"
import { HttpRouter } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import type { WorkflowEngine } from "@effect/workflow"
import {
  type CallerOwnedFactStreams,
  durableStreamUrl,
} from "@firegrid/host-sdk"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import { Effect, Layer, Logger, Schema } from "effect"
// durable-lint-allow-control-plane: NodeHttpServer.layer listener factory.
import { createServer } from "node:http"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  type WaitForWorkflowOutcome,
} from "./wait-for-workflow.ts"

const FieldEqualsScalarSchema = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
)

const WaitForToolInputSchema = Schema.Struct({
  // Mirrors the production agent-tool `wait_for` shape (whereFields-only,
  // scalar predicates, CallerFact source), plus an explicit `executionKey`
  // the agent supplies to make each nested workflow execution distinct.
  waitQuery: Schema.Struct({
    source: Schema.Struct({
      _tag: Schema.Literal("CallerFact"),
      stream: Schema.String,
    }),
    whereFields: Schema.Record({
      key: Schema.String,
      value: FieldEqualsScalarSchema,
    }),
  }),
  timeoutMs: Schema.Number,
  executionKey: Schema.String,
})

const WaitForToolSuccessSchema = Schema.Union(
  Schema.Struct({
    matched: Schema.Literal(true),
    event: Schema.Unknown,
  }),
  Schema.Struct({
    matched: Schema.Literal(false),
    timedOut: Schema.Literal(true),
  }),
)

const WaitForToolFailureSchema = Schema.Struct({
  _tag: Schema.Literal("WaitForWorkflowFailed"),
  message: Schema.String,
})

const SimWaitForTool = Tool.make("wait_for", {
  description:
    "INV-2: wait until a matching CallerFact stream row appears, or time out. " +
    "Dispatched as a nested WaitForWorkflow execution; NO wait-router involvement.",
})
  .setParameters(WaitForToolInputSchema)
  .setSuccess(WaitForToolSuccessSchema)
  .setFailure(WaitForToolFailureSchema)

const SimWaitForToolkit = Toolkit.make(SimWaitForTool)

type SimWaitForInput = Schema.Schema.Type<typeof WaitForToolInputSchema>
type SimWaitForSuccess = Schema.Schema.Type<typeof WaitForToolSuccessSchema>
type SimWaitForFailure = Schema.Schema.Type<typeof WaitForToolFailureSchema>

// Capture the per-engine context (WorkflowEngine + WorkflowEngineTable) once
// when the toolkit layer is built. The handler closes over `captured` so each
// tool invocation re-provides the same engine into the inner
// `WaitForWorkflow.execute` Effect — keeping the handler's R = `never`,
// which is what `Toolkit.toLayer` requires.
const SimWaitForToolkitLayer = SimWaitForToolkit.toLayer(
  Effect.map(
    Effect.context<WorkflowEngine.WorkflowEngine>(),
    (captured) => ({
      wait_for: (
        input: SimWaitForInput,
      ): Effect.Effect<SimWaitForSuccess, SimWaitForFailure> =>
        Effect.gen(function* () {
          const outcome: WaitForWorkflowOutcome = yield* WaitForWorkflow
            .execute({
              executionKey: input.executionKey,
              stream: input.waitQuery.source.stream,
              whereFields: input.waitQuery.whereFields,
              timeoutMs: input.timeoutMs,
            })
          return outcome._tag === "Match"
            ? {
              matched: true as const,
              event: outcome.raw,
            }
            : {
              matched: false as const,
              timedOut: true as const,
            }
        }).pipe(
          Effect.provide(captured),
          Effect.withSpan("firegrid.sim.inv2.wait_for_tool", {
            kind: "internal",
            attributes: {
              "firegrid.sim.inv2.execution_key": input.executionKey,
              "firegrid.sim.inv2.stream": input.waitQuery.source.stream,
              "firegrid.sim.inv2.timeout_ms": input.timeoutMs,
            },
          }),
          Effect.catchAllDefect((defect) =>
            Effect.fail({
              _tag: "WaitForWorkflowFailed" as const,
              message: defect instanceof Error
                ? defect.message
                : String(defect),
            })),
        ),
    }),
  ),
)

interface SimWaitForMcpServerOptions {
  readonly host: string
  readonly port: number
  readonly path: HttpRouter.PathInput
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}

/**
 * Builds the sim's MCP server Layer. Composes (top → bottom):
 *
 *  - `McpServer.registerToolkit(SimWaitForToolkit)` — registers the tool
 *    with the MCP server.
 *  - `HttpRouter.Default.serve()` — exposes the router as the server's
 *    HttpApp.
 *  - `WaitForWorkflowLayer` — registers the WaitForWorkflow body with the
 *    sim-local engine.
 *  - `SimWaitForToolkitLayer` — provides handlers for the toolkit.
 *  - `McpServer.layerHttp` — Effect AI MCP handlers over JSON-RPC HTTP.
 *  - `NodeHttpServer.layer` — loopback HTTP binder.
 *  - `DurableStreamsWorkflowEngine.layer` — sim-local workflow engine.
 *
 * Requirements left in the output layer: `CallerOwnedFactStreams` (the
 * host composition provides this).
 */
export const SimWaitForMcpServerLayer = (
  options: SimWaitForMcpServerOptions,
): Layer.Layer<never, never, CallerOwnedFactStreams> => {
  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(
      options.durableStreamsBaseUrl,
      `${options.namespace}.inv2WaitForWorkflow`,
    ),
    workerId: "inv2-wait-for-workflow-sim",
  })

  return Layer.mergeAll(
    Layer.scopedDiscard(
      McpServer.registerToolkit(SimWaitForToolkit).pipe(
        Effect.withSpan("firegrid.sim.inv2.mcp.register_toolkit", {
          kind: "server",
          attributes: {
            "firegrid.sim.inv2.mcp.tool_names":
              Object.keys(SimWaitForToolkit.tools).sort().join(","),
          },
        }),
      ),
    ),
    HttpRouter.Default.serve(),
    WaitForWorkflowLayer,
  ).pipe(
    Layer.provide(SimWaitForToolkitLayer),
    Layer.provideMerge(engineLayer),
    Layer.provide(
      McpServer.layerHttp({
        name: "firegrid-sim-inv2-wait-for-workflow",
        version: "0.0.0",
        path: options.path,
      }),
    ),
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        port: options.port,
        host: options.host,
      }),
    ),
    Layer.provide(Logger.remove(Logger.defaultLogger)),
    Layer.catchAll((cause) =>
      Layer.effectDiscard(
        Effect.logError("[inv2-waitforworkflow] sim MCP server failed").pipe(
          Effect.annotateLogs({ cause }),
        ),
      )),
  )
}

/** Helper used by the driver to compute the MCP URL the agent receives. */
export const simWaitForMcpUrl = (options: {
  readonly host: string
  readonly port: number
  readonly path: string
}): string => `http://${options.host}:${options.port}${options.path}`

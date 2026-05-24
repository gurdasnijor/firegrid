/**
 * INV-2 PATH A AMENDMENT — layer-composition variant of the sim MCP server.
 *
 * SAME `WaitForWorkflow` body as the sibling `inv2-waitforworkflow` sim
 * (imported as-is from `../inv2-waitforworkflow/wait-for-workflow.ts` — both
 * shapes exercise the same workflow definition). The ONLY difference is how
 * `WorkflowEngine.WorkflowEngine` is discharged into the toolkit handler:
 *
 *   PATTERN 1 (sibling sim, capture-and-re-provide):
 *     - `Tool.make` declares NO dependencies; handler R = `never`.
 *     - Handler closes over `Effect.context<WorkflowEngine>()` captured at
 *       toolkit-layer build time, then `Effect.provide(captured)` inside
 *       every invocation.
 *     - Works; not the @effect/workflow-canonical shape.
 *
 *   PATTERN 2 (this file, layer-composition — CANONICAL):
 *     - `Tool.make` declares `dependencies: [WorkflowEngine.WorkflowEngine]`;
 *       handler R = `WorkflowEngine.WorkflowEngine`.
 *     - Handler body does NOT capture and does NOT re-provide. It just calls
 *       `WaitForWorkflow.execute(...)` and lets normal Effect composition
 *       resolve the service from ambient.
 *     - The layer chain provides the engine via `Layer.provideMerge` at the
 *       point where BOTH `SimToolkitLayer` (for the handler) and
 *       `WaitForWorkflowLayer` (for the workflow body) need it.
 *     - This is the shape @effect/workflow uses in its own test suite
 *       (`packages/workflow/test/WorkflowEngine.test.ts:14-23`) — workflow
 *       body layer composed with `Layer.provideMerge(engineLayer)`, then
 *       provided to the consuming Effect.
 *
 * Both shapes must produce identical observable outcomes; the FINDING doc
 * compares the two side-by-side and recommends this shape for the production
 * cutover at `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`.
 */

import { McpServer, Tool, Toolkit } from "@effect/ai"
import { HttpRouter } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { WorkflowEngine } from "@effect/workflow"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { CallerOwnedFactStreams } from "@firegrid/runtime/channels/observation-streams"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import { Effect, Layer, Logger, Schema } from "effect"
// durable-lint-allow-control-plane: NodeHttpServer.layer listener factory.
import { createServer } from "node:http"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  type WaitForWorkflowOutcome,
} from "../inv2-waitforworkflow/wait-for-workflow.ts"

const FieldEqualsScalarSchema = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
)

const WaitForToolInputSchema = Schema.Struct({
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

// Canonical R-declaration: the WorkflowEngine service is a Tool dependency.
// Toolkit.HandlersFrom propagates this into the handler's R-type:
//   handler R = Context.Tag.Identifier<Dependencies[number]>
//             = WorkflowEngine.WorkflowEngine
// The toolkit handler body is then a normal Effect over that R; nothing in
// it knows or cares how the engine is materialized — that decision is the
// layer chain's job, not the handler's.
const SimWaitForTool = Tool.make("wait_for", {
  description:
    "INV-2 layer-composition variant: SAME WaitForWorkflow body as the " +
    "`inv2-waitforworkflow` sibling sim, dispatched the same way, with " +
    "WorkflowEngine discharged via layer composition (canonical shape).",
  dependencies: [WorkflowEngine.WorkflowEngine],
})
  .setParameters(WaitForToolInputSchema)
  .setSuccess(WaitForToolSuccessSchema)
  .setFailure(WaitForToolFailureSchema)

const SimWaitForToolkit = Toolkit.make(SimWaitForTool)

type SimWaitForInput = Schema.Schema.Type<typeof WaitForToolInputSchema>
type SimWaitForSuccess = Schema.Schema.Type<typeof WaitForToolSuccessSchema>
type SimWaitForFailure = Schema.Schema.Type<typeof WaitForToolFailureSchema>

// Handler signature carries WorkflowEngine in R because Tool.dependencies
// declared it. Body does NOT capture, does NOT re-provide; `WaitForWorkflow
// .execute` resolves the engine through the ambient Effect context, the same
// way `LongWorkflow.execute(...)` does in
// `repos/effect/packages/workflow/test/WorkflowEngine.test.ts:14`.
const SimWaitForToolkitLayer = SimWaitForToolkit.toLayer({
  wait_for: (
    input: SimWaitForInput,
  ): Effect.Effect<
    SimWaitForSuccess,
    SimWaitForFailure,
    WorkflowEngine.WorkflowEngine
  > =>
    Effect.gen(function* () {
      const outcome: WaitForWorkflowOutcome = yield* WaitForWorkflow.execute({
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
      Effect.withSpan("firegrid.sim.inv2_layered.wait_for_tool", {
        kind: "internal",
        attributes: {
          "firegrid.sim.inv2_layered.execution_key": input.executionKey,
          "firegrid.sim.inv2_layered.stream": input.waitQuery.source.stream,
          "firegrid.sim.inv2_layered.timeout_ms": input.timeoutMs,
        },
      }),
      Effect.catchAllDefect((defect) =>
        Effect.fail({
          _tag: "WaitForWorkflowFailed" as const,
          message: defect instanceof Error ? defect.message : String(defect),
        })),
    ),
})

interface SimWaitForMcpServerOptions {
  readonly host: string
  readonly port: number
  readonly path: HttpRouter.PathInput
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
}

/**
 * Layer chain (top → bottom):
 *
 *   - `McpServer.registerToolkit` — registers the tool with the MCP server.
 *   - `HttpRouter.Default.serve` — exposes the router as the server's HttpApp.
 *   - `WaitForWorkflowLayer` — registers the WaitForWorkflow body (R includes
 *     WorkflowEngine + CallerOwnedFactStreams).
 *   - `Layer.provide(SimWaitForToolkitLayer)` — consumes the toolkit handler
 *     tag; the toolkit handler ALSO carries WorkflowEngine as an R-requirement
 *     (declared via Tool.dependencies), and that R bubbles up.
 *   - `Layer.provideMerge(engineLayer)` — single point of WorkflowEngine
 *     provision; satisfies BOTH the toolkit handler and the workflow body
 *     registration. This is the canonical shape from
 *     `WorkflowEngine.test.ts:14-23`: workflow layer +
 *     `Layer.provideMerge(WorkflowEngine.layerMemory)`. We use
 *     `DurableStreamsWorkflowEngine.layer` instead of `layerMemory` because
 *     the engine must be backed by the same Durable Streams test server the
 *     sim host already provisions for everything else.
 *   - `McpServer.layerHttp`, `NodeHttpServer.layer`, etc. — transport.
 */
export const SimWaitForMcpServerLayerLayered = (
  options: SimWaitForMcpServerOptions,
): Layer.Layer<never, never, CallerOwnedFactStreams> => {
  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(
      options.durableStreamsBaseUrl,
      `${options.namespace}.inv2WaitForWorkflowLayered`,
    ),
    workerId: "inv2-wait-for-workflow-sim-layered",
  })

  return Layer.mergeAll(
    Layer.scopedDiscard(
      McpServer.registerToolkit(SimWaitForToolkit).pipe(
        Effect.withSpan("firegrid.sim.inv2_layered.mcp.register_toolkit", {
          kind: "server",
          attributes: {
            "firegrid.sim.inv2_layered.mcp.tool_names":
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
        name: "firegrid-sim-inv2-wait-for-workflow-layered",
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
        Effect.logError(
          "[inv2-waitforworkflow-layered] sim MCP server failed",
        ).pipe(
          Effect.annotateLogs({ cause }),
        ),
      )),
  )
}

/** Helper used by the driver to compute the MCP URL the agent receives. */
export const simWaitForLayeredMcpUrl = (options: {
  readonly host: string
  readonly port: number
  readonly path: string
}): string => `http://${options.host}:${options.port}${options.path}`

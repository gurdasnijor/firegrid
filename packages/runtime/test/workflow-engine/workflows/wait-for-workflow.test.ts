import { WorkflowEngine } from "@effect/workflow"
import { Effect, Layer, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  RuntimeObservationStreams,
} from "../../../src/streams/index.ts"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  waitForWorkflowExecutionId,
} from "../../../src/workflow-engine/workflows/index.ts"

const runtimeObservationStreams = RuntimeObservationStreams.of({
  agentOutput: Stream.empty,
  agentOutputAfter: () => Stream.empty,
  initialAgentOutputAfter: () => Effect.succeed(Option.none()),
  agentOutputForContext: () => Stream.empty,
  runtimeRun: Stream.empty,
  callerFact: stream =>
    stream === "facts"
      ? Stream.fromIterable([
        { kind: "ignore", correlationId: "decoy" },
        { kind: "match", correlationId: "target", payload: 42 },
      ])
      : Stream.empty,
})

const runtimeObservationStreamsLayer = Layer.succeed(
  RuntimeObservationStreams,
  runtimeObservationStreams,
)

const waitForWorkflowTestLayer = Layer.mergeAll(
  WaitForWorkflowLayer,
  runtimeObservationStreamsLayer,
).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
)

describe("WaitForWorkflow", () => {
  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.10 matches a runtime observation stream row through the workflow engine", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        WaitForWorkflow.execute({
          executionKey: "wf-match",
          source: { _tag: "CallerFact", stream: "facts" },
          trigger: [{ path: ["correlationId"], equals: "target" }],
          timeoutMs: 60_000,
        }).pipe(
          Effect.provide(waitForWorkflowTestLayer),
          Effect.provideService(RuntimeObservationStreams, runtimeObservationStreams),
        ),
      ),
    )

    expect(outcome).toEqual({
      _tag: "Match",
      raw: { kind: "match", correlationId: "target", payload: 42 },
    })
  })

  it("uses the stable wait-for workflow execution id prefix", () => {
    expect(waitForWorkflowExecutionId("wf-match")).toBe("wait-for:wf-match")
  })
})

import { WorkflowEngine } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Layer, Option, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeObservationStreams,
  type RuntimeObservationStreamsService,
} from "../../../src/streams/index.ts"
import {
  DurableStreamsWorkflowEngine,
} from "../../../src/engine/durable-streams-workflow-engine.ts"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  waitForWorkflowExecutionId,
} from "../../../src/subscribers/wait-router/workflow.ts"

const runtimeObservationStreams = RuntimeObservationStreams.of({
  agentOutput: Stream.empty,
  agentOutputAfter: () => Stream.empty,
  initialAgentOutputAfter: () => Effect.succeed(Option.none()),
  agentOutputForContext: () => Stream.empty,
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

const waitForWorkflowTestLayer = WaitForWorkflowLayer.pipe(
  Layer.provideMerge(runtimeObservationStreamsLayer),
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

  it("returns Timeout when no row arrives before the per-Activity-attempt timeout", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        WaitForWorkflow.execute({
          executionKey: "wf-timeout",
          source: { _tag: "CallerFact", stream: "empty" },
          trigger: [{ path: ["correlationId"], equals: "missing" }],
          timeoutMs: 10,
        }).pipe(
          Effect.provide(waitForWorkflowTestLayer),
          Effect.provideService(RuntimeObservationStreams, runtimeObservationStreams),
        ),
      ),
    )

    expect(outcome).toEqual({ _tag: "Timeout" })
  })

  it("uses the stable wait-for workflow execution id prefix", () => {
    expect(waitForWorkflowExecutionId("wf-match")).toBe("wait-for:wf-match")
  })

  // tf-0xe4: wait_for_any races the primary source plus additionalSources inside
  // the one workflow Activity and reports the winning index.
  it("tf-0xe4 races multiple sources and returns the winning index", async () => {
    const streams = RuntimeObservationStreams.of({
      ...runtimeObservationStreams,
      callerFact: stream =>
        stream === "s1"
          ? Stream.fromIterable([{ correlationId: "target", payload: 7 }])
          : Stream.empty, // s0 never matches
    })
    const layer = WaitForWorkflowLayer.pipe(
      Layer.provideMerge(Layer.succeed(RuntimeObservationStreams, streams)),
      Layer.provideMerge(WorkflowEngine.layerMemory),
    )
    const outcome = await Effect.runPromise(
      Effect.scoped(
        WaitForWorkflow.execute({
          executionKey: "wf-any-race",
          source: { _tag: "CallerFact", stream: "s0" },
          trigger: [{ path: ["correlationId"], equals: "target" }],
          additionalSources: [{
            source: { _tag: "CallerFact", stream: "s1" },
            trigger: [{ path: ["correlationId"], equals: "target" }],
          }],
          timeoutMs: 60_000,
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(RuntimeObservationStreams, streams),
        ),
      ),
    )
    expect(outcome).toEqual({
      _tag: "Match",
      raw: { correlationId: "target", payload: 7 },
      winnerIndex: 1,
    })
  })
})

// tf-0xe4: the durability proof — a completed wait_for_any race is persisted in
// the durable workflow engine and replays across engine reconstruction (a fresh
// engine over the same durable state returns the journaled winner even when the
// live source no longer matches). The in-memory Effect.raceAll it replaces had
// no execution row to reconstruct, so it was lost on host restart.
describe("WaitForWorkflow durable wait_for_any restart", () => {
  let server: DurableStreamTestServer | undefined
  let baseUrl: string | undefined
  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    baseUrl = await server.start()
  })
  afterEach(async () => {
    await server?.stop()
    server = undefined
    baseUrl = undefined
  })

  const emptyStreams: RuntimeObservationStreamsService = {
    agentOutput: Stream.empty,
    agentOutputAfter: () => Stream.empty,
    initialAgentOutputAfter: () => Effect.succeed(Option.none()),
    agentOutputForContext: () => Stream.empty,
    callerFact: () => Stream.empty,
  }

  const runGeneration = <A>(
    streamUrl: string,
    streams: RuntimeObservationStreamsService,
    effect: Effect.Effect<A, unknown, RuntimeObservationStreams | WorkflowEngine.WorkflowEngine>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        effect.pipe(
          Effect.provide(
            WaitForWorkflowLayer.pipe(
              Layer.provideMerge(Layer.succeed(RuntimeObservationStreams, streams)),
              Layer.provideMerge(
                DurableStreamsWorkflowEngine.layer({ streamUrl }) as Layer.Layer<never, unknown, unknown>,
              ),
            ),
          ),
          Effect.provideService(RuntimeObservationStreams, streams),
        ) as Effect.Effect<A, unknown, never>,
      ),
    )

  it("tf-0xe4 a completed wait_for_any race survives engine reconstruction (replay from durable state)", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/wait-any-restart-${crypto.randomUUID()}`
    const payload = {
      executionKey: "wf-any-restart",
      source: { _tag: "CallerFact" as const, stream: "s0" },
      trigger: [{ path: ["correlationId"], equals: "target" }],
      additionalSources: [{
        source: { _tag: "CallerFact" as const, stream: "s1" },
        trigger: [{ path: ["correlationId"], equals: "target" }],
      }],
    }

    // Generation 1: source s1 matches -> the durable workflow races and
    // completes with the winning index, persisting the result.
    const matchStreams: RuntimeObservationStreamsService = {
      ...emptyStreams,
      callerFact: stream =>
        stream === "s1"
          ? Stream.fromIterable([{ correlationId: "target", payload: 99 }])
          : Stream.empty,
    }
    const first = await runGeneration(
      streamUrl,
      matchStreams,
      WaitForWorkflow.execute(payload),
    )
    expect(first).toEqual({
      _tag: "Match",
      raw: { correlationId: "target", payload: 99 },
      winnerIndex: 1,
    })

    // Generation 2 (host restart): a freshly reconstructed engine over the same
    // durable state, now with NO matching source. Re-executing the same
    // execution returns the journaled result from durable state — if the race
    // were in-memory (the old Effect.raceAll) or re-run here, the empty source
    // would never match. This is the survives-restart property.
    const replayed = await runGeneration(
      streamUrl,
      emptyStreams,
      WaitForWorkflow.execute(payload),
    )
    expect(replayed).toEqual({
      _tag: "Match",
      raw: { correlationId: "target", payload: 99 },
      winnerIndex: 1,
    })
  }, 20_000)
})

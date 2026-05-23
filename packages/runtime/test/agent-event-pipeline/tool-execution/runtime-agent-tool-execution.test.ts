import { Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRuntimeAgentToolExecutionService,
} from "../../../src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts"
import type { RuntimeWaitCompletionTable } from "../../../src/agent-event-pipeline/wait-routing/runtime-wait-completion.ts"
import type { RuntimeObservationStreams } from "../../../src/streams/index.ts"

// The send/call tests below do not touch the Shape C wait primitive, so
// these dummies satisfy the dispatcher's DI without exercising them. The
// wait-routing Shape C path has its own dedicated test
// (runtime-wait-completion.test.ts) with a real DurableTable + restart proof.
const dummyWaitCompletionTable = {} as RuntimeWaitCompletionTable["Type"]
const dummyObservationStreams = {
  agentOutput: Stream.empty,
  agentOutputAfter: () => Stream.empty,
  initialAgentOutputAfter: () => Effect.succeed(Option.none()),
  agentOutputForContext: () => Stream.empty,
  runtimeRun: Stream.empty,
  callerFact: () => Stream.empty,
} as RuntimeObservationStreams["Type"]

const buildService = () =>
  makeRuntimeAgentToolExecutionService({
    waitCompletionTable: dummyWaitCompletionTable,
    observationStreams: dummyObservationStreams,
  })

describe("RuntimeAgentToolExecution", () => {
  it("firegrid-agent-body-plan.SLICE_D_VERBS.2 send executes the validated append effect", async () => {
    const service = buildService()
    const appended: Array<unknown> = []

    const output = await Effect.runPromise(
      service.send({
        contextId: "ctx-send",
        toolUseId: "tool-send",
        input: {
          channel: "notification.operator",
          payload: { id: "event-1", message: "ready" },
        },
        append: Effect.sync(() => {
          appended.push({ id: "event-1", message: "ready" })
        }),
      }),
    )

    expect(output).toEqual({ sent: true, channel: "notification.operator" })
    expect(appended).toEqual([{ id: "event-1", message: "ready" }])
  })

  it("firegrid-agent-body-plan.SLICE_D_VERBS.3 call executes the validated callable effect", async () => {
    const service = buildService()

    const output = await Effect.runPromise(
      service.call({
        contextId: "ctx-call",
        toolUseId: "tool-call",
        input: {
          channel: "operator.call",
          request: { prompt: "approve" },
        },
        call: Effect.succeed({ approved: true }),
      }),
    )

    expect(output).toEqual({ approved: true })
  })

  // tf-28b8 (#676): wait_for / wait_for_any are now Shape C — a durable
  // completion row keyed by toolUseId, snapshot-first reads, source-replay
  // determinism. The race + winnerIndex + timeout + restart-survival proofs
  // live at the Shape C primitive level in
  // test/agent-event-pipeline/wait-routing/runtime-wait-completion.test.ts.
})

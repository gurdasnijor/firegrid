import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRuntimeAgentToolExecutionService,
} from "../../../src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts"

describe("RuntimeAgentToolExecution", () => {
  it("firegrid-agent-body-plan.SLICE_D_VERBS.2 send executes the validated append effect", async () => {
    const service = makeRuntimeAgentToolExecutionService()
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
    const service = makeRuntimeAgentToolExecutionService()

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

  // tf-0xe4: waitForAny is no longer an in-memory Effect.raceAll over host-side
  // `wait` effects — it routes the descriptor (source, trigger) pairs through
  // the durable WaitForWorkflow so an in-flight race survives host restart. The
  // race + winnerIndex + timeout behavior is covered at the workflow level in
  // test/workflow-engine/workflows/wait-for-workflow.test.ts (including a
  // durable-restart proof).
})

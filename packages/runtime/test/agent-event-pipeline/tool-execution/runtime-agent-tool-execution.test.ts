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

  it("firegrid-agent-body-plan.SLICE_D_VERBS.4 waitForAny returns the first winning descriptor", async () => {
    const service = makeRuntimeAgentToolExecutionService()

    const output = await Effect.runPromise(
      service.waitForAny({
        contextId: "ctx-wait-any",
        toolUseId: "tool-wait-any",
        input: {
          channels: [
            { channel: "state.rows", match: { status: "ready" } },
            { channel: "event.plan.ready", match: { status: "ready" } },
          ],
        },
        waits: [
          {
            winnerIndex: 0,
            channel: "state.rows",
            wait: Effect.never,
          },
          {
            winnerIndex: 1,
            channel: "event.plan.ready",
            wait: Effect.succeed({ id: "row-fast", status: "ready" }),
          },
        ],
      }),
    )

    expect(output).toEqual({
      winnerIndex: 1,
      channel: "event.plan.ready",
      result: { id: "row-fast", status: "ready" },
    })
  })

  it("waitForAny preserves the timed-out variant when no descriptor wins", async () => {
    const service = makeRuntimeAgentToolExecutionService()

    const output = await Effect.runPromise(
      service.waitForAny({
        contextId: "ctx-wait-any-timeout",
        toolUseId: "tool-wait-any-timeout",
        input: {
          channels: [{ channel: "state.rows", match: { status: "ready" } }],
          timeoutMs: 5,
        },
        waits: [
          {
            winnerIndex: 0,
            channel: "state.rows",
            wait: Effect.never,
          },
        ],
      }),
    )

    expect(output).toEqual({ timedOut: true })
  })
})

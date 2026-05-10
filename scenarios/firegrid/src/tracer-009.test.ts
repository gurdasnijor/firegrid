import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  RequiredActions,
  RequiredActionRuntimeLive,
  startRequiredAction,
} from "@firegrid/runtime"
import { Duration, Effect, Fiber } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let server: DurableStreamsTestServerHandle | undefined

beforeEach(async () => {
  server = await startDurableStreamsTestServer()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  return server.createStreamUrl(name)
}

describe("firegrid tracer 009 required actions", () => {
  it("firegrid-required-actions.RECORDS.1 firegrid-required-actions.RECORDS.2 firegrid-required-actions.RECORDS.3 firegrid-required-actions.WORKFLOW.1 firegrid-required-actions.WORKFLOW.2 firegrid-required-actions.WORKFLOW.3 firegrid-required-actions.WORKFLOW.4 firegrid-required-actions.WORKFLOW.5 firegrid-required-actions.BOUNDARY.1 firegrid-required-actions.BOUNDARY.2 firegrid-required-actions.BOUNDARY.3 firegrid-required-actions.BOUNDARY.4 proves required actions unblock through durable workflow state", async () => {
    const requiredActionStreamUrl = await createStreamUrl("tracer-009-required-action")
    const workflowStreamUrl = await createStreamUrl("tracer-009-workflow")
    const requiredActionId = `req_${crypto.randomUUID()}`

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(startRequiredAction({
          requiredActionId,
          runtimeContextId: "ctx_tracer_009",
          requestKind: "approval",
          subject: {
            kind: "opaque-runtime-event",
            eventId: "runtime-output-1",
          },
          prompt: {
            text: "Approve the opaque runtime action?",
          },
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
        }))

        const actions = yield* RequiredActions
        let state = yield* actions.get(requiredActionId)
        while (state.request === undefined) {
          yield* Effect.sleep(Duration.millis(5))
          state = yield* actions.get(requiredActionId)
        }

        yield* actions.resolve({
          requiredActionId,
          outcome: "approved",
          resolvedBy: "scenario:tracer-009",
          selectedOptionId: "approve",
          resolvedAt: "2026-05-09T00:00:00.000Z",
        })

        const decision = yield* Fiber.join(fiber)
        const duplicate = yield* actions.resolve({
          requiredActionId,
          outcome: "approved",
          resolvedBy: "scenario:tracer-009",
          selectedOptionId: "approve",
          resolvedAt: "2026-05-09T00:00:00.000Z",
        })
        const conflict = yield* actions.resolve({
          requiredActionId,
          outcome: "denied",
          resolvedBy: "scenario:tracer-009",
          selectedOptionId: "deny",
          resolvedAt: "2026-05-09T00:00:01.000Z",
        })

        return {
          decision,
          duplicate,
          conflict,
          state: yield* actions.get(requiredActionId),
          rows: yield* actions.rows,
        }
      }).pipe(
        Effect.provide(RequiredActionRuntimeLive({
          requiredActionStreamUrl,
          workflowStreamUrl,
          workerId: "tracer-009-worker",
        })),
      ),
    )

    expect(result.decision).toMatchObject({
      requiredActionId,
      outcome: "approved",
      resolvedBy: "scenario:tracer-009",
      selectedOptionId: "approve",
    })
    expect(result.duplicate).toEqual(result.decision)
    expect(result.conflict).toEqual(result.decision)
    expect(result.state.status).toBe("approved")
    expect(result.state.request).toMatchObject({
      requiredActionId,
      runtimeContextId: "ctx_tracer_009",
      requestKind: "approval",
    })
    expect(result.state.resolution).toEqual(result.decision)
    expect(result.rows.map(row => row.type)).toEqual([
      "firegrid.required_action.requested",
      "firegrid.required_action.resolved",
    ])
    expect(result.rows.filter(row => row.type === "firegrid.required_action.resolved")).toHaveLength(1)
  })
})

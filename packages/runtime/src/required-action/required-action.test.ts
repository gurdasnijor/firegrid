import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import { Duration, Effect, Fiber } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RequiredActions,
  RequiredActionRuntimeLive,
  startRequiredAction,
} from "./index.ts"

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

describe("required-action workflow", () => {
  it("firegrid-required-actions.RECORDS.1 firegrid-required-actions.RECORDS.2 firegrid-required-actions.RECORDS.3 firegrid-required-actions.WORKFLOW.1 firegrid-required-actions.WORKFLOW.2 firegrid-required-actions.WORKFLOW.3 firegrid-required-actions.BOUNDARY.1 firegrid-required-actions.BOUNDARY.2 firegrid-required-actions.BOUNDARY.3 firegrid-required-actions.BOUNDARY.4 records a durable request and resumes from durable resolution", async () => {
    const requiredActionStreamUrl = await createStreamUrl("required-action")
    const workflowStreamUrl = await createStreamUrl("required-action-workflow")
    const requiredActionId = `req_${crypto.randomUUID()}`

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(startRequiredAction({
          requiredActionId,
          runtimeContextId: "ctx_required_action",
          requestKind: "approval",
          subject: {
            kind: "opaque-tool-reference",
            id: "tool-call-1",
          },
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        }))

        const actions = yield* RequiredActions
        let state = yield* actions.get(requiredActionId)
        while (state.request === undefined) {
          yield* Effect.sleep(Duration.millis(5))
          state = yield* actions.get(requiredActionId)
        }

        const resolution = yield* actions.resolve({
          requiredActionId,
          outcome: "approved",
          resolvedBy: "operator:test",
          selectedOptionId: "allow",
        })
        const decision = yield* Fiber.join(fiber)
        const finalState = yield* actions.get(requiredActionId)
        const rows = yield* actions.rows

        return {
          resolution,
          decision,
          finalState,
          rows,
        }
      }).pipe(
        Effect.provide(RequiredActionRuntimeLive({
          requiredActionStreamUrl,
          workflowStreamUrl,
          workerId: "required-action-test-worker",
        })),
      ),
    )

    expect(result.decision).toMatchObject({
      requiredActionId,
      outcome: "approved",
      resolvedBy: "operator:test",
      selectedOptionId: "allow",
    })
    expect(result.resolution).toMatchObject(result.decision)
    expect(result.finalState.status).toBe("approved")
    expect(result.finalState.request).toMatchObject({
      requiredActionId,
      runtimeContextId: "ctx_required_action",
      requestKind: "approval",
    })
    expect(result.finalState.resolution).toMatchObject(result.decision)
    expect(result.rows.map(row => row.type)).toEqual([
      "firegrid.required_action.requested",
      "firegrid.required_action.resolved",
    ])
  })

  it("firegrid-required-actions.WORKFLOW.4 firegrid-required-actions.WORKFLOW.5 keeps the first terminal decision for duplicate and conflicting resolutions", async () => {
    const requiredActionStreamUrl = await createStreamUrl("required-action-idempotency")
    const workflowStreamUrl = await createStreamUrl("required-action-idempotency-workflow")
    const requiredActionId = `req_${crypto.randomUUID()}`

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actions = yield* RequiredActions
        yield* actions.request({
          requiredActionId,
          runtimeContextId: "ctx_idempotency",
          requestKind: "approval",
          subject: { kind: "opaque" },
        })
        const first = yield* actions.resolve({
          requiredActionId,
          outcome: "approved",
          resolvedBy: "operator:test",
          selectedOptionId: "allow",
          resolvedAt: "2026-05-09T00:00:00.000Z",
        })
        const duplicate = yield* actions.resolve({
          requiredActionId,
          outcome: "approved",
          resolvedBy: "operator:test",
          selectedOptionId: "allow",
          resolvedAt: "2026-05-09T00:00:00.000Z",
        })
        const conflict = yield* actions.resolve({
          requiredActionId,
          outcome: "denied",
          resolvedBy: "operator:test",
          selectedOptionId: "deny",
          resolvedAt: "2026-05-09T00:00:01.000Z",
        })
        const state = yield* actions.get(requiredActionId)
        const rows = yield* actions.rows

        return {
          first,
          duplicate,
          conflict,
          state,
          rows,
        }
      }).pipe(
        Effect.provide(RequiredActionRuntimeLive({
          requiredActionStreamUrl,
          workflowStreamUrl,
          workerId: "required-action-idempotency-worker",
        })),
      ),
    )

    expect(result.duplicate).toEqual(result.first)
    expect(result.conflict).toEqual(result.first)
    expect(result.state.status).toBe("approved")
    expect(result.state.resolution).toEqual(result.first)
    expect(result.rows.filter(row => row.type === "firegrid.required_action.resolved")).toHaveLength(1)
  })
})

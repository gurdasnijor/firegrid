import type { HttpClient } from "@effect/platform"
import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  RequiredActions,
  RequiredActionRuntimeLive,
  awaitRequiredActionWorkflow,
  requiredActionWorkflowExecutionId,
  runRequiredActionOperator,
  type RequiredActionRow,
  type RequiredActionState,
} from "@firegrid/runtime"
import { Duration, Effect } from "effect"
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

const waitForTokenizedRequest = (
  requiredActionId: string,
): Effect.Effect<RequiredActionState, never, RequiredActions | HttpClient.HttpClient> =>
  RequiredActions.pipe(
    Effect.flatMap(actions =>
      actions.get(requiredActionId).pipe(
        Effect.orDie,
        Effect.flatMap(state =>
          state.request?.workflowDeferredToken === undefined
            ? Effect.sleep(Duration.millis(10)).pipe(
              Effect.flatMap(() => waitForTokenizedRequest(requiredActionId)),
            )
            : Effect.succeed(state)),
      )),
  )

describe("firegrid tracer 013 reactive workflow operators", () => {
  it("firegrid-reactive-workflow-operators.OPERATOR.1 firegrid-reactive-workflow-operators.OPERATOR.2 firegrid-reactive-workflow-operators.OPERATOR.3 firegrid-reactive-workflow-operators.OPERATOR.4 firegrid-reactive-workflow-operators.REPLAY.1 firegrid-reactive-workflow-operators.REPLAY.2 firegrid-reactive-workflow-operators.REPLAY.3 firegrid-reactive-workflow-operators.WORKFLOW.1 firegrid-reactive-workflow-operators.WORKFLOW.2 firegrid-reactive-workflow-operators.WORKFLOW.3 firegrid-reactive-workflow-operators.WORKFLOW.5 firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.1 firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.4 firegrid-platform-invariants.AUTHORITY.8 runs required actions through the generic operator substrate", async () => {
    const requiredActionStreamUrl = await createStreamUrl("tracer-013-required-action")
    const workflowStreamUrl = await createStreamUrl("tracer-013-workflow")
    const requiredActionId = `req_${crypto.randomUUID()}`
    const executionId = requiredActionWorkflowExecutionId(requiredActionId)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actions = yield* RequiredActions
        yield* actions.request({
          requiredActionId,
          runtimeContextId: "ctx_tracer_013",
          requestKind: "approval",
          subject: {
            kind: "opaque-runtime-event",
            eventId: "runtime-output-013",
          },
          prompt: {
            text: "Approve the tracer 013 runtime action?",
          },
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
        })

        const firstRun = yield* runRequiredActionOperator()
        const waitingState = yield* waitForTokenizedRequest(requiredActionId)
        yield* actions.resolve({
          requiredActionId,
          outcome: "approved",
          resolvedBy: "scenario:tracer-013",
          selectedOptionId: "approve",
          resolvedAt: "2026-05-10T00:00:00.000Z",
        })
        const decision = yield* awaitRequiredActionWorkflow(requiredActionId)
        const rowsAfterDecision = yield* actions.rows
        const replayRun = yield* runRequiredActionOperator()
        const rowsAfterReplay = yield* actions.rows

        return {
          firstRun,
          waitingState,
          decision,
          rowsAfterDecision,
          replayRun,
          rowsAfterReplay,
          finalState: yield* actions.get(requiredActionId),
        }
      }).pipe(
        Effect.provide(RequiredActionRuntimeLive({
          requiredActionStreamUrl,
          workflowStreamUrl,
          workerId: "tracer-013-worker",
        })),
      ),
    )

    expect(result.firstRun).toMatchObject({
      operatorId: "firegrid.required-action",
      sourceId: "firegrid.required-action.rows",
      factsRead: 1,
      payloadsSelected: 1,
      duplicateInputsSkipped: 0,
      workflowExecutionsRequested: 1,
      executionIds: [executionId],
    })
    expect(result.waitingState.request?.workflowDeferredToken).toEqual(expect.any(String))
    expect(result.decision).toMatchObject({
      requiredActionId,
      outcome: "approved",
      resolvedBy: "scenario:tracer-013",
      selectedOptionId: "approve",
    })
    expect(result.finalState.status).toBe("approved")
    expect(result.finalState.resolution).toEqual(result.decision)
    expect(result.replayRun).toMatchObject({
      operatorId: "firegrid.required-action",
      sourceId: "firegrid.required-action.rows",
      payloadsSelected: 2,
      duplicateInputsSkipped: 1,
      workflowExecutionsRequested: 1,
      executionIds: [executionId],
    })
    expect(result.rowsAfterReplay).toHaveLength(result.rowsAfterDecision.length)
    expect(countRows(result.rowsAfterReplay, "firegrid.required_action.resolved")).toBe(1)
  })
})

const countRows = (
  rows: ReadonlyArray<RequiredActionRow>,
  type: RequiredActionRow["type"],
): number =>
  rows.filter(row => row.type === type).length

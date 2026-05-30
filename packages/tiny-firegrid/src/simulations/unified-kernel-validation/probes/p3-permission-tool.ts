/**
 * P3 — Permission roundtrip + tool dispatch — runtime probes.
 *
 *   - probeP3A: permission body writes open-request row, parks via
 *     `awaitSignal`, returns the decision delivered in the signal
 *     payload.
 *   - probeP3B: tool dispatch idempotency. Same toolUseId across two
 *     concurrent executes invokes the executor once; both return the
 *     same memoized resultJson.
 */

import { Effect, Option, Ref } from "effect"
import { sendSignal } from "../signal.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../substrate.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  makeToolExecutor,
  PERMISSION_DECISION_SIGNAL,
  type PermissionDecisionPayload,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
} from "../subscribers/permission-and-tool.ts"
import { permissionKey } from "../tables.ts"

export interface ProbeP3AResult {
  readonly openRequestRecorded: boolean
  readonly decision: string
}

export const probeP3A = (urls: GenerationUrls): Effect.Effect<ProbeP3AResult, unknown> =>
  runGeneration(
    {
      urls,
      workflowLayers: [buildPermissionRoundtripLayer()],
      catalog: makeCatalog([PermissionRoundtripWorkflow]),
    },
    (services) =>
      Effect.gen(function*() {
        const contextId = "ctx-perm"
        const permissionRequestId = "perm-1"
        const toolUseId = "tool-perm-1"
        const key = permissionKey(contextId, permissionRequestId)

        const executionId = yield* PermissionRoundtripWorkflow.executionId({
          contextId, permissionRequestId, toolUseId,
        })
        const fiber = yield* Effect.fork(
          PermissionRoundtripWorkflow.execute({
            contextId, permissionRequestId, toolUseId,
          }),
        )

        yield* Effect.sleep("100 millis")
        const requestRow = yield* services.unified.permissions.get(key).pipe(
          Effect.map(Option.getOrUndefined),
        )
        const openRequestRecorded = requestRow !== undefined && requestRow.toolUseId === toolUseId

        yield* sendSignal({
          signals: services.signals,
          workflow: PermissionRoundtripWorkflow,
          executionId,
          name: PERMISSION_DECISION_SIGNAL,
          write: () => Effect.void,
          value: { decision: "allow" } satisfies PermissionDecisionPayload,
          serializeValue: (v) => JSON.stringify(v),
        })

        const exit = yield* fiber.await
        if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
        return {
          openRequestRecorded,
          decision: exit.value.decision,
        } satisfies ProbeP3AResult
      }),
  )

export interface ProbeP3BResult {
  readonly invocations: number
  readonly resultsMatch: boolean
}

export const probeP3B = (urls: GenerationUrls): Effect.Effect<ProbeP3BResult, unknown> =>
  Effect.gen(function*() {
    const executor = yield* makeToolExecutor(
      (p) => JSON.stringify({ echoed: p.inputJson }),
    )
    return yield* runGeneration(
      {
        urls,
        workflowLayers: [buildToolDispatchLayer(executor)],
        catalog: makeCatalog([ToolDispatchWorkflow]),
      },
      () =>
        Effect.gen(function*() {
          const payload = {
            contextId: "ctx-tool",
            toolUseId: "tool-once-1",
            toolName: "echo",
            inputJson: JSON.stringify({ a: 1 }),
          }
          const both = yield* Effect.all(
            [
              ToolDispatchWorkflow.execute(payload),
              ToolDispatchWorkflow.execute(payload),
            ],
            { concurrency: 2 },
          ).pipe(Effect.orDie)
          const invocations = yield* Ref.get(executor.state.invocationCount)
          return {
            invocations,
            resultsMatch: both[0].resultJson === both[1].resultJson,
          } satisfies ProbeP3BResult
        }),
    )
  })

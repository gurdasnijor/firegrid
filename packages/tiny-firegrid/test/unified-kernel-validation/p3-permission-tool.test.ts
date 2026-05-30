/**
 * P3 — Permission roundtrip + tool dispatch.
 *
 * Two specialized workflow bodies:
 *
 *   - PermissionRoundtripWorkflow: writes a UI-renderable open request
 *     row (Activity-memoized), parks via `awaitSignal`, returns the
 *     decision delivered in the signal payload.
 *   - ToolDispatchWorkflow: Activity-memoized executor;
 *     idempotencyKey: ({ toolUseId }) admits one execution per logical
 *     tool call. No parallel `toolResults` table.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Effect, Option, Ref } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sendSignal } from "../../src/simulations/unified-kernel-validation/signal.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  makeToolExecutor,
  PERMISSION_DECISION_SIGNAL,
  type PermissionDecisionPayload,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
} from "../../src/simulations/unified-kernel-validation/subscribers/permission-and-tool.ts"
import {
  permissionKey,
} from "../../src/simulations/unified-kernel-validation/tables.ts"

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

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  signalTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.signals`),
})

// ── Permission roundtrip ────────────────────────────────────────────────────

describe("P3.1 — PermissionRoundtripWorkflow", () => {
  it("body parks until the responder sends the decision signal; returns it", async () => {
    const ns = `p3-perm-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-perm"
    const permissionRequestId = "perm-1"
    const toolUseId = "tool-perm-1"
    const key = permissionKey(contextId, permissionRequestId)

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildPermissionRoundtripLayer()],
          catalog: makeCatalog([PermissionRoundtripWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const executionId = yield* PermissionRoundtripWorkflow.executionId({
              contextId,
              permissionRequestId,
              toolUseId,
            })

            const fiber = yield* Effect.fork(
              PermissionRoundtripWorkflow.execute({
                contextId,
                permissionRequestId,
                toolUseId,
              }),
            )

            yield* Effect.sleep("100 millis")
            const requestRow = yield* services.unified.permissions.get(key).pipe(
              Effect.map(Option.getOrUndefined),
            )
            expect(requestRow).toBeDefined()
            expect(requestRow?.toolUseId).toBe(toolUseId)

            // Deliver the decision via the signal payload.
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
            return exit.value
          }) as Effect.Effect<{ readonly decision: string }, unknown>,
      ),
    )
    expect(outcome.decision).toBe("allow")
  }, 15_000)
})

// ── Tool dispatch ───────────────────────────────────────────────────────────

describe("P3.2 — ToolDispatchWorkflow", () => {
  it("idempotency: same toolUseId across two executes invokes the executor ONCE", async () => {
    const ns = `p3-tool-once-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-tool"
    const toolUseId = "tool-once-1"

    const outcome = await Effect.runPromise(
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
          (_services) =>
            Effect.gen(function*() {
              const payload = {
                contextId,
                toolUseId,
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
                result1: both[0],
                result2: both[1],
              }
            }),
        )
      }),
    )

    expect(outcome.invocations).toBe(1)
    /* eslint-disable @typescript-eslint/no-unsafe-member-access */
    expect(outcome.result1.resultJson).toBe(outcome.result2.resultJson)
    /* eslint-enable @typescript-eslint/no-unsafe-member-access */
  }, 15_000)
})

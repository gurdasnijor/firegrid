/**
 * P3 — Wait / Permission / Tool patterns as workflow bodies.
 *
 * Three subscribers, all on the same kernel primitive. Asserts the
 * unified shape covers the load-bearing Shape C/D patterns from
 * subscribers/{wait-router, runtime-context permission, tool-dispatch}/
 * without inventing primitives.
 *
 *   - wait_for: predicate-filtered fact observation with timeout
 *     (DurableClock — the one allowed Shape D parked body).
 *   - permission roundtrip: request, suspend, kernel-arm on response,
 *     return decision. No DurableDeferred mailbox.
 *   - tool dispatch: Activity-memoized executor; same toolUseId across
 *     retries returns same result without re-invoking. No separate
 *     runtime-tool-result table.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Option, Ref } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { kernelWriteArm } from "../../src/simulations/unified-kernel-validation/kernel.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  buildWaitForFactLayer,
  makeToolExecutor,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
  WaitForFactWorkflow,
} from "../../src/simulations/unified-kernel-validation/subscribers/wait-permission-tool.ts"
import {
  peerEventKey,
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
  kernelTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.kernel`),
})

// ── 1. wait_for ─────────────────────────────────────────────────────────────

describe("P3.1 — WaitForFactWorkflow", () => {
  it("matches when a fact arrives before timeout", async () => {
    const ns = `p3-wait-match-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const waitId = `wait-${crypto.randomUUID()}`
    const eventName = "test.event"
    const eventId = "evt-1"
    const factKey = peerEventKey(eventName, eventId)

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildWaitForFactLayer()],
          catalog: makeCatalog([WaitForFactWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const executionId = yield* WaitForFactWorkflow.executionId({
              channelTarget: eventName,
              factKey,
              factTable: "peerEvents",
              timeoutMs: 5_000,
              waitId,
            })

            // Start the wait body in a forked fiber.
            const fiber = yield* Effect.fork(
              WaitForFactWorkflow.execute({
                channelTarget: eventName,
                factKey,
                factTable: "peerEvents",
                timeoutMs: 5_000,
                waitId,
              }),
            )

            // Give body time to park.
            yield* Effect.sleep("100 millis")

            // Write the fact + arm the workflow.
            yield* kernelWriteArm({
              kernel: services.kernel,
              workflow: WaitForFactWorkflow,
              executionId,
              inputTable: "peerEvents",
              inputKey: factKey,
              write: () =>
                services.unified.peerEvents.insertOrGet({
                  eventKey: factKey,
                  name: eventName,
                  eventId,
                  emitterContextId: "ctx-emit",
                  payloadJson: JSON.stringify({ x: 1 }),
                  emittedAt: new Date().toISOString(),
                }).pipe(Effect.orDie, Effect.asVoid),
              value: { factKey, eventId },
              serializeValue: (v) => JSON.stringify(v),
            })

            const exit = yield* fiber.await
            if (exit._tag === "Failure") {
              return yield* Effect.failCause(exit.cause)
            }
            return exit.value as {
              readonly matched: boolean
              readonly timedOut: boolean
              readonly factKey?: string
            }
          }) as Effect.Effect<
            { readonly matched: boolean; readonly timedOut: boolean; readonly factKey?: string },
            unknown
          >,
      ),
    )
    expect(outcome.matched).toBe(true)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.factKey).toBe(factKey)
  }, 15_000)

  it("times out when no fact arrives", async () => {
    const ns = `p3-wait-timeout-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const waitId = `wait-${crypto.randomUUID()}`

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildWaitForFactLayer()],
          catalog: makeCatalog([WaitForFactWorkflow]),
        },
        (_services) =>
          (WaitForFactWorkflow.execute({
            channelTarget: "test.never",
            factKey: peerEventKey("test.never", "never"),
            factTable: "peerEvents",
            timeoutMs: 200,
            waitId,
          }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>),
      ),
    )
    expect(outcome.matched).toBe(false)
    expect(outcome.timedOut).toBe(true)
  }, 10_000)
})

// ── 2. Permission roundtrip ─────────────────────────────────────────────────

describe("P3.2 — PermissionRoundtripWorkflow", () => {
  it("body parks until host updates permission row to responded; returns decision", async () => {
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

            // Give body time to record request + park.
            yield* Effect.sleep("100 millis")
            const requestRow = yield* services.unified.permissions.get(key).pipe(
              Effect.map(Option.getOrUndefined),
            )
            expect(requestRow?.status).toBe("pending")

            // Host updates row to "responded" + arms.
            yield* kernelWriteArm({
              kernel: services.kernel,
              workflow: PermissionRoundtripWorkflow,
              executionId,
              inputTable: "permissions",
              inputKey: key,
              write: () =>
                services.unified.permissions.upsert({
                  permissionKey: key,
                  contextId,
                  permissionRequestId,
                  toolUseId,
                  status: "responded",
                  decisionJson: JSON.stringify("allow"),
                  requestedAt: requestRow!.requestedAt,
                  respondedAt: new Date().toISOString(),
                }).pipe(Effect.orDie, Effect.asVoid),
              value: { decision: "allow" },
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

// ── 3. Tool dispatch ────────────────────────────────────────────────────────

describe("P3.3 — ToolDispatchWorkflow", () => {
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(outcome.result1.resultJson).toBe(outcome.result2.resultJson)
  }, 15_000)
})

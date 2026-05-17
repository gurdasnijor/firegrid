/**
 * AtMostOnce semantic test for local-process stdin delivery.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.4
 *  - firegrid-agent-ingress.DELIVERY.3
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeIngressTable,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  LocalProcessStdinDeliveryError,
  localProcessStdinDelivery,
} from "../../../src/agent-event-pipeline/sources/sandbox/local-process-stdin-delivery.ts"
import type {
  RuntimeIngressInputStream,
} from "../../../src/durable-tools/internal/runtime-ingress-input-stream.ts"
import {
  RuntimeIngressInputStream as RuntimeIngressInputStreamTag,
} from "../../../src/durable-tools/internal/runtime-ingress-input-stream.ts"
import {
  SandboxStdinEmissionClaimLive,
  SandboxSupervisorCommandTable,
} from "../../../src/agent-event-pipeline/sources/sandbox/supervisor-commands.ts"
import type {
  SandboxStdinEmissionClaim,
} from "../../../src/agent-event-pipeline/sources/sandbox/supervisor-commands.ts"

let server: DurableStreamTestServer
let baseUrl: string | undefined

beforeAll(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})
afterAll(async () => {
  await server.stop()
  baseUrl = undefined
})

const runScopedTestEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const makeRow = (
  contextId: string,
  inputId: string,
  text: string,
  sequence = 0,
): RuntimeIngressInputRow => ({
  inputId,
  contextId,
  sequence,
  status: "sequenced",
  kind: "message",
  authoredBy: "client",
  payload: { type: "text", text },
  createdAt: "2026-05-12T00:00:00.000Z",
  sequencedAt: "2026-05-12T00:00:01.000Z",
})

const deliveryLayer = (
  tableLayer: Layer.Layer<RuntimeIngressTable, unknown>,
  supervisorTableLayer: Layer.Layer<SandboxSupervisorCommandTable, unknown>,
): Layer.Layer<
  | RuntimeIngressTable
  | RuntimeIngressInputStream
  | SandboxSupervisorCommandTable
  | SandboxStdinEmissionClaim,
  unknown,
  never
> =>
  Layer.effect(
    RuntimeIngressInputStreamTag,
    Effect.map(RuntimeIngressTable, table => table.inputs.rows()),
  ).pipe(
    Layer.provideMerge(tableLayer),
    Layer.provideMerge(SandboxStdinEmissionClaimLive.pipe(
      Layer.provideMerge(supervisorTableLayer),
    )),
  ) as unknown as Layer.Layer<
    | RuntimeIngressTable
    | RuntimeIngressInputStream
    | SandboxSupervisorCommandTable
    | SandboxStdinEmissionClaim,
    unknown,
    never
  >

describe("localProcessStdinDelivery", () => {
  it("effect-durable-operators.FIREGRID_PROOF.4 firegrid-agent-ingress.DELIVERY.3 AtMostOnce: failure between claim and byte emission durably skips the row on restart", async () => {
    if (!baseUrl) throw new Error("server not started")
    const tableUrl = `${baseUrl}/v1/stream/runtime-ingress-atmost-${crypto.randomUUID()}.firegrid.runtimeIngress`
    const supervisorTableUrl = `${baseUrl}/v1/stream/sandbox-supervisor-atmost-${crypto.randomUUID()}.firegrid.sandboxSupervisor`
    const contextId = "ctx-am1"
    const inputId = "input-1"
    const tableLayer = RuntimeIngressTable.layer({
      streamOptions: {
        url: tableUrl,
        contentType: "application/json",
      },
    })
    const supervisorTableLayer = SandboxSupervisorCommandTable.layer({
      streamOptions: {
        url: supervisorTableUrl,
        contentType: "application/json",
      },
    })

    await runScopedTestEffect(Effect.scoped(
      Effect.gen(function* () {
        const table = yield* RuntimeIngressTable
        yield* table.inputs.insert(makeRow(contextId, inputId, "hello-once"))
      }).pipe(Effect.provide(tableLayer)),
    ))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            contextId,
            onClaimedBeforeEmit: () =>
              Effect.fail(
                new LocalProcessStdinDeliveryError({
                  op: "test-injected",
                  contextId,
                  inputId,
                  message: "failure injected between claim and emit",
                }),
              ),
          })

          const result = yield* Stream.runCollect(deliveryStream).pipe(
            Effect.either,
          )
          expect(result._tag).toBe("Left")
        }).pipe(
          // RuntimeIngressTable.layer currently widens its service type to any
          // in tests; the target service is RuntimeIngressTable.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          Effect.provide(deliveryLayer(tableLayer, supervisorTableLayer)),
        ),
      ),
    )

    const claimed = await runScopedTestEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const table = yield* SandboxSupervisorCommandTable
          return yield* table.stdinEmissionClaims.rows().pipe(
            Stream.filter(row => row.contextId === contextId && row.inputId === inputId),
            Stream.runHead,
          )
        }).pipe(Effect.provide(supervisorTableLayer)),
      ),
    )
    expect(Option.isSome(claimed)).toBe(true)
    if (Option.isSome(claimed)) {
      expect(typeof claimed.value.claimedAtMs).toBe("number")
    }

    const secondRunChunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            contextId,
          })
          const chunks: Array<Uint8Array> = []
          const fiber = yield* Effect.fork(
            Stream.runForEach(deliveryStream, (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk)
              }),
            ),
          )
          yield* Effect.sleep("250 millis")
          yield* Fiber.interrupt(fiber)
          return chunks
        }).pipe(
          // RuntimeIngressTable.layer currently widens its service type to any
          // in tests; the target service is RuntimeIngressTable.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          Effect.provide(deliveryLayer(tableLayer, supervisorTableLayer)),
        ),
      ),
    )

    expect(secondRunChunks).toEqual([])
  })

  it("effect-durable-operators.FIREGRID_PROOF.4 emits one chunk for an unclaimed input row", async () => {
    if (!baseUrl) throw new Error("server not started")
    const tableUrl = `${baseUrl}/v1/stream/runtime-ingress-happy-${crypto.randomUUID()}.firegrid.runtimeIngress`
    const supervisorTableUrl = `${baseUrl}/v1/stream/sandbox-supervisor-happy-${crypto.randomUUID()}.firegrid.sandboxSupervisor`
    const contextId = "ctx-happy"
    const inputId = "input-happy"
    const tableLayer = RuntimeIngressTable.layer({
      streamOptions: {
        url: tableUrl,
        contentType: "application/json",
      },
    })
    const supervisorTableLayer = SandboxSupervisorCommandTable.layer({
      streamOptions: {
        url: supervisorTableUrl,
        contentType: "application/json",
      },
    })

    await runScopedTestEffect(Effect.scoped(
      Effect.gen(function* () {
        const table = yield* RuntimeIngressTable
        yield* table.inputs.insert(makeRow(contextId, inputId, "hello"))
      }).pipe(Effect.provide(tableLayer)),
    ))

    const decoder = new TextDecoder()
    const chunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            contextId,
          })
          const collected: Array<string> = []
          const fiber = yield* Effect.fork(
            Stream.runForEach(deliveryStream, (chunk) =>
              Effect.sync(() => {
                collected.push(decoder.decode(chunk))
              }),
            ),
          )
          yield* Effect.sleep("250 millis")
          yield* Fiber.interrupt(fiber)
          return collected
        }).pipe(
          // RuntimeIngressTable.layer currently widens its service type to any
          // in tests; the target service is RuntimeIngressTable.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          Effect.provide(deliveryLayer(tableLayer, supervisorTableLayer)),
        ),
      ),
    )

    expect(chunks).toEqual(["hello\n"])
  })

  it("firegrid-runtime-agent-event-pipeline.STAGES.7 preserves RuntimeIngressAppender sequence order before stdin delivery", async () => {
    if (!baseUrl) throw new Error("server not started")
    const tableUrl = `${baseUrl}/v1/stream/runtime-ingress-order-${crypto.randomUUID()}.firegrid.runtimeIngress`
    const supervisorTableUrl = `${baseUrl}/v1/stream/sandbox-supervisor-order-${crypto.randomUUID()}.firegrid.sandboxSupervisor`
    const contextId = "ctx-order"
    const tableLayer = RuntimeIngressTable.layer({
      streamOptions: {
        url: tableUrl,
        contentType: "application/json",
      },
    })
    const supervisorTableLayer = SandboxSupervisorCommandTable.layer({
      streamOptions: {
        url: supervisorTableUrl,
        contentType: "application/json",
      },
    })

    await runScopedTestEffect(Effect.scoped(
      Effect.gen(function* () {
        const table = yield* RuntimeIngressTable
        yield* table.inputs.insert(makeRow(contextId, "input-continue", "continue", 1))
        yield* table.inputs.insert(makeRow(contextId, "input-start", "start", 0))
      }).pipe(Effect.provide(tableLayer)),
    ))

    const decoder = new TextDecoder()
    const chunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            contextId,
          })
          const collected: Array<string> = []
          const fiber = yield* Effect.fork(
            Stream.runForEach(deliveryStream, (chunk) =>
              Effect.sync(() => {
                collected.push(decoder.decode(chunk))
              }),
            ),
          )
          yield* Effect.sleep("250 millis")
          yield* Fiber.interrupt(fiber)
          return collected
        }).pipe(
          // RuntimeIngressTable.layer currently widens its service type to any
          // in tests; the target service is RuntimeIngressTable.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          Effect.provide(deliveryLayer(tableLayer, supervisorTableLayer)),
        ),
      ),
    )

    expect(chunks).toEqual(["start\n", "continue\n"])
  })
})

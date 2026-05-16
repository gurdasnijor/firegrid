import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeIngressTable,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
  RuntimeIngressInputStream,
} from "./runtime-ingress-appender.ts"
import {
  RuntimeIngressDeliveries,
  RuntimeIngressDeliveryClaimAndComplete,
  RuntimeIngressDeliveryTrackerLayer,
  runtimeIngressSubscriberId,
} from "./runtime-ingress-delivery-tracker.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"

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

const tableLayer = (name: string) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: `${baseUrl}/v1/stream/${name}.firegrid.runtimeIngress`,
      contentType: "application/json",
    },
  })

describe("runtime ingress authorities", () => {
  it("firegrid-runtime-agent-event-pipeline.AUTHORITIES.3 appends sequenced input rows idempotently", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const contextId = `ctx_${crypto.randomUUID()}`
    const first: RuntimeIngressRequest = {
      contextId,
      inputId: "input-one",
      kind: "message",
      authoredBy: "client",
      payload: { text: "one" },
      idempotencyKey: "one",
    }
    const second: RuntimeIngressRequest = {
      contextId,
      inputId: "input-two",
      kind: "message",
      authoredBy: "client",
      payload: { text: "two" },
      idempotencyKey: "two",
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const appender = yield* RuntimeIngressAppendAndGet
        const _ingressInputs = yield* RuntimeIngressInputStream
        const firstRow = yield* appender.append(first)
        const duplicate = yield* appender.append(first)
        const secondRow = yield* appender.append(second)
        return {
          firstRow,
          duplicate,
          secondRow,
          sourceName: RuntimeAuthoritySourceNames.runtimeIngressInputs,
        }
      }).pipe(
        Effect.provide(RuntimeIngressAppenderLayer({ currentContextId: contextId })),
        Effect.provide(tableLayer(`runtime-ingress-appender-${crypto.randomUUID()}`)),
        Effect.scoped,
      ),
    )

    expect(result.firstRow.inputId).toBe("input-one")
    expect(result.firstRow.status).toBe("sequenced")
    expect(result.firstRow.sequence).toBe(0)
    expect(result.duplicate).toEqual(result.firstRow)
    expect(result.secondRow.sequence).toBe(1)
    expect(result.sourceName).toBe(RuntimeAuthoritySourceNames.runtimeIngressInputs)
  })

  it("firegrid-runtime-agent-event-pipeline.AUTHORITIES.4 claims delivery rows once per subscriber", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const contextId = `ctx_${crypto.randomUUID()}`
    const request: RuntimeIngressRequest = {
      contextId,
      inputId: "input-claim",
      kind: "message",
      authoredBy: "client",
      payload: "hello",
      idempotencyKey: "claim",
    }
    const subscriberId = runtimeIngressSubscriberId("raw", "stdin")

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const appender = yield* RuntimeIngressAppendAndGet
        const tracker = yield* RuntimeIngressDeliveryClaimAndComplete
        const _ingressDeliveries = yield* RuntimeIngressDeliveries
        const row = yield* appender.append(request)
        const first = yield* tracker.claimInput(row, {
          subscriberId,
        })
        const second = yield* tracker.claimInput(row, {
          subscriberId,
        })
        return {
          first,
          second,
          sourceName: RuntimeAuthoritySourceNames.runtimeIngressDeliveries,
        }
      }).pipe(
        Effect.provide(RuntimeIngressAppenderLayer({ currentContextId: contextId })),
        Effect.provide(RuntimeIngressDeliveryTrackerLayer),
        Effect.provide(tableLayer(`runtime-ingress-delivery-${crypto.randomUUID()}`)),
        Effect.scoped,
      ),
    )

    expect(Option.isSome(result.first)).toBe(true)
    expect(Option.isNone(result.second)).toBe(true)
    expect(result.sourceName).toBe(RuntimeAuthoritySourceNames.runtimeIngressDeliveries)
  })
})

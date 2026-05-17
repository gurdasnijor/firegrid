import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeIngressTable,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import {
  RuntimeIngressInputStream,
} from "@firegrid/runtime/durable-tools"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
} from "../../src/host/runtime-ingress.ts"

const ingressInputsSourceName = "firegrid.runtime.ingress.inputs"

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

describe("host runtime ingress append authority", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 appends sequenced input rows idempotently behind the host-sdk seam", async () => {
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
          sourceName: ingressInputsSourceName,
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
    expect(result.sourceName).toBe(ingressInputsSourceName)
  })
})

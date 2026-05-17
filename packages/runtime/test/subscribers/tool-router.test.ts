import { Prompt } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  RuntimeOutputTable,
  type HostId,
  type RuntimeContext,
  type RuntimeEventRow,
} from "@firegrid/protocol/launch"
import { RuntimeIngressTable } from "@firegrid/protocol/runtime-ingress"
import { Effect, Fiber, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { toolResult } from "@firegrid/host-sdk/agent-tools/bindings"
import {
  RuntimeIngressAppenderLayer,
} from "../../src/agent-event-pipeline/authorities/runtime-ingress-appender.ts"
import {
  RuntimeEventAppendAndGet,
  RuntimeOutputJournalLayer,
} from "../../src/agent-event-pipeline/authorities/runtime-output-journal.ts"
import { encodeRuntimeAgentOutputEnvelope } from "../../src/agent-event-pipeline/events/index.ts"
import { runToolRouter } from "../../src/agent-event-pipeline/subscribers/tool-router.ts"
import { RuntimeToolUseExecutor } from "../../src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts"

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

const outputTableLayer = (name: string) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: `${baseUrl}/v1/stream/${name}.firegrid.runtimeOutput`,
      contentType: "application/json",
    },
  })

const ingressTableLayer = (name: string) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: `${baseUrl}/v1/stream/${name}.firegrid.runtimeIngress`,
      contentType: "application/json",
    },
  })

const testContext = (contextId: string): RuntimeContext => ({
  contextId,
  createdAt: new Date().toISOString(),
  runtime: normalizeRuntimeIntent(local.jsonl({
    argv: ["node", "-e", "process.exit(0)"],
  })),
  host: {
    hostId: "host_test" as HostId,
    streamPrefix: makeHostStreamPrefix({
      namespace: "test",
      hostId: "host_test" as HostId,
    }),
    boundAtMs: 0,
  },
})

const committedToolUseRow = (input: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly sequence: number
  readonly toolUseId: string
}): RuntimeEventRow => ({
  eventId: {
    contextId: input.context.contextId,
    activityAttempt: input.activityAttempt,
    target: "events",
    sequence: input.sequence,
  },
  contextId: input.context.contextId,
  activityAttempt: input.activityAttempt,
  sequence: input.sequence,
  source: "stdout",
  format: "jsonl",
  receivedAt: new Date().toISOString(),
  raw: encodeRuntimeAgentOutputEnvelope({
    _tag: "ToolUse",
    part: Prompt.toolCallPart({
      id: input.toolUseId,
      name: "sleep",
      params: { durationMs: "bad-duration" },
      providerExecuted: false,
    }),
  }),
})

const runWith = <A, E>(
  layer: Layer.Layer<unknown, unknown, unknown>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<
      A,
      unknown,
      never
    >,
  )

describe("runtime tool router subscriber", () => {
  it("firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1 firegrid-runtime-agent-event-pipeline.VALIDATION.5 firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1 replays committed RuntimeOutput ToolUse rows through RuntimeToolUseExecutor into deterministic ToolResult ingress", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const streamId = `tool-router-replay-${crypto.randomUUID()}`
    const context = testContext(`ctx_${crypto.randomUUID()}`)
    const outputCapabilities = RuntimeOutputJournalLayer.pipe(
      Layer.provideMerge(outputTableLayer(streamId)),
    )
    const ingressCapabilities = RuntimeIngressAppenderLayer({
      currentContextId: context.contextId,
    }).pipe(
      Layer.provideMerge(ingressTableLayer(streamId)),
    )
    const layer = Layer.mergeAll(
      outputCapabilities,
      ingressCapabilities,
      RuntimeToolUseExecutor.layer({
        execute: (_context, event) =>
          Effect.succeed(toolResult(event.part.id, event.part.name, { ok: true })),
      }),
    )

    const result = await runWith(
      layer,
      Effect.gen(function* () {
        const ingress = yield* RuntimeIngressTable
        const appendEvent = yield* RuntimeEventAppendAndGet
        yield* appendEvent.append(
          committedToolUseRow({
            context,
            activityAttempt: 1,
            sequence: 0,
            toolUseId: "tool-replay",
          }),
        )
        const router = yield* runToolRouter({
          context,
          activityAttempt: 1,
          toolUseMode: "client_result_roundtrip",
        }).pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")
        const first = yield* ingress.inputs.get(
          `agent-tool-result:${context.contextId}:1:tool-replay:result`,
        )
        yield* Fiber.interrupt(router)
        const routerAfterReconstruction = yield* runToolRouter({
          context,
          activityAttempt: 1,
          toolUseMode: "client_result_roundtrip",
        }).pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")
        yield* Fiber.interrupt(routerAfterReconstruction)
        const rows = yield* ingress.inputs.query(coll =>
          coll.toArray.filter(row =>
            row.contextId === context.contextId &&
            row.kind === "tool_result" &&
            row.authoredBy === "tool",
          ))
        return { first, rows }
      }),
    )

    expect(Option.isSome(result.first)).toBe(true)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      inputId: `agent-tool-result:${context.contextId}:1:tool-replay:result`,
      contextId: context.contextId,
      kind: "tool_result",
      authoredBy: "tool",
      idempotencyKey: `agent-tool-result:${context.contextId}:1:tool-replay`,
      status: "sequenced",
    })
  })
})

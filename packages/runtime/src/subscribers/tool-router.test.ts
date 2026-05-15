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
import { AgentToolHost } from "../agent-tools/tool-host.ts"
import { toolExecutionFailed } from "../agent-tools/tool-error.ts"
import {
  RuntimeIngressAppender,
  RuntimeOutputJournal,
} from "../authorities/index.ts"
import { encodeRuntimeAgentOutputEnvelope } from "../events/index.ts"
import { runToolRouter } from "./tool-router.ts"

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
  layer: Layer.Layer<never, unknown, never>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<
      A,
      unknown,
      never
    >,
  )

const unusedToolHostEffect = () =>
  Effect.fail(toolExecutionFailed("unused", "unused", "unused"))

describe("runtime tool router subscriber", () => {
  it("firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1 firegrid-runtime-agent-event-pipeline.VALIDATION.5 replays committed RuntimeOutput ToolUse rows into deterministic ToolResult ingress", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const streamId = `tool-router-replay-${crypto.randomUUID()}`
    const context = testContext(`ctx_${crypto.randomUUID()}`)
    const layer = Layer.mergeAll(
      outputTableLayer(streamId),
      ingressTableLayer(streamId),
      AgentToolHost.layer({
        spawnChildContext: unusedToolHostEffect,
        spawnChildContexts: unusedToolHostEffect,
        executeSandboxTool: unusedToolHostEffect,
        executeSessionCapability: unusedToolHostEffect,
        appendSessionPrompt: unusedToolHostEffect,
        cancelSession: unusedToolHostEffect,
        closeSession: unusedToolHostEffect,
        appendScheduledPrompt: unusedToolHostEffect,
      }),
    ) as Layer.Layer<never, unknown, never>

    const result = await runWith(
      layer,
      Effect.gen(function* () {
        const output = yield* RuntimeOutputTable
        const ingress = yield* RuntimeIngressTable
        yield* RuntimeOutputJournal.writeEventTo(
          output,
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
          source: RuntimeOutputJournal.sources(output).agentOutputEvents,
          ingressAuthority: {
            findInput: inputId => ingress.inputs.get(inputId),
            append: request =>
              RuntimeIngressAppender.appendTo(ingress, request, {
                currentContextId: context.contextId,
              }),
          },
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
          source: RuntimeOutputJournal.sources(output).agentOutputEvents,
          ingressAuthority: {
            findInput: inputId => ingress.inputs.get(inputId),
            append: request =>
              RuntimeIngressAppender.appendTo(ingress, request, {
                currentContextId: context.contextId,
              }),
          },
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

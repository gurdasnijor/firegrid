import { FetchHttpClient, type HttpClient } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import { NodeContext } from "@effect/platform-node"
import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  RuntimeJournalEventSchema,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import {
  runStreamNativeRuntimeLoop,
} from "@firegrid/runtime"
import {
  runtimeIngressRequestedRowId,
  RuntimeIngressRequestedRowSchema,
  RuntimeIngressRowSchema,
  type RuntimeIngressRow,
} from "@firegrid/runtime/runtime-ingress"
import { Effect, Layer, type Scope, Schema } from "effect"
import { DurableStream } from "effect-durable-streams"
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

type RuntimeRequirements =
  | CommandExecutor
  | FetchHttpClient.Fetch
  | HttpClient.HttpClient
  | Scope.Scope

const Live = Layer.mergeAll(FetchHttpClient.layer, NodeContext.layer)

const runRuntime = <A, E>(
  effect: Effect.Effect<A, E, RuntimeRequirements>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(Live))) as Effect.Effect<A, E, never>,
  )

const nodeEchoCommand = (): ReadonlyArray<string> => [
  process.execPath,
  "-e",
  [
    "process.stdin.setEncoding('utf8')",
    "let input = ''",
    "process.stdin.on('data', chunk => { input += chunk })",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify({ type: 'assistant', text: `fixture received ${input.trim()}` }))",
    "})",
  ].join(";"),
]

const runtimeIngressRequestedRow = (
  options: {
    readonly contextId: string
    readonly ingressId: string
    readonly prompt: string
  },
) =>
  Schema.decodeUnknownSync(RuntimeIngressRequestedRowSchema)({
    type: "firegrid.runtime_ingress.requested",
    id: runtimeIngressRequestedRowId(options.contextId, options.ingressId),
    at: "2026-05-10T00:00:00.000Z",
    ingressId: options.ingressId,
    contextId: options.contextId,
    kind: "message",
    authoredBy: "client",
    payload: [{ type: "text", text: options.prompt }],
    createdAt: "2026-05-10T00:00:00.000Z",
    idempotencyKey: "tracer-015-one-prompt",
    metadata: { tracer: "015" },
  })

describe("firegrid tracer 015 stream-native runtime loop validation", () => {
  it("stream-native-runtime-loop.LOOP.1 stream-native-runtime-loop.LOOP.2 stream-native-runtime-loop.LOOP.3 stream-native-runtime-loop.LOOP.4 stream-native-runtime-loop.SCENARIO.1 stream-native-runtime-loop.SCENARIO.2 stream-native-runtime-loop.SCENARIO.3 delivers one durable ingress row through the stream-native validation path", async () => {
    const ingressUrl = await createStreamUrl("tracer-015-ingress")
    const outputUrl = await createStreamUrl("tracer-015-runtime-output")
    const contextId = `ctx_${crypto.randomUUID()}`
    const ingressId = `ing_${crypto.randomUUID()}`
    const subscriberId = "tracer-015-local-process"
    const prompt = "Say exactly pong."
    const ingressStream = DurableStream.define({
      endpoint: { url: ingressUrl },
      schema: RuntimeIngressRowSchema,
    })
    const outputStream = DurableStream.define({
      endpoint: { url: outputUrl },
      schema: RuntimeJournalEventSchema,
    })

    const result = await runRuntime(
      Effect.gen(function* () {
        yield* ingressStream.append(runtimeIngressRequestedRow({
          contextId,
          ingressId,
          prompt,
        }))

        const first = yield* runStreamNativeRuntimeLoop({
          ingressEndpoint: { url: ingressUrl },
          outputEndpoint: { url: outputUrl },
          contextId,
          subscriberId,
          provider: "local-process",
          command: { argv: nodeEchoCommand() },
        })
        const ingressAfterFirst = yield* ingressStream.collect
        const outputAfterFirst = yield* outputStream.collect

        const second = yield* runStreamNativeRuntimeLoop({
          ingressEndpoint: { url: ingressUrl },
          outputEndpoint: { url: outputUrl },
          contextId,
          subscriberId,
          provider: "local-process",
          command: { argv: nodeEchoCommand() },
        })
        const ingressAfterSecond = yield* ingressStream.collect
        const outputAfterSecond = yield* outputStream.collect

        return {
          first,
          second,
          ingressAfterFirst,
          outputAfterFirst,
          ingressAfterSecond,
          outputAfterSecond,
        }
      }),
    )

    expect(result.first).toMatchObject({
      contextId,
      subscriberId,
      pendingRows: 1,
      deliveredRowsWritten: 1,
      promptsDelivered: 1,
      exitCode: 0,
    })
    expect(result.first.outputRowsWritten).toBeGreaterThanOrEqual(1)
    expect(result.second).toMatchObject({
      contextId,
      subscriberId,
      pendingRows: 0,
      deliveredRowsWritten: 0,
      promptsDelivered: 0,
      outputRowsWritten: 0,
    })

    const ingressRows = result.ingressAfterSecond.map(row =>
      Schema.decodeUnknownSync(RuntimeIngressRowSchema)(row)) as ReadonlyArray<RuntimeIngressRow>
    expect(ingressRows.filter(row => row.type === "firegrid.runtime_ingress.requested")).toHaveLength(1)
    expect(ingressRows.filter(row => row.type === "firegrid.runtime_ingress.delivered")).toHaveLength(1)

    expect(result.outputAfterSecond).toHaveLength(result.outputAfterFirst.length)
    const stdoutRows = result.outputAfterSecond
      .map(row => Schema.decodeUnknownSync(RuntimeJournalEventSchema)(row))
      .filter((row): row is Extract<RuntimeJournalEvent, { readonly type: "firegrid.runtime.output.stdout" }> =>
        row.type === "firegrid.runtime.output.stdout")
    expect(stdoutRows).toHaveLength(1)
    const [stdoutRow] = stdoutRows
    if (stdoutRow === undefined) throw new Error("expected one retained stdout runtime-output row")
    expect(JSON.parse(stdoutRow.event.raw)).toMatchObject({
      type: "assistant",
      text: `fixture received ${prompt}`,
    })
  })
})

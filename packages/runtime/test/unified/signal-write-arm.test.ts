import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client-sdk/firegrid"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Effect, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "../../src/engine/durable-streams-workflow-engine.ts"
import {
  RuntimeContextSessionAdapter,
  type SessionInputPayload,
} from "../../src/unified/adapter.ts"
import { FiregridHost } from "../../src/unified/host.ts"
import {
  recordSignal,
  SignalTable,
} from "../../src/unified/signal.ts"
import {
  encodeRuntimeContextSessionPayloadJson,
  RuntimeContextSessionWorkflow,
} from "../../src/unified/subscribers/runtime-context.ts"
import {
  makeRecorderAdapter,
  type RecorderAdapter,
} from "../helpers/recorder-adapter.ts"

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

const requireBaseUrl = (): string => {
  if (baseUrl === undefined) throw new Error("server not started")
  return baseUrl
}

const jsonStreamOptions = (url: string) => ({
  url,
  contentType: "application/json",
})

const engineStreamUrl = (namespace: string): string =>
  durableStreamUrl(requireBaseUrl(), `${namespace}.firegrid.engine`)

const signalStreamUrl = (namespace: string): string =>
  durableStreamUrl(requireBaseUrl(), `${namespace}.firegrid.signals`)

const recorderLayer = (recorder: RecorderAdapter) =>
  Layer.succeed(RuntimeContextSessionAdapter, recorder.service)

const hostClientLayer = (namespace: string, recorder: RecorderAdapter) => {
  const hostLayer = FiregridHost({
    adapter: recorderLayer(recorder),
    durableStreamsBaseUrl: requireBaseUrl(),
    namespace,
  })
  const configLayer = Layer.succeed(FiregridConfig, {
    durableStreamsBaseUrl: requireBaseUrl(),
    namespace,
  })
  return FiregridLive.pipe(
    Layer.provide(hostLayer),
    Layer.provide(configLayer),
  )
}

const inspectEngine = <A>(
  namespace: string,
  inspect: (table: WorkflowEngineTableService) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const table = yield* WorkflowEngineTable
        return yield* inspect(table)
      }).pipe(
        Effect.provide(WorkflowEngineTable.layer({
          streamOptions: jsonStreamOptions(engineStreamUrl(namespace)),
        })),
      ),
    ),
  )

describe("unified signal write+arm", () => {
  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1 creates the session workflow on prompt-before-start", async () => {
    const namespace = "signal-write-arm-prompt-before-start"
    const recorder = await Effect.runPromise(makeRecorderAdapter())
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const firegrid = yield* Firegrid
          const launched = yield* firegrid.launch({
            requestedBy: "signal-write-arm-test",
            runtime: local.jsonl({
              agent: "recorder",
              argv: [process.execPath, "-e", ""],
            }),
          })
          const session = yield* firegrid.sessions.attach({
            sessionId: launched.contextId,
          })
          yield* session.prompt({
            idempotencyKey: "prompt-before-start",
            payload: { text: "create the run from the first input" },
          })
          const executionId = yield* RuntimeContextSessionWorkflow.executionId({
            contextId: launched.contextId,
            attempt: 1,
          })
          const snapshot = yield* recorder.snapshot
          return { contextId: launched.contextId, executionId, snapshot }
        }).pipe(Effect.provide(hostClientLayer(namespace, recorder))),
      ),
    )

    const executionExists = await inspectEngine(namespace, (table) =>
      table.executions.get(result.executionId).pipe(
        Effect.map(Option.isSome),
      ),
    )

    expect(result.snapshot.spawns).toEqual([`${result.contextId}:1`])
    expect(result.snapshot.sends).toHaveLength(1)
    expect(result.snapshot.sends[0]?.input.kind).toBe("prompt")
    expect(executionExists).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.5 recovers a persisted signal whose arm was lost", async () => {
    const namespace = "signal-write-arm-recovery"
    const contextId = "recover-pending-signal-context"
    const workflowPayload = { contextId, attempt: 1 }
    const workflowPayloadJson = encodeRuntimeContextSessionPayloadJson(workflowPayload)
    const executionId = await Effect.runPromise(
      RuntimeContextSessionWorkflow.executionId(workflowPayload),
    )
    const signalPayload: SessionInputPayload = {
      kind: "prompt",
      payloadJson: "{}",
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const signals = yield* SignalTable
          yield* recordSignal({
            signals,
            workflowName: RuntimeContextSessionWorkflow.name,
            executionId,
            name: "recovered-prompt",
            workflowPayloadJson,
            write: () => Effect.void,
            value: signalPayload,
            serializeValue: (value) => JSON.stringify(value),
          })
        }).pipe(
          Effect.provide(SignalTable.layer({
            streamOptions: jsonStreamOptions(signalStreamUrl(namespace)),
          })),
        ),
      ),
    )

    const recorder = await Effect.runPromise(makeRecorderAdapter())
    await Effect.runPromise(
      Effect.scoped(
        Firegrid.pipe(
          Effect.asVoid,
          Effect.provide(hostClientLayer(namespace, recorder)),
        ),
      ),
    )

    const executionExists = await inspectEngine(namespace, (table) =>
      table.executions.get(executionId).pipe(
        Effect.map(Option.isSome),
      ),
    )
    const snapshot = await Effect.runPromise(recorder.snapshot)

    expect(executionExists).toBe(true)
    expect(snapshot.spawns).toEqual([`${contextId}:1`])
    expect(snapshot.sends).toEqual([{ key: `${contextId}:1`, input: signalPayload }])
  })
})

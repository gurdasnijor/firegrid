import {
  appendJson,
} from "@firegrid/durable-streams/log"
import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import type {
  RuntimeJournalEvent,
  RuntimeOutputStdoutJournalEvent,
} from "@firegrid/protocol/launch"
import type { MessageProjection } from "@firegrid/protocol/session"
import {
  createSessionProjectionDefinition,
  makeMaterializeStrategy,
  MaterializeProvider,
  MaterializeProviderPgLive,
  type MaterializeQuery,
  type SessionProjectionQuery,
} from "@firegrid/runtime/materialization"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import { createConnection } from "node:net"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const execFileAsync = promisify(execFile)

const materializeHttpPort = 6874
const materializeSqlPort = 6875
const materializeHost = "127.0.0.1"
const materializeWebhookBaseUrl = `http://${materializeHost}:${materializeHttpPort}`
const materializeStartupTimeoutMs = 90_000

const materializeLayer = MaterializeProviderPgLive({
  host: materializeHost,
  port: materializeSqlPort,
  database: "materialize",
  username: "materialize",
  ssl: false,
  connectTimeout: "5 seconds",
})

const materializeReadinessQuery: MaterializeQuery<{
  readonly ready: number
}> = {
  statement: sql => sql`SELECT 1 AS ready`,
}

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

const runtimeOutputEvent = (
  options: {
    readonly contextId: string
    readonly sequence: number
    readonly raw: string
  },
): RuntimeOutputStdoutJournalEvent => {
  const eventId = `event_${options.contextId}_1_${options.sequence}`
  return {
    type: "firegrid.runtime.output.stdout",
    id: eventId,
    at: "2026-05-10T00:00:00.000Z",
    event: {
      eventId,
      contextId: options.contextId,
      activityAttempt: 1,
      sequence: options.sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-10T00:00:00.000Z",
      raw: options.raw,
    },
  }
}

const appendRuntimeOutputEvents = async (
  streamUrl: string,
  events: ReadonlyArray<RuntimeJournalEvent>,
): Promise<void> => {
  for (const event of events) {
    await Effect.runPromise(appendJson({ streamUrl, event }))
  }
}

const canConnect = (
  port: number,
): Promise<boolean> =>
  new Promise(resolve => {
    const socket = createConnection({ host: materializeHost, port })
    socket.setTimeout(1_000)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
  })

const canQueryMaterialize = async (): Promise<boolean> => {
  try {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const materialize = yield* MaterializeProvider
        return yield* materialize.query(materializeReadinessQuery)
      }).pipe(Effect.provide(materializeLayer)),
    )
    return rows.some(row => row.ready === 1)
  } catch {
    return false
  }
}

const waitForMaterializeReady = async (
  timeoutMs = materializeStartupTimeoutMs,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const httpReady = await canConnect(materializeHttpPort)
    const sqlReady = httpReady ? await canQueryMaterialize() : false
    if (httpReady && sqlReady) return true
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  return false
}

type MaterializeEmulator =
  | {
    readonly _tag: "ready"
    readonly containerId?: string
  }
  | {
    readonly _tag: "skip"
    readonly reason: string
  }

const ensureMaterializeEmulator = async (): Promise<MaterializeEmulator> => {
  if (await canConnect(materializeHttpPort)) {
    return await waitForMaterializeReady()
      ? { _tag: "ready" }
      : {
        _tag: "skip",
        reason: "Materialize localhost:6874 was reachable, but Effect SQL readiness did not succeed within 90 seconds",
      }
  }

  try {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "-d",
      "-p",
      "127.0.0.1:6874:6874",
      "-p",
      "127.0.0.1:6875:6875",
      "-p",
      "127.0.0.1:6876:6876",
      "-p",
      "127.0.0.1:6877:6877",
      "materialize/materialized:v26.23.0",
    ])
    const containerId = stdout.trim()
    const ready = await waitForMaterializeReady()
    return ready
      ? { _tag: "ready", containerId }
      : {
        _tag: "skip",
        reason: "Materialize Docker container started but localhost:6874 and Effect SQL readiness did not succeed within 90 seconds",
      }
  } catch (cause) {
    return {
      _tag: "skip",
      reason: `Materialize emulator unavailable and Docker start failed: ${String(cause)}`,
    }
  }
}

const stopMaterializeContainer = async (
  containerId: string | undefined,
): Promise<void> => {
  if (containerId === undefined) return
  await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined)
}

const waitForMessages = async (
  read: () => Promise<ReadonlyArray<MessageProjection>>,
): Promise<ReadonlyArray<MessageProjection>> => {
  const deadline = Date.now() + 30_000
  let last: ReadonlyArray<MessageProjection> = []
  while (Date.now() < deadline) {
    last = await read()
    if (last.length > 0) return last
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return last
}

describe("firegrid tracer 004 scenario", () => {
  test("firegrid-materialization-engines.ENGINE.1 firegrid-materialization-engines.ENGINE.3 firegrid-materialization-engines.ENGINE.4 firegrid-materialization-engines.MATERIALIZE.1 firegrid-materialization-engines.MATERIALIZE.2 firegrid-materialization-engines.MATERIALIZE.4 firegrid-materialization-engines.MATERIALIZE.5 firegrid-materialization-engines.BOUNDARY.1 firegrid-event-pipeline-materialization.PIPELINE.5 firegrid-event-pipeline-materialization.SINK.3 runs session projection through live Materialize strategy query path", async ({ skip }) => {
    const emulator = await ensureMaterializeEmulator()
    if (emulator._tag === "skip") {
      skip(emulator.reason)
      return
    }

    try {
      const runtimeOutputStreamUrl = await createStreamUrl("tracer-004-runtime-output")
      const contextId = `ctx_tracer_004_${Date.now()}`
      await appendRuntimeOutputEvents(runtimeOutputStreamUrl, [
        runtimeOutputEvent({
          contextId,
          sequence: 0,
          raw: JSON.stringify({ type: "assistant", text: "materialize session row" }),
        }),
      ])

      const projection = createSessionProjectionDefinition({
        runtimeOutputStreamUrl,
        contextId,
      })
      const sourceName = `runtime_output_${Date.now()}`
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const materialize = yield* MaterializeProvider
          const target = yield* materialize.provisionRuntimeOutputProjection({
            sourceName,
            webhookBaseUrl: materializeWebhookBaseUrl,
          })
          const strategy = yield* makeMaterializeStrategy({ target })
          const summary = yield* strategy.run(projection)
          const messages = yield* Effect.promise(() =>
            waitForMessages(() =>
              Effect.runPromise(
                strategy.query<MessageProjection, SessionProjectionQuery>({
                  projectionName: projection.name,
                  target: projection.target,
                  query: { _tag: "messages", contextId },
                  select: rows => rows as ReadonlyArray<MessageProjection>,
                }),
              )))
          return { messages, summary }
        }).pipe(Effect.provide(materializeLayer)),
      )

      expect(result.summary).toMatchObject({
        sourceEventsRead: 1,
        sourceEventsProjected: 1,
        sourceEventsIgnored: 0,
        sourceEventsFailed: 0,
        sinkEventsWritten: 2,
        failures: [],
      })
      expect(result.messages).toEqual([
        expect.objectContaining({
          contextId,
          text: "materialize session row",
          sourceRuntimeEventId: `event_${contextId}_1_0`,
        }),
      ])
    } finally {
      await stopMaterializeContainer(emulator.containerId)
    }
  }, 180_000)
})

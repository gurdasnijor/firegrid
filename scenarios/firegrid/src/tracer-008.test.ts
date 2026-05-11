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
  makeRawFoldStrategy,
  makeStateProtocolStrategy,
  type MaterializationStrategyService,
  type SessionProjectionQuery,
} from "@firegrid/runtime/materialization"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  appendRuntimeJournalEvent,
} from "./durable-stream-fixtures.ts"

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
    await Effect.runPromise(appendRuntimeJournalEvent(streamUrl, event))
  }
}

const queryMessages = (
  strategy: MaterializationStrategyService,
  projection: ReturnType<typeof createSessionProjectionDefinition>,
  contextId: string,
) =>
  strategy.query<MessageProjection, SessionProjectionQuery>({
    projectionName: projection.name,
    target: projection.target,
    query: { _tag: "messages", contextId },
    select: rows => rows as ReadonlyArray<MessageProjection>,
  })

describe("firegrid tracer 008 scenario", () => {
  test("firegrid-materialization-engines.ENGINE.8 firegrid-materialization-engines.BOUNDARY.6 firegrid-platform-invariants.PRODUCTION_SURFACE.5 firegrid-architecture-boundary.SURFACE_AREA.6 runs raw-fold and State Protocol through stable runtime materialization surfaces", async () => {
    const runtimeOutputStreamUrl = await createStreamUrl("tracer-008-runtime-output")
    const sessionStateStreamUrl = await createStreamUrl("tracer-008-session-state")
    const contextId = "ctx_tracer_008"
    await appendRuntimeOutputEvents(runtimeOutputStreamUrl, [
      runtimeOutputEvent({
        contextId,
        sequence: 0,
        raw: JSON.stringify({ type: "assistant", text: "first strategy" }),
      }),
      runtimeOutputEvent({
        contextId,
        sequence: 1,
        raw: JSON.stringify({ type: "assistant", text: "second strategy" }),
      }),
    ])

    const projection = createSessionProjectionDefinition({
      runtimeOutputStreamUrl,
      contextId,
    })
    const rawFold = await Effect.runPromise(makeRawFoldStrategy)
    const stateProtocol = makeStateProtocolStrategy({
      streamUrl: sessionStateStreamUrl,
      contextId,
    })

    const rawSummary = await Effect.runPromise(rawFold.run(projection))
    const stateProtocolSummary = await Effect.runPromise(stateProtocol.run(projection))
    const rawMessages = await Effect.runPromise(queryMessages(rawFold, projection, contextId))
    const stateProtocolMessages = await Effect.runPromise(
      queryMessages(stateProtocol, projection, contextId),
    )

    expect(rawSummary).toMatchObject({
      sourceEventsRead: 2,
      sourceEventsProjected: 2,
      sourceEventsIgnored: 0,
      sourceEventsFailed: 0,
      sinkEventsWritten: 4,
      failures: [],
    })
    expect(stateProtocolSummary).toEqual(rawSummary)
    expect(rawMessages.map(message => message.text)).toEqual([
      "first strategy",
      "second strategy",
    ])
    expect(stateProtocolMessages).toEqual(rawMessages)
  })
})

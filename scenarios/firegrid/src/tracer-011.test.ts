import {
  appendJson,
} from "@firegrid/durable-streams"
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
  makeStateProtocolStrategy,
  type SessionProjectionQuery,
} from "@firegrid/runtime/data-plane/materialization"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

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
    at: "2026-05-09T00:00:00.000Z",
    event: {
      eventId,
      contextId: options.contextId,
      activityAttempt: 1,
      sequence: options.sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-09T00:00:00.000Z",
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

describe("firegrid tracer 011 scenario", () => {
  test("firegrid-materialization-engines.ENGINE.4 firegrid-materialization-engines.ENGINE.5 firegrid-materialization-engines.ENGINE.7 firegrid-materialization-engines.STATE_PROTOCOL.1 firegrid-materialization-engines.STATE_PROTOCOL.2 queries session projection through target-owned State Protocol contract", async () => {
    const runtimeOutputStreamUrl = await createStreamUrl("tracer-011-runtime-output")
    const sessionStateStreamUrl = await createStreamUrl("tracer-011-session-state")
    const contextId = "ctx_tracer_011"
    await appendRuntimeOutputEvents(runtimeOutputStreamUrl, [
      runtimeOutputEvent({
        contextId,
        sequence: 0,
        raw: JSON.stringify({ type: "assistant", text: "target-owned schema" }),
      }),
    ])

    const projection = createSessionProjectionDefinition({
      runtimeOutputStreamUrl,
      contextId,
    })
    expect(projection.target.stateProtocol).toBeDefined()

    const runStrategy = makeStateProtocolStrategy({
      streamUrl: sessionStateStreamUrl,
      contextId,
    })
    const summary = await Effect.runPromise(runStrategy.run(projection))
    const queryStrategy = makeStateProtocolStrategy({
      streamUrl: sessionStateStreamUrl,
      contextId,
    })
    const messages = await Effect.runPromise(
      queryStrategy.query<MessageProjection, SessionProjectionQuery>({
        projectionName: projection.name,
        target: projection.target,
        query: { _tag: "messages", contextId },
        select: rows => rows as ReadonlyArray<MessageProjection>,
      }),
    )

    expect(summary).toMatchObject({
      sourceEventsRead: 1,
      sourceEventsProjected: 1,
      sourceEventsIgnored: 0,
      sourceEventsFailed: 0,
      sinkEventsWritten: 2,
      failures: [],
    })
    expect(messages).toEqual([
      expect.objectContaining({
        contextId,
        text: "target-owned schema",
        sourceRuntimeEventId: `event_${contextId}_1_0`,
      }),
    ])
  })
})

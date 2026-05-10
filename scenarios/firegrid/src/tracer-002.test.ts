import {
  createDurableStateDb,
  appendJson,
  readRetainedJson,
  sessionStateSchema,
} from "@firegrid/durable-streams"
import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import type {
  RuntimeJournalEvent,
  RuntimeOutputStdoutJournalEvent,
} from "@firegrid/protocol/launch"
import {
  projectRuntimeOutputToSessionState,
  runSessionProjection,
} from "@firegrid/runtime/materialization"
import {
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime"
import { Effect, Layer } from "effect"
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
    at: "2026-05-08T00:00:00.000Z",
    event: {
      eventId,
      contextId: options.contextId,
      activityAttempt: 1,
      sequence: options.sequence,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-08T00:00:00.000Z",
      raw: options.raw,
    },
  }
}

const appendRuntimeOutputEvents = async (
  streamUrl: string,
  events: ReadonlyArray<RuntimeJournalEvent | unknown>,
): Promise<void> => {
  for (const event of events) {
    await Effect.runPromise(appendJson({ streamUrl, event }))
  }
}

const readSessionState = async (
  sessionStreamUrl: string,
) => {
  const sessionDb = createDurableStateDb({
    streamOptions: {
      url: sessionStreamUrl,
      contentType: "application/json",
    },
    state: sessionStateSchema,
  })
  await sessionDb.preload()
  try {
    return {
      sessions: Array.from(sessionDb.collections.sessions.state.values()),
      messages: Array.from(sessionDb.collections.messages.state.values()),
    }
  } finally {
    sessionDb.close()
  }
}

const runWithFiregrid = <A, E>(
  options: {
    readonly controlPlaneStreamUrl: string
    readonly legacyRuntimeStreamUrl: string
    readonly dataPlaneStreamUrl: string
  },
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FiregridLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, {
            runtimeStreamUrl: options.legacyRuntimeStreamUrl,
            controlPlaneStreamUrl: options.controlPlaneStreamUrl,
            dataPlaneStreamUrl: options.dataPlaneStreamUrl,
          })),
        ),
      ),
    ),
  )

describe("firegrid tracer 002 scenario", () => {
  test("durable-records-and-projections.PROJECTIONS.6 projects assistant payloads with provider-owned changes fields", () => {
    const result = projectRuntimeOutputToSessionState(runtimeOutputEvent({
      contextId: "ctx_collision",
      sequence: 0,
      raw: JSON.stringify({ type: "assistant", text: "pong", changes: [] }),
    }).event)

    expect(result).toMatchObject({
      _tag: "Projected",
    })
    expect(result._tag === "Projected" ? result.events : []).toContainEqual(expect.objectContaining({
      kind: "upsertMessage",
      value: expect.objectContaining({
        contextId: "ctx_collision",
        text: "pong",
      }),
    }))
  })

  test("durable-records-and-projections.PROJECTIONS.6 reports malformed JSON without writing session rows", async () => {
    const dataPlaneStreamUrl = await createStreamUrl("runtime-output-malformed")
    const sessionStreamUrl = await createStreamUrl("firegrid-session-malformed")
    const contextId = "ctx_malformed"
    await appendRuntimeOutputEvents(dataPlaneStreamUrl, [
      runtimeOutputEvent({
        contextId,
        sequence: 0,
        raw: "{malformed",
      }),
    ])

    const summary = await Effect.runPromise(runSessionProjection({
      runtimeOutputStreamUrl: dataPlaneStreamUrl,
      sessionStateStreamUrl: sessionStreamUrl,
      contextId,
    }))

    expect(summary).toMatchObject({
      sourceEventsRead: 1,
      sourceEventsProjected: 0,
      sourceEventsIgnored: 0,
      sourceEventsFailed: 1,
      sinkEventsWritten: 0,
    })
    expect(summary.failures).toContainEqual(expect.objectContaining({
      sourceEventId: `event_${contextId}_1_0`,
      reason: "malformed-json",
    }))

    const session = await readSessionState(sessionStreamUrl)
    expect(session.sessions).toEqual([])
    expect(session.messages).toEqual([])
  })

  test("durable-records-and-projections.REBUILD.3 isolates malformed runtime journal envelopes", async () => {
    const dataPlaneStreamUrl = await createStreamUrl("runtime-output-decode")
    const sessionStreamUrl = await createStreamUrl("firegrid-session-decode")
    const contextId = "ctx_decode"
    await appendRuntimeOutputEvents(dataPlaneStreamUrl, [
      runtimeOutputEvent({
        contextId,
        sequence: 0,
        raw: JSON.stringify({ type: "assistant", text: "pong" }),
      }),
      {
        type: "firegrid.runtime.output.stdout",
        id: `bad_${contextId}`,
        event: {
          contextId,
          raw: "not enough fields to satisfy RuntimeJournalEventSchema",
        },
      },
    ])

    const summary = await Effect.runPromise(runSessionProjection({
      runtimeOutputStreamUrl: dataPlaneStreamUrl,
      sessionStateStreamUrl: sessionStreamUrl,
      contextId,
    }))

    expect(summary).toMatchObject({
      sourceEventsRead: 2,
      sourceEventsProjected: 1,
      sourceEventsIgnored: 0,
      sourceEventsFailed: 1,
      sinkEventsWritten: 2,
    })
    expect(summary.failures).toContainEqual(expect.objectContaining({
      sourceEventId: `bad_${contextId}`,
      reason: "decode-failure",
    }))

    const session = await readSessionState(sessionStreamUrl)
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({
      text: "pong",
    })
  })

  test("durable-records-and-projections.RECORDS.3 applies the caller-owned runtime output cursor", async () => {
    const dataPlaneStreamUrl = await createStreamUrl("runtime-output-cursor")
    const sessionStreamUrl = await createStreamUrl("firegrid-session-cursor")
    const contextId = "ctx_cursor"
    await appendRuntimeOutputEvents(dataPlaneStreamUrl, [
      runtimeOutputEvent({
        contextId,
        sequence: 0,
        raw: JSON.stringify({ type: "assistant", text: "old" }),
      }),
      runtimeOutputEvent({
        contextId,
        sequence: 1,
        raw: JSON.stringify({ type: "assistant", text: "new" }),
      }),
    ])

    const summary = await Effect.runPromise(runSessionProjection({
      runtimeOutputStreamUrl: dataPlaneStreamUrl,
      sessionStateStreamUrl: sessionStreamUrl,
      contextId,
      since: { activityAttempt: 1, sequence: 0 },
    }))

    expect(summary).toMatchObject({
      sourceEventsRead: 1,
      sourceEventsProjected: 1,
      sinkEventsWritten: 2,
      failures: [],
    })

    const session = await readSessionState(sessionStreamUrl)
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({
      messageId: `msg_${contextId}_1_1`,
      text: "new",
    })
  })

  test("durable-records-and-projections.PROJECTIONS.3 materializes retained runtime output into idempotent session state", async () => {
    const controlPlaneStreamUrl = await createStreamUrl("runtime-control")
    const legacyRuntimeStreamUrl = await createStreamUrl("runtime-legacy-unused")
    const dataPlaneStreamUrl = await createStreamUrl("runtime-output")
    const workflowStreamUrl = await createStreamUrl("workflow")
    const sessionStreamUrl = await createStreamUrl("firegrid-session")
    const childCode = `
console.log(JSON.stringify({ type: "assistant", text: "pong" }))
console.error("diagnostic: tracer-002")
`

    const handle = await runWithFiregrid(
      { controlPlaneStreamUrl, legacyRuntimeStreamUrl, dataPlaneStreamUrl },
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", childCode],
          }),
        })
      }),
    )

    const runtime = await Effect.runPromise(
      startRuntime({
        contextId: handle.contextId,
      }).pipe(
        Effect.provide(FiregridRuntimeHostLive({
          streams: {
            workflow: workflowStreamUrl,
            controlPlane: controlPlaneStreamUrl,
            runtimeOutput: dataPlaneStreamUrl,
          },
        })),
      ),
    )

    expect(runtime).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const retainedJournal = await Effect.runPromise(
      readRetainedJson<RuntimeJournalEvent>({ streamUrl: dataPlaneStreamUrl }),
    )
    const sourceEvent = retainedJournal.find(event =>
      event.type === "firegrid.runtime.output.stdout" &&
      event.event.contextId === handle.contextId)
    expect(sourceEvent).toBeDefined()

    const materialize = runSessionProjection({
      runtimeOutputStreamUrl: dataPlaneStreamUrl,
      sessionStateStreamUrl: sessionStreamUrl,
      contextId: handle.contextId,
    })

    const firstSummary = await Effect.runPromise(materialize)
    const secondSummary = await Effect.runPromise(materialize)

    expect(firstSummary).toMatchObject({
      sourceEventsRead: 1,
      sourceEventsProjected: 1,
      sourceEventsIgnored: 0,
      sourceEventsFailed: 0,
      sinkEventsWritten: 2,
      failures: [],
    })
    expect(secondSummary).toMatchObject(firstSummary)

    const session = await readSessionState(sessionStreamUrl)
    expect(session.sessions).toHaveLength(1)
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({
      contextId: handle.contextId,
      text: "pong",
      sourceRuntimeEventId: sourceEvent?.id,
    })
  })
})

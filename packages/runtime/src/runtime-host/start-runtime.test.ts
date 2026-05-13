import { FetchHttpClient } from "@effect/platform"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  local,
  normalizeRuntimeIntent,
  RuntimeJournalEventSchema,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import { Effect, Either, Option } from "effect"
import { DurableStream } from "effect-durable-streams"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startRuntime,
  FiregridRuntimeHostLive,
} from "../runtime-host/index.ts"
import {
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"

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

const appendRuntimeContext = (
  controlPlaneStreamUrl: string,
  argv: ReadonlyArray<string>,
): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextId = `ctx_${crypto.randomUUID()}`
    yield* table.contexts.upsert({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...argv],
      })),
    })
    return contextId
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: controlPlaneStreamUrl,
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  ))

const readDataPlane = async (
  streamUrl: string,
): Promise<ReadonlyArray<RuntimeJournalEvent>> => {
  return await Effect.runPromise(DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RuntimeJournalEventSchema,
  }).collect.pipe(
    Effect.provide(FetchHttpClient.layer),
  ))
}

describe("durable launch tracer bullet 001", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7 firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5 journals child JSONL stdout events and stderr logs durably", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const dataPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtimeOutput`
    const childCode = `
console.log(JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "pong" }
    ]
  }
}))
console.log("{malformed")
console.error("diagnostic: child stderr")
`
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [process.execPath, "--input-type=module", "-e", childCode],
    )

    const result = await Effect.runPromise(
      startRuntime({
        contextId,
      }).pipe(
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.5
        Effect.provide(FiregridRuntimeHostLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
        })),
      ),
    )

    expect(result).toMatchObject({
      contextId,
      activityAttempt: 1,
      exitCode: 0,
    })

    const retained = await Effect.runPromise(Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      const dataPlane = yield* Effect.promise(() => readDataPlane(dataPlaneStreamUrl))
      const context = yield* table.contexts.get(contextId)
      const runs = yield* table.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId),
      )
      return {
        context,
        runs,
        events: dataPlane
          .flatMap(event => event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
          .sort((left, right) => left.sequence - right.sequence),
        logs: dataPlane
          .flatMap(event => event.type === "firegrid.runtime.output.stderr" ? [event.log] : []),
      }
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))

    expect(Option.getOrUndefined(retained.context)).toMatchObject({
      contextId,
      runtime: {
        provider: "local-process",
      },
    })

    const statuses = retained.runs
      .map(event => event.status)
    expect(statuses).toEqual(expect.arrayContaining(["started", "exited"]))
    expect(statuses).toHaveLength(2)

    expect(retained.events).toHaveLength(2)
    expect(retained.events[0]).toMatchObject({
      sequence: 0,
      source: "stdout",
      format: "jsonl",
    })
    const firstEvent = retained.events[0]
    expect(firstEvent).toBeDefined()
    expect(JSON.parse(firstEvent!.raw)).toMatchObject({
      type: "assistant",
    })
    expect(retained.events[1]).toMatchObject({
      sequence: 1,
      raw: "{malformed",
    })

    expect(retained.logs).toContainEqual(expect.objectContaining({
      source: "stderr",
      raw: "diagnostic: child stderr",
    }))
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.4 records failed when local command streaming cannot start", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [`missing-firegrid-command-${crypto.randomUUID()}`],
    )

    const result = await Effect.runPromise(
      Effect.either(startRuntime({
        contextId,
      }).pipe(
        Effect.provide(FiregridRuntimeHostLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
        })),
      )),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "RuntimeContextError",
        op: "sandbox.stream",
      })
    }

    const statuses = await Effect.runPromise(Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      const runs = yield* table.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId),
      )
      return runs.map(event => event.status)
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(statuses).toEqual(expect.arrayContaining(["started", "failed"]))
    expect(statuses).toHaveLength(2)
  })
})

import { DurableStreamTestServer } from "@durable-streams/server"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  local,
  normalizeRuntimeIntent,
  RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import { Effect, Either, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startRuntime,
  FiregridRuntimeHostWithWorkflowLive,
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

describe("durable launch tracer bullet 001", () => {
  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1 firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2 firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3 journals child JSONL stdout events and stderr logs durably through RuntimeContextWorkflow", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const outputTableStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtimeOutput`
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
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
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
      const outputTable = yield* RuntimeOutputTable
      const context = yield* table.contexts.get(contextId)
      const runs = yield* table.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId),
      )
      const events = yield* outputTable.events.query((coll) =>
        coll.toArray
          .filter(event => event.contextId === contextId)
          .sort((left, right) => left.sequence - right.sequence),
      )
      const logs = yield* outputTable.logs.query((coll) =>
        coll.toArray.filter(log => log.contextId === contextId),
      )
      return {
        context,
        runs,
        events,
        logs,
      }
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.provide(RuntimeOutputTable.layer({
        streamOptions: {
          url: outputTableStreamUrl,
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

  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2 records failed when local command streaming cannot start", async () => {
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
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
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

  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4 firegrid-workflow-driven-runtime.VALIDATION.1 does not duplicate external runtime execution for duplicate starts", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const outputTableStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtimeOutput`
    const markerDir = join(tmpdir(), `firegrid-runtime-start-${crypto.randomUUID()}`)
    await mkdir(markerDir)
    const markerPath = join(markerDir, "starts.txt")
    const childCode = `
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(markerPath)}, "start\\n")
await new Promise(resolve => setTimeout(resolve, 75))
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "once" }] } }))
`
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [process.execPath, "--input-type=module", "-e", childCode],
    )

    try {
      const [first, second] = await Promise.all([
        Effect.runPromise(
          startRuntime({ contextId }).pipe(
            Effect.provide(FiregridRuntimeHostWithWorkflowLive({
              durableStreamsBaseUrl: baseUrl,
              namespace,
            })),
          ),
        ),
        Effect.runPromise(
          startRuntime({ contextId }).pipe(
            Effect.provide(FiregridRuntimeHostWithWorkflowLive({
              durableStreamsBaseUrl: baseUrl,
              namespace,
            })),
          ),
        ),
      ])

      expect(first).toMatchObject({
        contextId,
        activityAttempt: 1,
        exitCode: 0,
      })
      expect(second).toEqual(first)

      const marker = await readFile(markerPath, "utf8")
      expect(marker.trim().split("\n")).toHaveLength(1)

      const retained = await Effect.runPromise(Effect.gen(function* () {
        const table = yield* RuntimeControlPlaneTable
        const outputTable = yield* RuntimeOutputTable
        const runs = yield* table.runs.query((coll) =>
          coll.toArray.filter(event => event.contextId === contextId),
        )
        const events = yield* outputTable.events.query((coll) =>
          coll.toArray.filter(event => event.contextId === contextId),
        )
        return {
          runs,
          events,
        }
      }).pipe(
        Effect.provide(RuntimeControlPlaneTable.layer({
          streamOptions: {
            url: controlPlaneStreamUrl,
            contentType: "application/json",
          },
        })),
        Effect.provide(RuntimeOutputTable.layer({
          streamOptions: {
            url: outputTableStreamUrl,
            contentType: "application/json",
          },
        })),
        Effect.scoped,
      ))

      expect(retained.runs.map(event => event.status)).toEqual(expect.arrayContaining(["started", "exited"]))
      expect(retained.runs).toHaveLength(2)
      expect(new Set(retained.runs.map(event => event.activityAttempt))).toEqual(new Set([1]))
      expect(retained.events).toHaveLength(1)
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })
})

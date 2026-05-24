import { DurableStreamTestServer } from "@durable-streams/server"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  local,
  makeHostSessionRow,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeContextInsert,
  RuntimeControlPlaneRecorderLive,
  RuntimeRunAppendAndGet,
} from "../../src/tables/runtime-control-plane.ts"

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

const runtimeControlPlaneLayer = (namespace: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: baseUrl!,
        namespace,
      }),
      contentType: "application/json",
    },
  })

const hostSessionLayer = (namespace: string) =>
  Layer.succeed(
    CurrentHostSession,
    makeHostSessionRow({
      hostId: "host-a" as HostId,
      hostSessionId: "host-a-session" as HostSessionId,
      namespace,
      startedAtMs: Date.now(),
    }),
  )

const runWithRecorder = <A, E>(
  namespace: string,
  effect: Effect.Effect<
    A,
    E,
    RuntimeContextInsert | RuntimeRunAppendAndGet | RuntimeControlPlaneTable
  >,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        RuntimeControlPlaneRecorderLive.pipe(
          Layer.provideMerge(runtimeControlPlaneLayer(namespace)),
          Layer.provide(hostSessionLayer(namespace)),
        ),
      ),
    ),
  )

describe("runtime control-plane runs table", () => {
  it("effect-durable-operators.TABLE.16 effect-durable-operators.TABLE.17 effect-durable-operators.TABLE.18 records concurrent started rows with distinct encoded composite runEventId keys", async () => {
    const namespace = `runtime-runs-composite-${crypto.randomUUID()}`
    const program = Effect.gen(function*() {
      const contexts = yield* RuntimeContextInsert
      const runs = yield* RuntimeRunAppendAndGet
      const control = yield* RuntimeControlPlaneTable
      const intent = normalizeRuntimeIntent(local.jsonl({
        argv: [process.execPath, "--version"],
        agentProtocol: "raw",
      }))
      const contextRows = yield* Effect.all(
        ["planner", "builder", "reviewer"].map(role =>
          contexts.insertLocalContextIfAbsent(intent, {
            contextId: `ctx-${role}`,
            createdBy: "runtime-runs-regression",
          }),
        ),
        { concurrency: "unbounded" },
      )

      yield* Effect.all(
        contextRows.map(context =>
          Effect.gen(function*() {
            const attempt = yield* runs.allocateActivityAttempt(context)
            yield* runs.recordStarted(context, attempt)
          }),
        ),
        { concurrency: "unbounded" },
      )

      const rows = yield* control.runs.query(coll => coll.toArray)
      expect(rows).toHaveLength(3)
      expect(rows.map(row => row.runEventId)).toEqual(
        expect.arrayContaining([
          { contextId: "ctx-planner", activityAttempt: 1, status: "started" },
          { contextId: "ctx-builder", activityAttempt: 1, status: "started" },
          { contextId: "ctx-reviewer", activityAttempt: 1, status: "started" },
        ]),
      )
    }) as Effect.Effect<
      void,
      unknown,
      RuntimeContextInsert | RuntimeRunAppendAndGet | RuntimeControlPlaneTable
    >

    await runWithRecorder(
      namespace,
      program,
    )
  })
})

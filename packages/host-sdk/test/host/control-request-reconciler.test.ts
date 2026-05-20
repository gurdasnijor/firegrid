import { DurableStreamTestServer } from "@durable-streams/server"
import { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import {
  RuntimeControlPlaneTable,
  local,
  makeHostSessionRow,
  makeLocalRuntimeContextForHostSession,
  makeRuntimeControlRequestClaimRow,
  makeRuntimeContextRequestRow,
  makeRuntimeStartRequestRow,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { Data, Effect, Fiber, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridRuntimeHostWithWorkflowLive,
  reconcileRuntimeControlRequestsOnce,
  runtimeControlRequestReconcilerDefaults,
  runRuntimeControlRequestReconciler,
  type RuntimeControlRequestReconcilerOptions,
} from "../../src/host/index.ts"
import {
  runtimeControlRequestWorkflowExecutionId,
  runtimeControlRequestWorkflowStreamUrl,
} from "@firegrid/runtime/workflows"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

class StartedRunsTimeout extends Data.TaggedError("StartedRunsTimeout")<{
  readonly contextIds: ReadonlyArray<string>
}> {}

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  ;(server as unknown as {
    server?: { closeAllConnections?: () => void }
  } | undefined)?.server?.closeAllConnections?.()
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const controlPlaneLayer = (namespace: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: baseUrl!,
        namespace,
      }),
      contentType: "application/json",
    },
  })

const controlRequestWorkflowLayer = (namespace: string) =>
  WorkflowEngineTable.layer({
    streamOptions: {
      url: runtimeControlRequestWorkflowStreamUrl({
        baseUrl: baseUrl!,
        namespace,
      }),
      contentType: "application/json",
    },
  })

const insertRequests = (
  contextId: string,
  createdAt: string,
  runtime: ReturnType<typeof local.jsonl>,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextRequest = makeRuntimeContextRequestRow(
      {
        contextId,
        runtime,
        createdBy: "control-request-reconciler-test",
      },
      { createdAt },
    )
    const startRequest = makeRuntimeStartRequestRow(
      { contextId },
      { createdAt },
    )
    yield* table.contextRequests.insertOrGet(contextRequest)
    yield* table.startRequests.insertOrGet(startRequest)
    return { contextRequest, startRequest }
  })

const seedRequestsWithRuntime = (
  namespace: string,
  contextId: string,
  createdAt: string,
  runtime: ReturnType<typeof local.jsonl>,
) =>
  insertRequests(contextId, createdAt, runtime).pipe(
    Effect.provide(controlPlaneLayer(namespace)),
    Effect.scoped,
  )

const seedRequests = (
  namespace: string,
  contextId: string,
  createdAt: string,
) =>
  seedRequestsWithRuntime(
    namespace,
    contextId,
    createdAt,
    local.jsonl({
      argv: [process.execPath, "-e", "process.exit(0)"],
    }),
  )

const waitForStartedRuns = (
  contextIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = yield* table.runs.query((coll) =>
        coll.toArray.filter(row =>
          row.status === "started" && contextIds.includes(row.contextId)))
      const started = new Set(rows.map(row => row.contextId))
      if (contextIds.every(contextId => started.has(contextId))) return rows
      yield* Effect.sleep("25 millis")
    }
    return yield* new StartedRunsTimeout({ contextIds })
  })

const seedStartRequest = (
  namespace: string,
  contextId: string,
  createdAt: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const startRequest = makeRuntimeStartRequestRow(
      { contextId },
      { createdAt },
    )
    yield* table.startRequests.insertOrGet(startRequest)
    return startRequest
  }).pipe(
    Effect.provide(controlPlaneLayer(namespace)),
    Effect.scoped,
  )

const seedContextRequest = (
  namespace: string,
  contextId: string,
  createdAt: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextRequest = makeRuntimeContextRequestRow(
      {
        contextId,
        runtime: local.jsonl({
          argv: [process.execPath, "-e", "process.exit(0)"],
        }),
        createdBy: "control-request-reconciler-test",
      },
      { createdAt },
    )
    yield* table.contextRequests.insertOrGet(contextRequest)
    return contextRequest
  }).pipe(
    Effect.provide(controlPlaneLayer(namespace)),
    Effect.scoped,
  )

const readControlPlane = (
  namespace: string,
  contextId: string,
) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const context = yield* table.contexts.get(contextId)
    const runs = yield* table.runs.query((coll) =>
      coll.toArray.filter(row => row.contextId === contextId))
    const claims = yield* table.controlRequestClaims.query((coll) => coll.toArray)
    const completions = yield* table.controlRequestCompletions.query((coll) => coll.toArray)
    const startRequests = yield* table.startRequests.query((coll) =>
      coll.toArray.filter(row => row.contextId === contextId))
    return { context, runs, claims, completions, startRequests }
  }).pipe(
    Effect.provide(controlPlaneLayer(namespace)),
    Effect.scoped,
  )

const readControlRequestWorkflow = (namespace: string) =>
  Effect.gen(function* () {
    const table = yield* WorkflowEngineTable
    const executions = yield* table.executions.query((coll) => coll.toArray)
    const activityClaims = yield* table.activityClaims.query((coll) => coll.toArray)
    return { executions, activityClaims }
  }).pipe(
    Effect.provide(controlRequestWorkflowLayer(namespace)),
    Effect.scoped,
  )

const runReconcilerOnce = (
  namespace: string,
  hostId: HostId,
  options: RuntimeControlRequestReconcilerOptions = {},
) =>
  reconcileRuntimeControlRequestsOnce(options).pipe(
    Effect.provide(FiregridRuntimeHostWithWorkflowLive({
      durableStreamsBaseUrl: baseUrl!,
      namespace,
      hostId,
      controlRequestReconciler: false,
    })),
    Effect.scoped,
  )

describe("Runtime control request reconciler", () => {
  it("materializes context requests and completes start requests through host-owned startRuntime", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()

    const { contextRequest, startRequest } = await Effect.runPromise(
      seedRequests(namespace, contextId, createdAt),
    )
    await Effect.runPromise(runReconcilerOnce(namespace, hostId))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(Option.getOrUndefined(state.context)).toMatchObject({
      contextId,
      createdBy: "control-request-reconciler-test",
      host: { hostId },
    })
    expect(state.claims).toHaveLength(0)
    const workflow = await Effect.runPromise(readControlRequestWorkflow(namespace))
    expect(workflow.executions.map(row => row.executionId)).toEqual(
      expect.arrayContaining([
        runtimeControlRequestWorkflowExecutionId("context", contextRequest.requestId),
        runtimeControlRequestWorkflowExecutionId("start", startRequest.requestId),
      ]),
    )
    expect(workflow.activityClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: runtimeControlRequestWorkflowExecutionId("context", contextRequest.requestId),
          workerId: hostId,
        }),
      ]),
    )
    expect(state.completions).toHaveLength(2)
    expect(state.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestKind: "context",
          contextId,
          hostId,
          status: "succeeded",
        }),
        expect.objectContaining({
          requestKind: "start",
          contextId,
          hostId,
          status: "succeeded",
          exitCode: 0,
        }),
      ]),
    )
    expect(state.completions.find(row => row.requestKind === "start")).toMatchObject({
      contextId,
      hostId,
      exitCode: 0,
    })
    expect(state.runs.map(row => row.status)).toEqual(expect.arrayContaining(["started", "exited"]))
  })

  it("abandons stale requests terminally without materializing or starting", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-abandon-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const stale = new Date(
      Date.now() - runtimeControlRequestReconcilerDefaults.abandonAfterMs - 1_000,
    ).toISOString()

    await Effect.runPromise(seedRequests(namespace, contextId, stale))
    await Effect.runPromise(runReconcilerOnce(namespace, hostId))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(Option.isNone(state.context)).toBe(true)
    expect(state.claims).toHaveLength(0)
    expect(state.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestKind: "context",
          status: "abandoned",
        }),
        expect.objectContaining({
          requestKind: "start",
          status: "abandoned",
        }),
      ]),
    )

    await Effect.runPromise(
      runReconcilerOnce(namespace, hostId, {
        abandonAfterMs: Number.MAX_SAFE_INTEGER,
      }),
    )
    const afterRetry = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(Option.isNone(afterRetry.context)).toBe(true)
    expect(afterRetry.claims).toHaveLength(0)
    expect(afterRetry.completions).toHaveLength(2)
  })

  it("elects one workflow activity owner for context provisioning under concurrent scans", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-claim-race-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()
    const hostA = `host_${crypto.randomUUID()}` as HostId
    const hostB = `host_${crypto.randomUUID()}` as HostId

    await Effect.runPromise(seedRequests(namespace, contextId, createdAt))
    await Effect.runPromise(Effect.all(
      [
        runReconcilerOnce(namespace, hostA, { claimWindowMs: 60_000 }),
        runReconcilerOnce(namespace, hostB, { claimWindowMs: 60_000 }),
      ],
      { concurrency: "unbounded", discard: true },
    ))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(state.claims).toHaveLength(0)
    const workflow = await Effect.runPromise(readControlRequestWorkflow(namespace))
    expect(workflow.activityClaims.filter(row =>
      row.executionId === runtimeControlRequestWorkflowExecutionId(
        "context",
        `req_ctx_${contextId}`,
      ))).toHaveLength(1)
    expect(workflow.executions.map(row => row.executionId)).toEqual(
      expect.arrayContaining([
        runtimeControlRequestWorkflowExecutionId("context", `req_ctx_${contextId}`),
        runtimeControlRequestWorkflowExecutionId("start", `req_start_${contextId}`),
      ]),
    )
    expect(state.completions.filter(row => row.requestKind === "context")).toHaveLength(1)
    expect(state.completions.filter(row => row.requestKind === "start")).toHaveLength(1)
  })

  it("ignores legacy claim-window rows because workflow executions now own coordination", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-window-retry-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()
    const hostA = `host_${crypto.randomUUID()}` as HostId
    const hostB = `host_${crypto.randomUUID()}` as HostId

    const seeded = await Effect.runPromise(seedRequests(namespace, contextId, createdAt))
    await Effect.runPromise(
      Effect.gen(function* () {
        const table = yield* RuntimeControlPlaneTable
        yield* table.controlRequestClaims.insertOrGet(
          makeRuntimeControlRequestClaimRow({
            requestKind: "context",
            requestId: seeded.contextRequest.requestId,
            contextId,
            hostId: hostA,
            hostSessionId: `${hostA}_session`,
            claimWindowStartedAtMs: 0,
            claimWindowExpiresAtMs: 60_000,
            claimedAtMs: 1,
          }),
        )
      }).pipe(
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(runReconcilerOnce(namespace, hostB, { claimWindowMs: 60_000 }))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    const contextClaims = state.claims.filter(row => row.requestKind === "context")
    expect(contextClaims).toHaveLength(1)
    expect(contextClaims[0]?.hostId).toBe(hostA)
    expect(Option.getOrUndefined(state.context)).toMatchObject({
      contextId,
      host: { hostId: hostB },
    })
    const workflow = await Effect.runPromise(readControlRequestWorkflow(namespace))
    expect(workflow.activityClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: runtimeControlRequestWorkflowExecutionId(
            "context",
            seeded.contextRequest.requestId,
          ),
          workerId: hostB,
        }),
      ]),
    )
  })

  it("request not lost: materializes context idempotently with insertOrGet and never blind-upserts an existing host binding", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-context-idempotent-${crypto.randomUUID()}`
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()
    const existingHost = `host_${crypto.randomUUID()}` as HostId
    const reconcilingHost = `host_${crypto.randomUUID()}` as HostId

    await Effect.runPromise(
      Effect.gen(function* () {
        const table = yield* RuntimeControlPlaneTable
        const existingContext = yield* makeLocalRuntimeContextForHostSession(
          makeHostSessionRow({
            hostId: existingHost,
            hostSessionId: `session_${crypto.randomUUID()}` as HostSessionId,
            namespace,
            startedAtMs: 1,
          }),
          normalizeRuntimeIntent(local.jsonl({
            argv: [process.execPath, "-e", "process.exit(0)"],
          })),
          {
            contextId,
            createdAtMs: 1,
            createdBy: "preexisting-context",
          },
        )
        yield* table.contexts.insertOrGet(existingContext)
      }).pipe(
        Effect.provide(controlPlaneLayer(namespace)),
        Effect.scoped,
      ),
    )
    await Effect.runPromise(seedContextRequest(namespace, contextId, createdAt))
    await Effect.runPromise(runReconcilerOnce(namespace, reconcilingHost))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(Option.getOrUndefined(state.context)).toMatchObject({
      contextId,
      createdBy: "preexisting-context",
      host: { hostId: existingHost },
    })
    expect(state.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestKind: "context",
          status: "succeeded",
          hostId: reconcilingHost,
        }),
      ]),
    )
    expect(state.runs).toHaveLength(0)
  })

  it("suppresses duplicate starts after a terminal completion row exists", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-start-dedup-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()

    await Effect.runPromise(seedRequests(namespace, contextId, createdAt))
    await Effect.runPromise(runReconcilerOnce(namespace, hostId))
    await Effect.runPromise(runReconcilerOnce(namespace, hostId))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(state.completions.filter(row => row.requestKind === "start")).toHaveLength(1)
    expect(state.runs.filter(row => row.status === "started")).toHaveLength(1)
    expect(state.runs.filter(row => row.status === "exited")).toHaveLength(1)
  })

  it("keeps a start request visible when no context has been materialized yet", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-not-lost-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()

    await Effect.runPromise(seedStartRequest(namespace, contextId, createdAt))
    await Effect.runPromise(runReconcilerOnce(namespace, hostId))

    const state = await Effect.runPromise(readControlPlane(namespace, contextId))
    expect(Option.isNone(state.context)).toBe(true)
    expect(state.startRequests).toHaveLength(1)
    expect(state.claims).toHaveLength(0)
    expect(state.completions).toHaveLength(0)
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.9 keeps dispatching while long-running start requests are active", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `control-request-concurrent-start-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const firstContextId = `ctx_${crypto.randomUUID()}`
    const secondContextId = `ctx_${crypto.randomUUID()}`
    const runtime = local.jsonl({
      argv: [
        process.execPath,
        "--input-type=module",
        "-e",
        `
const shutdown = () => process.exit(0)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
process.stdin.on("end", shutdown)
process.stdin.resume()
setInterval(() => {}, 1_000)
setTimeout(shutdown, 8_000)
`,
      ],
    })

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertRequests(firstContextId, new Date().toISOString(), runtime)
        const reconciler = yield* runRuntimeControlRequestReconciler({
          pollIntervalMs: 25,
          claimWindowMs: 60_000,
        }).pipe(Effect.fork)
        yield* waitForStartedRuns([firstContextId])

        yield* insertRequests(secondContextId, new Date().toISOString(), runtime)
        const runs = yield* waitForStartedRuns([firstContextId, secondContextId])
        const table = yield* RuntimeControlPlaneTable
        const completions = yield* table.controlRequestCompletions.query((coll) =>
          coll.toArray.filter(row => row.requestKind === "start"))
        yield* Fiber.interrupt(reconciler)
        return { runs, completions }
      }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId,
          controlRequestReconciler: false,
        })),
        Effect.scoped,
      ),
    )

    expect(new Set(state.runs.map(row => row.contextId))).toEqual(
      new Set([firstContextId, secondContextId]),
    )
    expect(state.completions).toHaveLength(0)
  }, 15_000)
})

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.VALIDATION.1
//
// Two-host smoke: two FiregridRuntimeHostWithWorkflowLive layers in
// the same namespace, each configured with a distinct hostId. Each
// host runs its own runtime context end-to-end. We then verify that
// workflow rows appear in the context-derived workflow stream for the
// owning context and not in another context's stream, and that the
// local-authority gate rejects a cross-host startRuntime call before
// any workflow/output rows are written.

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeContextWorkflowStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import { Effect, Either } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridRuntimeHostWithWorkflowLive,
  startRuntime,
} from "../../src/host/index.ts"
import { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"

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

const seedContext = (input: {
  readonly controlPlaneStreamUrl: string
  readonly hostId: HostId
  readonly namespace: string
  readonly argv: ReadonlyArray<string>
}): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextId = `ctx_${crypto.randomUUID()}`
    yield* table.contexts.upsert({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({ argv: [...input.argv] })),
      host: {
        hostId: input.hostId,
        streamPrefix: makeHostStreamPrefix({
          namespace: input.namespace,
          hostId: input.hostId,
        }),
        boundAtMs: Date.now(),
      },
    })
    return contextId
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: input.controlPlaneStreamUrl,
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  ))

const queryContextWorkflow = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly contextId: string
}) =>
  Effect.gen(function* () {
    const table = yield* WorkflowEngineTable
    const executions = yield* table.executions.query((coll) => coll.toArray)
    return {
      executionIds: executions.map((row) => row.executionId),
    }
  }).pipe(
    Effect.provide(WorkflowEngineTable.layer({
      streamOptions: {
        url: runtimeContextWorkflowStreamUrl({
          baseUrl: input.baseUrl,
          namespace: input.namespace,
          contextId: input.contextId,
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )

describe("firegrid-host-context-authority.VALIDATION.1 two-host workflow stream isolation", () => {
  it("firegrid-workflow-driven-runtime.BOUNDARIES.6 each host writes workflow rows only to the context-derived workflow stream it owns", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `two-host-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`

    const childArgv = [
      process.execPath,
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({ type: \"probe\" }))",
    ]

    const contextA = await seedContext({
      controlPlaneStreamUrl,
      hostId: hostA,
      namespace,
      argv: childArgv,
    })
    const contextB = await seedContext({
      controlPlaneStreamUrl,
      hostId: hostB,
      namespace,
      argv: childArgv,
    })

    // Each host runs its own context end-to-end. The runtime host's
    // workflow engine is bound to the context-derived workflow stream
    // for the context it owns.
    await Effect.runPromise(
      startRuntime({ contextId: contextA }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId: hostA,
        })),
      ),
    )
    await Effect.runPromise(
      startRuntime({ contextId: contextB }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId: hostB,
        })),
      ),
    )

    // Read each context's workflow stream directly and confirm the
    // execution id present is the one belonging to that context.
    // Workflow execution id format mirrors the runtime host's
    // `runtime-context:${contextId}` shape.
    const resultA = await Effect.runPromise(
      queryContextWorkflow({ baseUrl, namespace, contextId: contextA }),
    )
    const resultB = await Effect.runPromise(
      queryContextWorkflow({ baseUrl, namespace, contextId: contextB }),
    )

    expect(resultA.executionIds).toEqual([`runtime-context:${contextA}`])
    expect(resultB.executionIds).toEqual([`runtime-context:${contextB}`])

    // Cross-context check: context A's stream MUST NOT carry context
    // B's workflow row. The per-context stream is now the durable
    // workflow isolation boundary.
    expect(resultA.executionIds).not.toContain(`runtime-context:${contextB}`)
    expect(resultB.executionIds).not.toContain(`runtime-context:${contextA}`)
  })

  it("firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2 startRuntime rejects a context bound to another host before any host-owned row is written", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `two-host-foreign-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`

    const contextA = await seedContext({
      controlPlaneStreamUrl,
      hostId: hostA,
      namespace,
      argv: [process.execPath, "-e", "process.exit(0)"],
    })

    // Host B tries to execute host A's context. The local-authority
    // gate must reject before WorkflowEngine.execute runs, so no
    // workflow execution occurs and no run row is appended for contextA.
    const result = await Effect.runPromise(
      Effect.either(
        startRuntime({ contextId: contextA }).pipe(
          Effect.provide(FiregridRuntimeHostWithWorkflowLive({
            durableStreamsBaseUrl: baseUrl,
            namespace,
            hostId: hostB,
          })),
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "ContextNotLocal",
        contextId: contextA,
        hostId: hostA,
        currentHostId: hostB,
      })
    }

    // Verify contextA's workflow stream is empty: the gate fired
    // before engine.execute, so no `runtime-context:contextA` row
    // was inserted into the per-context workflow stream.
    const contextState = await Effect.runPromise(
      queryContextWorkflow({ baseUrl, namespace, contextId: contextA }),
    )
    expect(contextState.executionIds).not.toContain(`runtime-context:${contextA}`)

    // And no run rows for contextA appear in the namespace-scoped
    // control plane: the gate runs before runs are written.
    const runs = await Effect.runPromise(
      Effect.gen(function* () {
        const table = yield* RuntimeControlPlaneTable
        return yield* table.runs.query((coll) =>
          coll.toArray.filter((row) => row.contextId === contextA))
      }).pipe(
        Effect.provide(RuntimeControlPlaneTable.layer({
          streamOptions: {
            url: controlPlaneStreamUrl,
            contentType: "application/json",
          },
        })),
        Effect.scoped,
      ),
    )
    expect(runs).toEqual([])
  })
})

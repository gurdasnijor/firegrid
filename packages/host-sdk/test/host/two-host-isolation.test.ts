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
// workflow rows appear in the host-owned workflow stream for the
// owning host and not in another host's stream, and that the
// local-authority gate rejects a cross-host startRuntime call before
// any workflow/output rows are written.

import { DurableStreamTestServer } from "@durable-streams/server"
import { access, readFile } from "node:fs/promises"
import {
  RuntimeControlPlaneTable,
  hostOwnedStreamUrl,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
} from "@firegrid/protocol/launch"
import { Cause, Effect, Either, Exit } from "effect"
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

const queryHostWorkflow = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: HostId
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
        url: hostOwnedStreamUrl({
          baseUrl: input.baseUrl,
          prefix: makeHostStreamPrefix({
            namespace: input.namespace,
            hostId: input.hostId,
          }),
          segment: "workflow",
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )

describe("firegrid-host-context-authority.VALIDATION.1 two-host workflow stream isolation", () => {
  it("firegrid-workflow-driven-runtime.VALIDATION.7-2 removes the RuntimeContextEngineRegistry application surface", async () => {
    await expect(
      access(new URL("../../src/host/runtime-context-engine-registry.ts", import.meta.url)),
    ).rejects.toThrow()

    const sourceFiles = [
      "commands.ts",
      "agent-tool-host-live.ts",
      "control-request-reconciler.ts",
      "channels/session-self/index.ts",
      "../agent-tools/execution/toolkit-layer.ts",
    ]
    const contents = await Promise.all(
      sourceFiles.map(file =>
        readFile(new URL(`../../src/host/${file}`, import.meta.url), "utf8"),
      ),
    )

    expect(contents.join("\n")).not.toContain("RuntimeContextEngineRegistry")
    expect(contents.join("\n")).not.toContain("runtime-context-engine-registry")
  })

  it("firegrid-workflow-driven-runtime.BOUNDARIES.6-1 each host writes workflow rows only to its host-owned workflow stream", async () => {
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
    // workflow engine is bound to that host's workflow stream.
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

    // Read each host's workflow stream directly and confirm the
    // execution id present is the one belonging to that host's context.
    // Workflow execution id format mirrors the runtime host's
    // `runtime-context:${contextId}` shape.
    const resultA = await Effect.runPromise(
      queryHostWorkflow({ baseUrl, namespace, hostId: hostA }),
    )
    const resultB = await Effect.runPromise(
      queryHostWorkflow({ baseUrl, namespace, hostId: hostB }),
    )

    expect(resultA.executionIds).toEqual([`runtime-context:${contextA}`])
    expect(resultB.executionIds).toEqual([`runtime-context:${contextB}`])

    // Cross-host check: host A's stream MUST NOT carry host B's
    // workflow row. The host-owned stream is now the durable workflow
    // isolation boundary.
    expect(resultA.executionIds).not.toContain(`runtime-context:${contextB}`)
    expect(resultB.executionIds).not.toContain(`runtime-context:${contextA}`)
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.7-1 one host-scoped engine owns multiple context executions", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `two-context-one-host-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`

    const childArgv = [process.execPath, "-e", "process.exit(0)"]
    const contextA = await seedContext({
      controlPlaneStreamUrl,
      hostId: hostA,
      namespace,
      argv: childArgv,
    })
    const contextB = await seedContext({
      controlPlaneStreamUrl,
      hostId: hostA,
      namespace,
      argv: childArgv,
    })

    const exit = await Effect.runPromiseExit(
      Effect.all([
        startRuntime({ contextId: contextA }),
        startRuntime({ contextId: contextB }),
      ], { concurrency: "unbounded" }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId: hostA,
        })),
      ),
    )
    if (Exit.isFailure(exit)) {
      throw new Error(Cause.pretty(exit.cause))
    }

    const result = await Effect.runPromise(
      queryHostWorkflow({ baseUrl, namespace, hostId: hostA }),
    )

    expect(new Set(result.executionIds)).toEqual(new Set([
      `runtime-context:${contextA}`,
      `runtime-context:${contextB}`,
    ]))
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
    // workflow row appears in host B's host-owned workflow stream
    // and no run row is appended for contextA.
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

    // Verify hostB's workflow stream is empty: the gate fired
    // before engine.execute, so no `runtime-context:contextA` row
    // was inserted into the foreign host-owned workflow stream.
    const contextState = await Effect.runPromise(
      queryHostWorkflow({ baseUrl, namespace, hostId: hostB }),
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

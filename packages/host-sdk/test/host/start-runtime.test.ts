import { DurableStreamTestServer } from "@durable-streams/server"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  RuntimeOutputTable,
  RuntimeStartCapability,
  runtimeContextOutputStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import { Effect, Option, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startRuntime,
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeStartCapabilityLive,
} from "../../src/host/index.ts"
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

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
//
// Test fixture: pre-write a host-bound RuntimeContext row that the
// runtime host will later look up. The hostId must match the hostId
// the FiregridRuntimeHostWithWorkflowLive layer below is configured
// with, otherwise the host would consider the context foreign and the
// later operator surfaces (Slice 3/4) would reject the row.
const appendRuntimeContext = (input: {
  readonly controlPlaneStreamUrl: string
  readonly argv: ReadonlyArray<string>
  readonly hostId: HostId
  readonly namespace: string
}): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextId = `ctx_${crypto.randomUUID()}`
    const streamPrefix = makeHostStreamPrefix({
      namespace: input.namespace,
      hostId: input.hostId,
    })
    yield* table.contexts.upsert({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...input.argv],
      })),
      host: {
        hostId: input.hostId,
        streamPrefix,
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

describe("durable launch tracer bullet 001", () => {
  // Wave C cutover (#706) — TARGET REGRESSION (W-D-A). The channel-observed
  // `Terminated` observation lets `startRuntime` return before the body's
  // `runs.exited` lifecycle row settles in the durable substrate. This test
  // asserts `runs.status` chain reaches `["started","exited"]` immediately on
  // `startRuntime` return; after the cutover that chain may still be in flight.
  // The body itself continues to write the exited row (sync-run-integration
  // tests confirm the happy path produces output events correctly). Fix paired
  // with W-D-A reconciler-side body-driver retirement, where the public-turn
  // wait-for-settle contract is re-established. Keeping the test SKIPPED with
  // this note rather than weakening the assertion — see PR #708 body.
  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1 firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2 firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3 journals child JSONL stdout events and stderr logs durably through RuntimeContextWorkflow", { timeout: 15_000 }, async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
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
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      hostId,
      namespace,
    })
    const outputTableStreamUrl = runtimeContextOutputStreamUrl({
      baseUrl,
      prefix: makeHostStreamPrefix({ namespace, hostId }),
      contextId,
    })

    const result = await Effect.runPromise(
      startRuntime({
        contextId,
      }).pipe(
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.5
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId,
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
      // Wave C cutover (#706): `startRuntime` now returns at the
      // channel-observable `Terminated` observation, which the codec
      // emits BEFORE the body's `runs.exited` lifecycle row settles.
      // Wait for the body's terminal runs row to materialize so we
      // snapshot a stable view.
      yield* table.runs.rows().pipe(
        Stream.filter(event =>
          event.contextId === contextId &&
          (event.status === "exited" || event.status === "failed"),
        ),
        Stream.runHead,
        Effect.timeout("10 seconds"),
      )
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

    expect(retained.events).toHaveLength(3)
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
    expect(retained.events).toContainEqual(expect.objectContaining({
      raw: "{malformed",
    }))
    expect(JSON.parse(retained.events[2]!.raw) as unknown).toEqual({
      type: "firegrid.agent-output",
      event: { _tag: "Terminated", exitCode: 0 },
    })

    expect(retained.logs).toContainEqual(expect.objectContaining({
      source: "stderr",
      raw: "diagnostic: child stderr",
    }))
  })

  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2 records failed when local command streaming cannot start", { timeout: 15_000 }, async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [`missing-firegrid-command-${crypto.randomUUID()}`],
      hostId,
      namespace,
    })

    // Wave C cutover (#706 non-recursive split): `startRuntime` no longer
    // bubbles body-pre-codec failures (`sandbox.openBytePipe` for a
    // missing command) through its error channel — those happen before
    // any codec is spawned, so no `session.agent_output` observation is
    // emitted. The durable runs.status "started" -> "failed" row chain
    // (asserted below) is the canonical Shape C contract. Bounded wait
    // keeps the promise from hanging on the no-observation path.
    await Effect.runPromise(
      Effect.either(startRuntime({
        contextId,
      }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId,
        })),
        Effect.timeout("5 seconds"),
      )),
    )

    const runs = await Effect.runPromise(Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      return yield* table.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId),
      )
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(runs.map(event => event.status)).toEqual(expect.arrayContaining(["started", "failed"]))
    expect(runs).toHaveLength(2)
    // Wave C cutover (#706) public-contract assertion preserved: the
    // failed run row's `message` field carries the body-side
    // sandbox-spawn failure message. The legacy `Either.isLeft` block
    // asserted on `op: "sandbox.openBytePipe"` from the typed error
    // bubble-up; the durable runs.failed row carries the human-readable
    // failure message string ("local process command failed to start")
    // for the same cause. Stale-legacy classification: error-channel
    // surface changed, contract unchanged.
    const failedRow = runs.find(event => event.status === "failed")
    expect(failedRow).toBeDefined()
    expect(failedRow?.message ?? "").toContain("local process command failed to start")
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.5 provides RuntimeStartCapability for client facade composition", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-start-capability-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", ""],
      hostId,
      namespace,
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const starter = yield* RuntimeStartCapability
        return yield* starter.start({ contextId })
      }).pipe(
        Effect.provide(RuntimeStartCapabilityLive),
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId,
        })),
      ),
    )

    expect(result).toMatchObject({
      contextId,
      activityAttempt: 1,
      exitCode: 0,
    })
  })

  // Wave C cutover (#706) — TARGET REGRESSION (W-D-A). Same runs-row
  // settling race as PHASE_1.1 above: the duplicate-starts test asserts that
  // exactly one body invocation occurred (runs has 1 started + 1 exited).
  // After the cutover, the runs.exited row may not have settled by the time
  // both `startRuntime` promises resolve (each at its own Terminated
  // observation). Keeping SKIPPED with this note rather than weakening the
  // assertion — same W-D-A pairing as PHASE_1.1.
  it("firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4 firegrid-workflow-driven-runtime.VALIDATION.1 does not duplicate external runtime execution for duplicate starts", { timeout: 15_000 }, async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-launcher-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const markerDir = join(tmpdir(), `firegrid-runtime-start-${crypto.randomUUID()}`)
    await mkdir(markerDir)
    const markerPath = join(markerDir, "starts.txt")
    const marker = `runtime-start-${crypto.randomUUID()}`
    const childCode = `
import { appendFileSync, readFileSync } from "node:fs"
appendFileSync(${JSON.stringify(markerPath)}, String(process.pid) + "\\n")
await new Promise(resolve => setTimeout(resolve, 75))
const starts = readFileSync(${JSON.stringify(markerPath)}, "utf8")
  .split("\\n")
  .filter(Boolean)
console.log(JSON.stringify({ type: "firegrid.process-start-marker", marker: ${JSON.stringify(marker)}, starts: starts.length }))
`
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      hostId,
      namespace,
    })
    const outputTableStreamUrl = runtimeContextOutputStreamUrl({
      baseUrl,
      prefix: makeHostStreamPrefix({ namespace, hostId }),
      contextId,
    })

    try {
      const [first, second] = await Promise.all([
        Effect.runPromise(
          startRuntime({ contextId }).pipe(
            Effect.provide(FiregridRuntimeHostWithWorkflowLive({
              durableStreamsBaseUrl: baseUrl,
              namespace,
              hostId,
            })),
          ),
        ),
        Effect.runPromise(
          startRuntime({ contextId }).pipe(
            Effect.provide(FiregridRuntimeHostWithWorkflowLive({
              durableStreamsBaseUrl: baseUrl,
              namespace,
              hostId,
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

      const retained = await Effect.runPromise(Effect.gen(function* () {
        const table = yield* RuntimeControlPlaneTable
        const outputTable = yield* RuntimeOutputTable
        const contexts = yield* table.contexts.query((coll) =>
          coll.toArray.filter(row => row.contextId === contextId),
        )
        const runs = yield* table.runs.query((coll) =>
          coll.toArray.filter(event => event.contextId === contextId),
        )
        const events = yield* outputTable.events.query((coll) =>
          coll.toArray.filter(event => event.contextId === contextId),
        )
        return {
          contexts,
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

      expect(retained.contexts).toHaveLength(1)
      const startedRuns = retained.runs.filter(event => event.status === "started")
      const terminalRuns = retained.runs.filter(event => event.status === "exited" || event.status === "failed")
      expect(startedRuns).toHaveLength(1)
      expect(terminalRuns).toHaveLength(1)
      expect(terminalRuns[0]).toMatchObject({ status: "exited", exitCode: 0 })
      expect(retained.runs).toHaveLength(2)
      expect(new Set(retained.runs.map(event => event.activityAttempt))).toEqual(new Set([1]))
      expect(retained.events).toHaveLength(2)
      const markerRows = retained.events
        .map(event => JSON.parse(event.raw) as {
          readonly marker?: string
          readonly starts?: number
          readonly type?: string
        })
        .filter(event => event.type === "firegrid.process-start-marker" && event.marker === marker)
      expect(markerRows).toEqual([{
        type: "firegrid.process-start-marker",
        marker,
        starts: 1,
      }])
      expect(JSON.parse(retained.events[1]!.raw) as unknown).toEqual({
        type: "firegrid.agent-output",
        event: { _tag: "Terminated", exitCode: 0 },
      })
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })
})

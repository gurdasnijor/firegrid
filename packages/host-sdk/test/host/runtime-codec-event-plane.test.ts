import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  runtimeContextOutputStreamUrl,
  type HostId,
  type RuntimeAgentProtocol,
} from "@firegrid/protocol/launch"
import { Effect, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  decodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  FiregridRuntimeHostWithWorkflowLive,
  startRuntime,
} from "../../src/host/index.ts"

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
  readonly namespace: string
  readonly hostId: HostId
  readonly argv: ReadonlyArray<string>
  readonly agentProtocol?: RuntimeAgentProtocol
}): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      const contextId = `ctx_${crypto.randomUUID()}`
      const now = new Date().toISOString()
      yield* table.contexts.upsert({
        contextId,
        createdAt: now,
        runtime: normalizeRuntimeIntent(local.jsonl({
          argv: [...input.argv],
          ...(input.agentProtocol === undefined ? {} : { agentProtocol: input.agentProtocol }),
        })),
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
          url: runtimeControlPlaneStreamUrl({
            baseUrl: baseUrl!,
            namespace: input.namespace,
          }),
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ),
  )

const hostLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
}) =>
  FiregridRuntimeHostWithWorkflowLive({
    durableStreamsBaseUrl: baseUrl!,
    namespace: input.namespace,
    hostId: input.hostId,
    input: true,
  })

const outputTableLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: baseUrl!,
        prefix: makeHostStreamPrefix({
          namespace: input.namespace,
          hostId: input.hostId,
        }),
        contextId: input.contextId,
      }),
      contentType: "application/json",
    },
  })

const queryRawEvents = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  Effect.gen(function* () {
    const table = yield* RuntimeOutputTable
    return yield* table.events.query(coll =>
      coll.toArray
        .filter(row => row.contextId === input.contextId)
        .sort((left, right) => left.sequence - right.sequence))
  }).pipe(
    Effect.provide(outputTableLayer(input)),
    Effect.scoped,
  )

const decodeAgentEvent = (raw: string): AgentOutputEvent | undefined => {
  const decoded = decodeRuntimeAgentOutputEnvelope(raw)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const queryAgentEvents = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  queryRawEvents(input).pipe(
    Effect.map(rows => rows.flatMap(row => {
      const event = decodeAgentEvent(row.raw)
      return event === undefined ? [] : [event]
    })),
  )

describe("Runtime Codec Event Plane", () => {
  it("firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 preserves raw local-process journaling as the default path", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-raw-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
console.log(JSON.stringify({ type: "raw-probe", ok: true }))
`
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
    })

    const result = await Effect.runPromise(
      startRuntime({ contextId }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const rows = await Effect.runPromise(queryRawEvents({ namespace, hostId, contextId }))
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0]!.raw)).toEqual({ type: "raw-probe", ok: true })
    expect(JSON.parse(rows[1]!.raw) as unknown).toEqual({
      type: "firegrid.agent-output",
      event: { _tag: "Terminated", exitCode: 0 },
    })
  })

  // Wave D-A (PR #714) PARK — D-B TOOL LANE: ToolUse → ToolResult
  // round-trip through the legacy body's mailbox + per-context tool
  // executor binding. Shape C's RuntimeToolUseExecutor seam still
  // exists (handler.ts:dispatchAction RunToolUse branch); D-B's proof
  // lane will add the Shape C tool-result-via-session-seam assertion.
  // Replacement proof for the dispatch shape is in
  // `packages/runtime/test/subscribers/runtime-context/handler.test.ts`
  // ("runs a tool and forwards the result through the session-command
  // seam on a ToolUse output"). The journaled-row assertion here is
  // body-specific and retires when D-B migrates agent-tool-host-live.ts.
  it("firegrid-runtime-agent-event-pipeline.INGREDIENTS.6 commits Terminated before returning terminal exit evidence", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-codec-missing-terminal-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const childCode = `
console.log(JSON.stringify({ type: "text", text: "before-terminal", messageId: "m1" }))
`
    const contextId = await seedContext({
      namespace,
      hostId,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      agentProtocol: "stdio-jsonl",
    })

    const result = await Effect.runPromise(
      startRuntime({ contextId }).pipe(
        Effect.provide(hostLayer({ namespace, hostId })),
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })
    const events = await Effect.runPromise(queryAgentEvents({ namespace, hostId, contextId }))
    expect(events).toContainEqual(expect.objectContaining({ _tag: "Ready" }))
    expect(events).toContainEqual(expect.objectContaining({ _tag: "TextChunk" }))
    expect(events.at(-1)).toMatchObject({ _tag: "Terminated", exitCode: 0 })

    const runs = await Effect.runPromise(Effect.gen(function* () {
      const table = yield* RuntimeControlPlaneTable
      return yield* table.runs.query(coll =>
        coll.toArray
          .filter(row => row.contextId === contextId)
          .map(row => row.status),
      )
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: runtimeControlPlaneStreamUrl({
            baseUrl,
            namespace,
          }),
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(runs).toEqual(expect.arrayContaining(["started", "exited"]))
  }, 15_000)

  // Wave D-A (PR #714) PARK — D-C PERMISSION LANE: asserts ACP
  // PermissionRequest blocks/resumes through the "runtime-input deferred"
  // mailbox specifically. Shape C handles permission via
  // transformsruntime-context-transition.ts withPermissionRequest /
  // withPermissionResponse on RuntimeContextEventState's pending* sets
  // (per CC2 D-C inventory: Shape C contract is already in place; no
  // additional deletion in D-C). D-C's proof lane will add the Shape C
  // permission-rendezvous assertion. Until then the mailbox-specific
  // assertion stays parked. Grep blocker:
  //   grep -rn "runtime-input deferred" packages/runtime
})

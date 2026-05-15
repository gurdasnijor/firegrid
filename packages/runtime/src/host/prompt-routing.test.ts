// firegrid-host-context-authority.PROMPT_ROUTING.1
// firegrid-host-context-authority.PROMPT_ROUTING.2
// firegrid-host-context-authority.PROMPT_ROUTING.3
// firegrid-host-context-authority.VALIDATION.2
//
// Prompt-routing smoke: a host can append durable input for a
// context owned by another host, and the row lands in the owner
// host's ingress stream. `schedule_me` uses the same append surface.

import { Prompt } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  hostOwnedStreamUrl,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ScheduledInputWorkflow, ScheduledInputWorkflowLayer } from "../agent-tools/index.ts"
import { AgentToolHost } from "../agent-tools/tool-host.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeHostAgentToolHostLive,
  appendRuntimeIngress,
} from "./index.ts"

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
  readonly contextId: string
}) =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const nowMs = yield* Clock.currentTimeMillis
    yield* table.contexts.upsert({
      contextId: input.contextId,
      createdAt: new Date(nowMs).toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [process.execPath, "-e", "process.exit(0)"],
      })),
      host: {
        hostId: input.hostId,
        streamPrefix: makeHostStreamPrefix({
          namespace: input.namespace,
          hostId: input.hostId,
        }),
        boundAtMs: nowMs,
      },
    })
  })

const controlPlaneLayer = (input: {
  readonly namespace: string
  readonly baseUrl: string
}) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl(input),
      contentType: "application/json",
    },
  })

const ingressLayer = (input: {
  readonly namespace: string
  readonly baseUrl: string
  readonly hostId: HostId
}) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: input.baseUrl,
        prefix: makeHostStreamPrefix({
          namespace: input.namespace,
          hostId: input.hostId,
        }),
        segment: "runtimeIngress",
      }),
      contentType: "application/json",
    },
  })

const readHostIngress = (input: {
  readonly namespace: string
  readonly baseUrl: string
  readonly hostId: HostId
}): Promise<ReadonlyArray<RuntimeIngressInputRow>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = yield* RuntimeIngressTable
      return yield* table.inputs.query((coll) => coll.toArray)
    }).pipe(
      Effect.provide(ingressLayer(input)),
      Effect.scoped,
    ),
  )

describe("firegrid-host-context-authority.VALIDATION.2 prompt routing", () => {
  it("host B appends a prompt for host A context into host A ingress", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `prompt-routing-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`

    await Effect.runPromise(
      seedContext({ namespace, hostId: hostA, contextId }).pipe(
        Effect.provide(controlPlaneLayer({ baseUrl, namespace })),
        Effect.scoped,
      ),
    )

    const appended = await Effect.runPromise(
      appendRuntimeIngress({
        contextId,
        inputId: "input-cross-host",
        kind: "message",
        authoredBy: "client",
        payload: "hello from host B",
        idempotencyKey: "cross-host",
      }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId: hostB,
        })),
      ),
    )

    expect(appended).toMatchObject({
      inputId: "input-cross-host",
      contextId,
      sequence: 0,
      status: "sequenced",
      payload: "hello from host B",
    })

    const hostAIngress = await readHostIngress({ baseUrl, namespace, hostId: hostA })
    const hostBIngress = await readHostIngress({ baseUrl, namespace, hostId: hostB })

    expect(hostAIngress.map(row => row.inputId)).toEqual(["input-cross-host"])
    expect(hostBIngress).toEqual([])
  })

  it("schedule_me fires through the same owner-host prompt append path", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `prompt-routing-schedule-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const inputId = "schedule-me:test"

    await Effect.runPromise(
      seedContext({ namespace, hostId: hostA, contextId }).pipe(
        Effect.provide(controlPlaneLayer({ baseUrl, namespace })),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(
      ScheduledInputWorkflow.execute({
        contextId,
        dueAtMs: 0,
        inputId,
        prompt: Prompt.userMessage({
          content: [Prompt.textPart({ text: "scheduled follow-up" })],
        }),
      }).pipe(
        Effect.provide(ScheduledInputWorkflowLayer),
        Effect.provide(RuntimeHostAgentToolHostLive),
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId: hostB,
        })),
      ),
    )

    const hostAIngress = await readHostIngress({ baseUrl, namespace, hostId: hostA })
    const hostBIngress = await readHostIngress({ baseUrl, namespace, hostId: hostB })

    expect(hostAIngress.map(row => ({
      inputId: row.inputId,
      authoredBy: row.authoredBy,
      sequence: row.sequence,
      status: row.status,
    }))).toEqual([{
      inputId,
      authoredBy: "workflow",
      sequence: 0,
      status: "sequenced",
    }])
    expect(hostBIngress).toEqual([])
  })

  it("firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2 session_prompt uses owner-host prompt append routing", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `prompt-routing-session-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const hostB = `host_B_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const inputId = "session-prompt:test"

    await Effect.runPromise(
      seedContext({ namespace, hostId: hostA, contextId }).pipe(
        Effect.provide(controlPlaneLayer({ baseUrl, namespace })),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* AgentToolHost
        yield* host.appendSessionPrompt({
          toolUseId: "tool-session-prompt",
          sessionId: contextId,
          inputId,
          prompt: Prompt.userMessage({
            content: [Prompt.textPart({ text: "session follow-up" })],
          }),
        })
      }).pipe(
        Effect.provide(RuntimeHostAgentToolHostLive),
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId: hostB,
        })),
      ),
    )

    const hostAIngress = await readHostIngress({ baseUrl, namespace, hostId: hostA })
    const hostBIngress = await readHostIngress({ baseUrl, namespace, hostId: hostB })

    expect(hostAIngress.map(row => ({
      inputId: row.inputId,
      authoredBy: row.authoredBy,
      sequence: row.sequence,
      status: row.status,
    }))).toEqual([{
      inputId,
      authoredBy: "workflow",
      sequence: 0,
      status: "sequenced",
    }])
    expect(hostBIngress).toEqual([])
  })

  it("firegrid-factory-aligned-agent-tools.SESSION.1 starts a live session_new child without awaiting terminal completion", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `session-new-live-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* AgentToolHost
        const session = yield* host.spawnChildContext({
          parentContextId: "ctx-parent",
          toolUseId: "tool-session-new-live",
          agentKind: "/usr/bin/true",
          prompt: "ignored",
        })
        const table = yield* RuntimeControlPlaneTable
        const context = yield* table.contexts.get(session.childContextId)
        return { session, context }
      }).pipe(
        Effect.provide(RuntimeHostAgentToolHostLive),
        Effect.provide(FiregridRuntimeHostWithWorkflowLive({
          durableStreamsBaseUrl: baseUrl,
          namespace,
          hostId,
        })),
        Effect.scoped,
      ),
    )

    expect(result.session).toEqual({
      childContextId: result.session.childContextId,
      status: "running",
    })
    expect(result.context._tag).toBe("Some")

    const hostIngress = await readHostIngress({ baseUrl, namespace, hostId })
    expect(hostIngress.map(row => ({
      contextId: row.contextId,
      authoredBy: row.authoredBy,
      status: row.status,
    }))).toEqual([{
      contextId: result.session.childContextId,
      authoredBy: "workflow",
      status: "sequenced",
    }])
  })
})

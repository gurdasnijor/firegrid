// firegrid-host-context-authority.PROMPT_ROUTING.1
// firegrid-host-context-authority.PROMPT_ROUTING.2
// firegrid-host-context-authority.PROMPT_ROUTING.3
// firegrid-host-context-authority.VALIDATION.2
//
// Prompt-routing smoke: a host can append durable input for a context owned by
// another host, and the input completes the owner workflow's runtime-input
// deferred. `schedule_me` uses the same append surface.

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
  RuntimeIngressInputRowSchema,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Cause, Clock, Effect, Either, Exit, Match, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  WorkflowEngineTable,
} from "@firegrid/runtime/workflow-engine"
import { ScheduledInputWorkflow, ScheduledInputWorkflowLayer } from "../../src/agent-tools/index.ts"
import { AgentToolHost } from "../../src/agent-tools/execution/tool-host.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeHostAgentToolHostLive,
  appendRuntimeIngress,
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

const workflowTableLayer = (input: {
  readonly namespace: string
  readonly baseUrl: string
  readonly hostId: HostId
}) =>
  WorkflowEngineTable.layer({
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
  })

const reviveCause = (value: unknown): Cause.Cause<unknown> => {
  const record = value as { readonly _tag?: string; readonly failure?: unknown; readonly defect?: unknown }
  if (record?._tag === "Fail") return Cause.fail(record.failure)
  if (record?._tag === "Die") return Cause.die(record.defect)
  return value as Cause.Cause<unknown>
}

const reviveExit = (value: unknown): Exit.Exit<unknown, unknown> => {
  const record = value as { readonly _tag?: string; readonly value?: unknown; readonly cause?: unknown }
  if (record?._tag === "Success") return Exit.succeed(record.value)
  if (record?._tag === "Failure") return Exit.failCause(reviveCause(record.cause))
  return value as Exit.Exit<unknown, unknown>
}

const decodeInputRows = (value: unknown): ReadonlyArray<RuntimeIngressInputRow> =>
  Exit.match(reviveExit(value), {
    onFailure: () => [],
    onSuccess: success =>
      Match.value(Schema.decodeUnknownEither(RuntimeIngressInputRowSchema)(success)).pipe(
        Match.when(Either.isRight, decoded => [decoded.right]),
        Match.orElse(() => []),
      ),
  })

const readHostDeferredInputs = (input: {
  readonly namespace: string
  readonly baseUrl: string
  readonly hostId: HostId
}): Promise<ReadonlyArray<RuntimeIngressInputRow>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = yield* WorkflowEngineTable
      return yield* table.deferreds.query((coll) =>
        coll.toArray
          .filter(row => row.deferredName.includes("/input/"))
          .flatMap(row => decodeInputRows(row.exit)))
    }).pipe(
      Effect.provide(workflowTableLayer(input)),
      Effect.scoped,
    ),
  )

describe("firegrid-host-context-authority.VALIDATION.2 prompt routing", () => {
  it("host B appends a prompt for host A context into host A workflow input deferred", async () => {
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

    const hostAInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId: hostA })
    const hostBInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId: hostB })

    expect(hostAInputs.map(row => row.inputId)).toEqual(["input-cross-host"])
    expect(hostBInputs).toEqual([])
  })

  it("schedule_me fires through the same owner-host deferred-input path", async () => {
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

    const hostAInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId: hostA })
    const hostBInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId: hostB })

    expect(hostAInputs.map(row => ({
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
    expect(hostBInputs).toEqual([])
  })

  it("firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2 session_prompt uses owner-host deferred-input routing", async () => {
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

    const hostAInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId: hostA })
    const hostBInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId: hostB })

    expect(hostAInputs.map(row => ({
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
    expect(hostBInputs).toEqual([])
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

    const hostInputs = await readHostDeferredInputs({ baseUrl, namespace, hostId })
    expect(hostInputs.map(row => ({
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

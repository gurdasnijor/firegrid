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
import { Cause, Clock, Duration, Effect, Either, Exit, Match, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  WorkflowEngineTable,
} from "@firegrid/runtime/workflow-engine"
import { AgentToolHost } from "../../src/agent-tools/execution/tool-host.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
  appendRuntimeIngress,
} from "../../src/host/index.ts"
import {
  RuntimeContextInput,
  RuntimeContextWorkflowRuntime,
} from "@firegrid/runtime/kernel"

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
  Effect.gen(function*() {
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

const readContextDeferredInputs = (input: {
  readonly namespace: string
  readonly baseUrl: string
  readonly hostId: HostId
  readonly contextId: string
}): Promise<ReadonlyArray<RuntimeIngressInputRow>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const table = yield* WorkflowEngineTable
      return yield* table.deferreds.query((coll) =>
        coll.toArray
          .filter(row => row.deferredName.includes(`runtime-context/${input.contextId}/input/`))
          .flatMap(row => decodeInputRows(row.exit)))
    }).pipe(
      Effect.provide(workflowTableLayer(input)),
      Effect.scoped,
    ),
  )

const waitForContextDeferredInputs = async (
  input: {
    readonly namespace: string
    readonly baseUrl: string
    readonly hostId: HostId
    readonly contextId: string
  },
  count: number,
): Promise<ReadonlyArray<RuntimeIngressInputRow>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await readContextDeferredInputs(input)
    if (rows.length >= count) return rows
    await Effect.runPromise(Effect.sleep(Duration.millis(10)))
  }
  return readContextDeferredInputs(input)
}

const intentIds = (input: {
  readonly namespace: string
  readonly baseUrl: string
}) =>
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    return yield* table.inputIntents.query((coll) =>
      coll.toArray.map(row => row.intentId))
  }).pipe(
    Effect.provide(controlPlaneLayer(input)),
    Effect.scoped,
  )

const runWithHost = <A, E, R>(
  options: {
    readonly baseUrl: string
    readonly namespace: string
    readonly hostId: HostId
  },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(FiregridRuntimeHostWithWorkflowLive({
        durableStreamsBaseUrl: options.baseUrl,
        namespace: options.namespace,
        hostId: options.hostId,
      })),
    ),
  )

describe("firegrid-workflow-driven-runtime.VALIDATION.8 runtime input intents", () => {
  it("appends a durable intent without owner-host workflow stream routing when no local engine is active", async () => {
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
      runWithHost({ baseUrl, namespace, hostId: hostB }, appendRuntimeIngress({
        contextId,
        inputId: "input-cross-host",
        kind: "message",
        authoredBy: "client",
        payload: "hello from host B",
        idempotencyKey: "cross-host",
      })),
    )

    expect(appended).toMatchObject({
      inputId: "input-cross-host",
      contextId,
      status: "pending",
      payload: "hello from host B",
    })

    expect(await Effect.runPromise(intentIds({ baseUrl, namespace }))).toEqual(["input-cross-host"])
    expect(await readContextDeferredInputs({ baseUrl, namespace, hostId: hostA, contextId })).toEqual([])
  })

  it("reconciles durable intents when the owning host-scoped engine starts", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `prompt-routing-reconcile-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`

    await Effect.runPromise(
      seedContext({ namespace, hostId: hostA, contextId }).pipe(
        Effect.provide(controlPlaneLayer({ baseUrl, namespace })),
        Effect.scoped,
      ),
    )
    await Effect.runPromise(
      runWithHost({ baseUrl, namespace, hostId: hostA }, appendRuntimeIngress({
        contextId,
        inputId: "input-reconcile",
        kind: "message",
        authoredBy: "client",
        payload: "hello before engine",
        idempotencyKey: "reconcile",
      })),
    )

    await Effect.runPromise(
      runWithHost(
        { baseUrl, namespace, hostId: hostA },
        Effect.gen(function*() {
          const table = yield* RuntimeControlPlaneTable
          const context = yield* table.contexts.get(contextId)
          if (context._tag === "None") return yield* Effect.fail(new Error("missing context"))
          const runtime = yield* RuntimeContextWorkflowRuntime
          const input = yield* RuntimeContextInput
          yield* runtime.ensureActive(context.value)
          yield* input.reconcile(context.value)
        }),
      ),
    )

    expect((await readContextDeferredInputs({ baseUrl, namespace, hostId: hostA, contextId })).map(row => ({
      inputId: row.inputId,
      sequence: row.sequence,
      status: row.status,
    }))).toEqual([{
      inputId: "input-reconcile",
      sequence: 0,
      status: "sequenced",
    }])
  })

  it("dispatches session_prompt through the active local host-scoped engine", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `prompt-routing-session-${crypto.randomUUID()}`
    const hostA = `host_A_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const inputId = "session-prompt:test"

    await Effect.runPromise(
      seedContext({ namespace, hostId: hostA, contextId }).pipe(
        Effect.provide(controlPlaneLayer({ baseUrl, namespace })),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(
      runWithHost(
        { baseUrl, namespace, hostId: hostA },
        Effect.gen(function*() {
          const table = yield* RuntimeControlPlaneTable
          const context = yield* table.contexts.get(contextId)
          if (context._tag === "None") return yield* Effect.fail(new Error("missing context"))
          const runtime = yield* RuntimeContextWorkflowRuntime
          yield* runtime.ensureActive(context.value)
          const host = yield* AgentToolHost
          yield* host.appendSessionPrompt({
            toolUseId: "tool-session-prompt",
            sessionId: contextId,
            inputId,
            prompt: Prompt.userMessage({
              content: [Prompt.textPart({ text: "session follow-up" })],
            }),
          })
        }),
      ),
    )

    expect((await waitForContextDeferredInputs({ baseUrl, namespace, hostId: hostA, contextId }, 1)).map(row => ({
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
  })

  it("starts a live session_new child and reconciles its initial prompt on the child engine", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `session-new-live-${crypto.randomUUID()}`
    const hostId = `host_A_${crypto.randomUUID()}` as HostId

    const result = await Effect.runPromise(
      runWithHost(
        { baseUrl, namespace, hostId },
        Effect.gen(function*() {
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
        }),
      ),
    )

    expect(result.session).toEqual({
      childContextId: result.session.childContextId,
      status: "running",
    })
    expect(result.context._tag).toBe("Some")

    expect((await readContextDeferredInputs({
      baseUrl,
      namespace,
      hostId,
      contextId: result.session.childContextId,
    })).map(row => ({
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

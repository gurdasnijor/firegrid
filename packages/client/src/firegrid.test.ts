import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeOutputTable,
  type PublicLaunchRequest,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
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

const runWithFiregrid = <A, E>(
  config: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
  },
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          FiregridLive.pipe(
            Layer.provide(Layer.succeed(FiregridConfig, {
              durableStreamsBaseUrl: config.durableStreamsBaseUrl,
              namespace: config.namespace,
            })),
          ),
        ),
      ),
    ),
  )

const appendRuntimeOutput = (
  config: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
  },
  contextId: string,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = yield* RuntimeOutputTable
      yield* table.events.upsert({
        eventId: {
          contextId,
          activityAttempt: 1,
          target: "events",
          sequence: 0,
        },
        contextId,
        activityAttempt: 1,
        sequence: 0,
        source: "stdout",
        format: "jsonl",
        receivedAt: "2026-05-13T00:00:00.000Z",
        raw: "{\"type\":\"assistant\"}",
      })
      yield* table.logs.upsert({
        logLineId: {
          contextId,
          activityAttempt: 1,
          target: "logs",
          sequence: 1,
        },
        contextId,
        activityAttempt: 1,
        sequence: 1,
        source: "stderr",
        format: "text-lines",
        receivedAt: "2026-05-13T00:00:01.000Z",
        raw: "diagnostic",
      })
    }).pipe(
      Effect.provide(RuntimeOutputTable.layer({
        streamOptions: {
          url: `${config.durableStreamsBaseUrl}/v1/stream/${config.namespace}.firegrid.runtimeOutput`,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ),
  )

describe("@firegrid/client", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7 appends normalized runtime contexts without caller ids or stream wiring", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `client-${crypto.randomUUID()}`,
    }

    const handle = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
      }),
    )

    expect(handle.contextId).toMatch(/^ctx_/)

    const snapshot = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }),
    )
    expect(snapshot.context).toMatchObject({
      contextId: handle.contextId,
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
        },
      },
    })
    expect(snapshot.context?.runtime.journal).toContainEqual({
      source: "stdout",
      format: "jsonl",
      target: "events",
    })
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.1 firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.5 exposes durable snapshots without live process authority", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `client-${crypto.randomUUID()}`,
    }
    const snapshot = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
        return yield* handle.snapshot
      }),
    )

    expect(snapshot.context?.runtime.provider).toEqual("local-process")
    expect(snapshot.runs).toEqual([])
    expect(snapshot.events).toEqual([])
    expect(snapshot.logs).toEqual([])
  })

  it("firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.7 reads runtime output snapshots from RuntimeOutputTable", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `client-${crypto.randomUUID()}`,
    }
    const handle = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
      }),
    )

    await appendRuntimeOutput(firegridConfig, handle.contextId)

    const snapshot = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }),
    )

    expect(snapshot.events).toContainEqual(expect.objectContaining({
      raw: "{\"type\":\"assistant\"}",
    }))
    expect(snapshot.logs).toContainEqual(expect.objectContaining({
      raw: "diagnostic",
    }))
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects malformed public launch input at the client boundary", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `client-${crypto.randomUUID()}`,
    }
    const request: unknown = {
      runtime: {
        provider: "remote-provider",
        config: {
          argv: "node --version",
        },
      },
    }

    const result = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* Effect.either(firegrid.launch(request as PublicLaunchRequest))
      }),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "LaunchInputError",
      })
    }
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects public launch input with raw env or journal fields", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `client-${crypto.randomUUID()}`,
    }
    const request: unknown = {
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
          env: {
            ANTHROPIC_API_KEY: "must-not-persist",
          },
        },
        journal: [
          { source: "stdout", format: "text-lines", target: "logs" },
        ],
      },
    }

    const result = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* Effect.either(firegrid.launch(request as PublicLaunchRequest))
      }),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "LaunchInputError",
      })
    }
  })

  it("firegrid-agent-ingress.INGRESS.3 firegrid-agent-ingress.INGRESS.6 appends prompt input facts with deterministic identity without invoking runtime delivery", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `client-${crypto.randomUUID()}`,
    }
    const result = await runWithFiregrid(
      firegridConfig,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const first = yield* firegrid.prompt({
          contextId: "ctx_prompt",
          payload: [{ type: "text", text: "hello" }],
          idempotencyKey: "prompt-1",
          metadata: { source: "client-test" },
        })
        const duplicate = yield* firegrid.prompt({
          contextId: "ctx_prompt",
          payload: [{ type: "text", text: "hello duplicate" }],
          idempotencyKey: "prompt-1",
        })
        return { first, duplicate }
      }),
    )

    expect(result.duplicate.inputId).toEqual(result.first.inputId)
    expect(result.first).toMatchObject({
      contextId: "ctx_prompt",
      status: "sequenced",
      sequence: 0,
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "prompt-1",
    })
  })
})

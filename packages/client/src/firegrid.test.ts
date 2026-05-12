import {
  FetchHttpClient,
} from "@effect/platform"
import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  type PublicLaunchRequest,
} from "@firegrid/protocol/launch"
import {
  SessionInputRowSchema,
} from "@firegrid/protocol/session-input"
import { Effect, Either, Layer, Stream } from "effect"
import { DurableStream } from "effect-durable-streams"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "./index.ts"

let server: DurableStreamsTestServerHandle | undefined

beforeEach(async () => {
  server = await startDurableStreamsTestServer()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  return server.createStreamUrl(name)
}

const runWithFiregrid = <A, E>(
  runtimeStreamUrl: string,
  effect: Effect.Effect<A, E, Firegrid>,
  options: { readonly inputStreamUrl?: string } = {},
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FiregridLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, {
            runtimeStreamUrl,
            ...(options.inputStreamUrl === undefined ? {} : { inputStreamUrl: options.inputStreamUrl }),
          })),
        ),
      ),
    ),
  )

describe("@firegrid/client", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7 appends normalized runtime contexts without caller ids or stream wiring", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")

    const handle = await runWithFiregrid(
      runtimeStreamUrl,
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
      runtimeStreamUrl,
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
    const runtimeStreamUrl = await createStreamUrl("runtime")
    const snapshot = await runWithFiregrid(
      runtimeStreamUrl,
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

  it("firegrid-durable-launch-runtime-operator.LAUNCH_HANDLE.5 exposes runtime context changes as a Stream", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")

    const snapshots = await runWithFiregrid(
      runtimeStreamUrl,
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const handle = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: ["node", "--version"],
          }),
        })
        return yield* handle.changes.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(chunk => Array.from(chunk)),
        )
      }),
    )

    expect(snapshots[0]?.context?.runtime.config.argv).toEqual(["node", "--version"])
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects malformed public launch input at the client boundary", async () => {
    const runtimeStreamUrl = await createStreamUrl("runtime")
    const request: unknown = {
      runtime: {
        provider: "remote-provider",
        config: {
          argv: "node --version",
        },
      },
    }

    const result = await runWithFiregrid(
      runtimeStreamUrl,
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
    const runtimeStreamUrl = await createStreamUrl("runtime")
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
      runtimeStreamUrl,
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
    const runtimeStreamUrl = await createStreamUrl("runtime")
    const inputStreamUrl = await createStreamUrl("runtime-input")

    const result = await runWithFiregrid(
      runtimeStreamUrl,
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
      { inputStreamUrl },
    )

    expect(result.duplicate.sessionInputId).toEqual(result.first.sessionInputId)

    const rows = await Effect.runPromise(DurableStream.define({
      endpoint: { url: inputStreamUrl },
      schema: SessionInputRowSchema,
    }).collect.pipe(
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.sessionInputId)).toEqual([
      result.first.sessionInputId,
      result.first.sessionInputId,
    ])
    expect(rows[0]).toMatchObject({
      type: "firegrid.session.input",
      contextId: "ctx_prompt",
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "prompt-1",
    })
    expect(rows[1]).toMatchObject({
      type: "firegrid.session.input",
      contextId: "ctx_prompt",
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "prompt-1",
    })
  })
})

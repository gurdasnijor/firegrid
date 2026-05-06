import { DurableStream } from "@durable-streams/client"
import type { StateEvent } from "@durable-streams/state"
import {
  Chunk,
  Context,
  Duration,
  Effect,
  Either,
  Option,
  Schema,
  Stream,
  Tracer,
} from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  EventStream,
  FiregridClient,
  FiregridClientLive,
  Operation,
  OperationHandle,
} from "../index.ts"
import {
  FiregridSpanAttribute,
  FiregridSpanName,
  OPERATION_ENVELOPE_TAG,
  isOperationEnvelope,
} from "@firegrid/substrate/descriptors"
import {
  createSubstrateStream,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const EchoOperation = Operation.define({
  name: "client.echo",
  input: Schema.Struct({
    message: Schema.String,
    count: Schema.NumberFromString,
  }),
  output: Schema.Struct({
    echoed: Schema.String,
    total: Schema.NumberFromString,
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

const ClientEvents = EventStream.define({
  name: "client.events",
  event: Schema.Struct({
    kind: Schema.Literal("ready"),
    value: Schema.String,
  }),
})

interface RecordedSpan {
  readonly name: string
  readonly kind: string
  readonly attributes: Map<string, unknown>
}

const makeRecordingTracer = () => {
  const spans: Array<RecordedSpan> = []
  const tracer = Tracer.make({
    span: (name, _parent, _ctx, _links, startTime, kind, options) => {
      const attributes = new Map<string, unknown>(
        Object.entries(options?.attributes ?? {}),
      )
      spans.push({ name, kind, attributes })
      return {
        _tag: "Span",
        name,
        spanId: `${name}:${spans.length}`,
        traceId: "firegrid-client-test-trace",
        parent: Option.none(),
        context: Context.empty(),
        status: { _tag: "Started", startTime },
        attributes,
        links: [],
        sampled: true,
        kind,
        end: () => {},
        attribute: (key, value) => {
          attributes.set(key, value)
        },
        event: () => {},
        addLinks: () => {},
      }
    },
    context: (f) => f(),
  })
  return { spans, tracer } as const
}

const layerFor = (streamUrl: string) =>
  FiregridClientLive({ streamUrl, clientId: "firegrid-operation-tests" })

const durableFor = (url: string) =>
  new DurableStream({ url, contentType: "application/json" })

const readRetained = async (url: string): Promise<ReadonlyArray<StateEvent>> => {
  const response = await durableFor(url).stream<StateEvent>({
    offset: "-1",
    live: false,
  })
  return await response.json<StateEvent>()
}

const appendRow = async (url: string, row: StateEvent): Promise<void> => {
  await durableFor(url).append(JSON.stringify(row))
}

const runRow = (
  runId: string,
  value: Record<string, unknown>,
): StateEvent => ({
  type: "durable.run",
  key: runId,
  value: {
    runId,
    ...value,
  },
  headers: { operation: "upsert" },
})

describe("firegrid-client-api.CLIENT_SURFACE.1 — client.send appends operation intent", () => {
  it("firegrid-client-api.AUTHORITY_BOUNDARY.3 — writes a durable operation intent without exposing producer authority", async () => {
    const url = await createSubstrateStream("client-operation-send")

    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        return yield* client.send(EchoOperation, {
          message: "hello",
          count: 3,
        })
      }).pipe(Effect.provide(layerFor(url))),
    )

    expect(handle._tag).toBe("OperationHandle")
    expect(handle._operation).toBe("client.echo")

    const rows = await readRetained(url)
    expect(rows).toHaveLength(1)
    const row = rows[0]! as {
      readonly type: string
      readonly key: string
      readonly headers: unknown
      readonly value: Record<string, unknown>
    }
    expect(row.type).toBe("durable.run")
    expect(row.key).toBe(handle.id)
    expect(row.headers).toEqual({ operation: "insert" })

    const value = row.value
    expect(value.runId).toBe(handle.id)
    expect(value.state).toBe("started")
    expect(isOperationEnvelope(value.data)).toBe(true)
    expect(value.data).toEqual({
      _envelope: OPERATION_ENVELOPE_TAG,
      operation: "client.echo",
      payload: {
        message: "hello",
        count: "3",
      },
    })
  })
})

describe("firegrid-client-api.CLIENT_SURFACE.2, firegrid-client-api.CLIENT_SURFACE.4 — client.result composes over durable observation", () => {
  it("decodes a completed run output through the operation descriptor", async () => {
    const url = await createSubstrateStream("client-operation-result")

    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        return yield* client.send(EchoOperation, {
          message: "hello",
          count: 3,
        })
      }).pipe(Effect.provide(layerFor(url))),
    )

    await appendRow(
      url,
      runRow(handle.id, {
        state: "completed",
        result: {
          echoed: "hello",
          total: "4",
        },
      }),
    )

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        return yield* client.result(EchoOperation, handle)
      }).pipe(Effect.provide(layerFor(url))),
    )

    expect(output).toEqual({ echoed: "hello", total: 4 })
  })

  it("firegrid-client-api.CLIENT_SURFACE.5 — fails with the typed operation error decoded from a failed run", async () => {
    const url = await createSubstrateStream("client-operation-result-error")

    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        return yield* client.send(EchoOperation, {
          message: "hello",
          count: 3,
        })
      }).pipe(Effect.provide(layerFor(url))),
    )

    await appendRow(
      url,
      runRow(handle.id, {
        state: "failed",
        error: {
          code: "NOPE",
          message: "rejected",
        },
      }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        return yield* Effect.either(client.result(EchoOperation, handle))
      }).pipe(Effect.provide(layerFor(url))),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toEqual({ code: "NOPE", message: "rejected" })
    }
  })
})

describe("firegrid-client-api.CLIENT_SURFACE.2 — client.observe returns an Effect Stream", () => {
  it("streams pending and completed operation states for a handle", async () => {
    const url = await createSubstrateStream("client-operation-observe")

    const states = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* FiregridClient
          const handle = yield* client.send(EchoOperation, {
            message: "hello",
            count: 3,
          })
          const fiber = yield* Effect.fork(
            client.observe(EchoOperation, handle).pipe(
              Stream.take(3),
              Stream.runCollect,
            ),
          )
          yield* Effect.sleep(Duration.millis(40))
          yield* Effect.promise(() =>
            appendRow(
              url,
              runRow(handle.id, {
                state: "completed",
                result: {
                  echoed: "hello",
                  total: "4",
                },
              }),
            ),
          )
          return yield* fiber
        }),
      ).pipe(Effect.provide(layerFor(url))),
    )

    expect(Chunk.toReadonlyArray(states)).toEqual([
      { _tag: "Pending" },
      { _tag: "Pending" },
      { _tag: "Completed", output: { echoed: "hello", total: 4 } },
    ])
  })
})

describe("firegrid-client-api.AUTHORITY_BOUNDARY.1 — operation handles are attach-only values", () => {
  it("constructs a typed handle without exposing claim, completion, terminal, RunWait, or runtime authority", async () => {
    const handle = await Effect.runPromise(
      Effect.sync(() => OperationHandle.make(EchoOperation, "existing-run")),
    )
    expect(handle).toEqual({
      _tag: "OperationHandle",
      id: "existing-run",
      _operation: "client.echo",
    })
  })
})

describe("firegrid-observability.SUBSTRATE_SPANS.1 + .3 — client operations and EventStreams emit Effect-native spans", () => {
  it("a host Tracer observes send/result/observe/emit/events spans with stable firegrid attributes", async () => {
    const url = await createSubstrateStream("client-observability-spans")
    const { spans, tracer } = makeRecordingTracer()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        const handle = yield* client.send(EchoOperation, {
          message: "hello",
          count: 3,
        })

        yield* Effect.promise(() =>
          appendRow(
            url,
            runRow(handle.id, {
              state: "completed",
              result: {
                echoed: "hello",
                total: "4",
              },
            }),
          ),
        )

        const output = yield* client.result(EchoOperation, handle)
        const states = yield* client.observe(EchoOperation, handle).pipe(
          Stream.take(1),
          Stream.runCollect,
        )

        yield* client.emit(ClientEvents, { kind: "ready", value: "ok" })
        const events = yield* client.events(ClientEvents).pipe(
          Stream.take(1),
          Stream.runCollect,
        )

        return { handle, output, states, events } as const
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(layerFor(url)),
      ),
    )

    expect(result.output).toEqual({ echoed: "hello", total: 4 })
    expect(Chunk.toReadonlyArray(result.states)).toEqual([
      { _tag: "Completed", output: { echoed: "hello", total: 4 } },
    ])
    expect(Chunk.toReadonlyArray(result.events)).toEqual([
      { kind: "ready", value: "ok" },
    ])

    const byName = new Map(spans.map((span) => [span.name, span]))
    expect(byName.get(FiregridSpanName.clientOperationSend)?.kind).toBe(
      "client",
    )
    expect(byName.get(FiregridSpanName.clientOperationResult)?.kind).toBe(
      "client",
    )
    expect(byName.get(FiregridSpanName.clientOperationObserve)?.kind).toBe(
      "client",
    )
    expect(byName.get(FiregridSpanName.eventStreamEmit)?.kind).toBe("producer")
    expect(byName.has(FiregridSpanName.eventStreamEvents)).toBe(true)

    expect(
      byName
        .get(FiregridSpanName.clientOperationSend)
        ?.attributes.get(FiregridSpanAttribute.operationDescriptor),
    ).toBe(EchoOperation.name)
    expect(
      byName
        .get(FiregridSpanName.clientOperationSend)
        ?.attributes.get(FiregridSpanAttribute.operationHandleId),
    ).toBe(result.handle.id)
    expect(
      byName
        .get(FiregridSpanName.clientOperationResult)
        ?.attributes.get(FiregridSpanAttribute.status),
    ).toBe("completed")
    expect(
      byName
        .get(FiregridSpanName.clientOperationObserve)
        ?.attributes.get(FiregridSpanAttribute.status),
    ).toBe("Completed")
    expect(
      byName
        .get(FiregridSpanName.eventStreamEmit)
        ?.attributes.get(FiregridSpanAttribute.streamDescriptor),
    ).toBe(ClientEvents.name)
    expect(
      byName
        .get(FiregridSpanName.eventStreamEvents)
        ?.attributes.get(FiregridSpanAttribute.status),
    ).toBe("event")
  })

  it("firegrid-observability.ERROR_TERMINAL_CORRELATION.3 — tracing preserves typed operation failure semantics", async () => {
    const url = await createSubstrateStream("client-observability-error")
    const { spans, tracer } = makeRecordingTracer()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        const handle = yield* client.send(EchoOperation, {
          message: "hello",
          count: 3,
        })
        yield* Effect.promise(() =>
          appendRow(
            url,
            runRow(handle.id, {
              state: "failed",
              error: {
                code: "NOPE",
                message: "rejected",
              },
            }),
          ),
        )
        return yield* Effect.either(client.result(EchoOperation, handle))
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(layerFor(url)),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toEqual({ code: "NOPE", message: "rejected" })
    }

    const resultSpan = spans.find((span) =>
      span.name === FiregridSpanName.clientOperationResult
    )
    expect(resultSpan?.attributes.get(FiregridSpanAttribute.status)).toBe(
      "failed",
    )
    expect(resultSpan?.attributes.get(FiregridSpanAttribute.errorTag)).toBe(
      "object",
    )
  })
})

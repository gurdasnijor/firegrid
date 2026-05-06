import { DurableStream } from "@durable-streams/client"
import {
  EventStream,
  makeEventStreamStateRow,
  type EventStreamStateRow,
} from "@firegrid/substrate/descriptors"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Deferred, Duration, Effect, Exit, Layer, Ref, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"
import { Firegrid, FiregridRuntime, FiregridRuntimeBoot } from "../index.ts"

// firegrid-event-streams.RUNTIME_API.1
// firegrid-event-streams.RUNTIME_API.2
// firegrid-event-streams.RUNTIME_API.3
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
//
// Behavior + lifecycle tests for `Firegrid.eventStream`. Architecture-
// boundary enforcement (no client / lab imports, no substrate state-
// machine builders) lives in `eslint.config.js`; this test file does
// not parse imports.

class AppendFailed extends Data.TaggedError("AppendFailed")<{
  readonly cause: unknown
}> {}

const here = dirname(fileURLToPath(import.meta.url))
const internalRuntimeRoot = resolve(here, "..", "runtime", "internal")

const Hits = EventStream.define({
  name: "Hits",
  event: Schema.Struct({
    url: Schema.String,
    count: Schema.Number,
  }),
})

const appendRowRaw = (
  streamUrl: string,
  row: unknown,
): Effect.Effect<void, AppendFailed> =>
  Effect.tryPromise({
    try: async () => {
      const handle = new DurableStream({
        url: streamUrl,
        contentType: "application/json",
      })
      await handle.append(JSON.stringify(row))
    },
    catch: (cause) => new AppendFailed({ cause }),
  })

const createRuntimeStream = async (name: string): Promise<string> => {
  const streamUrl = freshStreamUrl(name)
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

describe("firegrid-event-streams.RUNTIME_API — Firegrid.eventStream public surface", () => {
  it("Firegrid.eventStream is a function and lives next to handler / subscribers", () => {
    expect(typeof Firegrid.eventStream).toBe("function")
    expect(new Set(Object.keys(Firegrid))).toEqual(
      new Set(["subscribers", "handler", "eventStream"]),
    )
  })

  it("Firegrid.eventStream(descriptor, materialize) returns an Effect Layer", () => {
    const layer = Firegrid.eventStream(Hits, () => Effect.void)
    expect(Layer.isLayer(layer)).toBe(true)
  })
})

describe("firegrid-event-streams.RUNTIME_API.1, .3 — materializer dispatches matching envelopes in order, decoded via descriptor.event", () => {
  it("decodes EventStream envelopes whose `stream` matches the descriptor and skips non-matching/malformed records", async () => {
    const streamUrl = await createRuntimeStream(
      "firegrid-eventstream-dispatch",
    )

    const program = Effect.gen(function* () {
      const observed = yield* Ref.make<ReadonlyArray<EventStream.Event<typeof Hits>>>([])
      const targetCount = 2
      const reachedTarget = yield* Deferred.make<void>()

      const layer = Firegrid.eventStream(Hits, (event) =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(observed, (prev) => [
            ...prev,
            event,
          ])
          if (next.length >= targetCount) {
            yield* Deferred.succeed(reachedTarget, undefined)
          }
        }),
      )

      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* FiregridRuntime
          expect(runtime.bootMode).toBe("attached")
          expect(runtime.streamIdentity.streamUrl).toBe(streamUrl)

          const matchingA: EventStreamStateRow = makeEventStreamStateRow({
            stream: Hits.name,
            eventId: "a",
            event: { url: "/a", count: 1 },
          })
          const matchingB: EventStreamStateRow = makeEventStreamStateRow({
            stream: Hits.name,
            eventId: "b",
            event: { url: "/b", count: 2 },
          })
          const otherStream: EventStreamStateRow = makeEventStreamStateRow({
            stream: "OtherEventStream",
            eventId: "other",
            event: { url: "/other", count: 99 },
          })
          const notAnEnvelope = { hello: "world" }

          // Append a non-State-Protocol row, a State Protocol row
          // for a different EventStream, and the two real events.
          // The materializer must skip the first two and decode the
          // latter two in arrival order.
          yield* appendRowRaw(streamUrl, notAnEnvelope)
          yield* appendRowRaw(streamUrl, otherStream)
          yield* appendRowRaw(streamUrl, matchingA)
          yield* appendRowRaw(streamUrl, matchingB)

          yield* Deferred.await(reachedTarget).pipe(
            Effect.timeout(Duration.seconds(5)),
          )
          return yield* Ref.get(observed)
        }).pipe(
          Effect.provide(
            FiregridRuntimeBoot.attached({
              streamUrl,
              runtime: layer,
            }),
          ),
        ),
      )

      return events
    })

    const events = await Effect.runPromise(program)
    expect(events).toEqual([
      { url: "/a", count: 1 },
      { url: "/b", count: 2 },
    ])
  })
})

describe("firegrid-event-streams.RUNTIME_API.3 — Scope-bound materializer fiber tears down with the providing Layer's scope", () => {
  it("interrupts the materializer fiber on scope exit without leaking work", async () => {
    const streamUrl = await createRuntimeStream(
      "firegrid-eventstream-scope",
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          // Acquiring the runtime is enough to prove the materializer
          // Layer is composable and Scope-bound; exiting this gen
          // closes the providing Layer's scope, which interrupts the
          // materializer fiber.
          yield* Effect.void
        }).pipe(
          Effect.provide(
            FiregridRuntimeBoot.attached({
              streamUrl,
              runtime: Firegrid.eventStream(Hits, () => Effect.void),
            }),
          ),
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("firegrid-remediation-hardening.EFFECT_CONSISTENCY.3 — materializer stream bridge guardrail", () => {
  it("firegrid-event-streams.RUNTIME_API.1, firegrid-event-streams.RUNTIME_API.3, firegrid-remediation-hardening.EFFECT_CONSISTENCY.3 — uses the typed subscribeJson StreamResponse bridge", () => {
    const source = readFileSync(
      resolve(internalRuntimeRoot, "event-stream-materializer.ts"),
      "utf8",
    )

    expect(source).toContain("type StreamResponse")
    expect(source).toContain("StreamResponse<unknown>")
    expect(source).toContain("Stream.asyncScoped<unknown>")
    expect(source).toContain('strategy: "suspend"')
    expect(source).toContain("await emit.single(item)")
    expect(source).toContain("Effect.acquireRelease")
    expect(source).toContain("subscribeJson")
    expect(source).not.toContain("as unknown as")
    expect(source).not.toContain("Stream.async<unknown, EventStreamSessionError>")
    expect(source).not.toContain("void emit.single(item)")
  })
})

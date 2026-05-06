import type { ChangeEvent } from "@durable-streams/state"
import { DurableStream } from "@durable-streams/client"
import { Chunk, Duration, Effect, Fiber, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  SubstrateProducerLive,
  WorkProducer,
  rebuildProjection,
} from "@firegrid/substrate/kernel"
import {
  SubstrateClient,
  SubstrateClientLive,
} from "../internal/work-client.ts"
import type { DeclareWorkInput } from "../internal/work-facet.ts"
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

const layerFor = (streamUrl: string) =>
  SubstrateClientLive({ streamUrl, clientId: "client-tests" })

// launchable-substrate-host.CLIENT_SURFACE.7
// Tests that need a deterministic runId BEFORE subscribing seed the
// stream through the kernel-level WorkProducer in test scope. The
// client root never accepts `runId` from callers (the reviewer's
// "do not expose that capability through the client API"); kernel
// composition stays in test scope only.
const seedKernelRun = (streamUrl: string, runId: string) =>
  Effect.gen(function* () {
    const wp = yield* WorkProducer
    return yield* wp.declareWork({ runId })
  }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl })))

// launchable-substrate-host.CLIENT_SURFACE.3
// launchable-substrate-host.CLIENT_SURFACE.11
// launchable-substrate-host.CLIENT_SURFACE.12
// client.work.declare uses the kernel WorkProducer.declareWork lowering
// internally; idempotency metadata travels as event headers, caller
// input lands on the substrate-generic durable.run.data field.
describe("launchable-substrate-host.CLIENT_SURFACE.3 — client.work.declare lowers to existing substrate producer semantics", () => {
  it("returns a workId, writes a started durable.run, and persists caller input on the row's data field", async () => {
    const url = await createSubstrateStream("client-declare")

    const program = Effect.gen(function* () {
      const client = yield* SubstrateClient
      return yield* client.work.declare({
        idempotencyKey: "demo:review-1",
        input: { kind: "review", target: "README.md" },
      })
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(url))),
    )
    expect(typeof result.workId).toBe("string")
    expect(result.workId.length).toBeGreaterThan(0)

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(result.workId)
    expect(run?.state).toBe("started")
    expect(run?.data).toStrictEqual({ kind: "review", target: "README.md" })
  })
})

// launchable-substrate-host.CLIENT_SURFACE.11
// Idempotency metadata lives on the event headers, NOT on the
// durable.run row value. The client never accepts a caller-supplied
// runId; the test uses the returned workId to find the matching
// durable.run event.
describe("launchable-substrate-host.CLIENT_SURFACE.11 — client.work.declare keeps idempotency metadata out of the run row value", () => {
  it("idempotencyKey appears on the durable.run insert event header for the returned workId, not on the rebuilt RunValue", async () => {
    const url = await createSubstrateStream("client-declare-idempotency")
    const idempotencyKey = "demo:idempotent-key"

    const program = Effect.gen(function* () {
      const client = yield* SubstrateClient
      return yield* client.work.declare({ idempotencyKey })
    })
    const { workId } = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(url))),
    )

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(workId)
    expect(run).toBeDefined()
    expect((run as Record<string, unknown>).idempotencyKey).toBeUndefined()

    const handle = new DurableStream({ url, contentType: "application/json" })
    const res = await handle.stream({ offset: "-1", live: false })
    const items = (await res.json()) as ReadonlyArray<ChangeEvent>
    const runEvent = items.find(
      (it) => it.type === "durable.run" && it.key === workId,
    )
    expect(runEvent).toBeDefined()
    expect(
      (runEvent!.headers as unknown as Record<string, string>).idempotencyKey,
    ).toBe(idempotencyKey)
  })
})

// launchable-substrate-host.CLIENT_SURFACE.6
// launchable-substrate-host.CLIENT_SURFACE.9
// launchable-substrate-host.CLIENT_SURFACE.10
// observe(workId).snapshot() reads the current no-gap materialized view
// once. The handle is scoped to a single workId; reads do not mutate
// durable state.
describe("launchable-substrate-host.CLIENT_SURFACE.10 — client snapshot reads the no-gap materialized view once", () => {
  it("snapshot returns the run value for the workId returned by declare without mutating state", async () => {
    const url = await createSubstrateStream("client-observe-snapshot")

    const program = Effect.gen(function* () {
      const client = yield* SubstrateClient
      const declared = yield* client.work.declare()
      const before = yield* client.work.observe(declared.workId).snapshot()
      const after = yield* client.work.observe(declared.workId).snapshot()
      return { declared, before, after }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(url))),
    )
    expect(result.before?.state).toBe("started")
    expect(result.before?.runId).toBe(result.declared.workId)
    expect(result.after?.state).toBe("started")
  })

  it("observe(workId) returns undefined for a workId that has never been declared", async () => {
    const url = await createSubstrateStream("client-observe-missing")
    const program = Effect.gen(function* () {
      const client = yield* SubstrateClient
      return yield* client.work.observe("never-declared").snapshot()
    })
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(url))),
    )
    expect(result).toBeUndefined()
  })
})

// launchable-substrate-host.CLIENT_SURFACE.9
// observe(workId).stream() emits an initial snapshot then live changes.
// To pre-subscribe to a known workId, the test seeds the run through
// the kernel producer in test scope; the client API itself never
// accepts a caller-supplied runId.
describe("launchable-substrate-host.CLIENT_SURFACE.9 — client read handles expose explicit snapshot, stream, and until operations", () => {
  it("stream() emits an initial empty snapshot followed by the started run after a kernel-seeded declareWork lands", async () => {
    const url = await createSubstrateStream("client-observe-stream")
    const knownRunId = "obs-stream-1"

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SubstrateClient
        const handle = client.work.observe(knownRunId)
        const fiber = yield* Effect.fork(
          handle.stream().pipe(Stream.take(2), Stream.runCollect),
        )
        // Allow the stream to subscribe before the seed append.
        yield* Effect.sleep(Duration.millis(40))
        yield* seedKernelRun(url, knownRunId)
        return yield* Fiber.join(fiber)
      }),
    )

    const chunk = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(url))),
    )
    const observed = Chunk.toReadonlyArray(chunk)
    expect(observed[0]).toBeUndefined()
    expect(observed[1]?.state).toBe("started")
    expect(observed[1]?.runId).toBe(knownRunId)
  })
})

// launchable-substrate-host.CLIENT_SURFACE.9
describe("launchable-substrate-host.CLIENT_SURFACE.9 — until composes stream with predicate and resolves on first match", () => {
  it("until resolves with the first observed run value matching the predicate", async () => {
    const url = await createSubstrateStream("client-observe-until")
    const knownRunId = "obs-until-1"

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SubstrateClient
        const fiber = yield* Effect.fork(
          client.work
            .observe(knownRunId)
            .until((s) => s !== undefined && s.state === "started"),
        )
        yield* Effect.sleep(Duration.millis(40))
        yield* seedKernelRun(url, knownRunId)
        return yield* Fiber.join(fiber)
      }),
    )

    const matched = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(url))),
    )
    expect(matched?.state).toBe("started")
    expect(matched?.runId).toBe(knownRunId)
  })
})

// launchable-substrate-host.CLIENT_COMPATIBILITY.4
// The client capability resolved through the Tag is the same shape
// regardless of how the layer is composed.
describe("launchable-substrate-host.CLIENT_COMPATIBILITY.4 — client service exposed inside dev helpers is the same capability as the standalone client", () => {
  it("SubstrateClient service has work.declare and work.observe on the same shape", async () => {
    const url = await createSubstrateStream("client-shape")
    const program = Effect.gen(function* () {
      const client = yield* SubstrateClient
      expect(typeof client.work.declare).toBe("function")
      expect(typeof client.work.observe).toBe("function")
      const handle = client.work.observe("shape-test")
      expect(typeof handle.snapshot).toBe("function")
      expect(typeof handle.stream).toBe("function")
      expect(typeof handle.until).toBe("function")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layerFor(url))))
  })
})

// launchable-substrate-host.CLIENT_SURFACE.7
// Type-level guard: DeclareWorkInput must NOT accept `runId`. Kernel
// vocabulary (runId) is intentionally hidden from the client root.
describe("launchable-substrate-host.CLIENT_SURFACE.7 — DeclareWorkInput rejects runId at the type boundary", () => {
  it("assigning a runId field to DeclareWorkInput is a compile error", () => {
    // @ts-expect-error runId is not a valid DeclareWorkInput field
    const _bad: DeclareWorkInput = { runId: "leak-attempt" }
    void _bad
    // Allowed shapes:
    const ok1: DeclareWorkInput = {}
    const ok2: DeclareWorkInput = { idempotencyKey: "k" }
    const ok3: DeclareWorkInput = { input: { kind: "x" } }
    expect(ok1).toBeDefined()
    expect(ok2).toBeDefined()
    expect(ok3).toBeDefined()
  })
})

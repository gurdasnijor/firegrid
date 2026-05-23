import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Layer, Option, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeObservationStreams,
  type RuntimeObservationStreamsService,
} from "../../../src/streams/index.ts"
import {
  RuntimeWaitCompletionTable,
  runtimeWaitForMatch,
  runtimeWaitForCompletionKey,
  runtimeWaitCompletionTableLayer,
} from "../../../src/agent-event-pipeline/wait-routing/runtime-wait-completion.ts"

// Shape C wait routing (tf-28b8 / #676): a wait is a durable completion row
// keyed by `completionKey`, snapshot-first reads, source-replay determinism.
// The terminal row is the at-most-once authority — replacing WaitForWorkflow's
// `executions.finalResult` memo with a plain DurableTable row.

const emptyStreams: RuntimeObservationStreamsService = {
  agentOutput: Stream.empty,
  agentOutputAfter: () => Stream.empty,
  initialAgentOutputAfter: () => Effect.succeed(Option.none()),
  agentOutputForContext: () => Stream.empty,
  runtimeRun: Stream.empty,
  callerFact: () => Stream.empty,
}

describe("runtimeWaitForMatch — in-memory completion store", () => {
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

  const layerFor = (
    streamUrl: string,
    streams: RuntimeObservationStreamsService,
  ) =>
    Layer.merge(
      Layer.succeed(RuntimeObservationStreams, streams),
      runtimeWaitCompletionTableLayer({
        streamOptions: { url: streamUrl, contentType: "application/json" },
        txTimeoutMs: 2_000,
      }),
    )

  const streamUrl = () =>
    `${baseUrl}/v1/stream/runtime-wait-completion-${crypto.randomUUID()}`

  it("matches a typed observation source through the durable completion row (single source)", async () => {
    const streams: RuntimeObservationStreamsService = {
      ...emptyStreams,
      callerFact: stream =>
        stream === "facts"
          ? Stream.fromIterable([
            { kind: "ignore", correlationId: "decoy" },
            { kind: "match", correlationId: "target", payload: 42 },
          ])
          : Stream.empty,
    }
    const url = streamUrl()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        runtimeWaitForMatch({
          completionKey: runtimeWaitForCompletionKey("ctx", "tool-1"),
          source: { _tag: "CallerFact", stream: "facts" },
          trigger: [{ path: ["correlationId"], equals: "target" }],
          timeoutMs: 60_000,
        }).pipe(Effect.provide(layerFor(url, streams))),
      ),
    )

    expect(outcome).toEqual({
      _tag: "Match",
      raw: { kind: "match", correlationId: "target", payload: 42 },
    })
  })

  it("returns Timeout when no row arrives before the bound", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        runtimeWaitForMatch({
          completionKey: runtimeWaitForCompletionKey("ctx", "tool-2"),
          source: { _tag: "CallerFact", stream: "empty" },
          trigger: [{ path: ["correlationId"], equals: "missing" }],
          timeoutMs: 10,
        }).pipe(Effect.provide(layerFor(streamUrl(), emptyStreams))),
      ),
    )

    expect(outcome).toEqual({ _tag: "Timeout" })
  })

  it("races multiple sources and reports the winning index (wait_for_any)", async () => {
    const streams: RuntimeObservationStreamsService = {
      ...emptyStreams,
      callerFact: stream =>
        stream === "s1"
          ? Stream.fromIterable([{ correlationId: "target", payload: 7 }])
          : Stream.empty,
    }
    const outcome = await Effect.runPromise(
      Effect.scoped(
        runtimeWaitForMatch({
          completionKey: runtimeWaitForCompletionKey("ctx", "tool-any-1"),
          source: { _tag: "CallerFact", stream: "s0" },
          trigger: [{ path: ["correlationId"], equals: "target" }],
          additionalSources: [{
            source: { _tag: "CallerFact", stream: "s1" },
            trigger: [{ path: ["correlationId"], equals: "target" }],
          }],
          timeoutMs: 60_000,
        }).pipe(Effect.provide(layerFor(streamUrl(), streams))),
      ),
    )
    expect(outcome).toEqual({
      _tag: "Match",
      raw: { correlationId: "target", payload: 7 },
      winnerIndex: 1,
    })
  })
})

// Restart-survival proof (port of the prior tf-0xe4 WaitForWorkflow durability
// test): a completed wait_for_any race survives "engine reconstruction" — here,
// a fresh layer instance over the SAME durable stream URL. If the completion
// row weren't durable (or the wait were re-run on the second pass), the second
// generation's empty source would never match. Shape C completion = the row.
describe("runtimeWaitForMatch — durable completion row survives reconstruction", () => {
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

  const runGeneration = (
    streamUrl: string,
    streams: RuntimeObservationStreamsService,
    completionKey: string,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        runtimeWaitForMatch({
          completionKey,
          source: { _tag: "CallerFact" as const, stream: "s0" },
          trigger: [{ path: ["correlationId"], equals: "target" }],
          additionalSources: [{
            source: { _tag: "CallerFact" as const, stream: "s1" },
            trigger: [{ path: ["correlationId"], equals: "target" }],
          }],
          timeoutMs: 60_000,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(RuntimeObservationStreams, streams),
              runtimeWaitCompletionTableLayer({
                streamOptions: { url: streamUrl, contentType: "application/json" },
                txTimeoutMs: 2_000,
              }),
            ),
          ),
        ),
      ),
    )

  it("tf-28b8: a completed wait race re-reads from the durable row on a fresh layer", async () => {
    if (!baseUrl) throw new Error("server not started")
    const url = `${baseUrl}/v1/stream/runtime-wait-completion-${crypto.randomUUID()}`
    const completionKey = runtimeWaitForCompletionKey("ctx", "tool-restart")

    // Generation 1: source s1 matches; the Shape C primitive writes the
    // completion row with the winning index.
    const matchStreams: RuntimeObservationStreamsService = {
      ...emptyStreams,
      callerFact: stream =>
        stream === "s1"
          ? Stream.fromIterable([{ correlationId: "target", payload: 99 }])
          : Stream.empty,
    }
    const first = await runGeneration(url, matchStreams, completionKey)
    expect(first).toEqual({
      _tag: "Match",
      raw: { correlationId: "target", payload: 99 },
      winnerIndex: 1,
    })

    // Generation 2: a fresh DurableTable layer over the SAME stream URL, now
    // with NO matching source. The primitive snapshot-reads the completion row
    // and returns the prior outcome WITHOUT touching the source. This is the
    // C4 invariant: reconstruction reads durable records, not in-memory waiters
    // or workflow `finalResult` memos.
    const replayed = await runGeneration(url, emptyStreams, completionKey)
    expect(replayed).toEqual({
      _tag: "Match",
      raw: { correlationId: "target", payload: 99 },
      winnerIndex: 1,
    })
  }, 20_000)
})

// Quick sanity for the completion key helper — keeps caller key generation
// stable across the wait-for.ts → Shape C transition.
describe("runtimeWaitForCompletionKey", () => {
  it("emits the stable wait completion key prefix", () => {
    expect(runtimeWaitForCompletionKey("ctx", "tool-1")).toBe("wait:ctx:tool-1")
  })
})

// Table tag is exported for host composition.
describe("RuntimeWaitCompletionTable", () => {
  it("is a DurableTable tag", () => {
    expect(RuntimeWaitCompletionTable).toBeDefined()
  })
})

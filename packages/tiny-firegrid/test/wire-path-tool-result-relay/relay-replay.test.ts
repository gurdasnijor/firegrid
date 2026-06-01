// tf-r06u.44 — wire-path tool-result relay SPIKE (workbench proof).
//
// De-risks Agent3's tf-r06u.41 (ToolResult arm on RuntimeAgentOutputObservation)
// + the production wire-path cutover. Proves the EMISSION half Agent2 deferred
// from the mcp-host slice (.28): an agent ToolUse turn → the host runs the
// shared typed arm → the result is relayed as a ToolResult OBSERVATION on the
// agent-output stream, readable by offset.
//
// SCHEMA (Coordinator-authoritative, mirrors the ToolUse arm): the observation
// carries `event.part: Prompt.ToolResultPart` (the @effect/ai canonical shape) —
// NOT bare `{ toolUseId, resultJson }`. `isFailure` is STRUCTURAL (a poll-only
// consumer must distinguish a published-with-buildSha terminal from a failed
// publish). `resultJson` is the DERIVED projection (`JSON.stringify(part.result)`).
//
// CLAIMS (the production-cutover de-risk):
//   1. appended-exactly-once on (toolUseId → sequence): re-running the relay
//      for the same toolUseId (= a replay) yields exactly ONE observation at a
//      STABLE sequence — via a durable toolUseId→sequence assignment, because
//      the codec's live sequenceRef is VOLATILE and would re-number on restart.
//   2. re-readable by offset across a replay boundary: after rebuilding the
//      table layer over the same durable stream (a fresh process), reading by
//      sequence offset returns the identical observation, and a post-replay
//      re-relay does not duplicate it.
//
// Workbench-only: a self-contained DurableTable models the .41 arm locally (the
// arm isn't in the public protocol surface until .41 lands — so a pure
// public-surface client-sdk read is itself blocked on .41; that ordering is a
// finding). No unified/ or protocol/ edits.

import { Prompt } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableTable, type DurableTableService } from "effect-durable-operators"
import { Effect, Option, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

// ── The .41 ToolResult observation, modeled locally (mirrors the ToolUse arm) ──

const ToolResultObservationEventSchema = Schema.TaggedStruct("ToolResult", {
  part: Prompt.ToolResultPart,
})

// One durable row per emitted ToolResult observation. Primary key is the
// toolUseId — that is what makes the relay appended-exactly-once: insertOrGet
// on a stable identity dedups across replay regardless of the volatile live
// sequence counter. `sequence` is the durable offset assigned at first emit.
const ToolResultObservationRowSchema = Schema.Struct({
  toolUseId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  sequence: Schema.Number,
  observationJson: Schema.String,
})

class WireRelayToolResultTable extends DurableTable("firegrid.spike.wireRelay", {
  observations: ToolResultObservationRowSchema,
}) {}

type WireRelayService = DurableTableService<{
  readonly observations: typeof ToolResultObservationRowSchema
}>

// ── The shared typed arm (modeled) + the relay ────────────────────────────────

// Stand-in for the .28 FiregridAgentToolExecutor arm: produce a canonical
// Prompt.ToolResultPart for a ToolUse. (The real shared arm lands with .28; the
// spike proves the RELAY shape around whatever the arm returns.)
const runSharedToolArm = (
  toolUseId: string,
  toolName: string,
  input: unknown,
): Prompt.ToolResultPart =>
  Prompt.toolResultPart({
    id: toolUseId,
    name: toolName,
    result: { echoed: input },
    isFailure: false,
    providerExecuted: false,
  })

const encodeObservation = (part: Prompt.ToolResultPart): string =>
  JSON.stringify({ _tag: "ToolResult", part })

interface RelayInput {
  readonly contextId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
}

// Relay a tool result as a durable ToolResult observation. Appended-exactly-once
// on (toolUseId → sequence): insertOrGet keyed by toolUseId guarantees one row;
// the sequence is the durable offset (current row count) assigned on genuine
// first insert and preserved by insertOrGet on every replay re-run.
const relayToolResult = (
  table: WireRelayService,
  input: RelayInput,
): Effect.Effect<{ readonly sequence: number; readonly observationJson: string }> =>
  Effect.gen(function*() {
    const part = runSharedToolArm(input.toolUseId, input.toolName, input.input)
    const existing = yield* table.observations.get(input.toolUseId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orDie,
    )
    if (existing !== undefined) {
      return { sequence: existing.sequence, observationJson: existing.observationJson }
    }
    const all = yield* table.observations.query((coll) => coll.toArray).pipe(Effect.orDie)
    const sequence = all.length
    const observationJson = encodeObservation(part)
    // insertOrGet provides the durable dedup; the early `existing` branch above
    // already returns the stored row on replay, so this branch is a genuine
    // first insert — the computed (sequence, observationJson) are authoritative.
    yield* table.observations.insertOrGet({
      toolUseId: input.toolUseId,
      contextId: input.contextId,
      sequence,
      observationJson,
    }).pipe(Effect.orDie)
    return { sequence, observationJson }
  })

const readByOffset = (
  table: WireRelayService,
  afterSequence: number,
): Effect.Effect<ReadonlyArray<{ readonly sequence: number; readonly observationJson: string }>> =>
  table.observations.query((coll) => coll.toArray).pipe(
    Effect.orDie,
    Effect.map((rows) =>
      rows
        .filter((r) => r.sequence > afterSequence)
        .sort((a, b) => a.sequence - b.sequence)
        .map((r) => ({ sequence: r.sequence, observationJson: r.observationJson }))),
  )

// ── Harness ───────────────────────────────────────────────────────────────────

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

// A fresh table layer over a given stream URL = one "process". Rebuilding it
// over the SAME url is the replay boundary (durable state survives, in-memory
// state does not).
const withTable = <A>(
  streamUrl: string,
  body: (table: WireRelayService) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(WireRelayToolResultTable, body).pipe(
        Effect.provide(
          WireRelayToolResultTable.layer({
            streamOptions: { url: streamUrl, contentType: "application/json" },
          }),
        ),
      ) as Effect.Effect<A, never, never>,
    ),
  )

describe("wire-path tool-result relay (tf-r06u.44 spike)", () => {
  it("claim 1: relaying the same toolUseId twice (replay) appends exactly once at a stable sequence", async () => {
    const streamUrl = `${baseUrl}/v1/stream/wire-relay-once-${crypto.randomUUID()}`
    const observed = await withTable(streamUrl, (table) =>
      Effect.gen(function*() {
        const first = yield* relayToolResult(table, {
          contextId: "ctx-1",
          toolUseId: "tu-1",
          toolName: "sleep",
          input: { durationMs: 1 },
        })
        // Replay: the relay runs again for the SAME toolUseId.
        const second = yield* relayToolResult(table, {
          contextId: "ctx-1",
          toolUseId: "tu-1",
          toolName: "sleep",
          input: { durationMs: 1 },
        })
        const rows = yield* readByOffset(table, -1)
        return { first, second, rowCount: rows.length }
      }))

    expect(observed.rowCount).toBe(1) // appended exactly once
    expect(observed.second.sequence).toBe(observed.first.sequence) // stable offset
    expect(observed.second.observationJson).toBe(observed.first.observationJson)
    // The relayed observation decodes against the .41 arm shape
    // (TaggedStruct("ToolResult", { part: Prompt.ToolResultPart })) — proving
    // the emitter produces a valid ToolResult observation, isFailure structural.
    const decoded = Schema.decodeUnknownSync(ToolResultObservationEventSchema)(
      JSON.parse(observed.first.observationJson),
    )
    expect(decoded._tag).toBe("ToolResult")
    expect(decoded.part.isFailure).toBe(false)
    expect(decoded.part.id).toBe("tu-1")
  })

  it("claim 2: observations are re-readable by offset across a replay boundary, with no post-replay duplication", async () => {
    const streamUrl = `${baseUrl}/v1/stream/wire-relay-replay-${crypto.randomUUID()}`

    // Process A: emit two ToolResult observations (an ordered stream).
    const beforeReplay = await withTable(streamUrl, (table) =>
      Effect.gen(function*() {
        yield* relayToolResult(table, { contextId: "ctx-1", toolUseId: "tu-a", toolName: "sleep", input: 1 })
        yield* relayToolResult(table, { contextId: "ctx-1", toolUseId: "tu-b", toolName: "send", input: 2 })
        return yield* readByOffset(table, -1)
      }))
    expect(beforeReplay.map((r) => r.sequence)).toEqual([0, 1])

    // Process B (replay boundary): a fresh table layer over the SAME durable
    // stream. Read by offset must return the identical observations, and
    // re-relaying tu-a must NOT duplicate it.
    const afterReplay = await withTable(streamUrl, (table) =>
      Effect.gen(function*() {
        const reread = yield* readByOffset(table, -1)
        const reRelayed = yield* relayToolResult(table, {
          contextId: "ctx-1",
          toolUseId: "tu-a",
          toolName: "sleep",
          input: 1,
        })
        const afterReRelay = yield* readByOffset(table, -1)
        // Tail read from offset 0 → only the second observation.
        const tail = yield* readByOffset(table, 0)
        return { reread, reRelayed, rowCount: afterReRelay.length, tail }
      }))

    // Identical across the replay boundary.
    expect(afterReplay.reread).toEqual(beforeReplay)
    // Re-relay after replay is idempotent (no duplicate; stable offset).
    expect(afterReplay.rowCount).toBe(2)
    expect(afterReplay.reRelayed.sequence).toBe(0)
    // Offset read is a true cursor.
    expect(afterReplay.tail.map((r) => r.sequence)).toEqual([1])
  })
})

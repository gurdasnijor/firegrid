// Wave D-D — wait/child-output PRODUCTION integration proof.
//
// Asserts that the existing `HostPlaneChannelRouter` registration of
// `sessionAgentOutputObservationRoute` (#703) and `sessionLifecycleTerminalRoute`
// (#708) settles `wait_for` against the PRODUCTION durable substrates
// (`RuntimeOutputTable.events.rows()` for child agent output;
// `RuntimeControlPlaneTable.runs.rows()` for lifecycle terminal), with
// snapshot-first + subscribe-after-cursor restart-safety semantics — the
// same Shape D invariants the tiny-firegrid migration probe
// (`wave-d-d-waitfor-channel-route-race`) proved in clean-room.
//
// This is the "production wait/child-output tests proving route-based
// observation and restart/no-stale-replay" deliverable for Wave D-D.
// Production `WaitForWorkflow` body migration is FOLLOW-UP: this PR ships
// the route-side proof + the migration finding; the workflow rewrite that
// retires `RuntimeObservationStreams` lands in a separate D-D body PR per
// the FINDING.md paired-deletion ledger.

import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt, Response } from "@effect/ai"
import {
  makeHostStreamPrefix,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostStreamPrefix,
} from "@firegrid/protocol/launch"
import {
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  SessionLifecycleChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import { Effect, Fiber, Layer, Option, type Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { encodeRuntimeAgentOutputEnvelope } from "../../src/agent-event-pipeline/events/index.ts"
import { sessionAgentOutputChannel } from "../../src/channels/session-agent-output.ts"
import {
  HostPlaneChannelRouter,
  RuntimeHostControlChannelsLive,
} from "../../src/channels/index.ts"
import type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
} from "../../src/agent-event-pipeline/events/index.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  ;(server as unknown as {
    server?: { closeAllConnections?: () => void }
  } | undefined)?.server?.closeAllConnections?.()
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const ATTEMPT = 0
const PREFIX: HostStreamPrefix = makeHostStreamPrefix({
  namespace: "wave-d-d-wait-child-output",
  hostId: "wave-d-d-wait-child-output_host" as HostId,
})

const outputUrl = (contextId: string) =>
  runtimeContextOutputStreamUrl({
    baseUrl: baseUrl!,
    prefix: PREFIX,
    contextId,
  })

const controlPlaneUrl = (namespace: string) =>
  runtimeControlPlaneStreamUrl({ baseUrl: baseUrl!, namespace })

const ready: AgentOutputEvent = {
  _tag: "Ready",
  capabilities: {
    streamingText: true,
    tools: true,
    permissions: true,
    images: false,
    structuredInput: false,
    cancellation: true,
    multiTurn: true,
    customStatus: [],
  },
}
const textChunk = (delta: string): AgentOutputEvent => ({
  _tag: "TextChunk",
  part: Response.textDeltaPart({ id: `p-${delta}`, delta }),
})
const toolUse = (id: string): AgentOutputEvent => ({
  _tag: "ToolUse",
  part: Prompt.toolCallPart({ id, name: "echo", params: {}, providerExecuted: false }),
})
const turnComplete: AgentOutputEvent = { _tag: "TurnComplete", finishReason: "stop" }
const terminated: AgentOutputEvent = { _tag: "Terminated", exitCode: 0 }

// Production session.agent_output channel: per-session ingress over the
// real `RuntimeOutputTable.events.rows()` source (the SAME implementation
// host-sdk supplies as `SessionAgentOutputChannelLive`).
const productionSessionAgentOutputChannel = (): SessionAgentOutputChannelService => ({
  forContext: (sessionId: string) =>
    sessionAgentOutputChannel({
      durableStreamsBaseUrl: baseUrl!,
      streamPrefix: PREFIX,
      contextId: sessionId,
    }),
})

const writeAgentOutput = (
  contextId: string,
  events: ReadonlyArray<AgentOutputEvent>,
): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function*() {
    const table = yield* RuntimeOutputTable
    for (let sequence = 0; sequence < events.length; sequence++) {
      yield* table.events.insert({
        eventId: { contextId, activityAttempt: ATTEMPT, target: "events", sequence },
        contextId,
        activityAttempt: ATTEMPT,
        sequence,
        source: "stdout",
        format: "jsonl",
        receivedAt: new Date(sequence).toISOString(),
        raw: encodeRuntimeAgentOutputEnvelope(events[sequence]!),
      })
    }
  }).pipe(
    Effect.provide(RuntimeOutputTable.layer({
      streamOptions: { url: outputUrl(contextId), contentType: "application/json" },
    })),
  )

interface RunRow {
  readonly runEventId: { readonly contextId: string; readonly activityAttempt: number; readonly status: "started" | "exited" | "failed" }
  readonly contextId: string
  readonly activityAttempt: number
  readonly status: "started" | "exited" | "failed"
  readonly at: string
  readonly provider: "local-process"
  readonly exitCode?: number
}

const runRow = (
  contextId: string,
  status: "started" | "exited" | "failed",
  exitCode?: number,
): RunRow => ({
  runEventId: { contextId, activityAttempt: ATTEMPT, status },
  contextId,
  activityAttempt: ATTEMPT,
  status,
  at: new Date(status === "started" ? 0 : 1).toISOString(),
  provider: "local-process",
  ...(exitCode === undefined ? {} : { exitCode }),
})

// Typed wrapper around `controlPlane.runs.upsert`. The table service's
// `upsert` is generic over the schema and returns `Effect<void, _, any>`;
// narrowing the cast HERE keeps every call site lint-clean.
interface ControlPlaneRunsUpsert {
  readonly runs: { readonly upsert: (row: RunRow) => Effect.Effect<void, unknown> }
}
const upsertRun = (
  controlPlane: ControlPlaneRunsUpsert,
  row: RunRow,
): Effect.Effect<void, unknown> => controlPlane.runs.upsert(row)

// `R = unknown` mirrors the pattern from
// `packages/runtime/test/tables/runtime-context-input-facts.test.ts`:
// `RuntimeControlPlaneTable["Type"]` leaks `any` through `DurableTable.layer`,
// so a precisely-typed R parameter triggers `@typescript-eslint/no-unsafe-argument`
// at the call site. The post-provide cast localizes the unknown to `never`.
const runWithRouter = <A, E>(
  namespace: string,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          RuntimeHostControlChannelsLive.pipe(
            Layer.provide(
              Layer.succeed(
                SessionAgentOutputChannel,
                productionSessionAgentOutputChannel(),
              ),
            ),
            Layer.provideMerge(
              RuntimeControlPlaneTable.layer({
                streamOptions: {
                  url: controlPlaneUrl(namespace),
                  contentType: "application/json",
                },
              }) as Layer.Layer<RuntimeControlPlaneTable, unknown, never>,
            ),
          ),
        ),
      ) as Effect.Effect<A, E, never>,
    ),
  )

describe("Wave D-D — wait/child-output through production channel router (no new protocol)", () => {
  describe("session.agent_output route over production RuntimeOutputTable", () => {
    it("settles wait_for with cursor round-trip over production durable output (no stale duplicate, no missed advance)", async () => {
      const childId = `ctx_child_${crypto.randomUUID()}`
      const events: ReadonlyArray<AgentOutputEvent> = [
        ready,
        textChunk("a"),
        toolUse("t-1"),
        textChunk("b"),
        turnComplete,
        terminated,
      ]

      await runWithRouter(`agent-output-${childId}`, Effect.gen(function*() {
        yield* writeAgentOutput(childId, events)
        const router = yield* HostPlaneChannelRouter

        // Cursor round-trip: -1 → 0 → 1 → ... → 5. Each dispatch is a fresh
        // call to `Stream.runHead` over a snapshot at the route's
        // factory-resolved per-session channel. Idempotent re-dispatch over
        // the SAME cursor returns the SAME row (snapshot-first invariant).
        let cursor = -1
        const seen: Array<{ sequence: number; tag: RuntimeAgentOutputObservation["_tag"] }> = []
        for (let i = 0; i < events.length; i++) {
          const observation = (yield* router.dispatch({
            target: SessionAgentOutputChannelTarget,
            verb: "wait_for",
            payload: { sessionId: childId, afterSequence: cursor },
          })) as RuntimeAgentOutputObservation
          seen.push({ sequence: observation.sequence, tag: observation._tag })
          cursor = observation.sequence
        }

        // All six dense rows observable through the SAME route.
        expect(seen.map(s => s.sequence)).toEqual([0, 1, 2, 3, 4, 5])
        // No duplicate, monotonically increasing.
        expect(new Set(seen.map(s => s.sequence)).size).toBe(seen.length)

        // No-stale-replay: re-dispatching with cursor=2 returns seq 3 again
        // (deterministic next-after-cursor), NOT seq 2 (would be stale).
        const replay = (yield* router.dispatch({
          target: SessionAgentOutputChannelTarget,
          verb: "wait_for",
          payload: { sessionId: childId, afterSequence: 2 },
        })) as RuntimeAgentOutputObservation
        expect(replay.sequence).toBe(3)
      }))
    })

    it("parks at frontier until next live append (subscribe-after-cursor) and wakes on the matching arrival", async () => {
      const childId = `ctx_child_${crypto.randomUUID()}`
      await runWithRouter(`agent-output-park-${childId}`, Effect.gen(function*() {
        yield* writeAgentOutput(childId, [ready, textChunk("first")])
        const router = yield* HostPlaneChannelRouter

        // Park at the frontier (cursor = 1, no row past it yet).
        const parked = yield* Effect.fork(
          router.dispatch({
            target: SessionAgentOutputChannelTarget,
            verb: "wait_for",
            payload: { sessionId: childId, afterSequence: 1 },
          }),
        )
        yield* Effect.sleep("50 millis")
        // Blocked-pending observation point: NOT returned a stale row.
        expect(Option.isNone(yield* Fiber.poll(parked))).toBe(true)

        // Append the next row; parked dispatch must wake with it.
        yield* writeAgentOutput(childId, [ready, textChunk("first"), textChunk("second")])
        const woken = (yield* Fiber.join(parked)) as RuntimeAgentOutputObservation
        expect(woken.sequence).toBe(2)
        expect(woken._tag).toBe("TextChunk")
      }))
    })

    it("restart-replay safety: interrupt mid-flight + re-dispatch over the SAME production source finds the SAME match (no stale duplicate)", async () => {
      const childId = `ctx_child_${crypto.randomUUID()}`
      await runWithRouter(`agent-output-restart-${childId}`, Effect.gen(function*() {
        // Pre-crash: non-matching row only.
        yield* writeAgentOutput(childId, [ready, textChunk("pre-crash")])
        const router = yield* HostPlaneChannelRouter

        // Arm a wait for the NEXT row past the cursor.
        const inFlight = yield* Effect.fork(
          router.dispatch({
            target: SessionAgentOutputChannelTarget,
            verb: "wait_for",
            payload: { sessionId: childId, afterSequence: 1 },
          }),
        )
        yield* Effect.sleep("30 millis")
        // Simulate host crash: interrupt the in-flight dispatch.
        yield* Fiber.interrupt(inFlight)

        // Post-crash: producer appends the matching row.
        yield* writeAgentOutput(childId, [
          ready,
          textChunk("pre-crash"),
          turnComplete,
        ])

        // Re-dispatch with the SAME cursor (the restart-equivalent of a
        // workflow Activity re-run after rehydration). Snapshot-first +
        // subscribe-after-cursor MUST return the post-restart matching row,
        // not a stale re-read of the pre-crash row.
        const reRun = (yield* router.dispatch({
          target: SessionAgentOutputChannelTarget,
          verb: "wait_for",
          payload: { sessionId: childId, afterSequence: 1 },
        })) as RuntimeAgentOutputObservation
        expect(reRun.sequence).toBe(2)
        expect(reRun._tag).toBe("TurnComplete")
      }))
    })
  })

  describe("session.lifecycle route over production RuntimeControlPlaneTable", () => {
    it("settles wait_for against the terminal `runs.exited` row (skipping non-terminal `started`)", async () => {
      const childId = `ctx_child_${crypto.randomUUID()}`
      await runWithRouter(`lifecycle-${childId}`, Effect.gen(function*() {
        const controlPlane = yield* RuntimeControlPlaneTable
        yield* (upsertRun(controlPlane, runRow(childId, "started")))
        yield* (upsertRun(controlPlane, runRow(childId, "exited", 0)))
        const router = yield* HostPlaneChannelRouter

        const terminal = (yield* router.dispatch({
          target: SessionLifecycleChannelTarget,
          verb: "wait_for",
          payload: { sessionId: childId },
        })) as {
          readonly contextId: string
          readonly status: "started" | "exited" | "failed"
          readonly exitCode?: number
        }
        // Route's `seek` predicate skips `started`; only the terminal row
        // returns.
        expect(terminal.status).toBe("exited")
        expect(terminal.exitCode).toBe(0)
        expect(terminal.contextId).toBe(childId)
      }))
    })

    it("parks until the terminal lifecycle row materializes (subscribe-after-cursor)", async () => {
      const childId = `ctx_child_${crypto.randomUUID()}`
      await runWithRouter(`lifecycle-park-${childId}`, Effect.gen(function*() {
        const controlPlane = yield* RuntimeControlPlaneTable
        // Only `started` so far — no terminal.
        yield* (upsertRun(controlPlane, runRow(childId, "started")))
        const router = yield* HostPlaneChannelRouter

        const parked = yield* Effect.fork(
          router.dispatch({
            target: SessionLifecycleChannelTarget,
            verb: "wait_for",
            payload: { sessionId: childId },
          }),
        )
        yield* Effect.sleep("50 millis")
        // Blocked-pending: started is filtered out by terminal `seek`.
        expect(Option.isNone(yield* Fiber.poll(parked))).toBe(true)

        // Write the terminal row → parked dispatch wakes with it.
        yield* (upsertRun(controlPlane, runRow(childId, "failed")))
        const woken = (yield* Fiber.join(parked)) as {
          readonly status: "started" | "exited" | "failed"
        }
        expect(woken.status).toBe("failed")
      }))
    })

    it("authority boundary: sibling session's terminal does NOT settle the wait keyed by another sessionId", async () => {
      const childA = `ctx_child_a_${crypto.randomUUID()}`
      const childB = `ctx_child_b_${crypto.randomUUID()}`
      await runWithRouter(`lifecycle-authority-${childA}`, Effect.gen(function*() {
        const controlPlane = yield* RuntimeControlPlaneTable
        const router = yield* HostPlaneChannelRouter

        const parkedA = yield* Effect.fork(
          router.dispatch({
            target: SessionLifecycleChannelTarget,
            verb: "wait_for",
            payload: { sessionId: childA },
          }),
        )
        // Sibling exits first — must NOT settle child A's wait.
        yield* (upsertRun(controlPlane, runRow(childB, "exited", 0)))
        yield* Effect.sleep("50 millis")
        expect(Option.isNone(yield* Fiber.poll(parkedA))).toBe(true)

        // Child A exits → settle.
        yield* (upsertRun(controlPlane, runRow(childA, "exited", 1)))
        const a = (yield* Fiber.join(parkedA)) as {
          readonly contextId: string
          readonly status: "started" | "exited" | "failed"
          readonly exitCode?: number
        }
        expect(a.contextId).toBe(childA)
        expect(a.exitCode).toBe(1)
      }))
    })
  })
})

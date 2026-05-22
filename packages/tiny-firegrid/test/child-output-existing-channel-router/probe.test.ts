import {
  SessionAgentOutputChannelTarget,
} from "@firegrid/protocol/channels"
import { RuntimeAgentOutputObservationSchema } from "@firegrid/protocol/session-facade"
import {
  SessionAgentOutputRouteInputSchema,
  sessionAgentOutputObservationRoute,
} from "@firegrid/runtime/channels"
import { Effect, Fiber, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  childTerminated,
  childTextChunk,
  childTurnComplete,
  collectThroughTerminal,
  makeChildOutputProof,
  naiveReadFromStart,
  observeAfter,
} from "../../src/simulations/child-output-existing-channel-router/probe.ts"

const CHILD = "ctx_child"

describe("tf-22fo — delegated child output through the existing channel/router", () => {
  it("reuses the existing route: ingress wait_for on session.agent_output with the {sessionId, afterSequence} input (no new schema)", () => {
    const route = sessionAgentOutputObservationRoute({ forContext: () => undefined as never })
    // Same target / direction / verb as production tf-1ymw — not a new
    // `session_read`-style target.
    expect(String(route.descriptor.target)).toBe(
      String(SessionAgentOutputChannelTarget),
    )
    expect(route.descriptor.direction).toBe("ingress")
    expect(route.descriptor.verbs).toEqual(["wait_for"])
    // The route input is the existing cursor schema, not a `ChildOutput*` one.
    expect(route.descriptor.inputSchema).toBe(SessionAgentOutputRouteInputSchema)
  })

  it("snapshot-first: observes already-produced child rows strictly after the cursor without blocking", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const proof = yield* makeChildOutputProof
        yield* proof.sessionNew(CHILD)
        yield* proof.emit(childTextChunk(CHILD, 0, "a"))
        yield* proof.emit(childTextChunk(CHILD, 1, "b"))
        yield* proof.emit(childTurnComplete(CHILD, 2))

        expect((yield* observeAfter(proof, CHILD, -1)).sequence).toBe(0)
        expect((yield* observeAfter(proof, CHILD, 0)).sequence).toBe(1)
        const terminal = yield* observeAfter(proof, CHILD, 1)
        expect(terminal.sequence).toBe(2)
        expect(terminal._tag).toBe("TurnComplete")
      }),
    ))

  it("cursor round-trip reads every child observation exactly once, in order, through the turn terminal (no stale duplicates)", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const proof = yield* makeChildOutputProof
        yield* proof.sessionNew(CHILD)
        yield* proof.emit(childTextChunk(CHILD, 0, "hello"))
        yield* proof.emit(childTextChunk(CHILD, 1, "world"))
        yield* proof.emit(childTurnComplete(CHILD, 2))

        const collected = yield* collectThroughTerminal(
          proof,
          CHILD,
          o => o._tag === "TurnComplete",
        )
        const sequences = collected.map(o => o.sequence)
        expect(sequences).toEqual([0, 1, 2])
        // strictly increasing + distinct == no stale re-read
        expect(new Set(sequences).size).toBe(sequences.length)
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
        expect(collected.at(-1)?._tag).toBe("TurnComplete")
        // Every row is a member of the EXISTING observation union — no parallel
        // `ChildOutput*` taxonomy.
        const isObservation = Schema.is(RuntimeAgentOutputObservationSchema)
        for (const o of collected) {
          expect(isObservation(o)).toBe(true)
        }
      }),
    ))

  it("subscribe-after-cursor: an observation at the frontier PARKS, then wakes on the next live append (not a stale re-read)", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const proof = yield* makeChildOutputProof
        yield* proof.sessionNew(CHILD)
        yield* proof.emit(childTextChunk(CHILD, 0, "first"))

        // Observe at the frontier (cursor = last produced seq). Nothing past it
        // yet, so the observation must block on the live source.
        const fiber = yield* Effect.fork(observeAfter(proof, CHILD, 0))
        yield* Effect.sleep("25 millis")
        const pending = yield* Fiber.poll(fiber)
        // Blocked-pending observation point: it has NOT returned a stale seq 0.
        expect(Option.isNone(pending)).toBe(true)

        // Produce the next row; the parked observation must wake with it.
        yield* proof.emit(childTextChunk(CHILD, 1, "second"))
        const woken = yield* Fiber.join(fiber)
        expect(woken.sequence).toBe(1)
        expect(woken._tag).toBe("TextChunk")
      }),
    ))

  it("observes the SESSION terminal (Terminated) through the same route — no separate terminal/session_read protocol", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const proof = yield* makeChildOutputProof
        yield* proof.sessionNew(CHILD)
        yield* proof.emit(childTextChunk(CHILD, 0, "working"))
        yield* proof.emit(childTurnComplete(CHILD, 1))
        yield* proof.emit(childTerminated(CHILD, 2, 0))

        const collected = yield* collectThroughTerminal(
          proof,
          CHILD,
          o => o._tag === "Terminated",
        )
        expect(collected.map(o => o.sequence)).toEqual([0, 1, 2])
        const terminal = collected.at(-1)
        expect(terminal?._tag).toBe("Terminated")
        if (terminal?._tag === "Terminated") {
          expect(terminal.event.exitCode).toBe(0)
        }
      }),
    ))

  it("empirical contrast: a non-advancing reader re-reads the same first row (stale), the cursored reader does not", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const proof = yield* makeChildOutputProof
        yield* proof.sessionNew(CHILD)
        yield* proof.emit(childTextChunk(CHILD, 0, "a"))
        yield* proof.emit(childTextChunk(CHILD, 1, "b"))
        yield* proof.emit(childTextChunk(CHILD, 2, "c"))
        yield* proof.emit(childTurnComplete(CHILD, 3))

        // Stale: always reads from the start → same seq 0 every time.
        const naive = yield* naiveReadFromStart(proof, CHILD, 4)
        const naiveSeqs = naive.map(o => o.sequence)
        expect(naiveSeqs).toEqual([0, 0, 0, 0])
        expect(new Set(naiveSeqs).size).toBe(1) // 4 reads, 1 distinct = stale dup

        // Cursored: 4 reads, 4 distinct, no duplication.
        const cursored = yield* collectThroughTerminal(
          proof,
          CHILD,
          o => o._tag === "TurnComplete",
        )
        const cursoredSeqs = cursored.map(o => o.sequence)
        expect(cursoredSeqs).toEqual([0, 1, 2, 3])
        expect(new Set(cursoredSeqs).size).toBe(cursoredSeqs.length)
      }),
    ))

  it("keys observation by the request sessionId: a sibling child's output is not observable on this cursor", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const proof = yield* makeChildOutputProof
        yield* proof.sessionNew("ctx_child_a")
        yield* proof.sessionNew("ctx_child_b")
        yield* proof.emit(childTextChunk("ctx_child_a", 0, "from-a"))
        yield* proof.emit(childTextChunk("ctx_child_b", 0, "from-b"))

        const a = yield* observeAfter(proof, "ctx_child_a", -1)
        const b = yield* observeAfter(proof, "ctx_child_b", -1)
        expect(a._tag === "TextChunk" && a.event.part.delta).toBe("from-a")
        expect(b._tag === "TextChunk" && b.event.part.delta).toBe("from-b")
      }),
    ))
})

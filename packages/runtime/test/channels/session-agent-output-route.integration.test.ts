// Shape C cutover integration: parent observes a child session's DENSE output
// (TextChunk + terminal) through the production `sessionAgentOutputChannel`
// (which reads RuntimeOutputTable.events.rows()) + the existing
// `sessionAgentOutputObservationRoute` + `makeRuntimeChannelRouter`.
//
// This is the "raw output remains for UI/telemetry" property the cutover
// preserves: while RuntimeContext's handler consumes ONLY sparse state-relevant
// facts (see runtime-context-state.sparse.test.ts), the dense rows stay in the
// durable table and remain observable to parents / projection consumers
// through the existing channel/router shape — no `session_read` protocol, no
// `ChildOutput*` schema, no source-specific cursor primitive.

import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt, Response } from "@effect/ai"
import {
  RuntimeOutputTable,
  runtimeOutputStreamUrl,
} from "@firegrid/protocol/launch"
import { SessionAgentOutputChannelTarget } from "@firegrid/protocol/channels"
import { Effect, type Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { encodeRuntimeAgentOutputEnvelope } from "../../src/events/index.ts"
import { sessionAgentOutputChannel } from "../../src/channels/session-agent-output.ts"
import {
  makeRuntimeChannelRouter,
  sessionAgentOutputObservationRoute,
} from "../../src/channels/index.ts"
import type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
} from "../../src/events/index.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  // Force-close lingering connections before graceful stop — same pattern
  // tiny-firegrid live-substrate tests use to avoid socket starvation under
  // parallel preflight load.
  ;(server as unknown as {
    server?: { closeAllConnections?: () => void }
  } | undefined)?.server?.closeAllConnections?.()
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const ATTEMPT = 0
const NAMESPACE = "shape-c-cutover-route"
const outputUrl = () =>
  runtimeOutputStreamUrl({
    baseUrl: baseUrl!,
    namespace: NAMESPACE,
  })

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
const terminated: AgentOutputEvent = { _tag: "Terminated", exitCode: 0 }

const populate = (
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
        receivedAt: new Date(0).toISOString(),
        raw: encodeRuntimeAgentOutputEnvelope(events[sequence]!),
      })
    }
  }).pipe(
    Effect.provide(RuntimeOutputTable.layer({
      streamOptions: { url: outputUrl(), contentType: "application/json" },
    })),
  )

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

describe("Shape C — parent observes child output through the production channel/router (no new protocol)", () => {
  it("returns dense child observations strictly after the cursor via the SAME route used by RuntimeContext-adjacent code", async () => {
    const childId = `ctx_child_${crypto.randomUUID()}`
    const stream: ReadonlyArray<AgentOutputEvent> = [
      ready,           // seq 0
      textChunk("hi"), // seq 1
      textChunk("there"), // seq 2
      toolUse("t-1"),  // seq 3
      textChunk("bye"), // seq 4
      terminated,      // seq 5
    ]

    await run(Effect.gen(function*() {
      yield* populate(childId, stream)

      // Production channel service: per-context ingress over RuntimeOutputTable.
      // This is the SAME channel implementation that powers child observation
      // in the host edge — no new ChildOutput* surface, no session_read protocol.
      const channelService = {
        forContext: (sessionId: string) =>
          sessionAgentOutputChannel({
            durableStreamsBaseUrl: baseUrl!,
            namespace: NAMESPACE,
            contextId: sessionId,
          }),
      }
      const router = makeRuntimeChannelRouter([
        sessionAgentOutputObservationRoute(channelService),
      ])

      // Parent cursor round-trip: start at -1, advance using observed sequence
      // as the next afterSequence — exactly the C6 source+cursor+match shape.
      const seen: Array<{ sequence: number; tag: RuntimeAgentOutputObservation["_tag"] }> = []
      let cursor = -1
      for (let i = 0; i < stream.length; i++) {
        const observation = (yield* router.dispatch({
          target: SessionAgentOutputChannelTarget,
          verb: "wait_for",
          payload: { sessionId: childId, afterSequence: cursor },
        })) as RuntimeAgentOutputObservation
        seen.push({ sequence: observation.sequence, tag: observation._tag })
        cursor = observation.sequence
      }

      // ALL dense rows observable — no inert filtering on the channel side.
      // The dense raw output remains for UI/telemetry/parent observation,
      // even though the RuntimeContext handler (separate path) only sees the
      // sparse subset.
      expect(seen).toEqual([
        { sequence: 0, tag: "Ready" },
        { sequence: 1, tag: "TextChunk" },
        { sequence: 2, tag: "TextChunk" },
        { sequence: 3, tag: "ToolUse" },
        { sequence: 4, tag: "TextChunk" },
        { sequence: 5, tag: "Terminated" },
      ])
      // No duplicates: cursor round-trip yields strictly-increasing distinct sequences.
      const seqs = seen.map(s => s.sequence)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    }))
  })
})

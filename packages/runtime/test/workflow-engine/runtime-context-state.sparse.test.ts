// Shape C cutover: RuntimeContext consumes ONLY state-relevant facts.
//
// `nextOutput` walks the durable RuntimeOutputTable by indexed point gets
// (tf-aseo, no full-table scan) AND now skips decodable-but-inert observations
// so the per-event handler is invoked only for the sparse subset:
//   - PermissionRequest, ToolUse (non-acp), Terminated.
// Dense rows (TextChunk, Ready, TurnComplete, Status, Error, ToolUse under
// ACP) remain in the table for UI/telemetry/parent→child observation through
// the route-backed `sessionAgentOutputChannel` — they are simply not
// transition events for the keyed RuntimeContext handler.
//
// These tests prove the sparse contract directly on the store + predicate:
// no Activity ever fires for the dense rows because the cursor walker never
// surfaces them. The route is exercised in a sibling test file.

import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt, Response } from "@effect/ai"
import { Effect, Option, type Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  makeHostStreamPrefix,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostStreamPrefix,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { encodeRuntimeAgentOutputEnvelope } from "../../src/events/index.ts"
import {
  initialRuntimeContextEventState,
  isStateRelevantOutputObservation,
  makePerContextRuntimeContextStateStore,
  type RuntimeContextStateStoreService,
} from "../../src/tables/runtime-context-state.ts"
import { transitionOutputEvent } from "../../src/workflow-engine/workflows/runtime-context.ts"
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
const PREFIX: HostStreamPrefix = makeHostStreamPrefix({
  namespace: "shape-c-cutover-sparse",
  hostId: "shape-c-cutover-sparse_host" as HostId,
})

const storeEffect = () => {
  if (baseUrl === undefined) throw new Error("server not started")
  return makePerContextRuntimeContextStateStore({ durableStreamsBaseUrl: baseUrl }, PREFIX)
}

const contextFor = (contextId: string, agentProtocol: "acp" | "raw" = "raw"): RuntimeContext =>
  // Narrow fixture: the store reads `contextId`, and the sparse predicate also
  // reads `runtime.config.agentProtocol` (only on ToolUse). Everything else on
  // the surrounding RuntimeContext is irrelevant to load/save/nextOutput.
  ({ contextId, runtime: { config: { agentProtocol } } }) as unknown as RuntimeContext

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

const outputUrl = (contextId: string) =>
  runtimeContextOutputStreamUrl({
    baseUrl: baseUrl!,
    prefix: PREFIX,
    contextId,
  })

// Event factories — the existing observation union, not a new taxonomy.

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
const turnComplete: AgentOutputEvent = {
  _tag: "TurnComplete",
  finishReason: "stop",
}
const permissionRequest = (id: string): AgentOutputEvent => ({
  _tag: "PermissionRequest",
  permissionRequestId: id,
  toolUseId: `tu-${id}`,
  options: [],
})
const toolUse = (toolUseId: string): AgentOutputEvent => ({
  _tag: "ToolUse",
  part: Prompt.toolCallPart({
    id: toolUseId,
    name: "echo",
    params: {},
    providerExecuted: false,
  }),
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
      streamOptions: { url: outputUrl(contextId), contentType: "application/json" },
    })),
  )

const drainSparse = (
  store: RuntimeContextStateStoreService,
  context: RuntimeContext,
): Effect.Effect<ReadonlyArray<RuntimeAgentOutputObservation>, unknown> =>
  Effect.gen(function*() {
    const collected: Array<RuntimeAgentOutputObservation> = []
    let cursor = -1
    for (;;) {
      const next = yield* store.nextOutput(context, ATTEMPT, cursor)
      if (Option.isNone(next)) break
      collected.push(next.value)
      cursor = next.value.sequence
    }
    return collected
  })

describe("Shape C — RuntimeContext consumes sparse state-relevant facts (no dense scan)", () => {
  it("nextOutput skips dense inert observations and surfaces ONLY the sparse subset", async () => {
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)

    // 0  Ready              (inert — handler would action:None)
    // 1  TextChunk("hi")    (inert)
    // 2  TextChunk("there") (inert)
    // 3  PermissionRequest  (SPARSE)
    // 4  TextChunk("...")   (inert)
    // 5  ToolUse            (SPARSE, non-acp)
    // 6  TurnComplete       (inert)
    // 7  Terminated         (SPARSE)
    const stream: ReadonlyArray<AgentOutputEvent> = [
      ready,
      textChunk("hi"),
      textChunk("there"),
      permissionRequest("p-1"),
      textChunk("..."),
      toolUse("t-1"),
      turnComplete,
      terminated,
    ]

    await run(Effect.gen(function*() {
      yield* populate(contextId, stream)
      const store = yield* storeEffect()
      const sparse = yield* drainSparse(store, context)

      // 3 sparse facts surface; the 5 dense rows are skipped during the walk.
      expect(sparse.map(o => ({ sequence: o.sequence, tag: o._tag }))).toEqual([
        { sequence: 3, tag: "PermissionRequest" },
        { sequence: 5, tag: "ToolUse" },
        { sequence: 7, tag: "Terminated" },
      ])
    }))
  })

  it("under ACP, ToolUse is NOT state-relevant — the body never RunToolUses ACP outputs", async () => {
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId, "acp")

    const stream: ReadonlyArray<AgentOutputEvent> = [
      ready,
      toolUse("acp-tool-1"), // SDK-side under ACP — handler dispatches no RunToolUse
      textChunk("noise"),
      permissionRequest("p-2"),
      terminated,
    ]

    await run(Effect.gen(function*() {
      yield* populate(contextId, stream)
      const store = yield* storeEffect()
      const sparse = yield* drainSparse(store, context)
      expect(sparse.map(o => o._tag)).toEqual(["PermissionRequest", "Terminated"])
    }))
  })

  it("cursor round-trip across the dense skips persists progress past inert rows (replay-safe)", async () => {
    // Replay-safety: after consuming the first sparse fact at seq 3, the
    // handler stores lastProcessedOutputSequence=3. A subsequent call walks
    // forward to seq 5 (ToolUse), then 7 (Terminated). The dense skips are
    // re-walked on each call (point gets, no full scan) but never produce a
    // duplicate handler invocation because the cursor never returns to them.
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)
    const stream: ReadonlyArray<AgentOutputEvent> = [
      textChunk("a"), textChunk("b"), textChunk("c"),
      permissionRequest("p"),
      textChunk("d"),
      terminated,
    ]
    await run(Effect.gen(function*() {
      yield* populate(contextId, stream)
      const store = yield* storeEffect()

      const first = yield* store.nextOutput(context, ATTEMPT, -1)
      expect(Option.isSome(first) && first.value.sequence).toBe(3)

      const second = yield* store.nextOutput(context, ATTEMPT, 3)
      expect(Option.isSome(second) && second.value.sequence).toBe(5)
      expect(Option.isSome(second) && second.value._tag).toBe("Terminated")

      const frontier = yield* store.nextOutput(context, ATTEMPT, 5)
      expect(Option.isNone(frontier)).toBe(true)
    }))
  })

  it("isStateRelevantOutputObservation is the DUAL of transitionOutputEvent — non-relevant tags reduce to action:None and a cursor bump", () => {
    // Property check across the full output union: any observation the predicate
    // rejects must, when handed to the handler, produce only a cursor bump with
    // no state mutation and action:None. This locks the predicate as the single
    // source of truth for sparse consumption.
    const context = contextFor("ctx-dual")
    const baseFields = {
      source: "firegrid.runtime.agent-output-events",
      sessionId: "ctx-dual",
      contextId: "ctx-dual",
      activityAttempt: 1,
    } as const
    const cases: ReadonlyArray<{ obs: RuntimeAgentOutputObservation; relevant: boolean }> = [
      { obs: { ...baseFields, sequence: 0, _tag: "Ready", event: ready } as unknown as RuntimeAgentOutputObservation, relevant: false },
      { obs: { ...baseFields, sequence: 1, _tag: "TextChunk", event: textChunk("x") } as unknown as RuntimeAgentOutputObservation, relevant: false },
      { obs: { ...baseFields, sequence: 2, _tag: "TurnComplete", event: turnComplete } as unknown as RuntimeAgentOutputObservation, relevant: false },
      { obs: { ...baseFields, sequence: 3, _tag: "Status", event: { _tag: "Status", kind: "info" } } as unknown as RuntimeAgentOutputObservation, relevant: false },
      { obs: { ...baseFields, sequence: 4, _tag: "Error", event: { _tag: "Error", cause: "boom", recoverable: true } } as unknown as RuntimeAgentOutputObservation, relevant: false },
      { obs: { ...baseFields, sequence: 5, _tag: "PermissionRequest", event: permissionRequest("p-d") } as unknown as RuntimeAgentOutputObservation, relevant: true },
      { obs: { ...baseFields, sequence: 6, _tag: "ToolUse", event: toolUse("t-d") } as unknown as RuntimeAgentOutputObservation, relevant: true },
      { obs: { ...baseFields, sequence: 7, _tag: "Terminated", event: terminated } as unknown as RuntimeAgentOutputObservation, relevant: true },
    ]

    for (const c of cases) {
      expect(isStateRelevantOutputObservation(context, c.obs)).toBe(c.relevant)
    }

    // Dual property: every non-relevant observation reduces to (state cursor-bumped, action:None).
    for (const c of cases) {
      if (c.relevant) continue
      const result = transitionOutputEvent(context, initialRuntimeContextEventState, c.obs)
      expect(result.action._tag).toBe("None")
      expect(result.state.lastProcessedOutputSequence).toBe(c.obs.sequence)
      expect(result.state.lastProcessedInputSequence).toBe(initialRuntimeContextEventState.lastProcessedInputSequence)
      expect(result.state.pendingPermissionRequests).toEqual(initialRuntimeContextEventState.pendingPermissionRequests)
      expect(result.state.pendingPermissionResponses).toEqual(initialRuntimeContextEventState.pendingPermissionResponses)
      expect(result.state.exitEvidence).toBeUndefined()
    }
  })

  it("Terminal evidence is durable-row-owned, not synthesized from output hints", async () => {
    // A `Terminated` observation sets state.exitEvidence on the durable state
    // row through the handler's transition (the route-owned terminal path).
    // No `TurnComplete` / TextChunk synthesizes terminal authority.
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)
    await run(Effect.gen(function*() {
      yield* populate(contextId, [textChunk("noise"), turnComplete, terminated])
      const store = yield* storeEffect()

      // TurnComplete is NOT terminal authority — the handler treats it as inert.
      const sparse = yield* drainSparse(store, context)
      expect(sparse.map(o => o._tag)).toEqual(["Terminated"])

      // The terminal observation, when applied via the handler, populates
      // exitEvidence on the durable state row.
      const terminalObs = sparse[0]!
      const transitioned = transitionOutputEvent(context, initialRuntimeContextEventState, terminalObs)
      expect(transitioned.state.exitEvidence).toBeDefined()
      expect(transitioned.state.exitEvidence?.exitCode).toBe(0)
    }))
  })
})

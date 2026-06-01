// tf-r06u.9 — parent→child agent-output authority, end-to-end over real durable
// streams (the R7-closure proof). Extends the Shape-C cutover integration test
// (session-agent-output-route.integration.test.ts) with the tf-r06u.8 FK
// authority: a child created via HostContextsCreate WITH a `parentContextId`
// (the tf-r06u.9 plumbing) is observable by its parent through the authorized
// route, and rejected for any non-parent — both against a live
// DurableStreamTestServer (real RuntimeControlPlaneTable for the FK + real
// RuntimeOutputTable for the child's output).
//
// The host-wide composition of these pieces into FiregridHost is deferred to
// tf-r06u.48/.16 (it lands with its agent-dispatch consumer); this test proves
// the CAPABILITY composes correctly, which is what closes R7's substance.

import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt, Response } from "@effect/ai"
import {
  HostContextsCreateChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import {
  local,
  makeHostStreamPrefix,
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostStreamPrefix,
} from "@firegrid/protocol/launch"
import { Effect, Layer, Option, type Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  makeAuthorizedSessionAgentOutputChannel,
  makeRuntimeChannelRouter,
  sessionAgentOutputObservationRoute,
} from "../../src/channels/index.ts"
import { sessionAgentOutputChannel } from "../../src/channels/session-agent-output.ts"
import { HostContextsCreateChannelLive } from "../../src/unified/channel-bindings.ts"
import { buildCurrentHostSessionLayer } from "../../src/unified/host-identity.ts"
import { encodeRuntimeAgentOutputEnvelope } from "../../src/events/index.ts"
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
  ;(server as unknown as {
    server?: { closeAllConnections?: () => void }
  } | undefined)?.server?.closeAllConnections?.()
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const ATTEMPT = 0
const PREFIX: HostStreamPrefix = makeHostStreamPrefix({
  namespace: "r06u8-authority-int",
  hostId: "r06u8-authority-int_host" as HostId,
})

const textChunk = (delta: string): AgentOutputEvent => ({
  _tag: "TextChunk",
  part: Response.textDeltaPart({ id: `p-${delta}`, delta }),
})
const toolUse = (id: string): AgentOutputEvent => ({
  _tag: "ToolUse",
  part: Prompt.toolCallPart({ id, name: "echo", params: {}, providerExecuted: false }),
})
const terminated: AgentOutputEvent = { _tag: "Terminated", exitCode: 0 }

const CHILD_OUTPUT: ReadonlyArray<AgentOutputEvent> = [
  textChunk("hi"), // seq 0
  textChunk("there"), // seq 1
  toolUse("t-1"), // seq 2
  terminated, // seq 3
]

const outputUrl = (contextId: string) =>
  runtimeContextOutputStreamUrl({ baseUrl: baseUrl!, prefix: PREFIX, contextId })

// Write a child's dense output rows into its real per-context RuntimeOutputTable.
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

// The production base channel: per-context ingress over RuntimeOutputTable.
const baseChannelService: SessionAgentOutputChannelService = {
  forContext: (contextId) =>
    sessionAgentOutputChannel({
      durableStreamsBaseUrl: baseUrl!,
      streamPrefix: PREFIX,
      contextId,
    }),
}

describe("tf-r06u.9 — parent→child agent-output authority over real durable streams", () => {
  it("a parent observes its child's output through the authorized route; a non-parent is denied", async () => {
    const namespace = `r06u8-authority-int-${crypto.randomUUID()}`
    const parentId = `ctx_parent_${crypto.randomUUID()}`
    const childId = `ctx_child_${crypto.randomUUID()}`

    const controlPlaneLayer = RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({ baseUrl: baseUrl!, namespace }),
        contentType: "application/json",
      },
    })
    const hostSessionLayer = buildCurrentHostSessionLayer({ namespace })
    const createChannelLayer = HostContextsCreateChannelLive.pipe(
      Layer.provide(Layer.mergeAll(controlPlaneLayer, hostSessionLayer)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          // 1. Create the child WITH parentContextId via the real writer — the
          //    tf-r06u.9 FK plumbing (HostContextsCreate -> contexts.insertOrGet).
          const createChannel = yield* HostContextsCreateChannel
          yield* createChannel.binding.call({
            contextId: childId,
            runtime: local.jsonl({ argv: ["node", "agent.js"] }),
            parentContextId: parentId,
          })

          // 2. The FK persisted on the child's own context row.
          const control = yield* RuntimeControlPlaneTable
          const childRow = yield* control.contexts.get(childId)
          expect(Option.isSome(childRow)).toBe(true)
          expect(Option.getOrThrow(childRow).parentContextId).toBe(parentId)

          // 3. The child produces dense output.
          yield* populate(childId, CHILD_OUTPUT)

          // 4. The PARENT observes the child through the authorized route — cursor
          //    round-trip over the real durable output stream.
          const parentRouter = makeRuntimeChannelRouter([
            sessionAgentOutputObservationRoute(
              makeAuthorizedSessionAgentOutputChannel({
                underlying: baseChannelService,
                control,
                observingContextId: parentId,
              }),
            ),
          ])
          const seen: Array<number> = []
          let cursor = -1
          for (let i = 0; i < CHILD_OUTPUT.length; i++) {
            const observation = (yield* parentRouter.dispatch({
              target: SessionAgentOutputChannelTarget,
              verb: "wait_for",
              payload: { sessionId: childId, afterSequence: cursor },
            })) as RuntimeAgentOutputObservation
            seen.push(observation.sequence)
            cursor = observation.sequence
          }
          expect(seen).toEqual([0, 1, 2, 3])

          // 5. A NON-parent observing the same child is denied — typed
          //    UnauthorizedChildObservation surfaced through the router.
          const otherRouter = makeRuntimeChannelRouter([
            sessionAgentOutputObservationRoute(
              makeAuthorizedSessionAgentOutputChannel({
                underlying: baseChannelService,
                control,
                observingContextId: `ctx_other_${crypto.randomUUID()}`,
              }),
            ),
          ])
          const denial = yield* Effect.flip(
            otherRouter.dispatch({
              target: SessionAgentOutputChannelTarget,
              verb: "wait_for",
              payload: { sessionId: childId, afterSequence: -1 },
            }),
          )
          expect(JSON.stringify(denial)).toContain("UnauthorizedChildObservation")
        }).pipe(
          Effect.provide(Layer.mergeAll(createChannelLayer, controlPlaneLayer)),
        ),
      ),
    )
  })
})

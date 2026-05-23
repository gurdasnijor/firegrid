// Wave C focused router test for the `session.agent_output` mapping.
//
// PR #702's blackbox client/channel-router proof pins this mapping:
//
//   `session.wait.forAgentOutput` → `session.agent_output / wait_for`
//
// The route definition (`sessionAgentOutputObservationRoute`) was landed in a
// prior Wave but was NOT registered on the production `HostPlaneChannelRouter`
// — so `router.dispatch({ target: SessionAgentOutputChannelTarget,
// verb: "wait_for", payload: { sessionId, afterSequence } })` was unreachable
// at wire-edge. This slice registers the route on the existing host-plane
// router in `RuntimeHostControlChannelsLive` (no new router, no new
// abstraction). The SessionAgentOutputChannel Live binding stays host-sdk
// supplied; this test stubs it to keep the boundary tight.
//
// Assertions:
//   1. `HostPlaneChannelRouter.metadata` advertises `session.agent_output`
//      with direction=ingress and verbs containing `wait_for`.
//   2. `dispatch({ verb: "wait_for", ... })` reaches the existing route
//      and returns the next observation strictly after the cursor.
//   3. A wrong verb against the same target produces
//      `ChannelRouteVerbNotSupported`.

import { Response } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
  SessionAgentOutputChannel,
} from "@firegrid/protocol/channels"
import {
  ChannelRouteVerbNotSupported,
} from "@firegrid/protocol/channels/router"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import {
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  HostPlaneChannelRouter,
  RuntimeHostControlChannelsLive,
} from "../../src/channels/index.ts"

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

const observation = (
  sessionId: string,
  sequence: number,
): RuntimeAgentOutputObservation => ({
  source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
  sessionId: sessionId as RuntimeAgentOutputObservation["sessionId"],
  contextId: sessionId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 0,
  sequence,
  _tag: "TextChunk",
  event: {
    _tag: "TextChunk",
    part: Response.textDeltaPart({
      id: `p-${sequence}`,
      delta: `chunk-${sequence}`,
    }),
  },
})

// Stub SessionAgentOutputChannel: per-session in-memory observation streams.
// Stands in for the host-sdk-supplied `SessionAgentOutputChannelLive`;
// the route registration we are exercising consumes only the
// `forContext` resolver shape, not any host-sdk runtime authority.
const stubSessionAgentOutputChannel = (
  rowsBySession: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
): Layer.Layer<SessionAgentOutputChannel> => {
  const service: SessionAgentOutputChannelService = {
    forContext: (sessionId) =>
      makeIngressChannel({
        target: SessionAgentOutputChannelTarget,
        schema: RuntimeAgentOutputObservationSchema,
        sourceClass: "static-source",
        stream: Stream.fromIterable(rowsBySession[sessionId] ?? []),
      }),
  }
  return Layer.succeed(SessionAgentOutputChannel, service)
}

const controlPlaneLayer = (namespace: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: baseUrl!,
        namespace,
      }),
      contentType: "application/json",
    },
  })

const runWithRouter = <A, E>(
  namespace: string,
  rowsBySession: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
  effect: Effect.Effect<A, E, HostPlaneChannelRouter | RuntimeControlPlaneTable>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          RuntimeHostControlChannelsLive.pipe(
            Layer.provide(stubSessionAgentOutputChannel(rowsBySession)),
            Layer.provideMerge(controlPlaneLayer(namespace)),
          ),
        ),
      ),
    ),
  )

describe("host-plane channel router — session.agent_output route (#702 wave C)", () => {
  it("metadata advertises session.agent_output as ingress/wait_for", async () => {
    const namespace = `router-saorl-meta-${crypto.randomUUID()}`

    const metadata = await runWithRouter(
      namespace,
      {},
      Effect.gen(function* () {
        const router = yield* HostPlaneChannelRouter
        return router.metadata
      }),
    )

    const entry = metadata.find(
      (m) => String(m.target) === String(SessionAgentOutputChannelTarget),
    )
    expect(entry).toBeDefined()
    expect(entry?.direction).toBe("ingress")
    expect(entry?.verbs).toContain("wait_for")
  })

  it("dispatch wait_for resolves through the existing route shape", async () => {
    const namespace = `router-saorl-dispatch-${crypto.randomUUID()}`
    const sessionId = `sess_${crypto.randomUUID()}`

    const result = await runWithRouter(
      namespace,
      {
        [sessionId]: [
          observation(sessionId, 0),
          observation(sessionId, 1),
          observation(sessionId, 2),
        ],
      },
      Effect.gen(function* () {
        const router = yield* HostPlaneChannelRouter
        return yield* router.dispatch({
          target: SessionAgentOutputChannelTarget,
          verb: "wait_for",
          payload: { sessionId, afterSequence: 0 },
        })
      }),
    )

    // Dispatch returns the next observation strictly after the cursor.
    const observed = result as RuntimeAgentOutputObservation
    expect(observed.sessionId).toBe(sessionId)
    expect(observed.sequence).toBe(1)
  })

  it("rejects a verb the route direction does not support (e.g. call)", async () => {
    const namespace = `router-saorl-verb-${crypto.randomUUID()}`
    const sessionId = `sess_${crypto.randomUUID()}`

    const result = await runWithRouter(
      namespace,
      { [sessionId]: [] },
      Effect.either(
        Effect.gen(function* () {
          const router = yield* HostPlaneChannelRouter
          return yield* router.dispatch({
            target: SessionAgentOutputChannelTarget,
            // `session.agent_output` is ingress (wait_for only). `call` is
            // a callable-channel verb; the route descriptor must reject it.
            verb: "call",
            payload: { sessionId, afterSequence: -1 },
          })
        }),
      ),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ChannelRouteVerbNotSupported)
    }
  })
})

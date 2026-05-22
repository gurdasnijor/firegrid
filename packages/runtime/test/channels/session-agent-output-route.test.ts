import { Response } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRuntimeChannelRouter,
  SessionAgentOutputRouteInputSchema,
  sessionAgentOutputObservationRoute,
} from "../../src/channels/index.ts"

const observation = (
  contextId: string,
  sequence: number,
): RuntimeAgentOutputObservation => ({
  source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
  sessionId: contextId as RuntimeAgentOutputObservation["sessionId"],
  contextId: contextId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 1,
  sequence,
  _tag: "TextChunk",
  event: {
    _tag: "TextChunk",
    part: Response.textDeltaPart({ id: `p-${sequence}`, delta: `chunk-${sequence}` }),
  },
})

// Stub SessionAgentOutputChannel: per-sessionId in-memory observation streams.
// This stands in for the host-resolved channel; in production the same resolver
// is the parent→child authorization boundary.
const stubChannel = (
  rowsBySession: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
  onResolve?: (sessionId: string) => void,
): SessionAgentOutputChannelService => ({
  forContext: sessionId => {
    onResolve?.(sessionId)
    return makeIngressChannel({
      target: SessionAgentOutputChannelTarget,
      schema: RuntimeAgentOutputObservationSchema,
      sourceClass: "static-source",
      stream: Stream.fromIterable(rowsBySession[sessionId] ?? []),
    })
  },
})

describe("session agent-output observation route (tf-1ymw)", () => {
  it("declares an ingress wait_for route on the session.agent_output target", () => {
    const route = sessionAgentOutputObservationRoute(stubChannel({}))
    expect(String(route.descriptor.target)).toBe(
      String(SessionAgentOutputChannelTarget),
    )
    expect(route.descriptor.direction).toBe("ingress")
    expect(route.descriptor.verbs).toEqual(["wait_for"])
  })

  it("returns the next observation strictly after the cursor", async () => {
    const channel = stubChannel({
      ctx_child: [observation("ctx_child", 0), observation("ctx_child", 1), observation("ctx_child", 2)],
    })
    const router = makeRuntimeChannelRouter([
      sessionAgentOutputObservationRoute(channel),
    ])
    const result = (await Effect.runPromise(
      router.dispatch({
        target: SessionAgentOutputChannelTarget,
        verb: "wait_for",
        payload: { sessionId: "ctx_child", afterSequence: 1 },
      }),
    )) as RuntimeAgentOutputObservation
    expect(result.sequence).toBe(2)
    expect(result.contextId).toBe("ctx_child")
  })

  it("reads from the start of child output when afterSequence is -1", async () => {
    const channel = stubChannel({
      ctx_child: [observation("ctx_child", 0), observation("ctx_child", 1)],
    })
    const router = makeRuntimeChannelRouter([
      sessionAgentOutputObservationRoute(channel),
    ])
    const result = (await Effect.runPromise(
      router.dispatch({
        target: SessionAgentOutputChannelTarget,
        verb: "wait_for",
        payload: { sessionId: "ctx_child", afterSequence: -1 },
      }),
    )) as RuntimeAgentOutputObservation
    expect(result.sequence).toBe(0)
  })

  it("keys the per-session channel by the request sessionId (authority boundary)", async () => {
    const resolved: Array<string> = []
    const channel = stubChannel(
      { ctx_a: [observation("ctx_a", 5)] },
      sessionId => resolved.push(sessionId),
    )
    const router = makeRuntimeChannelRouter([
      sessionAgentOutputObservationRoute(channel),
    ])
    const result = (await Effect.runPromise(
      router.dispatch({
        target: SessionAgentOutputChannelTarget,
        verb: "wait_for",
        payload: { sessionId: "ctx_a", afterSequence: 4 },
      }),
    )) as RuntimeAgentOutputObservation
    expect(resolved).toEqual(["ctx_a"])
    expect(result.sequence).toBe(5)
  })

  it("requires sessionId and a mandatory cursor >= -1", async () => {
    const reject = (input: unknown) =>
      Effect.runPromise(
        Effect.flip(
          Schema.decodeUnknown(SessionAgentOutputRouteInputSchema)(input),
        ),
      )
    expect(await reject({ sessionId: "ctx_child" })).toBeDefined()
    expect(await reject({ sessionId: "", afterSequence: 0 })).toBeDefined()
    expect(await reject({ sessionId: "ctx_child", afterSequence: -2 })).toBeDefined()
  })
})

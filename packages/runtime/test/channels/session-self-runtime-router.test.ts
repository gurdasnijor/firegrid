import { Response } from "@effect/ai"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RuntimeChannelRouter } from "../../src/channels/index.ts"
import { SessionSelfChannelsLive } from "../../src/channels/session-self/live.ts"

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
  effect: Effect.Effect<A, E, RuntimeChannelRouter>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          SessionSelfChannelsLive().pipe(
            Layer.provide(stubSessionAgentOutputChannel(rowsBySession)),
            Layer.provideMerge(controlPlaneLayer(namespace)),
          ),
        ),
      ),
    ),
  )

describe("session-self runtime tool router", () => {
  it("firegrid-agent-body-plan.MCP_CHANNEL_METADATA.1 exposes session.agent_output to MCP wait_for tools", async () => {
    const metadata = await runWithRouter(
      `session-self-router-meta-${crypto.randomUUID()}`,
      {},
      Effect.gen(function* () {
        const router = yield* RuntimeChannelRouter
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

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3 dispatches session.agent_output through the runtime tool router", async () => {
    const result = await runWithRouter(
      `session-self-router-dispatch-${crypto.randomUUID()}`,
      { "ctx-child": [observation("ctx-child", 0)] },
      Effect.gen(function* () {
        const router = yield* RuntimeChannelRouter
        return yield* router.dispatch({
          target: SessionAgentOutputChannelTarget,
          verb: "wait_for",
          payload: { sessionId: "ctx-child", afterSequence: -1 },
        })
      }),
    ) as RuntimeAgentOutputObservation

    expect(result).toMatchObject({
      sessionId: "ctx-child",
      contextId: "ctx-child",
      sequence: 0,
      _tag: "TextChunk",
    })
  })
})

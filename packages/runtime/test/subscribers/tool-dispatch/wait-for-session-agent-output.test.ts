import { Prompt, Response } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  SessionSelfLifecycleChannelTarget,
  SessionSelfLifecycleEventSchema,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  RuntimeChannelRouter,
  makeRuntimeChannelRouter,
  runtimeRouteFromChannel,
  sessionAgentOutputObservationRoute,
} from "../../../src/channels/index.ts"
import {
  toolUseToEffect,
} from "../../../src/subscribers/tool-dispatch/tool-use-to-effect.ts"
import {
  RuntimeAgentToolExecution,
} from "../../../src/subscribers/tool-dispatch/runtime-agent-tool-execution.ts"
import {
  AgentToolHost,
} from "../../../src/subscribers/tool-dispatch/tool-host.ts"

const observation = (
  sessionId: string,
  sequence: number,
): RuntimeAgentOutputObservation => ({
  source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
  sessionId: sessionId as RuntimeAgentOutputObservation["sessionId"],
  contextId: sessionId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 1,
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

const routerLayer = (
  rowsBySession: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
): Layer.Layer<RuntimeChannelRouter> => {
  const channel: SessionAgentOutputChannelService = {
    forContext: (sessionId) =>
      makeIngressChannel({
        target: SessionAgentOutputChannelTarget,
        schema: RuntimeAgentOutputObservationSchema,
        sourceClass: "static-source",
        stream: Stream.fromIterable(rowsBySession[sessionId] ?? []),
      }),
  }
  return Layer.succeed(
    RuntimeChannelRouter,
    makeRuntimeChannelRouter([sessionAgentOutputObservationRoute(channel)]),
  )
}

const unused = <A = never>() =>
  Effect.fail({ _tag: "UnusedDependency" as const }) as
    unknown as Effect.Effect<A>

const unusedToolDeps = Layer.mergeAll(
  RuntimeAgentToolExecution.layer({
    sleep: () => unused(),
    waitFor: () => unused(),
    waitForAny: () => unused(),
    send: () => unused(),
    call: () => unused(),
    schedule: () => unused(),
  }),
  AgentToolHost.layer({
    spawnChildContext: () => unused(),
    spawnChildContexts: () => unused(),
    executeSandboxTool: () => unused(),
    executeSessionCapability: () => unused(),
    callApprovalChannel: () => unused(),
    appendSessionPrompt: () => unused(),
    cancelSession: () => unused(),
    closeSession: () => unused(),
  }),
)

describe("agent wait_for over session.agent_output", () => {
  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3 routes child-output waits through the registered session.agent_output route", async () => {
    const result = await Effect.runPromise(
      toolUseToEffect(
        { contextId: "ctx-parent" },
        {
          _tag: "ToolUse",
          part: Prompt.toolCallPart({
            id: "tool-wait-child",
            name: "wait_for",
            params: {
              channel: "session.agent_output",
              match: { sessionId: "ctx-child", afterSequence: -1 },
              timeoutMs: 1_000,
            },
            providerExecuted: false,
          }),
        },
      ).pipe(
        Effect.provide(Layer.mergeAll(
          routerLayer({
            "ctx-child": [observation("ctx-child", 0)],
          }),
          unusedToolDeps,
        )),
      ),
    )

    expect(result._tag).toBe("ToolResult")
    expect(result.part.isFailure).toBe(false)
    expect(result.part.result).toMatchObject({
      matched: true,
      event: {
        sessionId: "ctx-child",
        contextId: "ctx-child",
        sequence: 0,
        _tag: "TextChunk",
      },
    })
  })

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3 waits on registered runtime route streams with dotted scalar matches", async () => {
    const lifecycle = makeIngressChannel({
      target: SessionSelfLifecycleChannelTarget,
      schema: SessionSelfLifecycleEventSchema,
      sourceClass: "static-source",
      stream: Stream.fromIterable([
        {
          channel: "session.self.lifecycle" as const,
          event: {
            runEventId: {
              contextId: "ctx-child",
              activityAttempt: 1,
              status: "exited" as const,
            },
            contextId: "ctx-child",
            activityAttempt: 1,
            status: "exited" as const,
            at: "2026-05-24T00:00:00.000Z",
            provider: "local-process" as const,
            exitCode: 0,
          },
        },
      ]),
    })
    const result = await Effect.runPromise(
      toolUseToEffect(
        { contextId: "ctx-parent" },
        {
          _tag: "ToolUse",
          part: Prompt.toolCallPart({
            id: "tool-wait-lifecycle",
            name: "wait_for",
            params: {
              channel: "session.self.lifecycle",
              match: { "event.status": "exited" },
              timeoutMs: 1_000,
            },
            providerExecuted: false,
          }),
        },
      ).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(
            RuntimeChannelRouter,
            makeRuntimeChannelRouter([runtimeRouteFromChannel(lifecycle)]),
          ),
          unusedToolDeps,
        )),
      ),
    )

    expect(result.part.isFailure).toBe(false)
    expect(result.part.result).toMatchObject({
      matched: true,
      event: {
        channel: "session.self.lifecycle",
        event: {
          contextId: "ctx-child",
          status: "exited",
          exitCode: 0,
        },
      },
    })
  })

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.5 times out cleanly when child output has not arrived", async () => {
    const result = await Effect.runPromise(
      toolUseToEffect(
        { contextId: "ctx-parent" },
        {
          _tag: "ToolUse",
          part: Prompt.toolCallPart({
            id: "tool-wait-child-timeout",
            name: "wait_for",
            params: {
              channel: "session.agent_output",
              match: { sessionId: "ctx-child", afterSequence: -1 },
              timeoutMs: 1,
            },
            providerExecuted: false,
          }),
        },
      ).pipe(
        Effect.provide(Layer.mergeAll(
          routerLayer({ "ctx-child": [] }),
          unusedToolDeps,
        )),
      ),
    )

    expect(result.part.isFailure).toBe(false)
    expect(result.part.result).toEqual({ matched: false, timedOut: true })
  })
})

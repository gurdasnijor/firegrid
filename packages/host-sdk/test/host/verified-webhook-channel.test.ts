import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt } from "@effect/ai"
import {
  VerifiedWebhookFactChannel,
  VerifiedWebhookFactChannelTarget,
} from "@firegrid/protocol/channels"
import {
  LinearWebhookFactSchema,
  type LinearWebhookFact,
} from "@firegrid/protocol/verified-webhook"
import {
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
} from "@firegrid/runtime/verified-webhook-ingest"
import type { AgentOutputEvent, ToolResultEvent } from "@firegrid/runtime/events"
import {
  CallerOwnedFactStreams,
  RuntimeObservationStreams,
} from "@firegrid/runtime/streams"
import { RuntimeAgentToolExecutionLive } from "@firegrid/runtime/tool-executor"
import { WaitForWorkflowLayer } from "@firegrid/runtime/workflows"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  channelMetadata,
  makeRuntimeContextChannelRouter,
  RuntimeChannelRouter,
  VerifiedWebhookFactCallerOwnedFactStreamsLive,
  verifiedWebhookFactChannel,
} from "../../src/host/index.ts"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../../src/agent-tools/execution/tool-host.ts"
import { toolUseToEffect } from "../../src/agent-tools/execution/tool-use-to-effect.ts"
import { toolExecutionFailed } from "../../src/agent-tools/bindings/tool-error.ts"

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

const streamUrl = (name: string): string => {
  if (!baseUrl) throw new Error("server not started")
  return `${baseUrl}/v1/stream/${name}-${crypto.randomUUID()}`
}

const linearWebhookFact = (webhookId: string): LinearWebhookFact => ({
  factKey: ["linear-demo", webhookId],
  source: "linear-demo",
  externalEventKey: webhookId,
  externalEntityKey: "issue_1",
  eventType: "Issue.update",
  receivedAt: "2026-05-20T00:00:00.100Z",
  verifiedAt: "2026-05-20T00:00:00.200Z",
  signatureScheme: "hmac-sha256",
  payloadSha256: "abc123",
  selectedHeaders: {
    "linear-delivery": webhookId,
  },
  payload: {
    action: "update",
    type: "Issue",
    actor: {
      id: "user_1",
      type: "user",
    },
    createdAt: "2026-05-20T00:00:00.000Z",
    data: {
      id: "issue_1",
      identifier: "TF-123",
    },
    url: "https://linear.app/team/issue/TF-123/example",
    updatedFrom: {
      title: "old title",
    },
    organizationId: "org_1",
    webhookTimestamp: 1_779_232_800_000,
    webhookId,
  },
  action: "update",
  type: "Issue",
  webhookId,
  webhookTimestamp: 1_779_232_800_000,
  createdAt: "2026-05-20T00:00:00.000Z",
  organizationId: "org_1",
  url: "https://linear.app/team/issue/TF-123/example",
  actor: {
    id: "user_1",
    type: "user",
  },
  data: {
    id: "issue_1",
    identifier: "TF-123",
  },
  updatedFrom: {
    title: "old title",
  },
})

const toolUse = (
  toolUseId: string,
  params: unknown,
): Extract<AgentOutputEvent, { _tag: "ToolUse" }> => ({
  _tag: "ToolUse",
  part: Prompt.toolCallPart({
    id: toolUseId,
    name: "wait_for",
    params,
    providerExecuted: false,
  }),
})

const resultContent = (result: ToolResultEvent): unknown => result.part.result

const fakeHost = (): AgentToolHostService => ({
  spawnChildContext: () =>
    Effect.succeed({
      childContextId: "stub-child",
      terminalState: { _tag: "Completed", output: { ok: true } },
    }),
  spawnChildContexts: () =>
    Effect.succeed({
      children: [],
    }),
  executeSandboxTool: () => Effect.succeed<unknown>({ ok: true }),
  executeSessionCapability: () => Effect.succeed<unknown>({ ok: true }),
  callApprovalChannel: () =>
    Effect.succeed({
      matched: false,
      timedOut: true,
    }),
  appendSessionPrompt: () => Effect.void,
  cancelSession: ({ toolUseId }) =>
    Effect.fail(toolExecutionFailed(
      toolUseId,
      "session_cancel",
      "session cancellation is not available in this test host",
    )),
  closeSession: ({ toolUseId }) =>
    Effect.fail(toolExecutionFailed(
      toolUseId,
      "session_close",
      "session close is not available in this test host",
    )),
})

const VerifiedWebhookFactRouterLive = Layer.unwrapEffect(
  Effect.map(VerifiedWebhookFactChannel, channel =>
    Layer.succeed(
      RuntimeChannelRouter,
      makeRuntimeContextChannelRouter([channel]),
    )),
)

const VerifiedWebhookRuntimeObservationStreamsLive = Layer.effect(
  RuntimeObservationStreams,
  Effect.gen(function*() {
    const callerOwnedFactStreams = yield* CallerOwnedFactStreams
    return {
      agentOutput: Stream.empty,
      agentOutputAfter: () => Stream.empty,
      initialAgentOutputAfter: () => Effect.succeed(Option.none()),
      agentOutputForContext: () => Stream.empty,
      callerFact: callerOwnedFactStreams.streamFor,
    }
  }),
)

const VerifiedWebhookFactChannelLinearProjectionLive = Layer.effect(
  VerifiedWebhookFactChannel,
  Effect.gen(function*() {
    const table = yield* VerifiedWebhookFactTable
    return verifiedWebhookFactChannel(table, {
      schema: LinearWebhookFactSchema,
      target: VerifiedWebhookFactChannelTarget,
    })
  }),
)

const runWithVerifiedWebhookLayer = <A, E>(
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          RuntimeAgentToolExecutionLive.pipe(
            Layer.provideMerge(WaitForWorkflowLayer),
            Layer.provideMerge(VerifiedWebhookRuntimeObservationStreamsLive),
            Layer.provideMerge(VerifiedWebhookFactCallerOwnedFactStreamsLive),
            Layer.provideMerge(VerifiedWebhookFactRouterLive),
            Layer.provideMerge(VerifiedWebhookFactChannelLinearProjectionLive),
            Layer.provideMerge(AgentToolHost.layer(fakeHost())),
            Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
              streamUrl: streamUrl("verified-webhook-wait-workflow"),
            })),
            Layer.provideMerge(VerifiedWebhookFactTable.layer(
              verifiedWebhookFactTableLayerOptions({
                streamUrl: streamUrl("verified-webhook-facts"),
              }),
            )),
          ),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  )

describe("VerifiedWebhookFactChannel", () => {
  it("firegrid-verified-webhook-ingest.WAIT_INTEGRATION.1 firegrid-verified-webhook-ingest.WAIT_INTEGRATION.2 firegrid-verified-webhook-ingest.WAIT_INTEGRATION.3 firegrid-durable-tools.SOURCE_COLLECTIONS.6 observes Linear-shaped data through the generic verified webhook wait_for channel", async () => {
    const webhookId = "delivery_1"
    const waitInput = {
      channel: String(VerifiedWebhookFactChannelTarget),
      match: {
        source: "linear-demo",
        eventType: "Issue.update",
        webhookId,
      },
      timeoutMs: 1_000,
    }

    const result = await runWithVerifiedWebhookLayer(
      Effect.gen(function*() {
        const channel = yield* VerifiedWebhookFactChannel
        const metadata = channelMetadata(channel)
        const table = yield* VerifiedWebhookFactTable
        const directObserved = yield* channel.binding.stream.pipe(
          Stream.filterMap(row =>
            Schema.decodeUnknownOption(LinearWebhookFactSchema)(row as unknown),
          ),
          Stream.filter(row => row.webhookId === webhookId),
          Stream.runHead,
          Effect.fork,
        )
        const toolObserved = yield* toolUseToEffect(
          { contextId: "ctx-verified-webhook" },
          toolUse("tool-verified-webhook", waitInput),
        ).pipe(Effect.fork)
        yield* Effect.sleep("60 millis")
        yield* table.verifiedWebhookFacts.insertOrGet(linearWebhookFact(webhookId))
        return {
          metadata,
          direct: Option.getOrThrow(yield* directObserved),
          tool: yield* toolObserved,
        }
      }),
    )

    expect(result.metadata).toMatchObject({
      target: VerifiedWebhookFactChannelTarget,
      direction: "ingress",
      sourceClass: "static-source",
    })
    expect(JSON.stringify(result.metadata)).not.toContain("verifiedWebhookFacts")
    expect(JSON.stringify(waitInput)).toContain("firegrid.verifiedWebhooks")
    expect(JSON.stringify(waitInput)).not.toContain("verifiedWebhookFacts")
    expect(JSON.stringify(waitInput)).not.toContain("linear.webhook")
    expect(result.direct.webhookId).toBe(webhookId)
    expect(result.tool.part.isFailure).toBe(false)
    expect(resultContent(result.tool)).toMatchObject({
      matched: true,
      event: {
        source: "linear-demo",
        externalEventKey: webhookId,
        eventType: "Issue.update",
        webhookId,
      },
    })
  })
})

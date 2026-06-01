/**
 * Production-flow scenario 9 — REAL subprocess via
 * `LocalProcessSandboxProvider` running an in-process `FixtureAgent`
 * wrapped as a Node binary.
 *
 * Same shape as scenario 8 (`production-flow-acp`) but with two
 * differences:
 *
 *   1. The `SandboxProvider` Layer is `LocalProcessSandboxProvider`
 *      (not `acp-sandbox-fake`). This is the SAME provider used in
 *      production with `claude-agent-acp`. Spawns a real child
 *      process, opens its stdio as an `AgentByteStream`.
 *   2. The spawn target is `packages/tiny-firegrid/src/bin/fake-acp-
 *      agent-process.ts` — a Node entrypoint that wraps `FixtureAgent`
 *      (or one of its variants) over `process.stdin` / `process.stdout`.
 *      Real ACP wire bytes, real subprocess lifecycle, no API
 *      credentials needed.
 *
 * Gated behind `FIREGRID_UKV_RUN_ACP_LIVE=1` so CI / default sim runs
 * skip it (subprocess spawn is slow + flakier than in-memory). When
 * set, the scenario runs end-to-end and proves the FULL real-host
 * stack — `ProductionCodecAdapterLive` + `LocalProcessSandboxProvider`
 * + `AcpSessionLive` + a real Node child process — works.
 *
 * The `claude-agent-acp` binary itself can substitute the fake when
 * credentials are available; the codec doesn't care which agent is
 * on the other end of the byte pipe.
 */

import { NodeContext } from "@effect/platform-node"
import { IdGenerator } from "@effect/ai"
import { type WorkflowEngine } from "@effect/workflow"
import {
  HostPlaneChannelRouter,
} from "@firegrid/runtime/channels"
import {
  WorkflowEngineTable,
  DurableStreamsWorkflowEngine,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
} from "@firegrid/runtime/sources/sandbox"
import {
  ContextResolverTag,
  PermissionRoundtripWorkflow,
  ProductionCodecAdapterLive,
  RuntimeContextSessionWorkflow,
  RuntimeContextSessionWorkflowLayer,
  RuntimeOutputTable,
  SignalTable,
  ToolDispatchWorkflow,
  UnifiedTable,
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  makeToolExecutor,
  recoverPendingSignals,
  type ToolExecutor,
} from "@firegrid/runtime/unified"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "@firegrid/runtime/events"
import {
  durableStreamUrl,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Prompt } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  HostPlaneChannelRouterLive,
  type SessionHandle,
} from "./channels.ts"
import type { EventOffset } from "./durable-event-channel.ts"
import {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
  buildWebhookFactObserverLayer,
  PeerEventObserverWorkflow,
  ScheduledPromptWorkflow,
  WebhookFactObserverWorkflow,
} from "./subscribers/scheduled-webhook-peer.ts"
import { makeCatalog } from "./substrate.ts"

export interface ProductionFlowAcpLiveResult {
  readonly enabled: boolean
  readonly skipped?: string
  readonly sessionTerminal?: boolean
  readonly sessionInputsConsumed?: number
  readonly journalRowsWritten?: number
  readonly sawToolUse?: boolean
  readonly sawTurnComplete?: boolean
}

export interface ProductionFlowAcpLiveUrls {
  readonly engineStreamUrl: string
  readonly unifiedTableStreamUrl: string
  readonly signalTableStreamUrl: string
  readonly outputTableStreamUrl: string
}

export const productionFlowAcpLiveUrlsFor = (
  base: { readonly durableStreamsBaseUrl: string; readonly namespace: string },
  runId: string,
): ProductionFlowAcpLiveUrls => ({
  engineStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow-acp-live.engine`,
  ),
  unifiedTableStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow-acp-live.unified`,
  ),
  signalTableStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow-acp-live.signals`,
  ),
  outputTableStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow-acp-live.output`,
  ),
})

const fullCatalog = makeCatalog([
  RuntimeContextSessionWorkflow,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
  ScheduledPromptWorkflow,
  WebhookFactObserverWorkflow,
  PeerEventObserverWorkflow,
])

const tableLayer = <T>(
  cls: {
    layer: (options: {
      readonly streamOptions: { readonly url: string; readonly contentType: string }
      readonly txTimeoutMs?: number
    }) => Layer.Layer<T, unknown, never>
  },
  url: string,
): Layer.Layer<T, unknown, never> =>
  cls.layer({
    streamOptions: { url, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const T = {
  sessionStart: "unified.session.start",
  sessionSendInput: "unified.session.send_input",
  sessionAwaitTerminal: "unified.session.await_terminal",
} as const

const simRoot = fileURLToPath(new URL(".", import.meta.url))
// simRoot is `.../packages/tiny-firegrid/src/simulations/unified-kernel-validation/`.
// Walk up two segments to `packages/tiny-firegrid/src/`, then to `bin/`.
const fakeAgentBin = join(
  dirname(dirname(simRoot)),
  "bin/fake-acp-agent-process.ts",
)
// Resolve tsx absolute path — the local-process sandbox provider restricts
// the spawn env to a small allowlist that does NOT include the workspace
// `node_modules/.bin` directory, so a bare "tsx" can't be found.
const requireFromScenario = createRequire(import.meta.url)
const tsxBin = join(
  dirname(requireFromScenario.resolve("tsx/package.json")),
  "dist/cli.mjs",
)
// Real `claude-agent-acp` binary (installed as a devDependency of
// `@firegrid/runtime`). When `FIREGRID_UKV_USE_REAL_CLAUDE_ACP=1` is
// set alongside `FIREGRID_UKV_RUN_ACP_LIVE=1`, scenario 9 spawns this
// real binary instead of the FixtureAgent bootstrap. Requires API
// credentials (ANTHROPIC_API_KEY etc.) in the host env — those have
// to be authorized through `envPolicy` on the FiregridHost composition;
// scenario 9's standalone composition uses denyAll, so the live binary
// won't get credentials this way and will exit with an auth error.
// Provided as a structural toggle for users wiring their own host with
// proper credential authorization.
const realClaudeAcpBin = (() => {
  try {
    return requireFromScenario.resolve("@agentclientprotocol/claude-agent-acp/dist/acp-agent.js")
  } catch {
    return undefined
  }
})()
const useRealClaudeAcp = process.env["FIREGRID_UKV_USE_REAL_CLAUDE_ACP"] === "1"
  && realClaudeAcpBin !== undefined

const staticContextResolver = (
  contextId: string,
): Layer.Layer<ContextResolverTag> =>
  Layer.succeed(
    ContextResolverTag,
    {
      resolve: (queryId: string) =>
        Effect.succeed(
          queryId === contextId
            ? Option.some({
              contextId,
              createdAt: new Date(0).toISOString(),
              runtime: {
                provider: "local-process",
                config: {
                  // Use the host's node binary (process.execPath) +
                  // tsx CLI mjs entry as absolute paths. The sandbox
                  // provider's env allowlist doesn't include
                  // node_modules/.bin so PATH lookup won't find tsx.
                  // FIREGRID_UKV_USE_REAL_CLAUDE_ACP=1 swaps in the
                  // real claude-agent-acp binary (requires credentials
                  // + envPolicy authorization to work).
                  argv: useRealClaudeAcp && realClaudeAcpBin !== undefined
                    ? [process.execPath, realClaudeAcpBin] as ReadonlyArray<string>
                    : [process.execPath, tsxBin, fakeAgentBin] as ReadonlyArray<string>,
                  agentProtocol: "acp" as const,
                },
                journal: [],
              },
              host: {
                hostId: "sim-host" as RuntimeContext["host"]["hostId"],
                streamPrefix: "sim.firegrid.host.simhost" as RuntimeContext["host"]["streamPrefix"],
                boundAtMs: 0,
              },
            } satisfies RuntimeContext)
            : Option.none(),
        ),
    },
  )

export const productionFlowAcpLiveScenario = (
  urls: ProductionFlowAcpLiveUrls,
): Effect.Effect<ProductionFlowAcpLiveResult, unknown> => {
  const enabled = process.env["FIREGRID_UKV_RUN_ACP_LIVE"] === "1"
  if (!enabled) {
    return Effect.succeed({
      enabled: false,
      skipped: "set FIREGRID_UKV_RUN_ACP_LIVE=1 to run scenario 9 (real subprocess via LocalProcessSandboxProvider)",
    } satisfies ProductionFlowAcpLiveResult)
  }

  return Effect.gen(function*() {
    const toolExecutor: ToolExecutor = yield* makeToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      (p) => JSON.stringify({ tool: p.toolName, echoed: JSON.parse(p.inputJson) }),
    )
    const contextId = "ctx-prod-acp-live"
    const attempt = 1

    // Shared substrate.
    const substrateLayer = Layer.mergeAll(
      tableLayer(UnifiedTable, urls.unifiedTableStreamUrl),
      tableLayer(SignalTable, urls.signalTableStreamUrl),
      tableLayer(RuntimeOutputTable, urls.outputTableStreamUrl),
    )
    const engineLayer = DurableStreamsWorkflowEngine.layer({
      streamUrl: urls.engineStreamUrl,
    })

    // REAL `LocalProcessSandboxProvider` + NodeContext (for CommandExecutor).
    // No env-binding policy — leave RuntimeEnvResolverPolicy as the default
    // deny-all. Our fake agent doesn't need any env vars.
    const sandboxLayer = LocalProcessSandboxProvider.layer().pipe(
      Layer.provide(NodeContext.layer),
    )

    const adapterLayer = ProductionCodecAdapterLive.pipe(
      Layer.provide(sandboxLayer),
      Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
      Layer.provide(staticContextResolver(contextId)),
      Layer.provide(RuntimeEnvResolverPolicy.denyAll),
    )

    // Same upper-layer composition as scenario 8: NO JournalObserverLive
    // (ACP handles tools internally — see scenario 8 commentary).
    const upperLayers = Layer.mergeAll(
      RuntimeContextSessionWorkflowLayer.pipe(Layer.provide(adapterLayer)),
      buildPermissionRoundtripLayer(),
      buildToolDispatchLayer(toolExecutor),
      buildScheduledPromptLayer(),
      buildWebhookFactObserverLayer(),
      buildPeerEventObserverLayer(),
      HostPlaneChannelRouterLive,
    )
    const generationLayer = upperLayers.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(substrateLayer),
    )

    return yield* (Effect.scoped(
      Effect.gen(function*() {
        const engineTable = yield* WorkflowEngineTable
        const signals = yield* SignalTable
        const outputTable = yield* RuntimeOutputTable
        yield* recoverPendingSignals({
          signals,
          engineTable,
          catalog: fullCatalog,
        })

        const router = yield* HostPlaneChannelRouter
        const call = <A>(target: string, payload: unknown) =>
          router.dispatch({ target, verb: "call", payload }).pipe(
            Effect.map((r) => r as A),
          ) as Effect.Effect<A, unknown>
        const send = <A>(target: string, payload: unknown) =>
          router.dispatch({ target, verb: "send", payload }).pipe(
            Effect.map((r) => r as A),
          ) as Effect.Effect<A, unknown>

        // 1. Start the session — adapter.startOrAttach spawns the
        //    subprocess via LocalProcessSandboxProvider, builds the
        //    real ACP codec session against its byte pipe.
        const session = yield* call<SessionHandle>(T.sessionStart, { contextId, attempt })

        // 2. Send a prompt through the real subprocess.
        const promptEvent: AgentInputEvent = {
          _tag: "Prompt",
          prompt: Prompt.userMessage({
            content: [Prompt.textPart({ text: "hello live acp" })],
          }),
          correlationId: "prompt-acp-live-1",
        }
        const promptPayloadJson = JSON.stringify(
          Schema.encodeSync(AgentInputEventSchema)(promptEvent),
        )
        yield* send<EventOffset>(T.sessionSendInput, {
          session,
          inputId: "prompt-acp-live-1",
          kind: "prompt",
          payloadJson: promptPayloadJson,
        })

        // Give the subprocess time to handle the prompt.
        yield* Effect.sleep("2 seconds")

        // 3. Terminate.
        yield* send<EventOffset>(T.sessionSendInput, {
          session,
          inputId: "terminal",
          kind: "terminal",
          payloadJson: JSON.stringify({ reason: "done" }),
        })

        const sessionResult = yield* call<{
          readonly contextId: string
          readonly attempt: number
          readonly inputsConsumed: number
          readonly reachedTerminal: boolean
        }>(T.sessionAwaitTerminal, session)

        const rows = yield* outputTable.events
          .query((coll) =>
            coll.toArray.filter((r) => r.contextId === contextId),
          ).pipe(Effect.orDie)

        const rawTags = rows.map((r) => {
          try {
            const parsed = JSON.parse(r.raw) as { readonly event?: { readonly _tag?: string } }
            return parsed.event?._tag
          } catch {
            return undefined
          }
        })
        const sawToolUse = rawTags.includes("ToolUse")
        const sawTurnComplete = rawTags.includes("TurnComplete")

        return {
          enabled: true,
          sessionTerminal: sessionResult.reachedTerminal,
          sessionInputsConsumed: sessionResult.inputsConsumed,
          journalRowsWritten: rows.length,
          sawToolUse,
          sawTurnComplete,
        } satisfies ProductionFlowAcpLiveResult
      }).pipe(
        Effect.provide(generationLayer as Layer.Layer<
          | WorkflowEngine.WorkflowEngine
          | WorkflowEngineTable
          | SignalTable
          | UnifiedTable
          | RuntimeOutputTable
          | HostPlaneChannelRouter,
          unknown,
          never
        >),
      ),
    ) as Effect.Effect<ProductionFlowAcpLiveResult, unknown, never>)
  })
}

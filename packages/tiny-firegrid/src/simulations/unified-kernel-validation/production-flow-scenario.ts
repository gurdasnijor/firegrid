/**
 * Production-flow end-to-end scenario.
 *
 * The only scenario in this simulation that exercises the full
 * production loop: codec writes to journal → `JournalObserverLive`
 * observes → fires sibling workflows → workflows auto-relay results
 * back to session → session body continues consuming inputs. No
 * driver-side relay anywhere.
 *
 * Other scenarios in `scenarios.ts` test each capability in isolation
 * (driving sibling workflows directly via channel calls). This one
 * proves the production wiring works end-to-end with the
 * `RuntimeContextSessionAdapter` Tag, `RuntimeOutputTable` journal,
 * `JournalObserverLive` daemon, and the sibling-workflow feedback
 * signals all participating.
 *
 * Why this scenario does NOT use `runGeneration`: the substrate helper
 * provides only `SignalTable` + `UnifiedTable`; production-flow needs
 * `RuntimeOutputTable` too (the codec writes outputs there; the
 * observer reads them from there). We hand-compose the layer graph
 * so all consumers share a single substrate instance.
 */

import { type WorkflowEngine } from "@effect/workflow"
import {
  HostPlaneChannelRouter,
} from "@firegrid/runtime/channels"
import {
  WorkflowEngineTable,
  DurableStreamsWorkflowEngine,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import {
  JournalObserverLive,
  PermissionRoundtripWorkflow,
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
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Effect, Layer, Ref } from "effect"
import {
  HostPlaneChannelRouterLive,
  type SessionHandle,
} from "./channels.ts"
import {
  buildFakeCodecAdapter,
} from "./fake-codec.ts"
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

export interface ProductionFlowResult {
  readonly sessionTerminal: boolean
  readonly sessionInputsConsumed: number
  /** Number of `adapter.send` calls. Each input forwarded to codec. */
  readonly codecSendCount: number
  /** Number of `adapter.deregister` calls. Should be 1. */
  readonly codecDeregisterCount: number
  /** Tool dispatch invocation count. Should be 1 (deduped via idempotencyKey). */
  readonly toolInvocations: number
  /**
   * True if codec received `permission-response` kind on adapter.send —
   * proves the PermissionRoundtripWorkflow's auto-relay reached the
   * session body which then forwarded to the codec.
   */
  readonly codecSawPermissionResponse: boolean
  /**
   * True if codec received `tool-result` kind on adapter.send — proves
   * ToolDispatchWorkflow's auto-relay reached the session body.
   */
  readonly codecSawToolResult: boolean
}

const T = {
  sessionStart: "unified.session.start",
  sessionSendInput: "unified.session.send_input",
  sessionAwaitTerminal: "unified.session.await_terminal",
  permissionRespond: "unified.permission.respond",
} as const

export interface ProductionFlowUrls {
  readonly engineStreamUrl: string
  readonly unifiedTableStreamUrl: string
  readonly signalTableStreamUrl: string
  readonly outputTableStreamUrl: string
}

export const productionFlowUrlsFor = (
  base: { readonly durableStreamsBaseUrl: string; readonly namespace: string },
  runId: string,
): ProductionFlowUrls => ({
  engineStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow.engine`,
  ),
  unifiedTableStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow.unified`,
  ),
  signalTableStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow.signals`,
  ),
  outputTableStreamUrl: durableStreamUrl(
    base.durableStreamsBaseUrl,
    `${base.namespace}.ukv.${runId}.production-flow.output`,
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

export const productionFlowScenario = (
  urls: ProductionFlowUrls,
): Effect.Effect<ProductionFlowResult, unknown> =>
  Effect.gen(function*() {
    const { layer: fakeCodecLayer, probe } = yield* buildFakeCodecAdapter()
    const toolExecutor: ToolExecutor = yield* makeToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      (p) => JSON.stringify({ tool: p.toolName, echoed: JSON.parse(p.inputJson) }),
    )

    // Shared substrate — built once, used by everyone.
    const substrateLayer = Layer.mergeAll(
      tableLayer(UnifiedTable, urls.unifiedTableStreamUrl),
      tableLayer(SignalTable, urls.signalTableStreamUrl),
      tableLayer(RuntimeOutputTable, urls.outputTableStreamUrl),
    )

    // Engine sits one tier above the substrate tables.
    const engineLayer = DurableStreamsWorkflowEngine.layer({
      streamUrl: urls.engineStreamUrl,
    })

    // Workflow + observer + adapter layers, all running on top of the
    // shared substrate. RuntimeContextSessionWorkflowLayer requires the
    // adapter; fakeCodecLayer satisfies that.
    const upperLayers = Layer.mergeAll(
      RuntimeContextSessionWorkflowLayer.pipe(Layer.provide(fakeCodecLayer)),
      buildPermissionRoundtripLayer(),
      buildToolDispatchLayer(toolExecutor),
      buildScheduledPromptLayer(),
      buildWebhookFactObserverLayer(),
      buildPeerEventObserverLayer(),
      JournalObserverLive,
      HostPlaneChannelRouterLive,
    )

    const generationLayer = upperLayers.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(substrateLayer),
    )

    return yield* (Effect.scoped(
      Effect.gen(function*() {
        // Recovery sweep (analogous to runGeneration's behavior).
        const engineTable = yield* WorkflowEngineTable
        const signals = yield* SignalTable
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

        const contextId = "ctx-production-e2e"
        const attempt = 1

        // 1. Start the session. Workflow body parks awaiting first signal.
        const session = yield* call<SessionHandle>(T.sessionStart, { contextId, attempt })

        // 2. Send the prompt. Body wakes, forwards to codec.send. Codec
        //    writes a ToolUse row. JournalObserver picks it up, fires
        //    ToolDispatchWorkflow. ToolDispatchWorkflow executes the
        //    tool then auto-relays a tool-result signal back to the
        //    session body. Body wakes, forwards tool-result to codec.
        //    Codec writes a PermissionRequest row. JournalObserver
        //    fires PermissionRoundtripWorkflow, which parks.
        yield* send<EventOffset>(T.sessionSendInput, {
          session,
          inputId: "prompt-1",
          kind: "prompt",
          payloadJson: JSON.stringify({ text: "hello" }),
        })

        // 3. Give the chain time to settle (codec writes → observer
        //    fires → workflow auto-relays → session consumes → codec
        //    writes again → observer fires → workflow parks).
        yield* Effect.sleep("400 millis")

        // 4. Respond to the permission. The workflow's awaitSignal
        //    resolves, then its terminal Activity auto-relays the
        //    decision back to the session as a permission-response
        //    input. Body wakes, forwards to codec.
        const permissionRequestId = `perm-fake-${contextId}-${attempt}`
        const permExecId = yield* PermissionRoundtripWorkflow.executionId({
          contextId,
          attempt,
          permissionRequestId,
          toolUseId: `tu-fake-${contextId}-${attempt}`,
        })
        yield* send<EventOffset>(T.permissionRespond, {
          handle: {
            contextId,
            attempt,
            permissionRequestId,
            toolUseId: `tu-fake-${contextId}-${attempt}`,
            executionId: permExecId,
          },
          decision: "allow",
        })

        yield* Effect.sleep("400 millis")

        // 5. Send terminal so the session body returns.
        yield* send<EventOffset>(T.sessionSendInput, {
          session,
          inputId: "terminal",
          kind: "terminal",
          payloadJson: JSON.stringify({ reason: "done" }),
        })

        // 6. Await the session's terminal.
        const sessionResult = yield* call<{
          readonly contextId: string
          readonly attempt: number
          readonly inputsConsumed: number
          readonly reachedTerminal: boolean
        }>(T.sessionAwaitTerminal, session)

        const codecSnapshot = yield* probe.snapshot
        const codecSends = codecSnapshot.log.filter((e) => e.op === "send")
        const codecDeregs = codecSnapshot.log.filter((e) => e.op === "deregister")
        const sawPermissionResponse = codecSends.some(
          (e) => e.op === "send" && e.kind === "permission-response",
        )
        const sawToolResult = codecSends.some(
          (e) => e.op === "send" && e.kind === "tool-result",
        )
        const toolInvocations = yield* Ref.get(toolExecutor.state.invocationCount)

        return {
          sessionTerminal: sessionResult.reachedTerminal,
          sessionInputsConsumed: sessionResult.inputsConsumed,
          codecSendCount: codecSends.length,
          codecDeregisterCount: codecDeregs.length,
          toolInvocations,
          codecSawPermissionResponse: sawPermissionResponse,
          codecSawToolResult: sawToolResult,
        } satisfies ProductionFlowResult
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
    ) as Effect.Effect<ProductionFlowResult, unknown, never>)
  })

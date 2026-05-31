/**
 * Production-shaped scenarios driven from the standard Firegrid
 * client SDK. The driver imports `Firegrid` from
 * `@firegrid/client-sdk` and uses `firegrid.channels.call/send` —
 * exactly the surface a real production consumer uses.
 *
 * Our channels are registered via `FiregridConfig.channels`, which is
 * the standard SDK extension point. The Firegrid client's
 * `channels.call/send` dispatches against this array, decodes the
 * payload against the channel's request schema, and invokes
 * `channel.binding.{call,append}` — which is the same signal-based
 * subscriber path the router-based scenarios exercise. Two dispatch
 * paths, one set of bindings, one signal subscriber surface.
 *
 * The trace evidence under this driver is what production would
 * emit: `firegrid.client.channels.call` / `firegrid.client.channels.send`
 * spans from the SDK boundary, plus the underlying
 * `firegrid.unified.signal.send` / subscriber body spans.
 *
 * Phase-2 cutover readiness: when the seven specialized Firegrid Tags
 * are rebound to `DurableEventChannel<P>` (per the SDD), the named
 * methods (`firegrid.prompt`, `firegrid.permissions.respond`, etc.)
 * will route to the same signal-based bindings — no scenario rewrite
 * needed.
 */

import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client-sdk/firegrid"
import type { ChannelRegistration } from "@firegrid/protocol/channels"
import { WorkflowEngine } from "@effect/workflow"
import { Effect, Layer, Ref } from "effect"
import { makeChannels, type PermissionHandle, type SessionHandle } from "./channels.ts"
import type { EventOffset } from "./durable-event-channel.ts"
import {
  SignalTable,
  type WorkflowCatalog,
} from "./signal.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  makeToolExecutor,
  PermissionRoundtripWorkflow,
  type ToolExecutor,
  ToolDispatchWorkflow,
} from "./subscribers/permission-and-tool.ts"
import {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  type RuntimeContextRecorder,
  RuntimeContextSessionWorkflow,
} from "./subscribers/runtime-context.ts"
import {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
  buildWebhookFactObserverLayer,
  PeerEventObserverWorkflow,
  ScheduledPromptWorkflow,
  WebhookFactObserverWorkflow,
} from "./subscribers/scheduled-webhook-peer.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "./substrate.ts"
import { UnifiedTable } from "./tables.ts"

// ── Helpers ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()
const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
const hmacSign = (secret: string, rawBody: Uint8Array): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      bytesToArrayBuffer(encoder.encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await globalThis.crypto.subtle.sign("HMAC", key, bytesToArrayBuffer(rawBody))
    return bytesToHex(new Uint8Array(digest))
  })

const fullCatalog: WorkflowCatalog = makeCatalog([
  RuntimeContextSessionWorkflow,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
  ScheduledPromptWorkflow,
  WebhookFactObserverWorkflow,
  PeerEventObserverWorkflow,
])

const T = {
  sessionStart: "unified.session.start",
  sessionSendInput: "unified.session.send_input",
  sessionAwaitTerminal: "unified.session.await_terminal",
  permissionOpen: "unified.permission.open",
  permissionRespond: "unified.permission.respond",
  permissionAwaitDecision: "unified.permission.await_decision",
  toolDispatch: "unified.tool.dispatch",
  schedulePrompt: "unified.schedule.prompt",
  webhookIngest: "unified.webhook.ingest",
  webhookObserverStart: "unified.webhook.observer.start",
  webhookObserverAwait: "unified.webhook.observer.await",
  peerEmit: "unified.peer.emit",
  peerObserverStart: "unified.peer.observer.start",
  peerObserverAwait: "unified.peer.observer.await",
} as const

// Derive base URL from a stream URL. `durableStreamUrl(base, name)`
// encodes to `${base}/v1/stream/${encodeURIComponent(name)}` — strip
// the `/v1/stream/...` suffix to recover `${base}`.
const STREAM_PATH_INFIX = "/v1/stream/"
const baseUrlOf = (streamUrl: string): string => {
  const idx = streamUrl.lastIndexOf(STREAM_PATH_INFIX)
  return idx === -1 ? streamUrl : streamUrl.slice(0, idx)
}

/**
 * Build a Firegrid client Layer with our channels registered via
 * `FiregridConfig.channels`. The Firegrid client SDK's
 * `channels.call/send/waitFor` then dispatches against these
 * registrations — the same surface a production consumer uses.
 *
 * FiregridStandaloneLive provides `RuntimeControlPlaneTable` from
 * baseUrl + namespace. Our scenario doesn't use the standard named
 * methods (`firegrid.prompt`, `firegrid.permissions.respond`), so the
 * control-plane table is constructed but unused. Phase-2 cutover
 * makes the named methods route through the unified bindings too;
 * no scenario change.
 */
const buildFiregridClientLayer = (
  baseUrl: string,
  fgNamespace: string,
) =>
  Effect.gen(function*() {
    const signals = yield* SignalTable
    const unified = yield* UnifiedTable
    const engine = yield* WorkflowEngine.WorkflowEngine
    const channels = Object.values(
      makeChannels(signals, unified, engine),
    ) as ReadonlyArray<ChannelRegistration>
    return FiregridStandaloneLive.pipe(
      Layer.provide(
        Layer.succeed(FiregridConfig, {
          durableStreamsBaseUrl: baseUrl,
          namespace: fgNamespace,
          channels,
        }),
      ),
    )
  })

// ── End-to-end via Firegrid client SDK ──────────────────────────────────────

export interface FiregridClientE2EResult {
  readonly sessionInputsConsumed: number
  readonly sessionTerminal: boolean
  readonly toolResultJson: string
  readonly permissionDecision: "allow" | "deny" | "cancelled"
  readonly scheduleFiredAt: string
  readonly webhookOffset: string
  readonly webhookObservationEventType: string
  readonly peerOffset: string
  readonly peerObservationName: string
  readonly toolInvocations: number
  readonly recorderSpawns: number
  readonly recorderSends: number
}

export const endToEndViaFiregridClient = (
  urls: GenerationUrls,
  fgNamespace: string,
): Effect.Effect<FiregridClientE2EResult, unknown> =>
  Effect.gen(function*() {
    const recorder = yield* makeRuntimeContextRecorder()
    const toolExecutor: ToolExecutor = yield* makeToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      (p) => JSON.stringify({ tool: p.toolName, echoed: JSON.parse(p.inputJson) }),
    )
    return yield* runGeneration(
      {
        urls,
        workflowLayers: [
          buildRuntimeContextSessionLayer(recorder),
          buildPermissionRoundtripLayer(),
          buildToolDispatchLayer(toolExecutor),
          buildScheduledPromptLayer(),
          buildWebhookFactObserverLayer(),
          buildPeerEventObserverLayer(),
        ],
        catalog: fullCatalog,
      },
      () =>
        Effect.gen(function*() {
          const baseUrl = baseUrlOf(urls.engineStreamUrl)
          const firegridLayer = yield* buildFiregridClientLayer(baseUrl, fgNamespace)
          return yield* driverBody(recorder, toolExecutor).pipe(
            Effect.provide(firegridLayer),
          ) as Effect.Effect<
            FiregridClientE2EResult,
            unknown,
            WorkflowEngine.WorkflowEngine
          >
        }) as Effect.Effect<
          FiregridClientE2EResult,
          unknown,
          WorkflowEngine.WorkflowEngine
        >,
    )
  })

/**
 * The actual driver — written as a real production consumer would
 * write it. Imports `Firegrid` from `@firegrid/client-sdk`, gets the
 * client from context, calls product methods through the standard
 * SDK surface. Nothing simulation-specific in the dispatch flow.
 */
const driverBody = (
  recorder: RuntimeContextRecorder,
  toolExecutor: ToolExecutor,
): Effect.Effect<FiregridClientE2EResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const contextId = "ctx-firegrid-e2e"
    const attempt = 1

    // ── 1. Start session ──────────────────────────────────────────
    const session = (yield* firegrid.channels.call(
      T.sessionStart,
      { contextId, attempt },
    )) as SessionHandle

    // ── 2. Send a prompt ──────────────────────────────────────────
    yield* Effect.sleep("50 millis")
    yield* firegrid.channels.send(T.sessionSendInput, {
      session, inputId: "prompt-1", kind: "prompt",
      payloadJson: JSON.stringify({ text: "hello" }),
    })

    // ── 3. Tool dispatch ──────────────────────────────────────────
    const toolUseId = "tu-firegrid-1"
    const toolResult = (yield* firegrid.channels.call(
      T.toolDispatch,
      { contextId, toolUseId, toolName: "echo", inputJson: JSON.stringify({ word: "hi" }) },
    )) as { readonly toolUseId: string; readonly resultJson: string }
    const toolInvocations = yield* Ref.get(toolExecutor.state.invocationCount)

    // ── 4. Permission roundtrip ───────────────────────────────────
    const permission = (yield* firegrid.channels.call(
      T.permissionOpen,
      { contextId, permissionRequestId: "perm-firegrid-1", toolUseId },
    )) as PermissionHandle
    yield* Effect.sleep("100 millis")
    yield* firegrid.channels.send(T.permissionRespond, {
      handle: permission, decision: "allow",
    })
    const decision = (yield* firegrid.channels.call(
      T.permissionAwaitDecision,
      permission,
    )) as { readonly permissionRequestId: string; readonly decision: "allow" | "deny" | "cancelled" }

    // ── 5. Permission response feeds back to session ──────────────
    yield* firegrid.channels.send(T.sessionSendInput, {
      session, inputId: "perm-response-1", kind: "permission-response",
      payloadJson: JSON.stringify({ permissionRequestId: "perm-firegrid-1", decision: decision.decision }),
    })

    // ── 6. Scheduled prompt ───────────────────────────────────────
    const schedResult = (yield* firegrid.channels.call(
      T.schedulePrompt,
      {
        contextId, scheduleId: "sched-firegrid-1",
        fireAtMs: Date.now() + 100,
        payloadJson: JSON.stringify({ self_prompt: "wake" }),
      },
    )) as { readonly scheduleId: string; readonly firedAt: string }

    // ── 7. Webhook ingest + observer ──────────────────────────────
    const webhookObserver = (yield* firegrid.channels.call(
      T.webhookObserverStart,
      { source: "linear", deliveryId: "delivery-fg-1", observerId: "obs-fg-1" },
    )) as { readonly source: string; readonly deliveryId: string; readonly observerId: string; readonly executionId: string }
    yield* Effect.sleep("50 millis")
    const webhookSecret = "firegrid-e2e-secret"
    const webhookBody = encoder.encode(JSON.stringify({
      action: "create", type: "Issue", webhookId: "delivery-fg-1",
    }))
    const webhookSig = yield* hmacSign(webhookSecret, webhookBody)
    const webhookOffset = (yield* firegrid.channels.send(T.webhookIngest, {
      verify: {
        source: "linear", deliveryId: "delivery-fg-1",
        eventType: "Issue.create",
        secret: webhookSecret, rawBody: webhookBody,
        receivedSignatureHex: webhookSig,
      },
      armObserver: webhookObserver,
    })) as EventOffset
    const webhookObservation = (yield* firegrid.channels.call(
      T.webhookObserverAwait,
      webhookObserver,
    )) as { readonly source: string; readonly factKey: string; readonly eventType: string }

    // ── 8. Peer event emit + observer ─────────────────────────────
    const peerObserver = (yield* firegrid.channels.call(
      T.peerObserverStart,
      { name: "plan.ready", eventId: "ev-fg-1", observerId: "peer-obs-fg-1" },
    )) as { readonly name: string; readonly eventId: string; readonly observerId: string; readonly executionId: string }
    yield* Effect.sleep("50 millis")
    const peerOffset = (yield* firegrid.channels.send(T.peerEmit, {
      payload: {
        name: "plan.ready", eventId: "ev-fg-1",
        emitterContextId: contextId,
        payloadJson: JSON.stringify({ phase: "done" }),
      },
      armObserver: peerObserver,
    })) as EventOffset
    const peerObservation = (yield* firegrid.channels.call(
      T.peerObserverAwait,
      peerObserver,
    )) as { readonly name: string; readonly factKey: string }

    // ── 9. Terminal ───────────────────────────────────────────────
    yield* firegrid.channels.send(T.sessionSendInput, {
      session, inputId: "terminal", kind: "terminal",
      payloadJson: JSON.stringify({ reason: "done" }),
    })
    const sessionResult = (yield* firegrid.channels.call(
      T.sessionAwaitTerminal,
      session,
    )) as { readonly inputsConsumed: number; readonly reachedTerminal: boolean }

    const recorderSnapshot = yield* recorder.snapshot
    return {
      sessionInputsConsumed: sessionResult.inputsConsumed,
      sessionTerminal: sessionResult.reachedTerminal,
      toolResultJson: toolResult.resultJson,
      permissionDecision: decision.decision,
      scheduleFiredAt: schedResult.firedAt,
      webhookOffset: webhookOffset.offset,
      webhookObservationEventType: webhookObservation.eventType,
      peerOffset: peerOffset.offset,
      peerObservationName: peerObservation.name,
      toolInvocations,
      recorderSpawns: recorderSnapshot.spawns.length,
      recorderSends: recorderSnapshot.sends.length,
    } satisfies FiregridClientE2EResult
  })

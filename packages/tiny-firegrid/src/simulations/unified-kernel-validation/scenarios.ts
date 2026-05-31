/**
 * Runtime scenarios driven through the `UnifiedChannels` product
 * surface. Each scenario is a thin recipe: open one or more channels,
 * exchange messages, observe outcomes through the channel's response
 * shape. No scenario reaches into SignalTable / UnifiedTable / engine
 * tables directly (with the deliberate exception of the crash-
 * recovery and bounded-ownership scenarios, which probe the
 * primitive's recovery boundary).
 *
 *   - endToEndScenario: walks the full product surface in one driver.
 *   - crashRecoveryScenario: gen-1 starts a session and records a
 *     terminal signal without resuming; gen-2 rebuilds the host
 *     generation and awaits the session terminal — recovery fires.
 *   - toolIdempotencyScenario: same toolUseId across concurrent
 *     `toolDispatch` channel calls invokes the executor once.
 *   - webhookBadHmacScenario: webhook ingest with an invalid HMAC
 *     returns `_tag: "Rejected"`.
 *   - boundedOwnershipScenario: a `DurableDeferred.await`-only
 *     workflow stays parked across signal recovery (signal recovery
 *     replays only its own signal log, never a generic sweep).
 */

import { DurableDeferred, Workflow, type WorkflowEngine } from "@effect/workflow"
import { Cause, Effect, Option, Ref, Schema } from "effect"
import { VerifiedWebhookError } from "./subscribers/scheduled-webhook-peer.ts"
import type { UnifiedChannelsShape } from "./channels.ts"
import { UnifiedChannels, UnifiedChannelsLive } from "./channels.ts"
import {
  recordSignal,
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
import type { UnifiedTable } from "./tables.ts"

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

/**
 * Run a scenario body inside a fresh generation with all subscribers
 * registered and `UnifiedChannels` available in context. The recorder
 * and tool executor are exposed to the body for observability —
 * production code wouldn't have them, but scenarios occasionally need
 * to assert "the host-side side effect ran N times."
 */
const runChannelScenario = <A>(
  urls: GenerationUrls,
  body: (env: {
    readonly channels: UnifiedChannelsShape
    readonly recorder: RuntimeContextRecorder
    readonly toolExecutor: ToolExecutor
  }) => Effect.Effect<A, unknown, UnifiedChannels | SignalTable | UnifiedTable>,
): Effect.Effect<A, unknown> =>
  Effect.gen(function*() {
    const recorder = yield* makeRuntimeContextRecorder()
    const toolExecutor = yield* makeToolExecutor(
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
          const channels = yield* UnifiedChannels
          return yield* body({ channels, recorder, toolExecutor })
        }).pipe(
          Effect.provide(UnifiedChannelsLive),
        ) as Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
    )
  })

// ── End-to-end scenario ─────────────────────────────────────────────────────

export interface EndToEndResult {
  readonly sessionInputsConsumed: number
  readonly sessionTerminal: boolean
  readonly toolResultJson: string
  readonly permissionDecision: "allow" | "deny" | "cancelled"
  readonly permissionRequestRowSeen: boolean
  readonly scheduleFiredAt: string
  readonly webhookOffset: string
  readonly webhookDeduplicated: boolean
  readonly webhookObservationEventType: string
  readonly peerOffset: string
  readonly peerDeduplicated: boolean
  readonly peerObservationName: string
  readonly toolInvocations: number
  readonly recorderSpawns: number
  readonly recorderSends: number
}

export const endToEndScenario = (
  urls: GenerationUrls,
): Effect.Effect<EndToEndResult, unknown> =>
  runChannelScenario(urls, ({ channels, recorder, toolExecutor }) =>
    Effect.gen(function*() {
      const contextId = "ctx-e2e"
      const attempt = 1
      const session = yield* channels.sessionStart.binding.call({ contextId, attempt })

      yield* Effect.sleep("50 millis")
      yield* channels.sessionSendInput.binding.append({
        session, inputId: "prompt-1", kind: "prompt",
        payloadJson: JSON.stringify({ text: "hello" }),
      })

      const toolUseId = "tu-1"
      const toolResult = yield* channels.toolDispatch.binding.call({
        contextId, toolUseId, toolName: "echo",
        inputJson: JSON.stringify({ word: "hi" }),
      })
      const toolInvocations = yield* Ref.get(toolExecutor.state.invocationCount)

      const permission = yield* channels.permissionOpen.binding.call({
        contextId, permissionRequestId: "perm-1", toolUseId,
      })
      yield* Effect.sleep("100 millis")
      const requestRow = yield* channels.permissionReadRequest.binding.call({
        contextId, permissionRequestId: "perm-1",
      })
      yield* channels.permissionRespond.binding.append({
        handle: permission, decision: "allow",
      })
      const decision = yield* channels.permissionAwaitDecision.binding.call(permission)

      yield* channels.sessionSendInput.binding.append({
        session, inputId: "perm-response-1", kind: "permission-response",
        payloadJson: JSON.stringify({
          permissionRequestId: "perm-1", decision: decision.decision,
        }),
      })

      const schedResult = yield* channels.schedulePrompt.binding.call({
        contextId, scheduleId: "sched-1",
        fireAtMs: Date.now() + 100,
        payloadJson: JSON.stringify({ self_prompt: "wake" }),
      })

      // Webhook: start observer, then ingest with arming.
      const webhookObserver = yield* channels.webhookObserverStart.binding.call({
        source: "linear", deliveryId: "delivery-1", observerId: "obs-1",
      })
      yield* Effect.sleep("50 millis")
      const webhookSecret = "e2e-webhook-secret"
      const webhookBody = encoder.encode(JSON.stringify({
        action: "create", type: "Issue", webhookId: "delivery-1",
      }))
      const webhookSig = yield* hmacSign(webhookSecret, webhookBody)
      const webhookOutcome = yield* channels.webhookIngest.binding.append({
        verify: {
          source: "linear", deliveryId: "delivery-1",
          eventType: "Issue.create",
          secret: webhookSecret, rawBody: webhookBody,
          receivedSignatureHex: webhookSig,
        },
        armObserver: webhookObserver,
      })
      const webhookObservation =
        yield* channels.webhookObserverAwait.binding.call(webhookObserver)

      // Peer event: start observer, then emit with arming.
      const peerObserver = yield* channels.peerObserverStart.binding.call({
        name: "plan.ready", eventId: "ev-1", observerId: "peer-obs-1",
      })
      yield* Effect.sleep("50 millis")
      const peerOutcome = yield* channels.peerEmit.binding.append({
        payload: {
          name: "plan.ready", eventId: "ev-1",
          emitterContextId: contextId,
          payloadJson: JSON.stringify({ phase: "done" }),
        },
        armObserver: peerObserver,
      })
      const peerObservation = yield* channels.peerObserverAwait.binding.call(peerObserver)

      yield* channels.sessionSendInput.binding.append({
        session, inputId: "terminal", kind: "terminal",
        payloadJson: JSON.stringify({ reason: "done" }),
      })
      const sessionResult = yield* channels.sessionAwaitTerminal.binding.call(session)
      const recorderSnapshot = yield* recorder.snapshot

      return {
        sessionInputsConsumed: sessionResult.inputsConsumed,
        sessionTerminal: sessionResult.reachedTerminal,
        toolResultJson: toolResult.resultJson,
        permissionDecision: decision.decision,
        permissionRequestRowSeen: requestRow !== null,
        scheduleFiredAt: schedResult.firedAt,
        webhookOffset: webhookOutcome.offset,
        webhookDeduplicated: webhookOutcome.deduplicated ?? false,
        webhookObservationEventType: webhookObservation.eventType,
        peerOffset: peerOutcome.offset,
        peerDeduplicated: peerOutcome.deduplicated ?? false,
        peerObservationName: peerObservation.name,
        toolInvocations,
        recorderSpawns: recorderSnapshot.spawns.length,
        recorderSends: recorderSnapshot.sends.length,
      } satisfies EndToEndResult
    }))

// ── Crash recovery scenario ─────────────────────────────────────────────────

export interface CrashRecoveryResult {
  readonly gen2InputsConsumed: number
  readonly gen2ReachedTerminal: boolean
}

export const crashRecoveryScenario = (
  urls: GenerationUrls,
): Effect.Effect<CrashRecoveryResult, unknown> =>
  Effect.gen(function*() {
    const contextId = "ctx-crash"
    const attempt = 1
    let sessionExecutionId = ""

    // Gen-1: start the session via the channel, then simulate
    // "producer recorded the terminal signal but crashed before
    // engine.resume" — recordSignal writes the signal row without
    // arming. Generation closes; signal recovery must close the gap.
    yield* runChannelScenario(urls, ({ channels }) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Effect.gen(function*() {
        const session = yield* channels.sessionStart.binding.call({ contextId, attempt })
        sessionExecutionId = session.executionId
        const signals = yield* SignalTable
        yield* recordSignal({
          signals,
          workflowName: RuntimeContextSessionWorkflow.name,
          executionId: session.executionId,
          name: "terminal",
          write: () => Effect.void,
          value: {
            kind: "terminal" as const,
            payloadJson: JSON.stringify({ reason: "via recovery" }),
          },
          serializeValue: (v) => JSON.stringify(v),
        })
        yield* Effect.sleep("50 millis")
      }))

    // Gen-2: rebuild. Driver awaits the session terminal through the
    // channel; the only way it can return reachedTerminal=true is if
    // signal recovery armed the body from the gen-1 terminal signal.
    const result = yield* runChannelScenario(urls, ({ channels }) =>
      channels.sessionAwaitTerminal.binding.call({
        contextId, attempt, executionId: sessionExecutionId,
      }))

    return {
      gen2InputsConsumed: result.inputsConsumed,
      gen2ReachedTerminal: result.reachedTerminal,
    } satisfies CrashRecoveryResult
  })

// ── Tool dispatch idempotency scenario ──────────────────────────────────────

export interface ToolIdempotencyResult {
  readonly executorInvocations: number
  readonly bothResultsMatch: boolean
}

export const toolIdempotencyScenario = (
  urls: GenerationUrls,
): Effect.Effect<ToolIdempotencyResult, unknown> =>
  runChannelScenario(urls, ({ channels, toolExecutor }) =>
    Effect.gen(function*() {
      const payload = {
        contextId: "ctx-tool-idem",
        toolUseId: "tool-once-1",
        toolName: "echo",
        inputJson: JSON.stringify({ a: 1 }),
      }
      const [r1, r2] = yield* Effect.all(
        [
          channels.toolDispatch.binding.call(payload),
          channels.toolDispatch.binding.call(payload),
        ],
        { concurrency: 2 },
      ).pipe(Effect.orDie)
      const executorInvocations = yield* Ref.get(toolExecutor.state.invocationCount)
      return {
        executorInvocations,
        bothResultsMatch: r1.resultJson === r2.resultJson,
      } satisfies ToolIdempotencyResult
    }))

// ── Webhook bad-HMAC rejection scenario ─────────────────────────────────────

export interface WebhookBadHmacResult {
  readonly rejected: boolean
  readonly errorOp: string | undefined
}

export const webhookBadHmacScenario = (
  urls: GenerationUrls,
): Effect.Effect<WebhookBadHmacResult, unknown> =>
  runChannelScenario(urls, ({ channels }) =>
    Effect.gen(function*() {
      const rawBody = encoder.encode(JSON.stringify({ action: "create" }))
      const wrongSig = yield* hmacSign("WRONG-secret", rawBody)
      // Under the unified shape, signature failure is a transport-level
      // failure on the append — caller observes via Effect.exit/either,
      // not a tagged response field. The channel append fails with a
      // `VerifiedWebhookError { op: "signature/invalid" }`.
      const exit = yield* Effect.exit(channels.webhookIngest.binding.append({
        verify: {
          source: "linear", deliveryId: "delivery-bad",
          eventType: "Issue.create",
          secret: "real-secret",
          rawBody,
          receivedSignatureHex: wrongSig,
        },
      }))
      if (exit._tag === "Success") {
        return { rejected: false, errorOp: undefined }
      }
      const failure = Cause.failureOption(exit.cause)
      const errorOp = Option.match(failure, {
        onNone: () => undefined,
        onSome: (err) =>
          err instanceof VerifiedWebhookError ? err.op : undefined,
      })
      return {
        rejected: true,
        errorOp,
      } satisfies WebhookBadHmacResult
    }))

// ── Bounded ownership scenario (signal-level, not via channels) ─────────────

const DeferredGate = DurableDeferred.make("scenario-bounded-gate", {
  success: Schema.String,
})

const DeferredOnlyWorkflow = Workflow.make({
  name: "scenario-bounded-deferred",
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  idempotencyKey: (p) => p.id,
})

const buildDeferredOnlyLayer = () =>
  DeferredOnlyWorkflow.toLayer(() => DurableDeferred.await(DeferredGate))

export interface BoundedOwnershipResult {
  readonly deferredStillParkedAfterRecovery: boolean
  readonly signalsReplayed: number
}

export const boundedOwnershipScenario = (
  urls: GenerationUrls,
): Effect.Effect<BoundedOwnershipResult, unknown> =>
  Effect.gen(function*() {
    let deferredExec = ""

    yield* runGeneration(
      {
        urls,
        workflowLayers: [buildDeferredOnlyLayer()],
        catalog: makeCatalog([DeferredOnlyWorkflow]),
      },
      () =>
        Effect.gen(function*() {
          yield* Effect.exit(
            DeferredOnlyWorkflow.execute({ id: "bounded-1" }).pipe(
              Effect.timeoutOption("100 millis"),
            ),
          )
          deferredExec = yield* DeferredOnlyWorkflow.executionId({ id: "bounded-1" })
        }) as Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine>,
    )

    const observed = yield* runGeneration(
      {
        urls,
        workflowLayers: [buildDeferredOnlyLayer()],
        catalog: makeCatalog([DeferredOnlyWorkflow]),
      },
      (services) =>
        Effect.gen(function*() {
          const exec = yield* services.engineTable.executions.get(deferredExec).pipe(
            Effect.map(Option.getOrUndefined),
          )
          return {
            stillParked: exec?.finalResult === undefined,
            replayed: services.replayed,
          }
        }),
    )

    return {
      deferredStillParkedAfterRecovery: observed.stillParked,
      signalsReplayed: observed.replayed,
    } satisfies BoundedOwnershipResult
  })

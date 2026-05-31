/**
 * Runtime scenarios driven through the standard `HostPlaneChannelRouter`
 * target-string dispatch surface (per
 * `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION`, phase 1 increment).
 *
 * The driver-side surface is identical to what production Firegrid
 * clients use over durable streams: `router.dispatch({ target, verb,
 * payload })`. This buys us the production `firegrid.channel.dispatch`
 * span automatically (target + direction + verb attributes), which
 * the gate predicates can assert against without any per-scenario
 * instrumentation.
 *
 * `DurableEventChannel<P>` is dispatched with `verb: "send"`;
 * `CallableChannel<Req, Res>` with `verb: "call"`. The router decodes
 * payloads against each channel's request schema at the dispatch
 * boundary, just as it does in production.
 *
 * Scenarios:
 *   - endToEndScenario: walks the full product surface via router.
 *   - crashRecoveryScenario: gen-1 records a terminal signal without
 *     resuming; gen-2 rebuilds and awaits the session terminal
 *     through the router.
 *   - toolIdempotencyScenario: same toolUseId across concurrent
 *     `unified.tool.dispatch` calls invokes the executor once.
 *   - webhookBadHmacScenario: invalid HMAC fails the
 *     `unified.webhook.ingest` dispatch via `VerifiedWebhookError`.
 *   - boundedOwnershipScenario: signal recovery is bounded to its
 *     own log (signal-level, not via channels).
 */

import { DurableDeferred, Workflow, type WorkflowEngine } from "@effect/workflow"
import {
  HostPlaneChannelRouter,
  type RuntimeChannelRouterService,
} from "@firegrid/runtime/channels"
import { Cause, Effect, Option, Ref, Schema } from "effect"
import {
  HostPlaneChannelRouterLive,
  type PermissionHandle,
  type SessionHandle,
} from "./channels.ts"
import type { EventOffset } from "./durable-event-channel.ts"
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
  VerifiedWebhookError,
  WebhookFactObserverWorkflow,
} from "./subscribers/scheduled-webhook-peer.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "./substrate.ts"

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
 * Typed router-dispatch helpers. The cast on the dispatch result
 * mirrors the Firegrid client SDK shape (`channels.call(target, payload)`
 * returns `Effect<unknown, FiregridChannelError>` — caller widens
 * to the expected response shape). The router has already decoded
 * the payload against the channel's request schema.
 */
interface DispatchHelpers {
  readonly router: RuntimeChannelRouterService
  readonly call: <T>(target: string, payload: unknown) => Effect.Effect<T, unknown>
  readonly send: <T>(target: string, payload: unknown) => Effect.Effect<T, unknown>
}

const makeDispatchHelpers = (router: RuntimeChannelRouterService): DispatchHelpers => ({
  router,
  call: <T>(target: string, payload: unknown) =>
    router.dispatch({ target, verb: "call", payload }).pipe(
      Effect.map((r) => r as T),
    ) as Effect.Effect<T, unknown>,
  send: <T>(target: string, payload: unknown) =>
    router.dispatch({ target, verb: "send", payload }).pipe(
      Effect.map((r) => r as T),
    ) as Effect.Effect<T, unknown>,
})

const runRouterScenario = <A>(
  urls: GenerationUrls,
  body: (env: DispatchHelpers & {
    readonly recorder: RuntimeContextRecorder
    readonly toolExecutor: ToolExecutor
  }) => Effect.Effect<A, unknown, HostPlaneChannelRouter | SignalTable>,
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
          const router = yield* HostPlaneChannelRouter
          const helpers = makeDispatchHelpers(router)
          return yield* body({ ...helpers, recorder, toolExecutor })
        }).pipe(
          Effect.provide(HostPlaneChannelRouterLive),
        ) as Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>,
    )
  })

// ── Channel target catalog (single source of truth for dispatch) ────────────

const T = {
  sessionStart: "unified.session.start",
  sessionSendInput: "unified.session.send_input",
  sessionAwaitTerminal: "unified.session.await_terminal",
  permissionOpen: "unified.permission.open",
  permissionReadRequest: "unified.permission.read_request",
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
  runRouterScenario(urls, ({ call, send, recorder, toolExecutor }) =>
    Effect.gen(function*() {
      const contextId = "ctx-e2e"
      const attempt = 1
      const session = yield* call<SessionHandle>(T.sessionStart, { contextId, attempt })

      yield* Effect.sleep("50 millis")
      yield* send<EventOffset>(T.sessionSendInput, {
        session, inputId: "prompt-1", kind: "prompt",
        payloadJson: JSON.stringify({ text: "hello" }),
      })

      const toolUseId = "tu-1"
      const toolResult = yield* call<{ readonly toolUseId: string; readonly resultJson: string }>(
        T.toolDispatch,
        { contextId, toolUseId, toolName: "echo", inputJson: JSON.stringify({ word: "hi" }) },
      )
      const toolInvocations = yield* Ref.get(toolExecutor.state.invocationCount)

      const permission = yield* call<PermissionHandle>(T.permissionOpen, {
        contextId, permissionRequestId: "perm-1", toolUseId,
      })
      yield* Effect.sleep("100 millis")
      const requestRow = yield* call<{ readonly toolUseId: string } | null>(
        T.permissionReadRequest,
        { contextId, permissionRequestId: "perm-1" },
      )
      yield* send<EventOffset>(T.permissionRespond, {
        handle: permission, decision: "allow",
      })
      const decision = yield* call<{ readonly permissionRequestId: string; readonly decision: "allow" | "deny" | "cancelled" }>(
        T.permissionAwaitDecision,
        permission,
      )

      yield* send<EventOffset>(T.sessionSendInput, {
        session, inputId: "perm-response-1", kind: "permission-response",
        payloadJson: JSON.stringify({
          permissionRequestId: "perm-1", decision: decision.decision,
        }),
      })

      const schedResult = yield* call<{ readonly scheduleId: string; readonly firedAt: string }>(
        T.schedulePrompt,
        {
          contextId, scheduleId: "sched-1",
          fireAtMs: Date.now() + 100,
          payloadJson: JSON.stringify({ self_prompt: "wake" }),
        },
      )

      const webhookObserver = yield* call<{
        readonly source: string; readonly deliveryId: string;
        readonly observerId: string; readonly executionId: string
      }>(T.webhookObserverStart, {
        source: "linear", deliveryId: "delivery-1", observerId: "obs-1",
      })
      yield* Effect.sleep("50 millis")
      const webhookSecret = "e2e-webhook-secret"
      const webhookBody = encoder.encode(JSON.stringify({
        action: "create", type: "Issue", webhookId: "delivery-1",
      }))
      const webhookSig = yield* hmacSign(webhookSecret, webhookBody)
      const webhookOffset = yield* send<EventOffset>(T.webhookIngest, {
        verify: {
          source: "linear", deliveryId: "delivery-1",
          eventType: "Issue.create",
          secret: webhookSecret, rawBody: webhookBody,
          receivedSignatureHex: webhookSig,
        },
        armObserver: webhookObserver,
      })
      const webhookObservation = yield* call<{
        readonly source: string; readonly deliveryId: string;
        readonly factKey: string; readonly eventType: string
      }>(T.webhookObserverAwait, webhookObserver)

      const peerObserver = yield* call<{
        readonly name: string; readonly eventId: string;
        readonly observerId: string; readonly executionId: string
      }>(T.peerObserverStart, {
        name: "plan.ready", eventId: "ev-1", observerId: "peer-obs-1",
      })
      yield* Effect.sleep("50 millis")
      const peerOffset = yield* send<EventOffset>(T.peerEmit, {
        payload: {
          name: "plan.ready", eventId: "ev-1",
          emitterContextId: contextId,
          payloadJson: JSON.stringify({ phase: "done" }),
        },
        armObserver: peerObserver,
      })
      const peerObservation = yield* call<{
        readonly name: string; readonly eventId: string;
        readonly factKey: string; readonly emitterContextId: string
      }>(T.peerObserverAwait, peerObserver)

      yield* send<EventOffset>(T.sessionSendInput, {
        session, inputId: "terminal", kind: "terminal",
        payloadJson: JSON.stringify({ reason: "done" }),
      })
      const sessionResult = yield* call<{
        readonly contextId: string; readonly attempt: number;
        readonly inputsConsumed: number; readonly reachedTerminal: boolean
      }>(T.sessionAwaitTerminal, session)
      const recorderSnapshot = yield* recorder.snapshot

      return {
        sessionInputsConsumed: sessionResult.inputsConsumed,
        sessionTerminal: sessionResult.reachedTerminal,
        toolResultJson: toolResult.resultJson,
        permissionDecision: decision.decision,
        permissionRequestRowSeen: requestRow !== null,
        scheduleFiredAt: schedResult.firedAt,
        webhookOffset: webhookOffset.offset,
        webhookDeduplicated: webhookOffset.deduplicated ?? false,
        webhookObservationEventType: webhookObservation.eventType,
        peerOffset: peerOffset.offset,
        peerDeduplicated: peerOffset.deduplicated ?? false,
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

    yield* runRouterScenario(urls, ({ call }) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Effect.gen(function*() {
        const session = yield* call<SessionHandle>(T.sessionStart, { contextId, attempt })
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

    const result = yield* runRouterScenario(urls, ({ call }) =>
      call<{
        readonly inputsConsumed: number; readonly reachedTerminal: boolean
      }>(T.sessionAwaitTerminal, {
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
  runRouterScenario(urls, ({ call, toolExecutor }) =>
    Effect.gen(function*() {
      const payload = {
        contextId: "ctx-tool-idem",
        toolUseId: "tool-once-1",
        toolName: "echo",
        inputJson: JSON.stringify({ a: 1 }),
      }
      const [r1, r2] = yield* Effect.all(
        [
          call<{ readonly resultJson: string }>(T.toolDispatch, payload),
          call<{ readonly resultJson: string }>(T.toolDispatch, payload),
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
  runRouterScenario(urls, ({ send }) =>
    Effect.gen(function*() {
      const rawBody = encoder.encode(JSON.stringify({ action: "create" }))
      const wrongSig = yield* hmacSign("WRONG-secret", rawBody)
      // Under the unified shape, signature failure is a transport-level
      // failure on the dispatch — caller observes via Effect.exit/either,
      // not a tagged response field. The router wraps the channel
      // failure in `ChannelRouteInvocationFailed.cause`.
      const exit = yield* Effect.exit(send<EventOffset>(T.webhookIngest, {
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
      // The router wraps invocation failures as
      // `ChannelRouteInvocationFailed { cause }` — peel one layer.
      const findOp = (err: unknown): string | undefined => {
        if (err instanceof VerifiedWebhookError) return err.op
        if (typeof err === "object" && err !== null) {
          const obj = err as { readonly cause?: unknown }
          if (obj.cause !== undefined) return findOp(obj.cause)
        }
        return undefined
      }
      const errorOp = Option.match(failure, {
        onNone: () => undefined,
        onSome: findOp,
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

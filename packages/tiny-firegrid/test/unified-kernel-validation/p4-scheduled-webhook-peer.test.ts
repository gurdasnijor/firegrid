/**
 * P4 — Scheduled prompts + webhook + peer events + specialized observers.
 *
 * Four capabilities on the same kernel primitive:
 *
 *   - ScheduledPromptWorkflow: DurableClock.sleep wakes a body at a
 *     wall-clock instant, fires the scheduled prompt fact.
 *   - verifyAndIngestWebhook: HMAC verify + idempotent fact write +
 *     optional kernel arm. Linear/GitHub webhook ingest shape.
 *   - emitPeerEvent: peer-event row write keyed by (name, eventId);
 *     optional kernel arm.
 *   - Specialized observers (`WebhookFactObserverWorkflow`,
 *     `PeerEventObserverWorkflow`): each parks on a specific fact
 *     family by point-read; kernel arm wakes; returns the row.
 *
 * Each observer is specialized to its fact family. There is
 * deliberately no generic "wait_for any fact" workflow — that pattern
 * reconstructs the retired SourceCollections / RuntimeObservationSourceNames
 * registry shape.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
  buildWebhookFactObserverLayer,
  emitPeerEvent,
  PeerEventObserverWorkflow,
  ScheduledPromptWorkflow,
  verifyAndIngestWebhook,
  VerifiedWebhookError,
  WebhookFactObserverWorkflow,
} from "../../src/simulations/unified-kernel-validation/subscribers/scheduled-webhook-peer.ts"
import {
  scheduleKey,
  webhookFactKey,
} from "../../src/simulations/unified-kernel-validation/tables.ts"

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

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  signalTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.signals`),
})

const encoder = new TextEncoder()

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const hmacSign = async (secret: string, rawBody: Uint8Array): Promise<string> => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, bytesToArrayBuffer(rawBody))
  return bytesToHex(new Uint8Array(digest))
}

// ── 1. Scheduled prompt ─────────────────────────────────────────────────────

describe("P4.1 — ScheduledPromptWorkflow", () => {
  it("DurableClock fires the prompt after the delay; body returns firedAt; commitment row present", async () => {
    const ns = `p4-sched-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-sched"
    const scheduleId = "sched-1"
    const fireAtMs = Date.now() + 200 // short for the test

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildScheduledPromptLayer()],
          catalog: makeCatalog([ScheduledPromptWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const result = yield* (ScheduledPromptWorkflow.execute({
              contextId,
              scheduleId,
              fireAtMs,
              payloadJson: JSON.stringify({ self_prompt: "wake up" }),
            }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>)
            const scheduleRow = yield* services.unified.schedules.get(
              scheduleKey(contextId, scheduleId),
            ).pipe(Effect.map(Option.getOrUndefined))
            return {
              result: result as { readonly scheduleId: string; readonly firedAt: string },
              rowPresent: scheduleRow !== undefined,
            }
          }),
      ),
    )

    // Firing is determined by the workflow's executions.finalResult
    // (the body returned with a firedAt); the schedule row only holds
    // the UI-renderable commitment, no `status` lifecycle column.
    expect(outcome.rowPresent).toBe(true)
    /* eslint-disable @typescript-eslint/no-unsafe-member-access */
    expect(outcome.result.scheduleId).toBe(scheduleId)
    expect(outcome.result.firedAt).toBeDefined()
    /* eslint-enable @typescript-eslint/no-unsafe-member-access */
  }, 15_000)
})

// ── 2. Webhook ingest ───────────────────────────────────────────────────────

describe("P4.2 — verifyAndIngestWebhook", () => {
  it("verifies HMAC + writes a webhookFacts row + wakes a waiting observer", async () => {
    const ns = `p4-webhook-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const secret = "linear-test-secret"
    const source = "linear"
    const deliveryId = "delivery-42"
    const payload = JSON.stringify({ action: "create", type: "Issue", webhookId: deliveryId })
    const rawBody = encoder.encode(payload)
    const signature = await hmacSign(secret, rawBody)

    const observerId = `obs-${crypto.randomUUID()}`
    const factKey = webhookFactKey(source, deliveryId)

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildWebhookFactObserverLayer()],
          catalog: makeCatalog([WebhookFactObserverWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const executionId = yield* WebhookFactObserverWorkflow.executionId({
              source,
              deliveryId,
              observerId,
            })

            // Start the observer body parked.
            const fiber = yield* Effect.fork(
              WebhookFactObserverWorkflow.execute({
                source,
                deliveryId,
                observerId,
              }),
            )
            yield* Effect.sleep("100 millis")

            // Ingest the webhook (verifies + writes + arms).
            const ingestResult = yield* verifyAndIngestWebhook({
              unified: services.unified,
              verify: {
                source,
                deliveryId,
                eventType: "Issue.create",
                secret,
                rawBody,
                receivedSignatureHex: signature,
              },
              signalOptions: {
                signals: services.signals,
                workflow: WebhookFactObserverWorkflow,
                executionId,
              },
            })

            const exit = yield* fiber.await
            if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
            const observerOutcome = exit.value
            const factRow = yield* services.unified.webhookFacts.get(factKey).pipe(
              Effect.map(Option.getOrUndefined),
            )
            return {
              ingestTag: ingestResult._tag,
              factWritten: factRow !== undefined,
              factSource: factRow?.source,
              observerFactKey: observerOutcome.factKey,
              observerEventType: observerOutcome.eventType,
            }
          }) as Effect.Effect<
            {
              readonly ingestTag: "Inserted" | "Duplicate"
              readonly factWritten: boolean
              readonly factSource: string | undefined
              readonly observerFactKey: string
              readonly observerEventType: string
            },
            unknown
          >,
      ),
    )
    expect(outcome.ingestTag).toBe("Inserted")
    expect(outcome.factWritten).toBe(true)
    expect(outcome.factSource).toBe(source)
    expect(outcome.observerFactKey).toBe(factKey)
    expect(outcome.observerEventType).toBe("Issue.create")
  }, 15_000)

  it("rejects invalid HMAC; no fact written", async () => {
    const ns = `p4-webhook-bad-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const secret = "real-secret"
    const source = "linear"
    const deliveryId = "delivery-bad"
    const rawBody = encoder.encode(JSON.stringify({ action: "create" }))
    const wrongSignature = await hmacSign("WRONG-secret", rawBody)

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [],
          catalog: makeCatalog([]),
        },
        (services) =>
          Effect.gen(function*() {
            const result = yield* Effect.either(
              verifyAndIngestWebhook({
                unified: services.unified,
                verify: {
                  source,
                  deliveryId,
                  eventType: "Issue.create",
                  secret,
                  rawBody,
                  receivedSignatureHex: wrongSignature,
                },
              }),
            )
            const factRow = yield* services.unified.webhookFacts.get(
              webhookFactKey(source, deliveryId),
            ).pipe(Effect.map(Option.getOrUndefined))
            return {
              rejected: result._tag === "Left",
              errorOp: result._tag === "Left" && result.left instanceof VerifiedWebhookError
                ? result.left.op
                : undefined,
              factWritten: factRow !== undefined,
            }
          }) as Effect.Effect<
            {
              readonly rejected: boolean
              readonly errorOp: string | undefined
              readonly factWritten: boolean
            },
            unknown
          >,
      ),
    )
    expect(outcome.rejected).toBe(true)
    expect(outcome.errorOp).toBe("signature/invalid")
    expect(outcome.factWritten).toBe(false)
  }, 10_000)
})

// ── 3. Peer event emit ──────────────────────────────────────────────────────

describe("P4.3 — emitPeerEvent", () => {
  it("emits a peer event; waiting observer wakes via kernel arm", async () => {
    const ns = `p4-peer-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const eventName = "plan.ready"
    const eventId = "ev-1"
    const observerId = `obs-${crypto.randomUUID()}`

    const outcome = await Effect.runPromise(
      runGeneration(
        {
          urls,
          workflowLayers: [buildPeerEventObserverLayer()],
          catalog: makeCatalog([PeerEventObserverWorkflow]),
        },
        (services) =>
          Effect.gen(function*() {
            const executionId = yield* PeerEventObserverWorkflow.executionId({
              name: eventName,
              eventId,
              observerId,
            })
            const fiber = yield* Effect.fork(
              PeerEventObserverWorkflow.execute({
                name: eventName,
                eventId,
                observerId,
              }),
            )
            yield* Effect.sleep("100 millis")

            const emitResult = yield* emitPeerEvent({
              unified: services.unified,
              name: eventName,
              eventId,
              emitterContextId: "ctx-emit",
              payloadJson: JSON.stringify({ phase: "planning" }),
              signalOptions: {
                signals: services.signals,
                workflow: PeerEventObserverWorkflow,
                executionId,
              },
            })

            const exit = yield* fiber.await
            if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
            const observerOutcome = exit.value
            return {
              emitTag: emitResult._tag,
              observerName: observerOutcome.name,
              observerEventId: observerOutcome.eventId,
              observerEmitter: observerOutcome.emitterContextId,
            }
          }) as Effect.Effect<
            {
              readonly emitTag: "Inserted" | "Duplicate"
              readonly observerName: string
              readonly observerEventId: string
              readonly observerEmitter: string
            },
            unknown
          >,
      ),
    )
    expect(outcome.emitTag).toBe("Inserted")
    expect(outcome.observerName).toBe(eventName)
    expect(outcome.observerEventId).toBe(eventId)
    expect(outcome.observerEmitter).toBe("ctx-emit")
  }, 15_000)
})

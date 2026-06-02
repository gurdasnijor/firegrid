import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect, Fiber } from "effect"

const encoder = new TextEncoder()
const verifiedWebhookWaitSource = "linear-cap1"
const verifiedWebhookWaitSecret = "verified-webhook-wait-secret"
const verifiedWebhookWaitRouteChannel = "tiny.verifiedWebhookWait.route"
const verifiedWebhookWaitRouteReadyEvent = "webhook.route.ready"
const webhookId = "cap1-linear-delivery-1"
const expectedEventType = "Issue.update"

const linearPayload = {
  action: "update",
  type: "Issue",
  actor: {
    id: "user_1",
    type: "user",
  },
  createdAt: "2026-06-02T00:00:00.000Z",
  data: {
    id: "issue_1",
    identifier: "TF-CAP1",
  },
  url: "https://linear.app/firegrid/issue/TF-CAP1/webhook-wait",
  updatedFrom: {
    title: "old title",
  },
  organizationId: "org_1",
  webhookTimestamp: 1_780_358_400_000,
  webhookId,
} as const

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")

const hmacSha256Hex = (
  secret: string,
  rawBody: Uint8Array,
): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      bytesToArrayBuffer(encoder.encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      bytesToArrayBuffer(rawBody),
    )
    return bytesToHex(new Uint8Array(digest))
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (
  value: unknown,
  field: string,
): Effect.Effect<string, string> =>
  isRecord(value) && typeof value[field] === "string"
    ? Effect.succeed(value[field])
    : Effect.fail(`missing string field ${field}`)

const postSignedLinearWebhook = (
  routeUrl: string,
): Effect.Effect<{ readonly status: number; readonly text: string }, unknown> =>
  Effect.gen(function*() {
    const rawBody = encoder.encode(JSON.stringify(linearPayload))
    const signature = yield* hmacSha256Hex(verifiedWebhookWaitSecret, rawBody)
    return yield* Effect.tryPromise(async () => {
      const response = await fetch(routeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-linear-signature": signature,
          "linear-delivery": webhookId,
          authorization: "Bearer must-not-be-captured",
        },
        body: rawBody,
      })
      return {
        status: response.status,
        text: await response.text(),
      }
    })
  }).pipe(
    Effect.tap(response =>
      Effect.annotateCurrentSpan({
        "firegrid.webhook_wait.post_status": response.status,
        "firegrid.webhook_wait.post_url": routeUrl,
      })),
    Effect.withSpan("tiny_firegrid.verified_webhook_wait.post", {
      kind: "client",
    }),
  )

export const verifiedWebhookWaitDriver: Effect.Effect<void, unknown, Firegrid> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const routeReady = yield* firegrid.wait.for({
      event: {
        channel: verifiedWebhookWaitRouteChannel,
        match: {
          source: verifiedWebhookWaitSource,
          eventType: verifiedWebhookWaitRouteReadyEvent,
        },
        timeoutMs: 30_000,
      },
    })
    if ("timedOut" in routeReady) {
      return yield* Effect.fail("timed out waiting for webhook route")
    }
    const routeUrl = yield* stringField(routeReady.event, "url")

    const waitFiber = yield* firegrid.wait.for({
      event: {
        channel: "firegrid.verifiedWebhooks",
        match: {
          source: verifiedWebhookWaitSource,
          eventType: expectedEventType,
        },
        timeoutMs: 30_000,
      },
    }).pipe(Effect.fork)
    yield* Effect.sleep("100 millis")

    const response = yield* postSignedLinearWebhook(routeUrl)
    if (response.status !== 202) {
      return yield* Effect.fail(
        `webhook route returned ${response.status}: ${response.text}`,
      )
    }

    const waitResult = yield* Fiber.join(waitFiber)
    if ("timedOut" in waitResult) {
      return yield* Effect.fail("timed out waiting for verified webhook fact")
    }
    const event = waitResult.event
    const externalEventKey = yield* stringField(event, "externalEventKey")
    const eventType = yield* stringField(event, "eventType")
    const source = yield* stringField(event, "source")
    yield* Effect.annotateCurrentSpan({
      "firegrid.webhook_wait.route_status": response.status,
      "firegrid.webhook_wait.route_url": routeUrl,
      "firegrid.webhook_wait.source": source,
      "firegrid.webhook_wait.event_type": eventType,
      "firegrid.webhook_wait.external_event_key": externalEventKey,
      "firegrid.webhook_wait.expected_event_key": webhookId,
      "firegrid.webhook_wait.matched": true,
    })
  }).pipe(
    Effect.withSpan("tiny_firegrid.verified_webhook_wait.driver", {
      kind: "client",
    }),
  )

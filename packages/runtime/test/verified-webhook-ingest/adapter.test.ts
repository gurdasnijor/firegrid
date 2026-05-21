import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Schema } from "effect"
import type { Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ingestVerifiedWebhook,
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
} from "../../src/verified-webhook-ingest/index.ts"
import {
  LinearWebhookFactSchema,
  type LinearWebhookFact,
} from "@firegrid/protocol/verified-webhook"

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

const encoder = new TextEncoder()

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")

const hmacSha256Hex = async (
  secret: string,
  rawBody: Uint8Array,
): Promise<string> => {
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

const runWith = <A, E>(
  streamUrl: string,
  effect: Effect.Effect<A, E, VerifiedWebhookFactTable>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          VerifiedWebhookFactTable.layer(
            verifiedWebhookFactTableLayerOptions({ streamUrl }),
          ) as Layer.Layer<VerifiedWebhookFactTable, unknown>,
        ),
      ),
    ),
  )

describe("verified webhook ingest adapter", () => {
  it("firegrid-verified-webhook-ingest.LINEAR_FACTS.1 firegrid-verified-webhook-ingest.LINEAR_FACTS.2 writes protocol LinearWebhookFact rows from a signed Linear payload", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/linear-webhook-fact-${crypto.randomUUID()}`
    const secret = "linear-webhook-secret"
    const payload = {
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
      webhookId: "delivery_1",
    }
    const rawBody = encoder.encode(JSON.stringify(payload))
    const signature = await hmacSha256Hex(secret, rawBody)

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const ingestAndReadFact: Effect.Effect<
      LinearWebhookFact,
      unknown,
      VerifiedWebhookFactTable
    > = Effect.gen(function* () {
        const result = yield* ingestVerifiedWebhook({
          source: "linear-demo",
          headers: {
            "x-linear-signature": signature,
            "linear-delivery": "delivery_1",
            authorization: "Bearer must-not-be-captured",
          },
          rawBody,
          receivedAt: "2026-05-20T00:00:00.100Z",
          config: {
            secret,
            signatureHeaderName: "x-linear-signature",
            selectedHeaderNames: [
              "linear-delivery",
              "x-linear-signature",
              "authorization",
            ],
          },
        })
        expect(result._tag).toBe("Inserted")
        const table = yield* VerifiedWebhookFactTable
        const rows = yield* table.verifiedWebhookFacts.query(coll => coll.toArray)
        expect(rows).toHaveLength(1)
        return yield* Schema.decodeUnknown(LinearWebhookFactSchema)(rows[0])
      })
    const fact = await runWith(streamUrl, ingestAndReadFact)

    expect(fact.factKey).toEqual(["linear-demo", fact.payload.webhookId])
    expect(fact.externalEventKey).toBe(fact.payload.webhookId)
    expect(fact.externalEntityKey).toBe("issue_1")
    expect(fact.eventType).toBe(`${fact.payload.type}.${fact.payload.action}`)
    expect(fact.action).toBe(fact.payload.action)
    expect(fact.type).toBe(fact.payload.type)
    expect(fact.webhookId).toBe(fact.payload.webhookId)
    expect(fact.webhookTimestamp).toBe(fact.payload.webhookTimestamp)
    expect(fact.createdAt).toBe(fact.payload.createdAt)
    expect(fact.organizationId).toBe(fact.payload.organizationId)
    expect(fact.selectedHeaders).toEqual({ "linear-delivery": "delivery_1" })
  })
})

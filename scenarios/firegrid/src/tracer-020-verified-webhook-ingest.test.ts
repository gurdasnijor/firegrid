/**
 * Tracer 020 — verified webhook ingest to durable facts.
 *
 * Implements:
 *  - firegrid-verified-webhook-ingest.FACTS.1
 *  - firegrid-verified-webhook-ingest.FACTS.2
 *  - firegrid-verified-webhook-ingest.FACTS.3
 *  - firegrid-verified-webhook-ingest.INGEST.1
 *  - firegrid-verified-webhook-ingest.INGEST.2
 *  - firegrid-verified-webhook-ingest.INGEST.3
 *  - firegrid-verified-webhook-ingest.INGEST.4
 *  - firegrid-verified-webhook-ingest.INGEST.5
 *  - firegrid-verified-webhook-ingest.INGEST.6
 *  - firegrid-verified-webhook-ingest.WAIT_INTEGRATION.1
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  ingestVerifiedWebhook,
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
  type VerifiedWebhookFact,
  type VerifiedWebhookIngestConfig,
} from "@firegrid/runtime"
import { createHmac } from "node:crypto"
import { Effect, Either } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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
const source = "linear-demo"
const secret = "tracer-020-secret"

const config: VerifiedWebhookIngestConfig = {
  secret,
  signatureHeaderName: "x-linear-signature",
  externalEventKeyPath: ["webhookId"],
  eventTypePath: ["type"],
  externalEntityKeyPath: ["data", "id"],
  selectedHeaderNames: ["x-linear-delivery"],
}

const requestFor = (payload: unknown) => {
  const rawBody = encoder.encode(JSON.stringify(payload))
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex")
  return {
    source,
    rawBody,
    headers: {
      "x-linear-signature": `sha256=${signature}`,
      "x-linear-delivery": "delivery-1",
    },
    receivedAt: "2026-05-13T12:00:00.000Z",
    config,
  }
}

const rows = Effect.gen(function*() {
  const table = yield* VerifiedWebhookFactTable
  return yield* table.verifiedWebhookFacts.query((coll) => coll.toArray)
})

const expectSingleOriginalFact = (facts: ReadonlyArray<VerifiedWebhookFact>) => {
  expect(facts).toHaveLength(1)
  expect(facts[0]).toMatchObject({
    factKey: [source, "evt-1"],
    source,
    externalEventKey: "evt-1",
    externalEntityKey: "issue:LIN-123",
    eventType: "Issue.updated",
    selectedHeaders: {
      "x-linear-delivery": "delivery-1",
    },
    payload: {
      webhookId: "evt-1",
      type: "Issue.updated",
      data: {
        id: "issue:LIN-123",
        title: "Original",
      },
    },
  })
}

describe("firegrid tracer 020 verified webhook ingest to durable facts", () => {
  it("firegrid-verified-webhook-ingest.INGEST.1 firegrid-verified-webhook-ingest.INGEST.4 firegrid-verified-webhook-ingest.INGEST.5 firegrid-verified-webhook-ingest.INGEST.6 authenticates, inserts, deduplicates, and rejects conflicts without overwriting facts", async () => {
    if (!baseUrl) throw new Error("durable streams test server not started")

    const originalPayload = {
      webhookId: "evt-1",
      type: "Issue.updated",
      data: {
        id: "issue:LIN-123",
        title: "Original",
      },
    }
    const changedPayload = {
      webhookId: "evt-1",
      type: "Issue.updated",
      data: {
        id: "issue:LIN-123",
        title: "Changed",
      },
    }
    const missingEventKeyPayload = {
      type: "Issue.updated",
      data: {
        id: "issue:LIN-999",
      },
    }

    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const inserted = yield* ingestVerifiedWebhook(requestFor(originalPayload))
        expect(inserted._tag).toBe("Inserted")
        expect(inserted.fact.factKey).toEqual([source, "evt-1"])

        const duplicate = yield* ingestVerifiedWebhook(requestFor(originalPayload))
        expect(duplicate._tag).toBe("Duplicate")

        expectSingleOriginalFact(yield* rows)

        const conflict = yield* Effect.either(
          ingestVerifiedWebhook(requestFor(changedPayload)),
        )
        expect(Either.isLeft(conflict)).toBe(true)
        if (Either.isLeft(conflict)) {
          expect(conflict.left).toMatchObject({
            _tag: "VerifiedWebhookIngestError",
            op: "webhook/conflict",
            factKey: [source, "evt-1"],
          })
        }
        expectSingleOriginalFact(yield* rows)

        const invalidSignature = yield* Effect.either(
          ingestVerifiedWebhook({
            ...requestFor({ ...originalPayload, webhookId: "evt-bad-signature" }),
            headers: {
              "x-linear-signature": "sha256=00",
            },
          }),
        )
        expect(Either.isLeft(invalidSignature)).toBe(true)

        const malformedRawBody = encoder.encode("{")
        const malformedSignature = createHmac("sha256", secret)
          .update(malformedRawBody)
          .digest("hex")
        const malformedJson = yield* Effect.either(
          ingestVerifiedWebhook({
            source,
            rawBody: malformedRawBody,
            headers: {
              "x-linear-signature": `sha256=${malformedSignature}`,
            },
            config,
          }),
        )
        expect(Either.isLeft(malformedJson)).toBe(true)

        const missingEventKey = yield* Effect.either(
          ingestVerifiedWebhook(requestFor(missingEventKeyPayload)),
        )
        expect(Either.isLeft(missingEventKey)).toBe(true)

        expectSingleOriginalFact(yield* rows)
      }).pipe(
        Effect.provide(
          VerifiedWebhookFactTable.layer(
            verifiedWebhookFactTableLayerOptions({
              streamUrl: `${baseUrl}/v1/stream/tracer-020-${crypto.randomUUID()}`,
            }),
          ),
        ),
      ),
    ))
  })
})

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  VerifiedWebhookFactKeySchema,
  VerifiedWebhookFactSchema,
} from "../../src/verified-webhook/schema.ts"

describe("verified webhook protocol schema", () => {
  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.1 projects verified webhook facts through protocol", () => {
    const key = Schema.decodeUnknownSync(VerifiedWebhookFactKeySchema)([
      "linear",
      "evt_1",
    ])
    expect(key).toEqual(["linear", "evt_1"])

    const fact = Schema.decodeUnknownSync(VerifiedWebhookFactSchema)({
      factKey: key,
      source: "linear",
      externalEventKey: "evt_1",
      eventType: "issue.updated",
      receivedAt: "2026-05-20T00:00:00.000Z",
      verifiedAt: "2026-05-20T00:00:01.000Z",
      signatureScheme: "hmac-sha256",
      payloadSha256: "abc123",
      selectedHeaders: {
        "x-linear-event": "Issue",
      },
      payload: {
        id: "evt_1",
      },
    })

    expect(fact.source).toBe("linear")
    expect(fact.factKey).toEqual(["linear", "evt_1"])
  })
})

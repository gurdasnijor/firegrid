import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  LinearWebhookFactSchema,
  LinearWebhookPayloadSchema,
  VerifiedWebhookFactKeySchema,
  VerifiedWebhookFactSchema,
} from "../../src/verified-webhook/schema.ts"
import { VerifiedWebhook } from "../../src/index.ts"

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

  it("firegrid-linear-webhook-fact-schema.PROTOCOL_SCHEMA.1 and firegrid-linear-webhook-fact-schema.EXPORTS.1 expose Linear webhook payload schema through protocol", () => {
    expect(VerifiedWebhook.LinearWebhookFactSchema).toBe(LinearWebhookFactSchema)

    const payload = Schema.decodeUnknownSync(LinearWebhookPayloadSchema)({
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
    })

    expect(payload.webhookId).toBe("delivery_1")
  })

  it("firegrid-linear-webhook-fact-schema.PROTOCOL_SCHEMA.2 and firegrid-linear-webhook-fact-schema.LINEAR_FIELDS.1 decode Linear webhook fact fields for waiters", () => {
    const fact = Schema.decodeUnknownSync(LinearWebhookFactSchema)({
      factKey: ["linear-demo", "delivery_1"],
      source: "linear-demo",
      externalEventKey: "delivery_1",
      externalEntityKey: "issue_1",
      eventType: "Issue.update",
      receivedAt: "2026-05-20T00:00:00.000Z",
      verifiedAt: "2026-05-20T00:00:01.000Z",
      signatureScheme: "hmac-sha256",
      payloadSha256: "abc123",
      selectedHeaders: {
        "linear-delivery": "delivery_1",
        "linear-event": "Issue",
      },
      payload: {
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
      },
      action: "update",
      type: "Issue",
      webhookId: "delivery_1",
      webhookTimestamp: 1_779_232_800_000,
      createdAt: "2026-05-20T00:00:00.000Z",
      organizationId: "org_1",
      url: "https://linear.app/team/issue/TF-123/example",
      actor: {
        id: "user_1",
        type: "user",
      },
      data: {
        id: "issue_1",
        identifier: "TF-123",
      },
      updatedFrom: {
        title: "old title",
      },
    })

    expect(fact.source).toBe("linear-demo")
    expect(fact.action).toBe("update")
    expect(fact.type).toBe("Issue")
    expect(fact.webhookId).toBe("delivery_1")
    expect(fact.organizationId).toBe("org_1")
  })

  it("firegrid-linear-webhook-fact-schema.LINEAR_FIELDS.2 rejects Linear webhook facts without the source-owned payload shape", () => {
    expect(() =>
      Schema.decodeUnknownSync(LinearWebhookFactSchema)({
        factKey: ["linear-demo", "delivery_1"],
        source: "linear-demo",
        externalEventKey: "delivery_1",
        eventType: "Issue.update",
        receivedAt: "2026-05-20T00:00:00.000Z",
        verifiedAt: "2026-05-20T00:00:01.000Z",
        signatureScheme: "hmac-sha256",
        payloadSha256: "abc123",
        selectedHeaders: {},
        payload: {
          action: "update",
          type: "Issue",
          createdAt: "2026-05-20T00:00:00.000Z",
          webhookTimestamp: 1_779_232_800_000,
        },
        action: "update",
        type: "Issue",
        webhookId: "delivery_1",
        webhookTimestamp: 1_779_232_800_000,
        createdAt: "2026-05-20T00:00:00.000Z",
      }),
    ).toThrow()
  })
})

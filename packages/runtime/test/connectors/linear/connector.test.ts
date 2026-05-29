/**
 * Linear connector spike — integration test.
 *
 * Stress-tests the `ConnectorAdapter<LinearEvent, LinearFact>` primitive
 * end-to-end through the connector's source + journal halves. The fake
 * `ExternalIngressAppender` records writes; assertions cover:
 *
 *  - happy path: signed payload → typed event → row appended;
 *  - bad signature: rejection in `source`, no row appended;
 *  - replay of the same `webhookId`: appender's `insertOrGet` returns
 *    `Duplicate`, no second row;
 *  - decoding failure on malformed JSON: rejection in `source`.
 */

import { HttpServerRequest } from "@effect/platform"
import { Cause, Chunk, Effect, Exit, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  ExternalIngressAppender,
  type ExternalIngressAppendResult,
  type ExternalIngressFactBase,
} from "../../../src/capabilities/external-ingress-appender.ts"
import { LinearConnector } from "../../../src/connectors/linear/index.ts"
import type { LinearFact } from "../../../src/connectors/linear/schema.ts"

const SECRET = "spike-test-secret"

const samplePayload = (overrides: { readonly webhookId?: string } = {}) => ({
  action: "create",
  type: "Issue",
  webhookId: overrides.webhookId ?? "wh_001",
  webhookTimestamp: 1_700_000_000_000,
  createdAt: "2026-05-29T00:00:00.000Z",
  organizationId: "org_abc",
  url: "https://linear.app/issue/ABC-1",
  data: { id: "issue_xyz", title: "Refactor connectors" },
  actor: { id: "user_1", name: "spike" },
})

const encoder = new globalThis.TextEncoder()

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const hmacSign = async (
  secret: string,
  rawBody: Uint8Array,
): Promise<string> => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const buf = new Uint8Array(rawBody.byteLength)
  buf.set(rawBody)
  const digest = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    buf.buffer,
  )
  return bytesToHex(new Uint8Array(digest))
}

const buildSignedRequest = async (
  payload: ReturnType<typeof samplePayload>,
  overrides: { readonly signature?: string; readonly body?: string } = {},
): Promise<HttpServerRequest.HttpServerRequest> => {
  const body = overrides.body ?? JSON.stringify(payload)
  const rawBody = encoder.encode(body)
  const signature = overrides.signature ?? await hmacSign(SECRET, rawBody)
  const req = new globalThis.Request("https://example.test/webhooks/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": `sha256=${signature}`,
    },
    body,
  })
  return HttpServerRequest.fromWeb(req)
}

interface FakeAppenderState {
  readonly facts: Array<LinearFact>
}

const makeFakeAppender = (
  state: FakeAppenderState,
): Layer.Layer<ExternalIngressAppender> =>
  Layer.succeed(
    ExternalIngressAppender,
    ExternalIngressAppender.of({
      append: <Fact extends ExternalIngressFactBase>(
        fact: Fact,
      ): Effect.Effect<ExternalIngressAppendResult<Fact>> =>
        Effect.sync(() => {
          const existing = state.facts.find(
            (f) =>
              f.factKey[0] === fact.factKey[0] &&
              f.factKey[1] === fact.factKey[1],
          )
          if (existing !== undefined) {
            return { _tag: "Duplicate", fact: existing as unknown as Fact }
          }
          state.facts.push(fact as unknown as LinearFact)
          return { _tag: "Inserted", fact }
        }),
    }),
  )

const runConnector = async (
  request: HttpServerRequest.HttpServerRequest,
  state: FakeAppenderState,
) => {
  const adapter = LinearConnector({
    secret: SECRET,
    path: "/webhooks/linear",
  })
  return await Effect.runPromiseExit(
    Effect.gen(function*() {
      const stream = yield* adapter.source(request)
      const events = yield* stream.pipe(
        Stream.runCollect,
        Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
      )
      const facts: Array<LinearFact> = []
      for (const event of events) {
        const fact = yield* adapter.journal(event)
        facts.push(fact)
      }
      return facts
    }).pipe(Effect.provide(makeFakeAppender(state))),
  )
}

describe("connectors/linear (SDD #761 PR-M3.5 spike)", () => {
  it("happy path: signed payload becomes one typed event and one durable fact", async () => {
    const state: FakeAppenderState = { facts: [] }
    const request = await buildSignedRequest(samplePayload())
    const exit = await runConnector(request, state)

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(state.facts).toHaveLength(1)
    const fact = state.facts[0]!
    expect(fact.eventType).toBe("Issue.create")
    expect(fact.webhookId).toBe("wh_001")
    expect(fact.factKey).toEqual(["linear", "wh_001"])
    expect(fact.organizationId).toBe("org_abc")
    expect(fact.payloadSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("invalid signature: rejection in source, no row written", async () => {
    const state: FakeAppenderState = { facts: [] }
    const request = await buildSignedRequest(samplePayload(), {
      signature: "00".repeat(32),
    })
    const exit = await runConnector(request, state)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = Cause.failureOption(exit.cause)
      expect(cause._tag).toBe("Some")
      if (cause._tag === "Some") {
        expect(cause.value.name).toBe("ConnectorSourceError")
        expect(cause.value.op).toBe("signature/invalid")
      }
    }
    expect(state.facts).toHaveLength(0)
  })

  it("replay of the same webhookId: appender Duplicate, no second insert", async () => {
    const state: FakeAppenderState = { facts: [] }
    const payload = samplePayload({ webhookId: "wh_replay" })

    const firstExit = await runConnector(
      await buildSignedRequest(payload),
      state,
    )
    const secondExit = await runConnector(
      await buildSignedRequest(payload),
      state,
    )

    expect(Exit.isSuccess(firstExit)).toBe(true)
    expect(Exit.isSuccess(secondExit)).toBe(true)
    expect(state.facts).toHaveLength(1)
  })

  it("malformed JSON: rejection in source, no row written", async () => {
    const state: FakeAppenderState = { facts: [] }
    // signature still valid for the malformed body
    const request = await buildSignedRequest(samplePayload(), {
      body: "{not json",
    })
    const exit = await runConnector(request, state)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = Cause.failureOption(exit.cause)
      if (cause._tag === "Some") {
        expect(cause.value.name).toBe("ConnectorSourceError")
        expect(cause.value.op).toBe("payload/decode")
      }
    }
    expect(state.facts).toHaveLength(0)
  })

  it("missing signature header: rejected in source", async () => {
    const state: FakeAppenderState = { facts: [] }
    const body = JSON.stringify(samplePayload())
    const req = new globalThis.Request("https://example.test/webhooks/linear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    const request = HttpServerRequest.fromWeb(req)
    const exit = await runConnector(request, state)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = Cause.failureOption(exit.cause)
      if (cause._tag === "Some") {
        expect(cause.value.op).toBe("signature/missing-header")
      }
    }
    expect(state.facts).toHaveLength(0)
  })
})

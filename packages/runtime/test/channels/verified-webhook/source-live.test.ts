/**
 * `makeVerifiedWebhookSource` helper integration test.
 *
 * Proves the helper compresses the per-adapter boilerplate from
 * `firelab/src/simulations/linear-webhook-cookbook-composition/host.ts`
 * (243 lines of host wiring per source) into one factory call per source,
 * while still routing through the existing channel + table + ingest stack:
 *
 *   product HTTP route (mounted by helper)
 *     -> ingestVerifiedWebhook
 *     -> VerifiedWebhookFactTable.verifiedWebhookFacts.insertOrGet
 *         -> channel projection (the helper's `binding.channel(table)`)
 *
 * Stress-test goal: a second adapter (GitHub) reuses the helper with only
 * a per-source config diff; the merged channel emits facts from both.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Chunk, Effect, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  makeVerifiedWebhookSource,
  mergeWebhookSourceChannels,
} from "../../../src/channels/verified-webhook/source-live.ts"
import {
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
  type VerifiedWebhookFact,
  VerifiedWebhookFactSchema,
} from "../../../src/verified-webhook-ingest/index.ts"

const encoder = new TextEncoder()

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const hmacSha256Hex = async (secret: string, rawBody: Uint8Array): Promise<string> => {
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
}

const linearPayload = {
  action: "update",
  type: "Issue",
  webhookId: "lin_delivery_1",
  webhookTimestamp: 1_779_232_800_000,
  createdAt: "2026-05-20T00:00:00.000Z",
  organizationId: "org_1",
  url: "https://linear.app/team/issue/TF-123/example",
  data: { id: "issue_1", identifier: "TF-123" },
  actor: { id: "user_1", type: "user" },
  updatedFrom: { title: "old title" },
} as const

const githubPayload = {
  // GitHub webhooks identify the event via the `X-GitHub-Event` header and
  // the delivery via `X-GitHub-Delivery`. The body is provider-shaped JSON;
  // the GraphQL `node_id` (a string) is the idiomatic external-event key.
  action: "opened",
  number: 42,
  pull_request: {
    id: 1001,
    node_id: "PR_kwDOABCDEF12345",
    title: "Add connectors helper",
    html_url: "https://github.com/example/repo/pull/42",
    user: { login: "octocat", id: 7 },
  },
  repository: {
    full_name: "example/repo",
    id: 555,
    node_id: "R_kwDOABCDEF999",
  },
  sender: { login: "octocat", id: 7 },
} as const

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

const factTableLayer = (namespace: string) =>
  VerifiedWebhookFactTable.layer(
    verifiedWebhookFactTableLayerOptions({
      streamUrl: durableStreamUrl(
        baseUrl!,
        `${namespace}.verifiedWebhookFacts`,
      ),
    }),
  )

const postSignedRequest = async (options: {
  readonly url: string
  readonly body: unknown
  readonly secret: string
  readonly signatureHeaderName: string
  readonly signaturePrefix?: string
  readonly extraHeaders?: Record<string, string>
}): Promise<{ readonly ok: boolean; readonly status: number; readonly text: string }> => {
  const rawBody = encoder.encode(JSON.stringify(options.body))
  const signature = await hmacSha256Hex(options.secret, rawBody)
  const signatureValue = options.signaturePrefix === undefined
    ? signature
    : `${options.signaturePrefix}${signature}`
  const response = await globalThis.fetch(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [options.signatureHeaderName]: signatureValue,
      ...(options.extraHeaders ?? {}),
    },
    body: rawBody,
  })
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  }
}

describe("makeVerifiedWebhookSource — helper compresses per-adapter boilerplate", () => {
  it("Linear-only: one factory call mounts route + projects channel + writes facts", async () => {
    const namespace = `helper-linear-${crypto.randomUUID()}`
    const tableLayer = factTableLayer(namespace)
    const secret = "linear-helper-secret"

    const linear = makeVerifiedWebhookSource({
      source: "linear-helper-demo",
      factSchema: VerifiedWebhookFactSchema,
      ingest: {
        secret,
        signatureHeaderName: "x-linear-signature",
        selectedHeaderNames: ["x-linear-signature", "linear-delivery"],
      },
      route: { host: "127.0.0.1", port: 0, path: "/webhooks/linear" },
    })

    const observed: Array<VerifiedWebhookFact> = []

    const program = Effect.gen(function* () {
      const bound = yield* linear.routeUrl
      const response = yield* Effect.promise(() =>
        postSignedRequest({
          url: bound.url,
          body: linearPayload,
          secret,
          signatureHeaderName: "x-linear-signature",
          extraHeaders: { "linear-delivery": linearPayload.webhookId },
        }))
      expect(response.ok).toBe(true)
      expect(response.status).toBe(202)

      const table = yield* VerifiedWebhookFactTable
      const stream = linear.channel(table).binding.stream
      const collected = yield* stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
      )
      observed.push(...collected)
    }).pipe(
      Effect.provide(Layer.merge(tableLayer, linear.routeLayer.pipe(Layer.provide(tableLayer)))),
      Effect.scoped,
    )

    await Effect.runPromise(program)

    expect(observed).toHaveLength(1)
    const fact = observed[0]!
    expect(fact.source).toBe("linear-helper-demo")
    expect(fact.eventType).toBe("Issue.update")
    expect(fact.externalEventKey).toBe(linearPayload.webhookId)
    expect(fact.factKey).toEqual(["linear-helper-demo", linearPayload.webhookId])
    expect(fact.payloadSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fact.signatureScheme).toBe("hmac-sha256")
    // header allow-list filters out auth-like headers
    expect(Object.keys(fact.selectedHeaders)).toEqual(
      expect.arrayContaining(["linear-delivery"]),
    )
  }, 15_000)

  it("Linear + GitHub through the same helper, merged into one channel target", async () => {
    const namespace = `helper-multi-${crypto.randomUUID()}`
    const tableLayer = factTableLayer(namespace)
    const linearSecret = "linear-helper-secret"
    const githubSecret = "github-helper-secret"

    const linear = makeVerifiedWebhookSource({
      source: "linear-multi",
      factSchema: VerifiedWebhookFactSchema,
      ingest: {
        secret: linearSecret,
        signatureHeaderName: "x-linear-signature",
        selectedHeaderNames: ["x-linear-signature", "linear-delivery"],
      },
      route: { host: "127.0.0.1", port: 0, path: "/webhooks/linear" },
    })

    const github = makeVerifiedWebhookSource({
      source: "github-multi",
      factSchema: VerifiedWebhookFactSchema,
      ingest: {
        secret: githubSecret,
        // GitHub's signature header is `X-Hub-Signature-256` and the
        // signature value carries a `sha256=` prefix.
        signatureHeaderName: "x-hub-signature-256",
        externalEventKeyPath: ["pull_request", "node_id"],
        eventTypePath: ["action"],
        externalEntityKeyPath: ["repository", "full_name"],
        selectedHeaderNames: ["x-github-event", "x-github-delivery"],
      },
      route: { host: "127.0.0.1", port: 0, path: "/webhooks/github" },
    })

    const mergedChannelProjection = mergeWebhookSourceChannels(
      [linear, github],
      { mergedSchema: VerifiedWebhookFactSchema },
    )

    const composed = Layer.mergeAll(
      tableLayer,
      linear.routeLayer.pipe(Layer.provide(tableLayer)),
      github.routeLayer.pipe(Layer.provide(tableLayer)),
    )

    const observed: Array<VerifiedWebhookFact> = []

    const program = Effect.gen(function* () {
      const linearBound = yield* linear.routeUrl
      const githubBound = yield* github.routeUrl

      const linearResponse = yield* Effect.promise(() =>
        postSignedRequest({
          url: linearBound.url,
          body: linearPayload,
          secret: linearSecret,
          signatureHeaderName: "x-linear-signature",
          extraHeaders: { "linear-delivery": linearPayload.webhookId },
        }))
      expect(linearResponse.ok).toBe(true)

      const githubResponse = yield* Effect.promise(() =>
        postSignedRequest({
          url: githubBound.url,
          body: githubPayload,
          secret: githubSecret,
          signatureHeaderName: "x-hub-signature-256",
          signaturePrefix: "sha256=",
          extraHeaders: {
            "x-github-event": "pull_request",
            "x-github-delivery": "gh-delivery-1",
          },
        }))
      expect(githubResponse.ok).toBe(true)

      const table = yield* VerifiedWebhookFactTable
      const merged = mergedChannelProjection(table)
      const collected = yield* merged.binding.stream.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
      )
      observed.push(...collected)
    }).pipe(
      Effect.provide(composed),
      Effect.scoped,
    )

    await Effect.runPromise(program)

    expect(observed).toHaveLength(2)
    const bySource = new Map(observed.map((fact) => [fact.source, fact]))
    expect(bySource.has("linear-multi")).toBe(true)
    expect(bySource.has("github-multi")).toBe(true)

    const linearFact = bySource.get("linear-multi")!
    expect(linearFact.eventType).toBe("Issue.update")
    expect(linearFact.externalEventKey).toBe(linearPayload.webhookId)

    const githubFact = bySource.get("github-multi")!
    // The GitHub config uses `["action"]` for event type and
    // `["pull_request", "node_id"]` for the external event key. Both come
    // straight from the payload, proving the helper passed the per-source
    // `ingest` config through to `ingestVerifiedWebhook`.
    expect(githubFact.eventType).toBe("opened")
    expect(githubFact.externalEventKey).toBe(githubPayload.pull_request.node_id)
    expect(githubFact.externalEntityKey).toBe(githubPayload.repository.full_name)
  }, 20_000)

  it("invalid signature → 400 response, no row written", async () => {
    const namespace = `helper-bad-sig-${crypto.randomUUID()}`
    const tableLayer = factTableLayer(namespace)

    const linear = makeVerifiedWebhookSource({
      source: "linear-bad-sig",
      factSchema: VerifiedWebhookFactSchema,
      ingest: {
        secret: "real-secret",
        signatureHeaderName: "x-linear-signature",
      },
      route: { host: "127.0.0.1", port: 0, path: "/webhooks/linear" },
    })

    const observedAfterBadRequest: Array<VerifiedWebhookFact> = []

    const program = Effect.gen(function* () {
      const bound = yield* linear.routeUrl
      const response = yield* Effect.promise(() =>
        postSignedRequest({
          url: bound.url,
          body: linearPayload,
          secret: "WRONG-secret",
          signatureHeaderName: "x-linear-signature",
          extraHeaders: { "linear-delivery": linearPayload.webhookId },
        }))
      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)

      // Post a second, valid request to confirm the channel only emits the
      // valid one (so the first row truly was rejected, not buffered).
      const validResponse = yield* Effect.promise(() =>
        postSignedRequest({
          url: bound.url,
          body: linearPayload,
          secret: "real-secret",
          signatureHeaderName: "x-linear-signature",
          extraHeaders: { "linear-delivery": linearPayload.webhookId },
        }))
      expect(validResponse.ok).toBe(true)

      const table = yield* VerifiedWebhookFactTable
      const collected = yield* linear.channel(table).binding.stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
      )
      observedAfterBadRequest.push(...collected)
    }).pipe(
      Effect.provide(Layer.merge(tableLayer, linear.routeLayer.pipe(Layer.provide(tableLayer)))),
      Effect.scoped,
    )

    await Effect.runPromise(program)

    expect(observedAfterBadRequest).toHaveLength(1)
    expect(observedAfterBadRequest[0]!.source).toBe("linear-bad-sig")
  }, 15_000)
})

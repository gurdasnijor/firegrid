/**
 * Tiny verified webhook ingest adapter.
 *
 * Implements:
 *  - firegrid-verified-webhook-ingest.INGEST.1
 *  - firegrid-verified-webhook-ingest.INGEST.2
 *  - firegrid-verified-webhook-ingest.INGEST.3
 *  - firegrid-verified-webhook-ingest.INGEST.4
 *  - firegrid-verified-webhook-ingest.INGEST.5
 *  - firegrid-verified-webhook-ingest.INGEST.6
 *  - firegrid-verified-webhook-ingest.INGEST.7
 *  - firegrid-verified-webhook-ingest.BOUNDARIES.1
 *  - firegrid-verified-webhook-ingest.BOUNDARIES.2
 */

import { Clock, Effect, Match, Schema } from "effect"
import {
  VerifiedWebhookFactTable,
  type VerifiedWebhookFact,
} from "./table.ts"

export type VerifiedWebhookHeaders = Readonly<
  Record<string, string | ReadonlyArray<string> | undefined>
>

export interface VerifiedWebhookIngestConfig {
  readonly secret: string | Uint8Array
  readonly signatureHeaderName?: string
  readonly externalEventKeyPath?: ReadonlyArray<string>
  readonly eventTypePath?: ReadonlyArray<string>
  readonly externalEntityKeyPath?: ReadonlyArray<string>
  readonly selectedHeaderNames?: ReadonlyArray<string>
}

export interface VerifiedWebhookIngestRequest {
  readonly source: string
  readonly headers: VerifiedWebhookHeaders
  readonly rawBody: Uint8Array
  readonly receivedAt?: string
  readonly config: VerifiedWebhookIngestConfig
}

export type VerifiedWebhookIngestResult =
  | {
    readonly _tag: "Inserted"
    readonly fact: VerifiedWebhookFact
  }
  | {
    readonly _tag: "Duplicate"
    readonly fact: VerifiedWebhookFact
  }

export class VerifiedWebhookIngestError extends Schema.TaggedError<VerifiedWebhookIngestError>()(
  "VerifiedWebhookIngestError",
  {
    op: Schema.String,
    source: Schema.String,
    message: Schema.String,
    factKey: Schema.optional(Schema.Tuple(Schema.String, Schema.String)),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const ingestError = (options: {
  readonly op: string
  readonly source: string
  readonly message: string
  readonly factKey?: readonly [string, string]
  readonly cause?: unknown
}): VerifiedWebhookIngestError =>
  new VerifiedWebhookIngestError({
    op: options.op,
    source: options.source,
    message: options.message,
    ...(options.factKey === undefined ? {} : { factKey: options.factKey }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  })

const defaultSignatureHeaderName = "x-firegrid-signature-256"
const defaultExternalEventKeyPath = ["id"] as const
const defaultEventTypePath = ["type"] as const
const signatureScheme = "hmac-sha256"
const unsafeSelectedHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
])

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const headerKey = (name: string) => name.toLowerCase()

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const normalizeHeaders = (
  headers: VerifiedWebhookHeaders,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) return []
      if (isStringArray(value)) {
        const first = value[0]
        return first === undefined ? [] : [[headerKey(name), first]]
      }
      return [[headerKey(name), value]]
    }),
  )

const signatureHexFromHeader = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const hexToBytes = (hex: string): Uint8Array | undefined => {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    const parsed = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    if (!Number.isFinite(parsed)) return undefined
    bytes[index] = parsed
  }
  return bytes
}

const hmacSha256Hex = (
  source: string,
  secret: string | Uint8Array,
  rawBody: Uint8Array,
): Effect.Effect<string, VerifiedWebhookIngestError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        bytesToArrayBuffer(typeof secret === "string" ? encoder.encode(secret) : secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const digest = await globalThis.crypto.subtle.sign("HMAC", key, bytesToArrayBuffer(rawBody))
      return bytesToHex(new Uint8Array(digest))
    },
    catch: (cause) => ingestError({
      op: "webhook/signature-digest",
      source,
      message: "failed computing HMAC digest",
      cause,
    }),
  })

const sha256Hex = (
  source: string,
  rawBody: Uint8Array,
): Effect.Effect<string, VerifiedWebhookIngestError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytesToArrayBuffer(rawBody))
      return bytesToHex(new Uint8Array(digest))
    },
    catch: (cause) => ingestError({
      op: "webhook/payload-digest",
      source,
      message: "failed computing payload digest",
      cause,
    }),
  })

const constantTimeHexEquals = (
  left: string,
  right: string,
): boolean => {
  const leftBytes = hexToBytes(left)
  const rightBytes = hexToBytes(right)
  if (leftBytes === undefined || rightBytes === undefined) return false
  const maxLength = Math.max(leftBytes.length, rightBytes.length)
  let diff = leftBytes.length === rightBytes.length ? 0 : 1
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return diff === 0
}

const verifySignature = (
  request: VerifiedWebhookIngestRequest,
  headers: Readonly<Record<string, string>>,
): Effect.Effect<void, VerifiedWebhookIngestError> =>
  Effect.gen(function*() {
    const signatureHeaderName = headerKey(
      request.config.signatureHeaderName ?? defaultSignatureHeaderName,
    )
    const received = headers[signatureHeaderName]
    if (received === undefined) {
      return yield* Effect.fail(ingestError({
        op: "webhook/verify",
        source: request.source,
        message: "missing signature header",
      }))
    }
    const expected = yield* hmacSha256Hex(
      request.source,
      request.config.secret,
      request.rawBody,
    )
    return yield* (constantTimeHexEquals(expected, signatureHexFromHeader(received))
      ? Effect.void
      : Effect.fail(ingestError({
        op: "webhook/verify",
        source: request.source,
        message: "invalid signature",
      })))
  })

const parseJsonPayload = (
  request: VerifiedWebhookIngestRequest,
): Effect.Effect<unknown, VerifiedWebhookIngestError> =>
  Effect.try({
    try: () => JSON.parse(decoder.decode(request.rawBody)) as unknown,
    catch: (cause) => ingestError({
      op: "webhook/decode-json",
      source: request.source,
      message: "malformed JSON payload",
      cause,
    }),
  })

const pathValue = (
  value: unknown,
  path: ReadonlyArray<string>,
): unknown =>
  path.reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null) return undefined
    return (current as Record<string, unknown>)[part]
  }, value)

const stringAtPath = (
  value: unknown,
  path: ReadonlyArray<string>,
): string | undefined => {
  const found = pathValue(value, path)
  return typeof found === "string" && found.length > 0 ? found : undefined
}

const selectedHeaders = (
  headers: Readonly<Record<string, string>>,
  signatureHeaderName: string,
  names: ReadonlyArray<string> | undefined,
): Readonly<Record<string, string>> => {
  if (names === undefined) return {}
  const unsafeNames = new Set([
    ...unsafeSelectedHeaderNames,
    headerKey(signatureHeaderName),
  ])
  return Object.fromEntries(
    names.flatMap((name) => {
      const key = headerKey(name)
      if (unsafeNames.has(key)) return []
      const value = headers[key]
      return value === undefined ? [] : [[key, value]]
    }),
  )
}

const makeFact = (
  request: VerifiedWebhookIngestRequest,
  headers: Readonly<Record<string, string>>,
  payload: unknown,
  timestamp: string,
  payloadSha256: string,
): Effect.Effect<VerifiedWebhookFact, VerifiedWebhookIngestError> => {
  const externalEventKey = stringAtPath(
    payload,
    request.config.externalEventKeyPath ?? defaultExternalEventKeyPath,
  )
  if (externalEventKey === undefined) {
    return Effect.fail(ingestError({
      op: "webhook/derive-key",
      source: request.source,
      message: "missing external event key",
    }))
  }
  const eventType =
    stringAtPath(payload, request.config.eventTypePath ?? defaultEventTypePath) ??
      "unknown"
  const externalEntityKey = request.config.externalEntityKeyPath === undefined
    ? undefined
    : stringAtPath(payload, request.config.externalEntityKeyPath)
  return Effect.succeed({
    factKey: [request.source, externalEventKey],
    source: request.source,
    externalEventKey,
    ...(externalEntityKey === undefined ? {} : { externalEntityKey }),
    eventType,
    receivedAt: request.receivedAt ?? timestamp,
    verifiedAt: timestamp,
    signatureScheme,
    payloadSha256,
    selectedHeaders: selectedHeaders(
      headers,
      request.config.signatureHeaderName ?? defaultSignatureHeaderName,
      request.config.selectedHeaderNames,
    ),
    payload,
  })
}

export const ingestVerifiedWebhook = (
  request: VerifiedWebhookIngestRequest,
): Effect.Effect<
  VerifiedWebhookIngestResult,
  VerifiedWebhookIngestError,
  VerifiedWebhookFactTable
> =>
  // Effect.gen infers the precise service tag class structurally here, but the
  // eslint type-aware rule sees part of the generator plumbing as unsafe.
   
  Effect.gen(function*() {
    const headers = normalizeHeaders(request.headers)
    yield* verifySignature(request, headers)
    const payload = yield* parseJsonPayload(request)
    const nowMs = yield* Clock.currentTimeMillis
    const payloadSha256 = yield* sha256Hex(request.source, request.rawBody)
    const fact = yield* makeFact(
      request,
      headers,
      payload,
      new Date(nowMs).toISOString(),
      payloadSha256,
    )
    const table = yield* VerifiedWebhookFactTable
    const result = yield* table.verifiedWebhookFacts.insertOrGet(fact).pipe(
      Effect.mapError((cause) =>
        ingestError({
          op: "webhook/write-fact",
          source: request.source,
          message: "failed writing verified webhook fact",
          factKey: fact.factKey,
          cause,
        }),
      ),
    )
    const outcome = Match.value(result).pipe(
      Match.tag("Inserted", () =>
        ({
          _tag: "Inserted",
          fact,
        } satisfies VerifiedWebhookIngestResult)),
      Match.tag("Found", ({ row }) =>
        row.payloadSha256 === fact.payloadSha256
          ? ({
            _tag: "Duplicate",
            fact: row,
          } satisfies VerifiedWebhookIngestResult)
          : ({
            _tag: "Conflict",
          } satisfies { readonly _tag: "Conflict" })),
      Match.exhaustive,
    )
    if (outcome._tag !== "Conflict") return outcome
    return yield* Effect.fail(ingestError({
      op: "webhook/conflict",
      source: request.source,
      message: "duplicate external event key has different payload hash",
      factKey: fact.factKey,
    }))
  })

/**
 * Linear webhook connector (PR-M3.5 spike).
 *
 * Implements the `ConnectorAdapter<LinearEvent, LinearFact>` primitive
 * against Linear's HMAC-signed webhook protocol.
 *
 * Stress-test goals: does the `ConnectorAdapter` shape express every
 * step of the inbound flow without leaking concerns into the wrong half?
 * Friction encountered here informs PR-M4 (verified-webhook rework).
 */

import type { HttpRouter, HttpServerRequest } from "@effect/platform"
import { Clock, Effect, Schema, Stream } from "effect"
import { ExternalIngressAppender } from "../../capabilities/external-ingress-appender.ts"
import {
  ConnectorJournalError,
  ConnectorSourceError,
  type ConnectorAdapter,
} from "../../events/connector-adapter.ts"
import {
  LinearEventSchema,
  LinearFactSchema,
  LinearWebhookPayloadSchema,
  type LinearEvent,
  type LinearFact,
  type LinearWebhookPayload,
} from "./schema.ts"
import { sha256Hex, verifyHmacSha256 } from "./signature.ts"

const connectorId = "linear"
const defaultSignatureHeaderName = "linear-signature"
const decoder = new globalThis.TextDecoder()

export interface LinearConnectorConfig {
  /** HMAC secret Linear uses to sign deliveries. */
  readonly secret: string | Uint8Array
  /** Where the host mounts the route. */
  readonly path: HttpRouter.PathInput
  /** Override the signature header name (defaults to `linear-signature`). */
  readonly signatureHeaderName?: string
  /**
   * Stable source identifier written into every fact row's `factKey[0]`.
   * Defaults to `"linear"`; an org-multi-tenant deployment can override
   * to scope facts per tenant.
   */
  readonly source?: string
}

const readRawBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Uint8Array, ConnectorSourceError> =>
  request.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((cause) =>
      new ConnectorSourceError(
        connectorId,
        "request/read-body",
        "failed reading webhook body",
        { cause },
      )),
  )

const headerValue = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
): string | undefined => {
  const value = request.headers[name.toLowerCase()]
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

const decodePayload = (
  rawBody: Uint8Array,
): Effect.Effect<LinearWebhookPayload, ConnectorSourceError> =>
  Schema.decodeUnknown(Schema.parseJson(LinearWebhookPayloadSchema))(
    decoder.decode(rawBody),
  ).pipe(
    Effect.mapError((cause) =>
      new ConnectorSourceError(
        connectorId,
        "payload/decode",
        "malformed Linear webhook payload",
        { cause },
      )),
  )

export const LinearConnector = (
  config: LinearConnectorConfig,
): ConnectorAdapter<LinearEvent, LinearFact> => {
  const source = config.source ?? connectorId
  const signatureHeaderName =
    config.signatureHeaderName ?? defaultSignatureHeaderName

  const sourceFn: ConnectorAdapter<LinearEvent, LinearFact>["source"] = (request) =>
    Effect.gen(function*() {
      const rawBody = yield* readRawBody(request)
      yield* verifyHmacSha256({
        connectorId,
        secret: config.secret,
        rawBody,
        receivedHeaderValue: headerValue(request, signatureHeaderName),
      })
      const payload = yield* decodePayload(rawBody)
      const payloadSha256 = yield* sha256Hex(connectorId, rawBody)
      const nowMs = yield* Clock.currentTimeMillis
      const verifiedAt = new Date(nowMs).toISOString()
      const event: LinearEvent = {
        payload,
        receivedAt: verifiedAt,
        verifiedAt,
        payloadSha256,
        rawBodyBytes: rawBody.byteLength,
      }
      return Stream.succeed(event)
    })

  const journalFn: ConnectorAdapter<LinearEvent, LinearFact>["journal"] = (event) =>
    Effect.gen(function*() {
      const appender = yield* ExternalIngressAppender
      const fact: LinearFact = {
        factKey: [source, event.payload.webhookId],
        source,
        externalEventKey: event.payload.webhookId,
        eventType: `${event.payload.type}.${event.payload.action}`,
        receivedAt: event.receivedAt,
        verifiedAt: event.verifiedAt,
        payloadSha256: event.payloadSha256,
        action: event.payload.action,
        type: event.payload.type,
        webhookId: event.payload.webhookId,
        webhookTimestamp: event.payload.webhookTimestamp,
        createdAt: event.payload.createdAt,
        ...(event.payload.organizationId === undefined
          ? {}
          : { organizationId: event.payload.organizationId }),
        ...(event.payload.url === undefined ? {} : { url: event.payload.url }),
        ...(event.payload.data === undefined ? {} : { data: event.payload.data }),
        ...(event.payload.actor === undefined ? {} : { actor: event.payload.actor }),
        ...(event.payload.updatedFrom === undefined
          ? {}
          : { updatedFrom: event.payload.updatedFrom }),
      }
      const result = yield* appender.append(fact).pipe(
        Effect.mapError((cause) =>
          new ConnectorJournalError(
            connectorId,
            "journal/append",
            "failed appending Linear fact",
            { cause },
          )),
      )
      return result.fact
    })

  return {
    id: connectorId,
    route: { method: "POST", path: config.path },
    source: sourceFn,
    journal: journalFn,
    eventSchema: LinearEventSchema,
    factSchema: LinearFactSchema,
  }
}

import { Effect } from "effect"
import { ConnectorSourceError } from "../../events/connector-adapter.ts"

const encoder = new globalThis.TextEncoder()

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

const constantTimeHexEquals = (left: string, right: string): boolean => {
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

const signatureHexFromHeader = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed
}

export const hmacSha256Hex = (
  connectorId: string,
  secret: string | Uint8Array,
  rawBody: Uint8Array,
): Effect.Effect<string, ConnectorSourceError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        bytesToArrayBuffer(typeof secret === "string" ? encoder.encode(secret) : secret),
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
    },
    catch: (cause) =>
      new ConnectorSourceError(
        connectorId,
        "signature/digest",
        "failed computing HMAC digest",
        { cause },
      ),
  })

export const sha256Hex = (
  connectorId: string,
  rawBody: Uint8Array,
): Effect.Effect<string, ConnectorSourceError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        bytesToArrayBuffer(rawBody),
      )
      return bytesToHex(new Uint8Array(digest))
    },
    catch: (cause) =>
      new ConnectorSourceError(
        connectorId,
        "payload/digest",
        "failed computing payload digest",
        { cause },
      ),
  })

export const verifyHmacSha256 = (options: {
  readonly connectorId: string
  readonly secret: string | Uint8Array
  readonly rawBody: Uint8Array
  readonly receivedHeaderValue: string | undefined
}): Effect.Effect<void, ConnectorSourceError> =>
  Effect.gen(function*() {
    if (options.receivedHeaderValue === undefined) {
      return yield* Effect.fail(
        new ConnectorSourceError(
          options.connectorId,
          "signature/missing-header",
          "missing signature header",
        ),
      )
    }
    const expected = yield* hmacSha256Hex(
      options.connectorId,
      options.secret,
      options.rawBody,
    )
    if (
      constantTimeHexEquals(
        expected,
        signatureHexFromHeader(options.receivedHeaderValue),
      )
    ) {
      return
    }
    return yield* Effect.fail(
      new ConnectorSourceError(
        options.connectorId,
        "signature/invalid",
        "invalid signature",
      ),
    )
  })

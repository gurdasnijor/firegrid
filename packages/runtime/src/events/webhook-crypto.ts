const encoder = new TextEncoder()

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const hexToBytes = (hex: string): Uint8Array | undefined => {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    const parsed = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    if (!Number.isFinite(parsed)) return undefined
    bytes[index] = parsed
  }
  return bytes
}

export const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export const signHmacSha256 = async (
  secret: string | Uint8Array,
  rawBody: Uint8Array,
): Promise<Uint8Array> => {
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
  return new Uint8Array(digest)
}

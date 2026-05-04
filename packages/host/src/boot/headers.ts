// launchable-substrate-host.HOST_CONFIGURATION.8
// launchable-substrate-host.HOST_CONFIGURATION.10
// launchable-substrate-host.HOST_CONFIGURATION.11
//
// Authorization vs token resolution rules:
//   - When both `authorization` and `bearerToken` are present,
//     `authorization` wins per
//     launchable-substrate-host.HOST_CONFIGURATION.10.
//   - A bare `bearerToken` materializes as
//     `Authorization: Bearer <token>` per
//     launchable-substrate-host.HOST_CONFIGURATION.11.
//   - Missing inputs produce no Authorization header.
//   - Caller-supplied extra headers merge under the resolved
//     authorization (the caller owns precedence in `extra`, except
//     never for Authorization itself, which the resolution rules above
//     own).
export interface HeaderInput {
  readonly authorization?: string
  readonly bearerToken?: string
  readonly extra?: Readonly<Record<string, string>>
}

export const buildHostHeaders = (
  input: HeaderInput,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  if (input.extra !== undefined) {
    for (const [k, v] of Object.entries(input.extra)) {
      // Skip caller-supplied "Authorization" so the resolution rules
      // below remain authoritative; a caller that wants to override
      // should use `authorization` directly.
      if (k.toLowerCase() === "authorization") continue
      out[k] = v
    }
  }
  if (input.authorization !== undefined) {
    out.Authorization = input.authorization
  } else if (input.bearerToken !== undefined) {
    out.Authorization = `Bearer ${input.bearerToken}`
  }
  return Object.freeze(out)
}

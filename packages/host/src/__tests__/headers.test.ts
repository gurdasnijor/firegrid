import { describe, expect, it } from "vitest"
import { buildHostHeaders } from "../boot/headers.js"

// launchable-substrate-host.HOST_CONFIGURATION.10
// When both authorization and bearer token config are present,
// authorization config wins.
describe("launchable-substrate-host.HOST_CONFIGURATION.10 — authorization config wins over bearer token config", () => {
  it("buildHostHeaders prefers `authorization` over `bearerToken` when both are supplied", () => {
    const headers = buildHostHeaders({
      authorization: "AuthnSchemeA xyz",
      bearerToken: "ignored-token",
    })
    expect(headers.Authorization).toBe("AuthnSchemeA xyz")
  })
})

// launchable-substrate-host.HOST_CONFIGURATION.11
// Bare bearer token materializes as Authorization: Bearer <token>.
describe("launchable-substrate-host.HOST_CONFIGURATION.11 — bare bearer token materializes as Authorization Bearer header", () => {
  it("buildHostHeaders sets Authorization to `Bearer <token>` when only bearerToken is supplied", () => {
    const headers = buildHostHeaders({ bearerToken: "tok-123" })
    expect(headers.Authorization).toBe("Bearer tok-123")
  })

  it("missing authorization and bearer token yields no Authorization header", () => {
    const headers = buildHostHeaders({})
    expect(headers.Authorization).toBeUndefined()
  })

  it("extra headers merge under the resolved authorization but cannot override Authorization itself", () => {
    const headers = buildHostHeaders({
      bearerToken: "tok-1",
      extra: { Authorization: "leak", "X-Trace": "abc" },
    })
    expect(headers.Authorization).toBe("Bearer tok-1")
    expect(headers["X-Trace"]).toBe("abc")
  })

  it("returned headers object is frozen so callers cannot mutate the materialized auth", () => {
    const headers = buildHostHeaders({ authorization: "Sig 1" })
    expect(Object.isFrozen(headers)).toBe(true)
  })
})

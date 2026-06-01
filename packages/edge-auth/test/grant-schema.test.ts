/**
 * Misuse-resistance PROOFS at the schema layer (tf-r06u.27 §9): illegal
 * capability shapes are unrepresentable — they fail to decode. These are the
 * structural guarantees the rest of the auth layer leans on.
 */
import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { GrantSchema, TokenClaimsSchema } from "../src/schema.ts"

const decodeGrant = Schema.decodeUnknownEither(GrantSchema)
const decodeClaims = Schema.decodeUnknownEither(TokenClaimsSchema)

describe("Grant — illegal states unrepresentable", () => {
  it("accepts exactly the three contract grants", () => {
    expect(Either.isRight(decodeGrant({ verb: "open" }))).toBe(true)
    expect(Either.isRight(decodeGrant({ verb: "append", handleClass: "intent" }))).toBe(true)
    expect(Either.isRight(decodeGrant({ verb: "read", handleClass: "output" }))).toBe(true)
  })

  it("rejects append-to-output (the edge must NEVER write the projection)", () => {
    expect(Either.isLeft(decodeGrant({ verb: "append", handleClass: "output" }))).toBe(true)
  })

  it("rejects read-intent (pointless + widens surface)", () => {
    expect(Either.isLeft(decodeGrant({ verb: "read", handleClass: "intent" }))).toBe(true)
  })

  it("rejects open WITH a handleClass (open is class-less)", () => {
    expect(Either.isLeft(decodeGrant({ verb: "open", handleClass: "intent" }))).toBe(true)
  })

  it("has no admin / wildcard / delete / close verb to name", () => {
    for (const verb of ["admin", "*", "delete", "close", "all"]) {
      expect(Either.isLeft(decodeGrant({ verb }))).toBe(true)
      expect(Either.isLeft(decodeGrant({ verb, handleClass: "output" }))).toBe(true)
    }
  })

  it("rejects a handleClass outside {intent, output}", () => {
    expect(Either.isLeft(decodeGrant({ verb: "read", handleClass: "control" }))).toBe(true)
    expect(Either.isLeft(decodeGrant({ verb: "append", handleClass: "workflow" }))).toBe(true)
  })
})

describe("TokenClaims — closed shape", () => {
  it("requires a non-empty grant set", () => {
    expect(
      Either.isLeft(
        decodeClaims({ iss: "i", tenant: "t", tokenId: "k", grants: [] }),
      ),
    ).toBe(true)
  })

  it("rejects an empty tenant", () => {
    expect(
      Either.isLeft(
        decodeClaims({ iss: "i", tenant: "", tokenId: "k", grants: [{ verb: "open" }] }),
      ),
    ).toBe(true)
  })

  it("accepts a long-lived token (no exp) — DECIDE-4", () => {
    const decoded = decodeClaims({
      iss: "firegrid.brookhaven.prod",
      tenant: "brookhaven.prod",
      tokenId: "tok_1",
      grants: [{ verb: "open" }, { verb: "append", handleClass: "intent" }, { verb: "read", handleClass: "output" }],
    })
    expect(Either.isRight(decoded)).toBe(true)
  })
})

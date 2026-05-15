import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  SessionCreateOrLoadInputSchema,
  SessionExternalKeySchema,
  sessionContextIdForExternalKey,
} from "./schema.ts"

describe("session facade protocol schema", () => {
  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.4 derives deterministic context ids from canonical external keys", () => {
    const externalKey = Schema.decodeUnknownSync(SessionExternalKeySchema)({
      source: "linear",
      id: "LIN-123",
    })

    expect(sessionContextIdForExternalKey(externalKey)).toBe(
      sessionContextIdForExternalKey(externalKey),
    )
    expect(sessionContextIdForExternalKey(externalKey)).toMatch(/^ctx_ext_[A-Za-z0-9_-]+$/)
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.4 keeps canonical identity non-lossy for slug and separator collisions", () => {
    const slugLeft = sessionContextIdForExternalKey({ source: "a b", id: "c" })
    const slugRight = sessionContextIdForExternalKey({ source: "a_b", id: "c" })
    const separatorLeft = sessionContextIdForExternalKey({ source: "a:b", id: "c" })
    const separatorRight = sessionContextIdForExternalKey({ source: "a", id: "b:c" })

    expect(slugLeft).not.toBe(slugRight)
    expect(separatorLeft).not.toBe(separatorRight)
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.4 decodes createOrLoad through protocol schema", () => {
    const decoded = Schema.decodeUnknownSync(SessionCreateOrLoadInputSchema)({
      externalKey: { source: "linear", id: "LIN-123" },
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "-e", "console.log('ok')"],
        },
      },
      createdBy: "factory",
    })

    expect(decoded).toMatchObject({
      externalKey: { source: "linear", id: "LIN-123" },
      runtime: { provider: "local-process" },
      createdBy: "factory",
    })
  })
})

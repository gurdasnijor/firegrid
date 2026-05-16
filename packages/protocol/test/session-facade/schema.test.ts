import { describe, expect, it } from "vitest"
import { Schema, SchemaAST } from "effect"
import {
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  SessionAttachInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionExternalKeySchema,
  sessionContextIdForExternalKey,
} from "../../src/session-facade/schema.ts"

describe("session facade protocol schema", () => {
  it("firegrid-session-fact-client-surfaces.SESSION_IDENTITY.1 documents sessionId as the v1 RuntimeContext.contextId alias", () => {
    const sessionId = Schema.decodeUnknownSync(FiregridSessionIdSchema)("ctx_123")
    const runtimeContextId = Schema.decodeUnknownSync(RuntimeContextIdSchema)("ctx_123")

    expect(sessionId).toBe("ctx_123")
    expect(runtimeContextId).toBe(sessionId)
    expect(
      FiregridSessionIdSchema.ast.annotations[SchemaAST.IdentifierAnnotationId],
    ).toBe("firegrid.sessionId")
    expect(
      FiregridSessionIdSchema.ast.annotations[SchemaAST.DescriptionAnnotationId],
    ).toContain("RuntimeContext.contextId")
    expect(
      RuntimeContextIdSchema.ast.annotations[SchemaAST.DescriptionAnnotationId],
    ).toContain("sessionId")
  })

  it("firegrid-session-fact-client-surfaces.CLIENT_SESSION.3 decodes attach input through the protocol schema", () => {
    const decoded = Schema.decodeUnknownSync(SessionAttachInputSchema)({
      sessionId: "ctx_attach",
    })

    expect(decoded.sessionId).toBe("ctx_attach")
    expect(() =>
      Schema.decodeUnknownSync(SessionAttachInputSchema)({
        sessionId: "",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SessionAttachInputSchema)({
        sessionId: "ctx_attach",
        contextId: "ctx_attach",
      }),
    ).toThrow()
  })

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

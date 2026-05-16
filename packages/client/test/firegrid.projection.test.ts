import { getFiregridProjectionMetadata } from "@firegrid/protocol/operations"
import {
  SessionCreateOrLoadInputSchema,
  SessionHandlePromptInputSchema,
  SessionPermissionRespondInputSchema,
} from "@firegrid/protocol/session-facade"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FiregridClientOperations } from "../src/operations.ts"

describe("Firegrid client schema projection", () => {
  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.1 exposes namespaced client operations from the session schema catalog", () => {
    expect(FiregridClientOperations.sessions.createOrLoad.inputSchema).toBe(
      SessionCreateOrLoadInputSchema,
    )
    expect(FiregridClientOperations.sessions.promptScoped.inputSchema).toBe(
      SessionHandlePromptInputSchema,
    )
    expect(FiregridClientOperations.permissions.respondScoped.inputSchema).toBe(
      SessionPermissionRespondInputSchema,
    )
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 reads client projection metadata from Effect Schema annotations", () => {
    expect(
      getFiregridProjectionMetadata(
        FiregridClientOperations.sessions.createOrLoad.inputSchema,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "session.createOrLoad",
        clientName: "sessions.createOrLoad",
      },
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.2 decodes scoped programmer-facing permission responses through the session schema catalog", () => {
    const decoded = Schema.decodeUnknownSync(
      FiregridClientOperations.permissions.respondScoped.inputSchema,
    )({
      permissionRequestId: "permission-1",
      decision: { _tag: "Deny", reason: "not approved" },
    })

    expect(decoded).toEqual({
      permissionRequestId: "permission-1",
      decision: { _tag: "Deny", reason: "not approved" },
    })
  })
})

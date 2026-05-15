import {
  FiregridAgentToolOperations,
  PermissionRespondInputSchema,
  SessionPromptToolInputSchema,
  WaitForToolInputSchema,
} from "@firegrid/protocol/agent-tools"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FiregridClientOperations } from "./firegrid.ts"

describe("Firegrid client schema projection", () => {
  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.1 exposes namespaced client operations from the shared schema catalog", () => {
    expect(FiregridClientOperations.sessions.prompt.inputSchema).toBe(
      SessionPromptToolInputSchema,
    )
    expect(FiregridClientOperations.wait.for.inputSchema).toBe(
      WaitForToolInputSchema,
    )
    expect(FiregridClientOperations.permissions.respond.inputSchema).toBe(
      PermissionRespondInputSchema,
    )
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.2 does not introduce a client-only input schema", () => {
    expect(FiregridClientOperations.sessions.prompt).toBe(
      FiregridAgentToolOperations.sessionPrompt,
    )
    expect(FiregridClientOperations.wait.for).toBe(
      FiregridAgentToolOperations.waitFor,
    )
    expect(FiregridClientOperations.permissions.respond).toBe(
      FiregridAgentToolOperations.permissionRespond,
    )
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.3 decodes programmer-facing permission responses through the shared schema", () => {
    const decoded = Schema.decodeUnknownSync(
      FiregridClientOperations.permissions.respond.inputSchema,
    )({
      contextId: "ctx-1",
      permissionRequestId: "permission-1",
      decision: { _tag: "Deny", reason: "not approved" },
    })

    expect(decoded).toEqual({
      contextId: "ctx-1",
      permissionRequestId: "permission-1",
      decision: { _tag: "Deny", reason: "not approved" },
    })
  })
})

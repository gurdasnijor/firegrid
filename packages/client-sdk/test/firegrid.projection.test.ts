import { getFiregridProjectionMetadata } from "@firegrid/protocol/projection"
import {
  SessionAgentOutputWaitInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionHandlePromptInputSchema,
  SessionPermissionRequestWaitInputSchema,
  SessionPermissionRespondInputSchema,
} from "@firegrid/protocol/session-facade"
import {
  FiregridAgentToolOperations,
  PermissionRespondInputSchema,
  SpawnAllToolInputSchema,
  SpawnToolInputSchema,
  SessionPromptToolInputSchema,
  WaitAnyToolInputSchema,
  WaitForToolInputSchema,
  WaitUntilToolInputSchema,
} from "@firegrid/protocol/agent-tools"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

describe("Firegrid client schema projection", () => {
  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.1 exposes namespaced client metadata on canonical schemas", () => {
    expect(getFiregridProjectionMetadata(SessionCreateOrLoadInputSchema)).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "session.createOrLoad",
        clientName: "sessions.createOrLoad",
      },
    })
    expect(getFiregridProjectionMetadata(SessionHandlePromptInputSchema)).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "session.prompt.scoped",
        clientName: "session.prompt",
      },
    })
    expect(getFiregridProjectionMetadata(SessionPermissionRespondInputSchema)).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "permission.respond.scoped",
        clientName: "session.permissions.respond",
      },
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.1 exposes protocol-owned wait client operations", () => {
    expect(FiregridAgentToolOperations.waitFor.input).toBe(
      WaitForToolInputSchema,
    )
    expect(FiregridAgentToolOperations.waitUntil.input).toBe(
      WaitUntilToolInputSchema,
    )
    expect(FiregridAgentToolOperations.waitAny.input).toBe(
      WaitAnyToolInputSchema,
    )
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 projects spawn operation ids without legacy suffixes", () => {
    expect(FiregridAgentToolOperations.spawn.input).toBe(
      SpawnToolInputSchema,
    )
    expect(FiregridAgentToolOperations.spawnAll.input).toBe(
      SpawnAllToolInputSchema,
    )
    expect(
      getFiregridProjectionMetadata(
        FiregridAgentToolOperations.spawn.input,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "session.spawn",
        toolName: "spawn",
      },
    })
    expect(
      getFiregridProjectionMetadata(
        FiregridAgentToolOperations.spawnAll.input,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "session.spawnAll",
        toolName: "spawn_all",
      },
    })
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 reads client projection metadata from Effect Schema annotations", () => {
    expect(
      getFiregridProjectionMetadata(
        SessionCreateOrLoadInputSchema,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "session.createOrLoad",
        clientName: "sessions.createOrLoad",
      },
    })
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 reads wait.* projection metadata from Effect Schema annotations", () => {
    expect(
      getFiregridProjectionMetadata(
        FiregridAgentToolOperations.waitFor.input,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "wait.for",
        toolName: "wait_for",
        clientName: "wait.for",
      },
    })
    expect(
      getFiregridProjectionMetadata(
        FiregridAgentToolOperations.waitUntil.input,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "wait.until",
        toolName: "wait_until",
        clientName: "wait.until",
      },
    })
    expect(
      getFiregridProjectionMetadata(
        FiregridAgentToolOperations.waitAny.input,
      ),
    ).toMatchObject({
      _tag: "Some",
      value: {
        operationId: "wait.any",
        toolName: "wait_any",
        clientName: "wait.any",
      },
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.2 decodes scoped programmer-facing permission responses through the session schema catalog", () => {
    const decoded = Schema.decodeUnknownSync(
      SessionPermissionRespondInputSchema,
    )({
      permissionRequestId: "permission-1",
      decision: { _tag: "Deny", reason: "not approved" },
    })

    expect(decoded).toEqual({
      permissionRequestId: "permission-1",
      decision: { _tag: "Deny", reason: "not approved" },
    })
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.1 keeps direct client schemas annotated", () => {
    const inputs = [
      SessionCreateOrLoadInputSchema,
      SessionPromptToolInputSchema,
      SessionHandlePromptInputSchema,
      SessionPermissionRequestWaitInputSchema,
      SessionAgentOutputWaitInputSchema,
      PermissionRespondInputSchema,
      SessionPermissionRespondInputSchema,
    ]
    for (const input of inputs) {
      expect(getFiregridProjectionMetadata(input)).toMatchObject({ _tag: "Some" })
    }
  })
})

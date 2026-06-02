import { getFiregridProjectionMetadata } from "@firegrid/protocol/projection"
import {
  SessionCreateOrLoadInputSchema,
  SessionHandlePromptInputSchema,
  SessionPermissionRespondInputSchema,
} from "@firegrid/protocol/session-facade"
import {
  FiregridAgentToolOperations,
  SpawnAllToolInputSchema,
  SpawnToolInputSchema,
  WaitAnyToolInputSchema,
  WaitForToolInputSchema,
  WaitUntilToolInputSchema,
} from "@firegrid/protocol/agent-tools"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FiregridClientOperations } from "../src/operations.ts"

describe("Firegrid client schema projection", () => {
  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.1 exposes namespaced client operations from the session schema catalog", () => {
    expect(FiregridClientOperations.sessions.createOrLoad.input).toBe(
      SessionCreateOrLoadInputSchema,
    )
    expect(FiregridClientOperations.sessions.promptScoped.input).toBe(
      SessionHandlePromptInputSchema,
    )
    expect(FiregridClientOperations.permissions.respondScoped.input).toBe(
      SessionPermissionRespondInputSchema,
    )
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
        FiregridClientOperations.sessions.createOrLoad.input,
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
      FiregridClientOperations.permissions.respondScoped.input,
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

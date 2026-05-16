import { describe, expect, it } from "vitest"
import { Option, Schema, SchemaAST } from "effect"
import {
  PermissionRespondInputSchema,
  SessionPromptToolInputSchema,
} from "../../src/agent-tools/schema.ts"
import { getFiregridProjectionMetadata } from "../../src/operations/schema.ts"
import { FiregridClientOperations } from "../../src/session-facade/operations.ts"
import {
  RuntimeAgentOutputObservationSchema,
  RuntimePermissionRequestObservationSchema,
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  SessionAttachInputSchema,
  SessionAgentOutputWaitInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionExternalKeySchema,
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  runtimePermissionRequestObservationFromAgentOutput,
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

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.1 firegrid-schema-projection-contract.SCHEMA_CATALOG.3 defines client operations from protocol schemas without copying agent-tool shapes", () => {
    expect(FiregridClientOperations.sessions.createOrLoad.inputSchema).toBe(
      SessionCreateOrLoadInputSchema,
    )
    expect(FiregridClientOperations.sessions.prompt.inputSchema).toBe(
      SessionPromptToolInputSchema,
    )
    expect(FiregridClientOperations.wait.forAgentOutput.inputSchema).toBe(
      SessionAgentOutputWaitInputSchema,
    )
    expect(FiregridClientOperations.permissions.respond.inputSchema).toBe(
      PermissionRespondInputSchema,
    )
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 stores client projection metadata on session Effect Schemas", () => {
    const createOrLoad = Option.getOrThrow(
      getFiregridProjectionMetadata(SessionCreateOrLoadInputSchema),
    )
    const waitForAgentOutput = Option.getOrThrow(
      getFiregridProjectionMetadata(SessionAgentOutputWaitInputSchema),
    )

    expect(createOrLoad).toEqual({
      operationId: "session.createOrLoad",
      clientName: "sessions.createOrLoad",
    })
    expect(waitForAgentOutput).toEqual({
      operationId: "session.wait.forAgentOutput",
      clientName: "session.wait.forAgentOutput",
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.1 projects normalized agent-output observations from RuntimeOutput rows", () => {
    const observation = runtimeAgentOutputObservationFromRow({
      eventId: {
        contextId: "ctx_projection",
        activityAttempt: 1,
        target: "events",
        sequence: 2,
      },
      contextId: "ctx_projection",
      activityAttempt: 1,
      sequence: 2,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-16T00:00:00.000Z",
      raw: encodeRuntimeAgentOutputEnvelope({
        _tag: "ToolUse",
        part: {
          id: "tool-1",
          name: "wait_for",
        },
      }),
    })

    expect(Option.isSome(observation)).toBe(true)
    if (Option.isNone(observation)) return
    expect(Schema.decodeUnknownSync(RuntimeAgentOutputObservationSchema)(
      observation.value,
    )).toMatchObject({
      source: "firegrid.runtime.agent-output-events",
      sessionId: "ctx_projection",
      contextId: "ctx_projection",
      sequence: 2,
      _tag: "ToolUse",
      toolUseId: "tool-1",
      toolName: "wait_for",
    })
  })

  it("firegrid-session-fact-client-surfaces.RUNTIME_OBSERVATION.2 projects PermissionRequest options and resume anchors", () => {
    const output = runtimeAgentOutputObservationFromRow({
      eventId: {
        contextId: "ctx_permission",
        activityAttempt: 1,
        target: "events",
        sequence: 3,
      },
      contextId: "ctx_permission",
      activityAttempt: 1,
      sequence: 3,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-16T00:00:00.000Z",
      raw: encodeRuntimeAgentOutputEnvelope({
        _tag: "PermissionRequest",
        permissionRequestId: "permission-1",
        toolUseId: "tool-1",
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
        ],
      }),
    })

    expect(Option.isSome(output)).toBe(true)
    if (Option.isNone(output)) return
    const permission = runtimePermissionRequestObservationFromAgentOutput(output.value)
    expect(Option.isSome(permission)).toBe(true)
    if (Option.isNone(permission)) return
    expect(Schema.decodeUnknownSync(RuntimePermissionRequestObservationSchema)(
      permission.value,
    )).toMatchObject({
      sessionId: "ctx_permission",
      contextId: "ctx_permission",
      sequence: 3,
      permissionRequestId: "permission-1",
      toolUseId: "tool-1",
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
      ],
    })
  })

  it("firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.3 decodes session agent-output wait input", () => {
    expect(Schema.decodeUnknownSync(SessionAgentOutputWaitInputSchema)({
      afterSequence: 1,
      timeoutMs: 30_000,
    })).toEqual({
      afterSequence: 1,
      timeoutMs: 30_000,
    })
  })
})

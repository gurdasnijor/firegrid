import { Prompt, Response } from "@effect/ai"
import { describe, expect, it } from "vitest"
import { Option, Schema, SchemaAST } from "effect"
import {
  PermissionRespondInputSchema,
  SessionPromptToolInputSchema,
} from "../../src/agent-tools/schema.ts"
import { getFiregridProjectionMetadata } from "../../src/projection/schema.ts"
import { FiregridClientOperations } from "../../src/session-facade/operations.ts"
import {
  RuntimePermissionRequestObservationSchema,
  type RuntimeAgentOutputObservation,
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  SessionAttachInputSchema,
  SessionAgentOutputWaitInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionExternalKeySchema,
  decodeRuntimeAgentOutputEnvelope,
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  runtimePermissionRequestObservationFromAgentOutput,
  sessionContextIdForExternalKey,
  tryDecodeRuntimeAgentOutputEnvelope,
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
        part: Prompt.toolCallPart({
          id: "tool-1",
          name: "wait_for",
          params: {},
          providerExecuted: false,
        }),
      }),
    })

    expect(Option.isSome(observation)).toBe(true)
    if (Option.isNone(observation)) return
    // TFIND-030: `event` is now the typed union (a decoded Effect-AI
    // `ToolCallPart` class for ToolUse). Assert the projected observation
    // directly rather than re-decoding a Schema class instance back through
    // the strict (`onExcessProperty: "error"`) observation schema.
    expect(observation.value).toMatchObject({
      source: "firegrid.runtime.agent-output-events",
      sessionId: "ctx_projection",
      contextId: "ctx_projection",
      sequence: 2,
      _tag: "ToolUse",
      toolUseId: "tool-1",
      toolName: "wait_for",
    })
  })

  it("TFIND-047 exposes correlated agent-output observation narrowing from the outer tag", () => {
    const textDeltaFromObservation = (
      observation: RuntimeAgentOutputObservation,
    ): string | undefined => {
      if (observation._tag !== "TextChunk") return undefined
      return observation.event.part.delta
    }
    const toolNameFromObservation = (
      observation: RuntimeAgentOutputObservation,
    ): string | undefined => {
      if (observation._tag !== "ToolUse") return undefined
      return observation.event.part.name
    }

    const text = runtimeAgentOutputObservationFromRow({
      eventId: {
        contextId: "ctx_text",
        activityAttempt: 1,
        target: "events",
        sequence: 1,
      },
      contextId: "ctx_text",
      activityAttempt: 1,
      sequence: 1,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-16T00:00:00.000Z",
      raw: encodeRuntimeAgentOutputEnvelope({
        _tag: "TextChunk",
        part: Response.textDeltaPart({ id: "part-1", delta: "hello" }),
      }),
    })
    const tool = runtimeAgentOutputObservationFromRow({
      eventId: {
        contextId: "ctx_tool",
        activityAttempt: 1,
        target: "events",
        sequence: 2,
      },
      contextId: "ctx_tool",
      activityAttempt: 1,
      sequence: 2,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-16T00:00:00.000Z",
      raw: encodeRuntimeAgentOutputEnvelope({
        _tag: "ToolUse",
        part: Prompt.toolCallPart({
          id: "tool-1",
          name: "wait_for",
          params: {},
          providerExecuted: false,
        }),
      }),
    })

    expect(Option.isSome(text)).toBe(true)
    expect(Option.isSome(tool)).toBe(true)
    if (Option.isNone(text) || Option.isNone(tool)) return
    expect(textDeltaFromObservation(text.value)).toBe("hello")
    expect(toolNameFromObservation(tool.value)).toBe("wait_for")
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

  it("TFIND-030 firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.1 strictly rejects an envelope whose event is not a known AgentOutputEvent", () => {
    // Wire JSON with a non-conforming event. The strict encoder cannot
    // produce this, so the envelope is hand-built to model a malformed/
    // unknown producer event reaching the client read path.
    const raw = JSON.stringify({
      type: "firegrid.agent-output",
      event: { _tag: "NotARealAgentOutputEvent", whatever: true },
    })

    // Decode rejects (no opaque-record pass-through).
    expect(Option.isNone(decodeRuntimeAgentOutputEnvelope(raw))).toBe(true)

    // And the projection therefore yields no observation.
    const observation = runtimeAgentOutputObservationFromRow({
      eventId: {
        contextId: "ctx_reject",
        activityAttempt: 1,
        target: "events",
        sequence: 1,
      },
      contextId: "ctx_reject",
      activityAttempt: 1,
      sequence: 1,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-16T00:00:00.000Z",
      raw,
    })
    expect(Option.isNone(observation)).toBe(true)
  })

  it("TFIND-030 decoded agent-output event is the typed union, not an opaque record", () => {
    const decoded = decodeRuntimeAgentOutputEnvelope(
      encodeRuntimeAgentOutputEnvelope({
        _tag: "Status",
        kind: "thinking",
      }),
    )
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) return
    // Discriminated access without a record cast.
    expect(decoded.value._tag).toBe("Status")
    if (decoded.value._tag === "Status") {
      expect(decoded.value.kind).toBe("thinking")
    }
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

  // tf-8s7d: AgentOutputEvent schema migration path —
  // forward-compatibility for future `_tag` variants per the tf-ypq9
  // schema-evolution policy (replay-facing rows must decode across
  // version boundaries).
  describe("tf-8s7d agent-output forward-compatibility (future _tag rows)", () => {
    // Hand-built envelope using a `_tag` value the current
    // AgentOutputEventSchema does NOT declare. Stands in for a row written
    // by a future Firegrid version that has added a new variant. The
    // string is JSON-encoded the same way encodeRuntimeAgentOutputEnvelope
    // would encode it, so the only difference vs a real envelope is the
    // unknown _tag.
    const futureRowRaw = JSON.stringify({
      type: "firegrid.agent-output",
      event: {
        _tag: "FutureNewVariant",
        someNewField: "future-payload",
        nested: { deep: 1 },
      },
    })

    it("STRICT decoder REJECTS a row with an unknown _tag (proves the original failure mode)", () => {
      const decoded = decodeRuntimeAgentOutputEnvelope(futureRowRaw)
      expect(Option.isNone(decoded)).toBe(true)
    })

    it("FORGIVING decoder accepts the same row and surfaces it as AgentOutputUnknown carrying the original tag + payload", () => {
      const decoded = tryDecodeRuntimeAgentOutputEnvelope(futureRowRaw)
      expect(Option.isSome(decoded)).toBe(true)
      if (Option.isNone(decoded)) return
      const event = decoded.value
      expect(event._tag).toBe("AgentOutputUnknown")
      if (event._tag !== "AgentOutputUnknown") return
      expect(event.unknownTag).toBe("FutureNewVariant")
      expect(event.payload).toEqual({
        someNewField: "future-payload",
        nested: { deep: 1 },
      })
    })

    it("FORGIVING decoder still strictly decodes a KNOWN _tag (no regression — known variants stay typed)", () => {
      const decoded = tryDecodeRuntimeAgentOutputEnvelope(
        encodeRuntimeAgentOutputEnvelope({
          _tag: "Status",
          kind: "thinking",
        }),
      )
      expect(Option.isSome(decoded)).toBe(true)
      if (Option.isNone(decoded)) return
      expect(decoded.value._tag).toBe("Status")
      // AgentUnknownEvent has `unknownTag` — its absence proves the strict
      // path took precedence over the fallback for a known _tag.
      expect((decoded.value as { unknownTag?: string }).unknownTag).toBeUndefined()
    })

    it("FORGIVING decoder rejects malformed envelopes (missing event, wrong outer type, empty _tag)", () => {
      // Missing top-level `event`
      expect(
        Option.isNone(
          tryDecodeRuntimeAgentOutputEnvelope(
            JSON.stringify({ type: "firegrid.agent-output" }),
          ),
        ),
      ).toBe(true)
      // Wrong outer type discriminator
      expect(
        Option.isNone(
          tryDecodeRuntimeAgentOutputEnvelope(
            JSON.stringify({
              type: "not.firegrid",
              event: { _tag: "FutureNewVariant" },
            }),
          ),
        ),
      ).toBe(true)
      // Event has _tag but it's empty
      expect(
        Option.isNone(
          tryDecodeRuntimeAgentOutputEnvelope(
            JSON.stringify({
              type: "firegrid.agent-output",
              event: { _tag: "" },
            }),
          ),
        ),
      ).toBe(true)
      // Not JSON at all
      expect(
        Option.isNone(
          tryDecodeRuntimeAgentOutputEnvelope("not-json{{{"),
        ),
      ).toBe(true)
    })

    it("runtimeAgentOutputObservationFromRow returns Option.none for an unknown _tag row (does not crash, does not surface unknowns into the typed observation)", () => {
      const observation = runtimeAgentOutputObservationFromRow({
        eventId: {
          contextId: "ctx_future",
          activityAttempt: 1,
          target: "events",
          sequence: 1,
        },
        contextId: "ctx_future",
        activityAttempt: 1,
        sequence: 1,
        source: "stdout",
        format: "jsonl",
        receivedAt: "2026-05-21T00:00:00.000Z",
        raw: futureRowRaw,
      })
      expect(Option.isNone(observation)).toBe(true)
    })
  })
})

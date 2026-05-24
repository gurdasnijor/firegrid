/**
 * Tests for shared agent-tool input/output schemas.
 *
 * These schemas are the source of truth for Firegrid agent-tool shapes.
 */

import { Effect, JSONSchema, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { getFiregridProjectionMetadata } from "../../src/projection/schema.ts"
import {
  ApprovalCallOutputSchema,
  ApprovalCallRequestSchema,
  CallToolInputSchema,
  CallToolOutputSchema,
  ExecuteToolInputSchema,
  ExecuteToolOutputSchema,
  FiregridAgentToolOperations,
  PermissionRespondInputSchema,
  PermissionRespondOutputSchema,
  SandboxRefSchema,
  ScheduleMeToolInputSchema,
  ScheduleMeToolOutputSchema,
  SendToolInputSchema,
  SendToolOutputSchema,
  SessionCancelToolInputSchema,
  SessionCancelToolOutputSchema,
  SessionCloseToolInputSchema,
  SessionCloseToolOutputSchema,
  SessionHandleSchema,
  SessionNewToolInputSchema,
  SessionNewToolOutputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
  SleepToolInputSchema,
  SleepToolOutputSchema,
  SpawnAllToolInputSchema,
  SpawnAllToolOutputSchema,
  SpawnTaskSchema,
  SpawnToolInputSchema,
  SpawnToolOutputSchema,
  WaitForAnyToolInputSchema,
  WaitForAnyToolOutputSchema,
  WaitForToolMatchSchema,
  WaitForToolInputSchema,
  WaitForToolOutputSchema,
  WorkflowTerminalStateSchema,
} from "../../src/agent-tools/schema.ts"

const decodes = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Promise<A> =>
  Effect.runPromise(Schema.decodeUnknown(schema)(input))

const rejects = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Promise<unknown> =>
  Effect.runPromise(Effect.flip(Schema.decodeUnknown(schema)(input)))

describe("agent-tool schemas — sleep", () => {
  it("accepts a non-negative integer duration", async () => {
    const decoded = await decodes(SleepToolInputSchema, { durationMs: 500 })
    expect(decoded).toEqual({ durationMs: 500 })
  })

  it("rejects a negative duration", async () => {
    const error = await rejects(SleepToolInputSchema, { durationMs: -1 })
    expect(error).toBeDefined()
  })

  it("rejects a non-integer duration", async () => {
    const error = await rejects(SleepToolInputSchema, { durationMs: 0.5 })
    expect(error).toBeDefined()
  })

  it("output requires slept:true literal", async () => {
    const decoded = await decodes(SleepToolOutputSchema, { slept: true })
    expect(decoded).toEqual({ slept: true })
    const error = await rejects(SleepToolOutputSchema, { slept: false })
    expect(error).toBeDefined()
  })

  it("exposes encoded JSON schema via Schema.encodedSchema", () => {
    // The catalog publication path (Phase 2) projects encodedSchema to
    // build agent-callable JSON shapes. Verify the projection compiles.
    const encoded = Schema.encodedSchema(SleepToolInputSchema)
    expect(encoded).toBeDefined()
  })

  it("annotations are present on the input schema", () => {
    const ast = SleepToolInputSchema.ast
    expect(ast.annotations).toBeDefined()
  })
})

describe("agent-tool schemas — wait_for", () => {
  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.1 accepts channel, optional match, and optional timeoutMs", async () => {
    const decoded = await decodes(WaitForToolInputSchema, {
      channel: "factory.events",
      match: { eventType: "factory.run.approved" },
      timeoutMs: 30_000,
    })
    expect(decoded.channel).toBe("factory.events")
    expect(decoded.match).toEqual({ eventType: "factory.run.approved" })
    expect(decoded.timeoutMs).toBe(30_000)
  })

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.4 accepts discovery shape without match and with timeoutMs:0", async () => {
    const decoded = await decodes(WaitForToolInputSchema, {
      channel: "factory.events",
      timeoutMs: 0,
    })
    expect(decoded.channel).toBe("factory.events")
    expect(decoded.match).toBeUndefined()
    expect(decoded.timeoutMs).toBe(0)
  })

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.2 rejects the old source-shaped wait_for input", async () => {
    const error = await rejects(WaitForToolInputSchema, {
      waitQuery: {
        source: { _tag: "CallerFact", stream: "darkFactory.facts" },
        whereFields: {},
      },
    })
    expect(error).toBeDefined()
  })

  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.1 firegrid-agent-body-plan.WAIT_FOR_CHANNEL.2 projects channel-only JSON schema for tools/list", () => {
    const jsonSchema = JSONSchema.make(WaitForToolInputSchema)
    const text = JSON.stringify(jsonSchema)
    expect(text).toContain("\"channel\"")
    expect(text).toContain("\"match\"")
    expect(text).toContain("\"timeoutMs\"")
    expect(text).not.toContain("\"source\"")
    expect(text).not.toContain("\"stream\"")
  })

  it("accepts arbitrary match values at the protocol boundary", async () => {
    const decoded = await decodes(WaitForToolMatchSchema, {
      nested: { value: "tool lowering validates scalar-only predicates" },
    })
    expect(decoded).toEqual({
      nested: { value: "tool lowering validates scalar-only predicates" },
    })
  })

  it("output accepts matched:true with event payload", async () => {
    const decoded = await decodes(WaitForToolOutputSchema, {
      matched: true,
      event: { foo: 1 },
    })
    expect(decoded).toEqual({ matched: true, event: { foo: 1 } })
  })

  it("output accepts matched:false with timedOut:true", async () => {
    const decoded = await decodes(WaitForToolOutputSchema, {
      matched: false,
      timedOut: true,
    })
    expect(decoded).toEqual({ matched: false, timedOut: true })
  })
})

describe("schema projection metadata", () => {
  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 reads Firegrid projection metadata from Effect Schema annotations", () => {
    const metadata = Option.getOrThrow(
      getFiregridProjectionMetadata(SessionPromptToolInputSchema),
    )
    expect(metadata).toEqual({
      operationId: "session.prompt",
      toolName: "session_prompt",
      clientName: "sessions.prompt",
      cliName: "sessions prompt",
    })
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.2 keeps descriptions and examples on the operation entry", () => {
    expect(FiregridAgentToolOperations.waitFor.description).toContain(
      "host-declared channel",
    )
    expect(FiregridAgentToolOperations.waitFor.examples).toHaveLength(2)
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.3 compatibility-exports existing schemas as catalog entries", () => {
    expect(FiregridAgentToolOperations.send.inputSchema).toBe(
      SendToolInputSchema,
    )
    expect(FiregridAgentToolOperations.send.outputSchema).toBe(
      SendToolOutputSchema,
    )
    expect(FiregridAgentToolOperations.waitForAny.inputSchema).toBe(
      WaitForAnyToolInputSchema,
    )
    expect(FiregridAgentToolOperations.waitForAny.outputSchema).toBe(
      WaitForAnyToolOutputSchema,
    )
    expect(FiregridAgentToolOperations.sessionPrompt.inputSchema).toBe(
      SessionPromptToolInputSchema,
    )
    expect(FiregridAgentToolOperations.sessionPrompt.outputSchema).toBe(
      SessionPromptToolOutputSchema,
    )
  })

  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.1 includes permission response as a client-facing operation", async () => {
    const input = await decodes(PermissionRespondInputSchema, {
      contextId: "ctx-1",
      permissionRequestId: "permission-1",
      decision: { _tag: "Allow", optionId: "allow_once" },
    })
    expect(input.permissionRequestId).toBe("permission-1")
    const output = await decodes(PermissionRespondOutputSchema, {
      responded: true,
      contextId: "ctx-1",
      permissionRequestId: "permission-1",
      inputId: "input-1",
    })
    expect(output.responded).toBe(true)
  })
})

describe("agent-tool schemas — spawn", () => {
  it("accepts minimum required fields", async () => {
    const decoded = await decodes(SpawnToolInputSchema, {
      agentKind: "stdio-jsonl",
      prompt: "hello",
    })
    expect(decoded.agentKind).toBe("stdio-jsonl")
    expect(decoded.options).toBeUndefined()
  })

  it("rejects empty agentKind", async () => {
    const error = await rejects(SpawnToolInputSchema, {
      agentKind: "",
      prompt: "hi",
    })
    expect(error).toBeDefined()
  })

  it("accepts optional spawn options", async () => {
    const decoded = await decodes(SpawnToolInputSchema, {
      agentKind: "stdio-jsonl",
      prompt: "hi",
      options: { cwd: "/tmp", metadata: { foo: "bar" } },
    })
    expect(decoded.options?.cwd).toBe("/tmp")
  })

  it("output carries terminal state", async () => {
    const decoded = await decodes(SpawnToolOutputSchema, {
      childContextId: "child-1",
      terminalState: { _tag: "Completed", output: { ok: true } },
    })
    expect(decoded.terminalState._tag).toBe("Completed")
  })
})

describe("agent-tool schemas — spawn_all", () => {
  it("requires at least one task", async () => {
    const error = await rejects(SpawnAllToolInputSchema, { tasks: [] })
    expect(error).toBeDefined()
  })

  it("accepts tasks with optional keys", async () => {
    const decoded = await decodes(SpawnAllToolInputSchema, {
      tasks: [
        { agentKind: "stdio-jsonl", prompt: "a", key: "alpha" },
        { agentKind: "stdio-jsonl", prompt: "b" },
      ],
    })
    expect(decoded.tasks).toHaveLength(2)
  })

  it("task schema rejects empty agentKind", async () => {
    const error = await rejects(SpawnTaskSchema, {
      agentKind: "",
      prompt: "hi",
    })
    expect(error).toBeDefined()
  })

  it("output aggregates per-child results", async () => {
    const decoded = await decodes(SpawnAllToolOutputSchema, {
      children: [
        {
          key: "alpha",
          childContextId: "c-1",
          terminalState: { _tag: "Cancelled" },
        },
      ],
    })
    expect(decoded.children).toHaveLength(1)
  })
})

describe("agent-tool schemas — session plane", () => {
  it("firegrid-factory-aligned-agent-tools.SESSION.7 decodes a session handle", async () => {
    const decoded = await decodes(SessionHandleSchema, {
      sessionId: "ctx-child",
      contextId: "ctx-child",
      status: "done",
      metadata: { correlationId: "corr-1" },
      terminalState: { _tag: "Completed", output: { ok: true } },
    })
    expect(decoded.sessionId).toBe("ctx-child")
    expect(decoded.contextId).toBe("ctx-child")
  })

  it("decodes session_new input and output", async () => {
    const input = await decodes(SessionNewToolInputSchema, {
      agentKind: "stdio-jsonl",
      prompt: "start",
      options: { metadata: { parent: "ctx-parent" } },
    })
    expect(input.agentKind).toBe("stdio-jsonl")
    const output = await decodes(SessionNewToolOutputSchema, {
      session: {
        sessionId: "ctx-child",
        contextId: "ctx-child",
        status: "running",
      },
    })
    expect(output.session.sessionId).toBe("ctx-child")
  })

  it("firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2 decodes session_prompt input and output", async () => {
    const input = await decodes(SessionPromptToolInputSchema, {
      sessionId: "ctx-child",
      prompt: "continue",
      inputId: "input-1",
    })
    expect(input.sessionId).toBe("ctx-child")
    const output = await decodes(SessionPromptToolOutputSchema, {
      appended: true,
      sessionId: "ctx-child",
      inputId: "input-1",
    })
    expect(output.appended).toBe(true)
  })

  it("decodes session_cancel and session_close shapes", async () => {
    const cancel = await decodes(SessionCancelToolInputSchema, {
      sessionId: "ctx-child",
      reason: "stop",
    })
    expect(cancel.reason).toBe("stop")
    const cancelOutput = await decodes(SessionCancelToolOutputSchema, {
      cancelled: true,
      sessionId: "ctx-child",
    })
    expect(cancelOutput.cancelled).toBe(true)

    const close = await decodes(SessionCloseToolInputSchema, {
      sessionId: "ctx-child",
      reason: "done",
    })
    expect(close.reason).toBe("done")
    const closeOutput = await decodes(SessionCloseToolOutputSchema, {
      closed: true,
      sessionId: "ctx-child",
    })
    expect(closeOutput.closed).toBe(true)
  })
})

describe("agent-tool schemas — schedule_me", () => {
  it("requires a non-negative integer when", async () => {
    const decoded = await decodes(ScheduleMeToolInputSchema, {
      when: 1_700_000_000_000,
      prompt: "follow up",
    })
    expect(decoded.when).toBe(1_700_000_000_000)
  })

  it("rejects empty prompt", async () => {
    const error = await rejects(ScheduleMeToolInputSchema, {
      when: 0,
      prompt: "",
    })
    expect(error).toBeDefined()
  })

  it("output carries scheduleId", async () => {
    const decoded = await decodes(ScheduleMeToolOutputSchema, {
      scheduled: true,
      scheduleId: "sched-1",
    })
    expect(decoded.scheduleId).toBe("sched-1")
  })
})

describe("agent-tool schemas — execute", () => {
  it("accepts legacy sandbox ref + arbitrary input", async () => {
    const decoded = await decodes(ExecuteToolInputSchema, {
      sandbox: { providerName: "local-process", toolName: "shell" },
      input: { command: "echo" },
    })
    expect(decoded).toMatchObject({
      sandbox: { providerName: "local-process", toolName: "shell" },
    })
  })

  it("firegrid-factory-aligned-agent-tools.CAPABILITY.2 accepts session-bound capability input", async () => {
    const decoded = await decodes(ExecuteToolInputSchema, {
      sessionId: "ctx-child",
      capability: { kind: "terminal", name: "primary" },
      input: { command: "pwd" },
    })
    expect(decoded).toMatchObject({
      sessionId: "ctx-child",
      capability: { kind: "terminal", name: "primary" },
    })
  })

  it("rejects empty provider or tool name", async () => {
    const error = await rejects(SandboxRefSchema, {
      providerName: "",
      toolName: "shell",
    })
    expect(error).toBeDefined()
  })

  it("output accepts any unknown payload", async () => {
    const decoded = await decodes(ExecuteToolOutputSchema, { foo: 1 })
    expect(decoded).toEqual({ foo: 1 })
  })
})

describe("agent-tool schemas — call approval", () => {
  it("firegrid-agent-body-plan.SLICE_D_VERBS.1 firegrid-agent-body-plan.SLICE_D_VERBS.3 decodes generic call input", async () => {
    const decoded = await decodes(CallToolInputSchema, {
      channel: "approval.operator",
      request: {
        decision: { _tag: "Allow", optionId: "allow_once" },
        timeoutMs: 1000,
      },
    })
    expect(decoded.channel).toBe("approval.operator")
    expect(decoded.request).toEqual({
      decision: { _tag: "Allow", optionId: "allow_once" },
      timeoutMs: 1000,
    })
  })

  it("firegrid-agent-body-plan.APPROVAL_CALL.1 rejects an empty call channel target", async () => {
    const error = await rejects(CallToolInputSchema, {
      channel: "",
      request: {
        decision: { _tag: "Allow" },
      },
    })
    expect(error).toBeDefined()
  })

  it("firegrid-agent-body-plan.APPROVAL_CALL.2 decodes approval request and output variants", async () => {
    const request = await decodes(ApprovalCallRequestSchema, {
      decision: { _tag: "Deny", reason: "no" },
      afterSequence: 2,
    })
    expect(request.afterSequence).toBe(2)

    const matched = await decodes(ApprovalCallOutputSchema, {
      matched: true,
      request: {
        contextId: "ctx-1",
        activityAttempt: 1,
        sequence: 3,
        permissionRequestId: "permission-1",
        toolUseId: "tool-1",
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        ],
      },
      response: {
        responded: true,
        contextId: "ctx-1",
        permissionRequestId: "permission-1",
        inputId: "input-1",
      },
    })
    expect(matched.matched).toBe(true)

    const timedOut = await decodes(CallToolOutputSchema, {
      matched: false,
      timedOut: true,
    })
    expect(timedOut).toEqual({ matched: false, timedOut: true })
  })
})

describe("agent-tool schemas — Slice D channel verbs", () => {
  it("firegrid-agent-body-plan.SLICE_D_VERBS.1 firegrid-agent-body-plan.SLICE_D_VERBS.2 decodes send input and output", async () => {
    const input = await decodes(SendToolInputSchema, {
      channel: "factory.events",
      payload: { eventType: "ready", payload: { ok: true } },
    })
    expect(input.channel).toBe("factory.events")
    expect(input.payload).toEqual({
      eventType: "ready",
      payload: { ok: true },
    })

    const output = await decodes(SendToolOutputSchema, {
      sent: true,
      channel: "factory.events",
    })
    expect(output).toEqual({ sent: true, channel: "factory.events" })
  })

  it("firegrid-agent-body-plan.SLICE_D_VERBS.1 firegrid-agent-body-plan.SLICE_D_VERBS.4 decodes wait_for_any input and output", async () => {
    const input = await decodes(WaitForAnyToolInputSchema, {
      channels: [
        { channel: "state.changes", match: { status: "ready" } },
        { channel: "factory.events" },
      ],
      timeoutMs: 250,
    })
    expect(input.channels).toHaveLength(2)
    expect(input.channels[0]?.match).toEqual({ status: "ready" })

    const output = await decodes(WaitForAnyToolOutputSchema, {
      winnerIndex: 1,
      channel: "factory.events",
      result: { eventType: "approved" },
    })
    expect(output).toEqual({
      winnerIndex: 1,
      channel: "factory.events",
      result: { eventType: "approved" },
    })
  })

  it("firegrid-agent-body-plan.SLICE_D_VERBS.4 requires at least one wait_for_any descriptor", async () => {
    const error = await rejects(WaitForAnyToolInputSchema, { channels: [] })
    expect(error).toBeDefined()
  })
})

describe("workflow terminal state", () => {
  it("accepts Failed with structured error", async () => {
    const decoded = await decodes(WorkflowTerminalStateSchema, {
      _tag: "Failed",
      error: { message: "boom", code: "E_BOOM" },
    })
    expect(decoded._tag).toBe("Failed")
  })
})

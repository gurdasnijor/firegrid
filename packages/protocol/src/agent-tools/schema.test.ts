/**
 * Tests for shared agent-tool input/output schemas.
 *
 * These schemas are the source of truth for the six canonical Firegrid
 * agent tools' shapes. Phase 2 will build a keyed `FiregridAgentTools`
 * manifest on top of them.
 */

import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  EventQuerySchema,
  ExecuteToolInputSchema,
  ExecuteToolOutputSchema,
  SandboxRefSchema,
  ScheduleMeToolInputSchema,
  ScheduleMeToolOutputSchema,
  SleepToolInputSchema,
  SleepToolOutputSchema,
  SpawnAllToolInputSchema,
  SpawnAllToolOutputSchema,
  SpawnTaskSchema,
  SpawnToolInputSchema,
  SpawnToolOutputSchema,
  WaitForToolInputSchema,
  WaitForToolOutputSchema,
  WorkflowTerminalStateSchema,
} from "./schema.ts"

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
  it("accepts a query with stream and whereFields", async () => {
    const decoded = await decodes(WaitForToolInputSchema, {
      eventQuery: { stream: "ns.events", whereFields: { type: "Issue.updated" } },
      timeoutMs: 30_000,
    })
    expect(decoded.eventQuery.stream).toBe("ns.events")
    expect(decoded.timeoutMs).toBe(30_000)
  })

  it("accepts a query without optional timeout", async () => {
    const decoded = await decodes(WaitForToolInputSchema, {
      eventQuery: { stream: "ns.events", whereFields: {} },
    })
    expect(decoded.timeoutMs).toBeUndefined()
  })

  it("rejects empty stream name", async () => {
    const error = await rejects(EventQuerySchema, {
      stream: "",
      whereFields: {},
    })
    expect(error).toBeDefined()
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
  it("requires sandbox ref + arbitrary input", async () => {
    const decoded = await decodes(ExecuteToolInputSchema, {
      sandbox: { providerName: "local-process", toolName: "shell" },
      input: { command: "echo" },
    })
    expect(decoded.sandbox.providerName).toBe("local-process")
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

describe("workflow terminal state", () => {
  it("accepts Failed with structured error", async () => {
    const decoded = await decodes(WorkflowTerminalStateSchema, {
      _tag: "Failed",
      error: { message: "boom", code: "E_BOOM" },
    })
    expect(decoded._tag).toBe("Failed")
  })
})

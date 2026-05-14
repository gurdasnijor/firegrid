/**
 * Tests for the canonical Firegrid agent-tool descriptor manifest.
 *
 * Spec: agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"Canonical descriptors"
 *
 * Schema round-trip is the load-bearing check: every descriptor in
 * `FiregridAgentTools` must accept the SDD-documented "happy-path"
 * shape and reject obviously wrong shapes. The schemas themselves live
 * in `@firegrid/protocol/agent-tools`; these tests confirm the
 * descriptor manifest binds them correctly without duplicating shapes.
 */

import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  FiregridAgentTools,
  firegridAgentToolCatalog,
  firegridAgentToolNames,
} from "./descriptors.ts"

const decodes = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(schema)(input))

const rejects = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Effect.runPromise(Effect.flip(Schema.decodeUnknown(schema)(input)))

describe("FiregridAgentTools", () => {
  it("manifests exactly the six canonical tools", () => {
    expect(firegridAgentToolNames).toEqual([
      "sleep",
      "wait_for",
      "spawn",
      "spawn_all",
      "schedule_me",
      "execute",
    ])
  })

  it("catalog projection matches the manifest ordering", () => {
    expect(firegridAgentToolCatalog).toHaveLength(6)
    expect(firegridAgentToolCatalog.map((d) => d.name)).toEqual(
      firegridAgentToolNames,
    )
  })

  it("descriptor fields are limited to the neutral binding shape", () => {
    // firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4 —
    // descriptor must not carry credentials, callback tokens, transport
    // refs, sandbox handles, or provider session tokens.
    for (const descriptor of firegridAgentToolCatalog) {
      const keys = Object.keys(descriptor)
      expect(keys.sort()).toEqual(
        [
          "capabilities",
          "description",
          "inputSchema",
          "name",
          "outputSchema",
          "stability",
        ].sort(),
      )
    }
  })
})

describe("sleep descriptor", () => {
  const { inputSchema, outputSchema } = FiregridAgentTools.sleep
  it("accepts a non-negative integer duration", async () => {
    expect(await decodes(inputSchema, { durationMs: 100 })).toEqual({
      durationMs: 100,
    })
  })
  it("rejects a negative duration", async () => {
    expect(await rejects(inputSchema, { durationMs: -1 })).toBeDefined()
  })
  it("output schema accepts { slept: true }", async () => {
    expect(await decodes(outputSchema, { slept: true })).toEqual({
      slept: true,
    })
  })
})

describe("wait_for descriptor", () => {
  const { inputSchema, outputSchema } = FiregridAgentTools.wait_for
  it("accepts an EventQuery + optional timeout", async () => {
    expect(
      await decodes(inputSchema, {
        eventQuery: { stream: "events.approvals", whereFields: { id: "a-1" } },
        timeoutMs: 5_000,
      }),
    ).toMatchObject({
      eventQuery: { stream: "events.approvals" },
      timeoutMs: 5_000,
    })
  })
  it("rejects an empty stream name", async () => {
    expect(
      await rejects(inputSchema, {
        eventQuery: { stream: "", whereFields: {} },
      }),
    ).toBeDefined()
  })
  it("output schema accepts the matched variant", async () => {
    expect(
      await decodes(outputSchema, {
        matched: true,
        event: { id: "a-1" },
      }),
    ).toMatchObject({ matched: true })
  })
  it("output schema accepts the timed-out variant", async () => {
    expect(
      await decodes(outputSchema, { matched: false, timedOut: true }),
    ).toMatchObject({ matched: false, timedOut: true })
  })
})

describe("spawn descriptor", () => {
  const { inputSchema, outputSchema } = FiregridAgentTools.spawn
  it("accepts agentKind + prompt", async () => {
    expect(
      await decodes(inputSchema, {
        agentKind: "stdio-jsonl",
        prompt: "summarize the issue",
      }),
    ).toMatchObject({ agentKind: "stdio-jsonl" })
  })
  it("rejects an empty agentKind", async () => {
    expect(
      await rejects(inputSchema, { agentKind: "", prompt: "x" }),
    ).toBeDefined()
  })
  it("output schema accepts a Completed terminal state", async () => {
    expect(
      await decodes(outputSchema, {
        childContextId: "ctx-child",
        terminalState: { _tag: "Completed", output: { ok: true } },
      }),
    ).toMatchObject({ childContextId: "ctx-child" })
  })
})

describe("spawn_all descriptor", () => {
  const { inputSchema, outputSchema } = FiregridAgentTools.spawn_all
  it("accepts a non-empty task array", async () => {
    const decoded = await decodes(inputSchema, {
      tasks: [{ agentKind: "stdio-jsonl", prompt: "do thing" }],
    })
    expect(decoded.tasks).toHaveLength(1)
  })
  it("rejects an empty task array", async () => {
    expect(await rejects(inputSchema, { tasks: [] })).toBeDefined()
  })
  it("output schema accepts an aggregated children list", async () => {
    const decoded = await decodes(outputSchema, {
      children: [
        {
          key: "k1",
          childContextId: "ctx-1",
          terminalState: { _tag: "Cancelled" },
        },
      ],
    })
    expect(decoded.children).toHaveLength(1)
  })
})

describe("schedule_me descriptor", () => {
  const { inputSchema, outputSchema } = FiregridAgentTools.schedule_me
  it("accepts when + prompt", async () => {
    expect(
      await decodes(inputSchema, { when: 1_000_000, prompt: "follow-up" }),
    ).toMatchObject({ when: 1_000_000 })
  })
  it("rejects a negative when", async () => {
    expect(
      await rejects(inputSchema, { when: -1, prompt: "x" }),
    ).toBeDefined()
  })
  it("output schema accepts { scheduled: true, scheduleId }", async () => {
    expect(
      await decodes(outputSchema, {
        scheduled: true,
        scheduleId: "schedule-me:ctx:tool",
      }),
    ).toMatchObject({ scheduled: true })
  })
})

describe("execute descriptor", () => {
  const { inputSchema, outputSchema } = FiregridAgentTools.execute
  it("accepts a sandbox ref + input payload", async () => {
    expect(
      await decodes(inputSchema, {
        sandbox: { providerName: "local", toolName: "read-file" },
        input: { path: "/tmp/x" },
      }),
    ).toMatchObject({
      sandbox: { providerName: "local", toolName: "read-file" },
    })
  })
  it("rejects an empty provider name", async () => {
    expect(
      await rejects(inputSchema, {
        sandbox: { providerName: "", toolName: "x" },
        input: {},
      }),
    ).toBeDefined()
  })
  it("output schema accepts arbitrary unknown payloads", async () => {
    expect(await decodes(outputSchema, { whatever: 1 })).toEqual({
      whatever: 1,
    })
  })
})

describe("Schema projections (encodedSchema / typeSchema)", () => {
  // Phase 2 catalog projection uses these projections; tests confirm the
  // descriptor schemas remain Schema-projectable.
  it.each([
    ["sleep"],
    ["wait_for"],
    ["spawn"],
    ["spawn_all"],
    ["schedule_me"],
    ["execute"],
  ] as const)("%s descriptor exposes encodedSchema/typeSchema", (name) => {
    // `FiregridAgentTools[name]` returns a per-tool descriptor whose
    // schemas are invariant in their decoded type. Widen to
    // `Schema.Schema<unknown>` so the projection helpers accept the
    // union without forcing a per-name branch.
    const descriptor = FiregridAgentTools[name] as unknown as {
      readonly inputSchema: Schema.Schema<unknown>
      readonly outputSchema: Schema.Schema<unknown>
    }
    expect(Schema.encodedSchema(descriptor.inputSchema)).toBeDefined()
    expect(Schema.typeSchema(descriptor.inputSchema)).toBeDefined()
    expect(Schema.encodedSchema(descriptor.outputSchema)).toBeDefined()
    expect(Schema.typeSchema(descriptor.outputSchema)).toBeDefined()
  })
})

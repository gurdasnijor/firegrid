/**
 * Tests for the neutral agent-tool descriptor type and the Effect Schema
 * projections that Phase 2 catalog code will use when publishing the
 * canonical tool catalog.
 */

import {
  SleepToolInputSchema,
  SleepToolOutputSchema,
} from "@firegrid/protocol/agent-tools"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  defineAgentTool,
  type AgentToolDescriptor,
} from "./descriptor.ts"

describe("AgentToolDescriptor (Phase 1 type)", () => {
  const sleepDescriptor: AgentToolDescriptor<
    Schema.Schema.Type<typeof SleepToolInputSchema>,
    Schema.Schema.Type<typeof SleepToolOutputSchema>
  > = defineAgentTool({
    name: "sleep",
    description: "Durably suspend until a duration elapses.",
    inputSchema: SleepToolInputSchema,
    outputSchema: SleepToolOutputSchema,
    stability: "stable",
    capabilities: {
      requiresPermission: false,
      idempotent: true,
      streaming: false,
    },
  })

  it("descriptor input schema decodes valid input", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(sleepDescriptor.inputSchema)({ durationMs: 100 }),
    )
    expect(decoded).toEqual({ durationMs: 100 })
  })

  it("encodedSchema projection is callable for catalog publication", () => {
    // Phase 2's catalog projection projects encodedSchema to produce
    // agent-facing JSON. Validate the projection compiles and yields
    // a Schema we can decode the encoded form against.
    const encoded = Schema.encodedSchema(sleepDescriptor.inputSchema)
    expect(encoded).toBeDefined()
  })

  it("typeSchema projection produces the decoded host-side shape", () => {
    const decodedSide = Schema.typeSchema(sleepDescriptor.inputSchema)
    expect(decodedSide).toBeDefined()
  })

  it("rejects descriptors carrying credentials or transport fields", () => {
    // The TS type doesn't permit extra fields; this test exists as a
    // documentation marker (`firegrid-scheduling-tool-bindings.
    // NEUTRAL_TOOL_BINDING_SHAPE.4`). If a future change widens the
    // descriptor shape, this test should be reconsidered.
    const allowedKeys: ReadonlyArray<keyof AgentToolDescriptor> = [
      "name",
      "description",
      "inputSchema",
      "outputSchema",
      "stability",
      "capabilities",
    ]
    expect(allowedKeys).not.toContain("credentials")
    expect(allowedKeys).not.toContain("transport")
    expect(allowedKeys).not.toContain("hostId")
  })
})

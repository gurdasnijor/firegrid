// Focused transforms/ test: agentInputEventFromRuntimeIngressRow is a pure
// Either-returning decoder — callable in a unit test with NO Effect
// environment (docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// §"Enforcement Checklist" item 7).

import { describe, expect, it } from "vitest"
import { Either } from "effect"
import { makeRuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"
import {
  agentInputEventFromRuntimeIngressRow,
  RuntimeIngressAgentInputTransformError,
} from "../../src/transforms/decode-ingress-row.ts"

describe("transforms/decode-ingress-row (pure)", () => {
  it("decodes a text-shaped message payload into a Prompt event", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: "ctx_a",
      kind: "message",
      authoredBy: "client",
      payload: "hello",
    })

    const result = agentInputEventFromRuntimeIngressRow(row)

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right._tag).toBe("Prompt")
    }
  })

  it("decodes a structured-text message payload into a Prompt event", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: "ctx_a",
      kind: "message",
      authoredBy: "client",
      payload: { type: "text", text: "hi there" },
    })

    const result = agentInputEventFromRuntimeIngressRow(row)

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right._tag).toBe("Prompt")
    }
  })

  it("returns a Left of RuntimeIngressAgentInputTransformError on undecodable payloads", () => {
    const row = makeRuntimeIngressInputRow({
      contextId: "ctx_a",
      kind: "control",
      authoredBy: "client",
      payload: { wholly: "wrong shape" },
    })

    const result = agentInputEventFromRuntimeIngressRow(row)

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RuntimeIngressAgentInputTransformError)
      expect(result.left.contextId).toBe("ctx_a")
    }
  })
})

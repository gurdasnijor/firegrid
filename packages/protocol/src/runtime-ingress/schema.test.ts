import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRuntimeIngressRequestedRow,
  promptToRuntimeIngressRequest,
  PublicPromptRequestSchema,
  RuntimeIngressRowSchema,
} from "./index.ts"

describe("@firegrid/protocol runtime-ingress schema", () => {
  it("firegrid-agent-ingress.INGRESS.1 firegrid-agent-ingress.INGRESS.5 firegrid-agent-ingress.INGRESS.6 declares provider-neutral prompt input facts", () => {
    const prompt = Schema.decodeUnknownSync(PublicPromptRequestSchema)({
      contextId: "ctx_1",
      payload: [{ type: "text", text: "hello" }],
      idempotencyKey: "prompt-1",
      metadata: { source: "test" },
    })
    const row = makeRuntimeIngressRequestedRow(promptToRuntimeIngressRequest(prompt), {
      ingressId: "ing_1",
      createdAt: "2026-05-11T00:00:00.000Z",
    })
    const decoded = Schema.decodeUnknownSync(RuntimeIngressRowSchema)(row)

    expect(decoded).toMatchObject({
      type: "firegrid.runtime_ingress.requested",
      contextId: "ctx_1",
      ingressId: "ing_1",
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "prompt-1",
    })
  })
})

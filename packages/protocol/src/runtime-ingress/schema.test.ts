import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRuntimeIngressAcceptedRow,
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

  it("firegrid-agent-ingress.DELIVERY.3 firegrid-agent-ingress.DELIVERY.5 declares accepted-for-dispatch progress facts", () => {
    const row = makeRuntimeIngressAcceptedRow({
      contextId: "ctx_1",
      ingressId: "ing_1",
      subscriberId: "runtime-context:local-process:stdin",
      provider: "local-process",
      acceptedAt: "2026-05-11T00:00:00.000Z",
    })
    const decoded = Schema.decodeUnknownSync(RuntimeIngressRowSchema)(row)

    expect(decoded).toMatchObject({
      type: "firegrid.runtime_ingress.accepted",
      contextId: "ctx_1",
      ingressId: "ing_1",
      provider: "local-process",
      acceptedAt: "2026-05-11T00:00:00.000Z",
    })
  })
})

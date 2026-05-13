import { describe, expect, it } from "vitest"
import {
  makeRuntimeIngressInputRow,
  promptToRuntimeIngressRequest,
} from "./index.ts"

describe("@firegrid/protocol runtime ingress schema", () => {
  it("firegrid-agent-ingress.INGRESS.3 firegrid-agent-ingress.INGRESS.9 builds pending input rows with deterministic idempotency ids", () => {
    const row = makeRuntimeIngressInputRow(promptToRuntimeIngressRequest({
      contextId: "ctx-1",
      payload: { type: "text", text: "hello" },
      idempotencyKey: "same-key",
    }), {
      createdAt: "2026-05-12T00:00:00.000Z",
    })

    expect(row).toMatchObject({
      inputId: "input_ctx-1_same-key",
      contextId: "ctx-1",
      status: "pending",
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "same-key",
    })
  })
})

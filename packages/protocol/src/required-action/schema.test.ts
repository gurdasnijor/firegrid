import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  RequiredActionRequestedRowSchema,
  RequiredActionResolvedRowSchema,
} from "./index.ts"

describe("@firegrid/protocol required-action schema", () => {
  it("firegrid-required-actions.RECORDS.4 firegrid-required-actions.BOUNDARY.5 declares shared required-action durable records", () => {
    const requested = Schema.decodeUnknownSync(RequiredActionRequestedRowSchema)({
      type: "firegrid.required_action.requested",
      id: "required-action:req_1:requested",
      at: "2026-05-10T00:00:00.000Z",
      requiredActionId: "req_1",
      runtimeContextId: "ctx_1",
      requestKind: "approval",
      subject: { kind: "opaque-tool-call" },
      prompt: { text: "Approve?" },
    })
    const resolved = Schema.decodeUnknownSync(RequiredActionResolvedRowSchema)({
      type: "firegrid.required_action.resolved",
      id: "required-action:req_1:resolved",
      at: "2026-05-10T00:00:01.000Z",
      requiredActionId: "req_1",
      resolution: {
        requiredActionId: "req_1",
        outcome: "approved",
        resolvedBy: "operator:test",
        resolvedAt: "2026-05-10T00:00:01.000Z",
        selectedOptionId: "allow",
      },
    })

    expect(requested.runtimeContextId).toBe("ctx_1")
    expect(resolved.resolution.outcome).toBe("approved")
  })
})

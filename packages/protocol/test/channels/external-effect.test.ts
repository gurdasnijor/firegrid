import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ExternalEffectCallChannelTarget,
  ExternalEffectCallRequestSchema,
  ExternalEffectCallResponseSchema,
} from "../../src/channels/index.ts"

describe("external effect channel contract", () => {
  it("firegrid-external-effect-channel.CONTRACT.1 firegrid-external-effect-channel.CONTRACT.2 firegrid-external-effect-channel.CONTRACT.3 declares a neutral callable channel schema", () => {
    expect(ExternalEffectCallChannelTarget).toBe("external.effect.call")

    const request = Schema.decodeUnknownSync(ExternalEffectCallRequestSchema)({
      effectId: "provider.action",
      payload: { providerData: true },
      idempotencyKey: "idem-1",
      correlationId: "corr-1",
    })
    expect(request).toEqual({
      effectId: "provider.action",
      payload: { providerData: true },
      idempotencyKey: "idem-1",
      correlationId: "corr-1",
    })
    expect(() =>
      Schema.decodeUnknownSync(ExternalEffectCallRequestSchema)({
        effectId: "",
        payload: {},
      })).toThrow()

    const response = Schema.decodeUnknownSync(ExternalEffectCallResponseSchema)({
      effectId: "provider.action",
      status: "completed",
      output: { providerResult: true },
      completedAt: "2026-05-20T00:00:00.000Z",
    })
    expect(response.output).toEqual({ providerResult: true })
  })
})

import { ExternalEffectCallChannel } from "@firegrid/protocol/channels"
import {
  ExternalEffectOutboundAdapter,
  type ExternalEffectOutboundAdapterService,
} from "@firegrid/runtime/outbound-effects"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  channelMetadata,
  ExternalEffectCallChannelLive,
} from "../../src/host/index.ts"

describe("external effect host channel", () => {
  it("firegrid-agent-body-plan.CHANNEL_REGISTRY.4 firegrid-agent-body-plan.SLICE_D_VERBS.3 firegrid-external-effect-channel.HOST_BINDING.1 firegrid-external-effect-channel.HOST_BINDING.2 firegrid-external-effect-channel.VALIDATION.2 registers the neutral runtime-backed callable channel", async () => {
    const calls: Array<{ readonly effectId: string; readonly payload: unknown }> = []
    const adapter: ExternalEffectOutboundAdapterService = {
      call: request =>
        Effect.sync(() => {
          calls.push({ effectId: request.effectId, payload: request.payload })
          return {
            effectId: request.effectId,
            status: "completed",
            output: { accepted: true },
            completedAt: "2026-05-20T00:00:00.000Z",
          }
        }),
    }

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const channel = yield* ExternalEffectCallChannel
        const metadata = channelMetadata(channel)
        const response = yield* channel.binding.call({
          effectId: "provider.action",
          payload: { providerData: true },
        })
        return { metadata, response }
      }).pipe(
        Effect.provide(ExternalEffectCallChannelLive.pipe(
          Layer.provide(Layer.succeed(ExternalEffectOutboundAdapter, adapter)),
        )),
      ),
    )

    expect(result.metadata).toMatchObject({
      target: "external.effect.call",
      direction: "call",
    })
    expect("binding" in result.metadata).toBe(false)
    expect(result.response.output).toEqual({ accepted: true })
    expect(calls).toEqual([{
      effectId: "provider.action",
      payload: { providerData: true },
    }])
  })
})

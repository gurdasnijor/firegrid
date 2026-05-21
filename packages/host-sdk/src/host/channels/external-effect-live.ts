import {
  ExternalEffectCallChannel,
  ExternalEffectCallChannelTarget,
  ExternalEffectCallRequestSchema,
  ExternalEffectCallResponseSchema,
  makeCallableChannel,
} from "@firegrid/protocol/channels"
import { ExternalEffectOutboundAdapter } from "@firegrid/runtime/outbound-effects"
import { Effect, Layer } from "effect"

export const ExternalEffectCallChannelLive = Layer.effect(
  ExternalEffectCallChannel,
  Effect.gen(function*() {
    const adapter = yield* ExternalEffectOutboundAdapter
    return makeCallableChannel({
      target: ExternalEffectCallChannelTarget,
      requestSchema: ExternalEffectCallRequestSchema,
      responseSchema: ExternalEffectCallResponseSchema,
      // firegrid-external-effect-channel.HOST_BINDING.1
      call: request => adapter.call(request),
    })
  }),
)

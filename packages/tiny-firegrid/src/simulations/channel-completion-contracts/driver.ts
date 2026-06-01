import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

export const driver = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  yield* Effect.annotateCurrentSpan({
    "firegrid.channel_completion.recommendation":
      "channel-route-descriptor-plus-return-receipt",
    "firegrid.channel_completion.route_target": "probe.prompt.completion",
    "firegrid.channel_completion.direction": "call",
    "firegrid.channel_completion.client_metadata_count":
      firegrid.channels.metadata.length,
    "firegrid.channel_completion.router_inspectable_before_dispatch": true,
    "firegrid.channel_completion.edge_can_map_transport_response": true,
    "firegrid.channel_completion.caller_can_diverge_from_contract": false,
    "firegrid.channel_completion.done_maps_to": "PromptResponse.completed",
    "firegrid.channel_completion.rejected_maps_to": "PromptResponse.rejected",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.channel_completion_contracts.driver", {
    kind: "internal",
  }),
)

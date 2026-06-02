import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

const emittedSequences = [0, 1, 2, 3] as const
const naiveSequences = [0, 0, 0, 0] as const

export const driver = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  yield* Effect.annotateCurrentSpan({
    "firegrid.child_output.target": "session.agent_output",
    "firegrid.child_output.verb": "wait_for",
    "firegrid.child_output.client_metadata_count":
      firegrid.channels.metadata.length,
    "firegrid.child_output.cursor_field": "afterSequence",
    "firegrid.child_output.schema": "RuntimeAgentOutputObservation",
    "firegrid.child_output.parent_child_specific_protocol": false,
    "firegrid.child_output.emitted_sequences": emittedSequences.join(","),
    "firegrid.child_output.cursored_sequences": emittedSequences.join(","),
    "firegrid.child_output.naive_sequences": naiveSequences.join(","),
    "firegrid.child_output.cursored_distinct_count": emittedSequences.length,
    "firegrid.child_output.naive_distinct_count": 1,
    "firegrid.child_output.terminal_tag": "TurnComplete",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.child_output_existing_channel_router.driver", {
    kind: "internal",
  }),
)

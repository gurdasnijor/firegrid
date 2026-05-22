import { makeChannelTarget } from "@firegrid/protocol/channels"
import type { ChannelDispatchRequest } from "@firegrid/protocol/channels/router"
import { Schema } from "effect"

export const tinyInputAppendChannelTarget = makeChannelTarget(
  "tiny.phase0c.input_append",
)

export const TinyInputAppendSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
  inputId: Schema.String.pipe(Schema.minLength(1)),
  body: Schema.String,
}).annotations({
  identifier: "firegrid.tinyPhase0C.inputAppend",
  title: "Tiny Phase 0C input append",
})
export type TinyInputAppend = Schema.Schema.Type<typeof TinyInputAppendSchema>

export const appendTinyInput = (
  payload: TinyInputAppend,
): ChannelDispatchRequest => ({
  target: tinyInputAppendChannelTarget,
  verb: "send",
  payload,
})

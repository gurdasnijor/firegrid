import { Context, Schema } from "effect"
import { RuntimeRunEventSchema } from "../launch/schema.ts"
import {
  makeChannelTarget,
  type ChannelTarget,
  type IngressChannel,
} from "./core.ts"

// Wave D-E shrank this module to the lifecycle half only. The previous
// workflow-engine row-projection ingress was retired (engine-internal row
// shapes leaked to the agent surface, no production source populator
// post-D-A/D-B, zero live consumers). The lifecycle ingress remains —
// backed by `RuntimeControlPlaneTable.runs`.

export const SessionSelfLifecycleChannelTarget: ChannelTarget =
  makeChannelTarget("session.self.lifecycle")

export const SessionSelfLifecycleEventSchema = Schema.Struct({
  channel: Schema.Literal("session.self.lifecycle"),
  event: RuntimeRunEventSchema,
})
export type SessionSelfLifecycleEvent = Schema.Schema.Type<
  typeof SessionSelfLifecycleEventSchema
>

export class SessionSelfLifecycleChannel extends Context.Tag(
  "firegrid/protocol/channels/session.self.lifecycle",
)<
  SessionSelfLifecycleChannel,
  IngressChannel<typeof SessionSelfLifecycleEventSchema>
>() {}

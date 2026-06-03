
import { Schema } from "effect"

export const SessionLifecycleRouteInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.channel.sessionLifecycle.routeInput",
  title: "Session lifecycle route input",
  description:
    "Wait for the next TERMINAL RuntimeRunEvent (status exited|failed) for the given session.",
})
export type SessionLifecycleRouteInput = Schema.Schema.Type<
  typeof SessionLifecycleRouteInputSchema
>

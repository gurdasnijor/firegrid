// Wave C: cursored session lifecycle observation as a channel ROUTE over the
// existing `SessionLifecycleChannel` (`session.lifecycle` ingress, factory-
// keyed by `sessionId`). Pattern-identical to `sessionAgentOutputObservationRoute`
// in `./session-agent-output-route.ts`; uses only existing primitives
// (the protocol-owned channel tag + the `RuntimeRunEvent` schema) — no new
// abstraction, no new router surface.
//
// Source of truth: #708 finding pins `SessionLifecycleChannel` +
// `RuntimeRunEvent` as the public terminal-completion evidence for a
// runtime turn (the durable lifecycle row chain `started -> {exited,failed}`
// is what the host-sdk public turn waits on; `session.agent_output Terminated`
// is a codec-emitted observation that arrives BEFORE the body's lifecycle
// row settles — using it as the public settlement signal causes the
// duplicate-prevention + runs-row-timing regressions documented in #708).
//
// This route returns the next TERMINAL lifecycle event
// (`status === "exited" | "failed"`) for the given `sessionId`. Non-terminal
// events (`status === "started"`) are skipped by the route's seek predicate.
// Caller dispatches `router.dispatch({ target: session.lifecycle, verb: "wait_for",
// payload: { sessionId } })` and receives the terminal `RuntimeRunEvent` when
// the body's lifecycle row materializes.

import {
  SessionLifecycleChannelTarget,
  type SessionLifecycleChannelService,
} from "@firegrid/protocol/channels"
import {
  type RuntimeRunEvent,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  runtimeRouteFromFactoryIngressChannel,
  type RuntimeChannelRoute,
} from "./router.ts"

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

/**
 * Build the session-lifecycle terminal-event route. `channel` is the
 * resolved {@link SessionLifecycleChannelService}; the route filters to
 * terminal lifecycle status so a `wait_for` dispatch settles only when the
 * body has actually finished (or failed).
 */
export const sessionLifecycleTerminalRoute = (
  channel: SessionLifecycleChannelService,
): RuntimeChannelRoute<RuntimeRunEvent, unknown> =>
  runtimeRouteFromFactoryIngressChannel({
    target: SessionLifecycleChannelTarget,
    field: "sessionId",
    inputSchema: SessionLifecycleRouteInputSchema,
    channel: (sessionId) => channel.forSession(sessionId),
    seek: () => (event) => event.status === "exited" || event.status === "failed",
  })

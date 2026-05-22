import {
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import {
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import { Schema } from "effect"
import {
  runtimeRouteFromFactoryIngressChannel,
  type RuntimeChannelRoute,
} from "./router.ts"

/**
 * Cursored delegated child/session output observation as a CHANNEL ROUTE over
 * the existing `SessionAgentOutputChannel` (tf-1ymw), instead of a parallel
 * agent-tool read protocol with a bespoke event taxonomy.
 *
 * - identity: `sessionId` keys the per-session `forContext` ingress channel
 *   (analogous to how `SessionPromptChannel` is factory-keyed by `sessionId`).
 * - cursor: `afterSequence` is an EXCLUSIVE lower bound over the observation
 *   `sequence`; `-1` reads from the start of the child's output (matching the
 *   runtime's initial `lastProcessedOutputSequence`). Round-trip the observed
 *   `sequence` back as `afterSequence` to avoid stale re-reads.
 * - rows: observations are the existing `RuntimeAgentOutputObservation`
 *   (`sessionId`/`contextId`/`sequence`/`event` over `AgentOutputEvent`) — no
 *   new event taxonomy.
 *
 * Parent→child authority lives at this route boundary: the `forContext`
 * resolver passed to {@link sessionAgentOutputObservationRoute} is where an
 * authorization check (durable parent-child link, synthesis §3.1/§5.2/§6) is
 * applied before a `sessionId` is observable. The route does not invent its
 * own authority surface.
 */
export const SessionAgentOutputRouteInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  afterSequence: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(-1),
  ),
}).annotations({
  identifier: "firegrid.channel.sessionAgentOutput.routeInput",
  title: "Session agent-output route input",
  description:
    "Observe a session's agent output after an exclusive sequence cursor; -1 reads from the start.",
})
export type SessionAgentOutputRouteInput = Schema.Schema.Type<
  typeof SessionAgentOutputRouteInputSchema
>

/**
 * Build the cursored session-agent-output observation route. `channel` is the
 * resolved {@link SessionAgentOutputChannelService} (the authority/authorization
 * boundary for which sessions are observable). Dispatching the route with
 * `{ sessionId, afterSequence }` returns the next `RuntimeAgentOutputObservation`
 * strictly after the cursor.
 */
export const sessionAgentOutputObservationRoute = (
  channel: SessionAgentOutputChannelService,
): RuntimeChannelRoute<RuntimeAgentOutputObservation, unknown> =>
  runtimeRouteFromFactoryIngressChannel({
    target: SessionAgentOutputChannelTarget,
    field: "sessionId",
    inputSchema: SessionAgentOutputRouteInputSchema,
    channel: sessionId => channel.forContext(sessionId),
    seek: input => observation => observation.sequence > input.afterSequence,
  })

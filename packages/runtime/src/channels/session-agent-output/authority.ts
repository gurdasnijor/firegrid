import {
  CurrentRuntimeContext,
  type RuntimeContext,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import {
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import { RuntimeAgentOutputObservationSchema } from "@firegrid/protocol/session-facade"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  makeRuntimeChannelRouter,
  RuntimeChannelRouter,
} from "../router.ts"
import { sessionAgentOutputObservationRoute } from "../session-agent-output-route.ts"

// tf-r06u.8: the typed parent→child observation authority failure. Surfaces
// through the router as `ChannelRouteInvocationFailed.cause` (the route stream
// fails with this), so a caller observing a child it does not parent gets a
// typed denial rather than another agent's output.
export class UnauthorizedChildObservation extends Schema.TaggedError<UnauthorizedChildObservation>()(
  "firegrid/runtime/UnauthorizedChildObservation",
  {
    observingContextId: Schema.String,
    childContextId: Schema.String,
    // `unknown-context`: no context row for `childContextId`.
    // `not-parent`: the row exists but its `parentContextId` is not the
    // observer (incl. a top-level context with no `parentContextId`).
    reason: Schema.Literal("not-parent", "unknown-context"),
  },
) {}

/**
 * Wrap a base {@link SessionAgentOutputChannelService} so that observing a
 * child's output is gated on the durable parent-child FK: `forContext(childId)`
 * only yields the child's agent output when `childId`'s context row names
 * `observingContextId` as its `parentContextId` (synthesis §3.1/§4 — the FK on
 * the child's own context row is the authority record; tf-r06u.8).
 *
 * The check is baked in at build time — the observer and the resolved contexts
 * reader (`control`) are closed over — so the returned ingress stream stays
 * context-free (`R = never`), satisfying the
 * {@link runtimeRouteFromFactoryIngressChannel} contract (its `invoke` runs the
 * stream with no environment). The observer is therefore per-caller: build one
 * authorized channel per observing context (see
 * {@link AuthorizedSessionAgentOutputRouterLive}).
 */
export const makeAuthorizedSessionAgentOutputChannel = (options: {
  readonly underlying: SessionAgentOutputChannelService
  readonly control: RuntimeControlPlaneTable["Type"]
  readonly observingContextId: string
}): SessionAgentOutputChannelService => ({
  forContext: (childContextId) => {
    const denied = (reason: UnauthorizedChildObservation["reason"]) =>
      Stream.fail(
        new UnauthorizedChildObservation({
          observingContextId: options.observingContextId,
          childContextId,
          reason,
        }),
      )
    const authorizedStream = options.control.contexts.get(childContextId).pipe(
      Effect.map(
        Option.match({
          onNone: () => denied("unknown-context"),
          onSome: (row: RuntimeContext) =>
            row.parentContextId === options.observingContextId
              ? options.underlying.forContext(childContextId).binding.stream
              : denied("not-parent"),
        }),
      ),
      Stream.unwrap,
    )
    return makeIngressChannel({
      target: SessionAgentOutputChannelTarget,
      schema: RuntimeAgentOutputObservationSchema,
      sourceClass: "static-source",
      stream: authorizedStream,
    })
  },
})

/**
 * Per-context `RuntimeChannelRouter` carrying the authorized cursored
 * `session.agent_output` observation route. Reads {@link CurrentRuntimeContext}
 * as the observing principal and resolves the base channel + contexts index, so
 * a `wait_for session.agent_output` dispatched within a context can only read
 * the output of contexts that context parents.
 *
 * Requires `CurrentRuntimeContext`, so it composes inside a per-context scope
 * (the choreography dispatch path, tf-r06u.9) — not host-wide. The base
 * {@link SessionAgentOutputChannel} is wired host-wide; this Layer adds the
 * authority + route on top per observer.
 */
export const AuthorizedSessionAgentOutputRouterLive: Layer.Layer<
  RuntimeChannelRouter,
  never,
  SessionAgentOutputChannel | RuntimeControlPlaneTable | CurrentRuntimeContext
> = Layer.effect(
  RuntimeChannelRouter,
  // `Effect.context<...>()` + `Context.get` (not `yield* Tag`) pins the
  // requirement set explicitly and avoids the DurableTable Tag `any`-leak
  // (tf-wku1) that otherwise collapses `R` to `any` — same pattern as
  // `SessionSelfChannelsLive`.
  Effect.context<
    SessionAgentOutputChannel | RuntimeControlPlaneTable | CurrentRuntimeContext
  >().pipe(
    Effect.map((context) => {
      const underlying = Context.get(context, SessionAgentOutputChannel)
      const control = Context.get(context, RuntimeControlPlaneTable)
      const current = Context.get(context, CurrentRuntimeContext)
      const authorized = makeAuthorizedSessionAgentOutputChannel({
        underlying,
        control,
        observingContextId: current.contextId,
      })
      return makeRuntimeChannelRouter([
        sessionAgentOutputObservationRoute(authorized),
      ])
    }),
  ),
)

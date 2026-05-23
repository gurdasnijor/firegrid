// Shape C Wave C — channel/router turn-path simulation.
//
// Validates the existing-docs thesis (SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md,
// runtime-pipeline-type-boundaries.md, runtime-design-constraints.md,
// host-sdk-runtime-boundary.md): host-sdk composes typed channel/router
// capabilities; runtime owns execution/substrate; the public turn goes
// through a client facade modeled on `packages/client-sdk/src/firegrid.ts`
// that dispatches through router/channel contracts — not a new driver,
// runner, or generic stream surface.
//
// The full client surface (`launch`, `prompt`, `sessions.createOrLoad`,
// `sessions.attach`, `open`, session `start`/`prompt`/`wait`/`permissions`,
// `permissions.respond`) is preserved as the Wave C dispatch contract.
// `watchContexts` is explicitly out of scope (see FINDING.md).
//
// Verdict + production target mapping in `FINDING.md`. Probe at
// `packages/tiny-firegrid/test/shape-c-channel-router-turn/probe.test.ts`.

export * from "./protocol.ts"
export * from "./router.ts"
export * from "./host-facade.ts"
export * from "./edge.ts"
export * from "./client.ts"
// `runtime-routes.ts` exports the route schemas + the `makeRuntimeRoutes`
// factory. Shape C handler + per-session state types stay file-private
// — that absence is asserted in the probe.
export {
  HostContextsCreateTarget,
  HostPermissionRespondTarget,
  HostPromptTarget,
  HostSessionsCreateOrLoadTarget,
  HostSessionsStartTarget,
  makeRuntimeRoutes,
  makeStubAgent,
  type PermissionDecision,
  PermissionDecisionSchema,
  RuntimeInputIntentRowSchema,
  RuntimeStartRequestAckSchema,
  SessionAgentOutputObservationSchema,
  SessionAgentOutputRouteInputSchema,
  SessionAgentOutputTarget,
  SessionCreateOrLoadInputSchema,
  SessionHandleReferenceSchema,
  SessionPromptRequestSchema,
  SessionPromptTarget,
  SessionStartInputSchema,
  type HostPermissionRespondRequest,
  type HostPermissionRespondResponse,
  type HostContextsCreateRequest,
  type HostContextsCreateResponse,
  type HostPromptRequest,
  type RuntimeInputIntentRow,
  type RuntimeRouteHandle,
  type RuntimeRouteSet,
  type RuntimeStartRequestAck,
  type SessionAgentOutputObservation,
  type SessionAgentOutputRouteInput,
  type SessionCreateOrLoadInput as RuntimeSessionCreateOrLoadInput,
  type SessionHandleReference,
  type SessionPromptRequest,
  type SessionStartInput,
  type StubAgentFixture,
} from "./runtime-routes.ts"

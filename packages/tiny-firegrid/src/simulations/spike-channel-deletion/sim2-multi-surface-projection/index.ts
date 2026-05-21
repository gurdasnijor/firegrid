/**
 * tf-35f4 Sim 2 — multi-surface projection equivalence for the callable
 * channel `HostSessionsCreateOrLoadChannel`.
 *
 * This module exposes the sim's host composition + driver effects.
 *
 * The acceptance harness lives in
 * `packages/tiny-firegrid/test/spike-channel-deletion/sim2-multi-surface-projection.test.ts`
 * — substrate-row equivalence + response equivalence are checked there.
 * The harness is a vitest test rather than a `simulate:run` entrypoint
 * because Sim 2 needs assertions over typed substrate rows (not just
 * span emission) and the equivalence comparison is the load-bearing
 * deliverable, not the full agent loop the simulate runner is shaped for.
 */

export { SIM_ID, sim2ChannelLayer, sim2FullLayer } from "./host.ts"
export {
  buildRequestForProjection,
  runClientMethodProjection,
  runMcpToolProjection,
} from "./driver.ts"

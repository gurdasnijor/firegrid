import { Effect } from "effect"
import { defineSimulation } from "../../types.ts"
import {
  runAgentCoordinationReadinessSmokeViaClient,
} from "./driver.ts"
import { agentCoordinationReadinessHost } from "./host.ts"

export {
  readinessFixtureAgentArgv,
  readinessFixtureAgentRuntime,
} from "./fixture-agent.ts"
export { agentCoordinationReadinessHost } from "./host.ts"
export {
  ReadinessSmokeFailure,
  runAgentCoordinationReadinessSmokeViaClient,
  type AgentCoordinationReadinessClientResult,
} from "./driver.ts"
export {
  runAgentCoordinationReadinessSmoke,
  type AgentCoordinationReadinessResult,
} from "./router-probe.ts"

/**
 * Standard runner simulation — exposes the CLIENT-ONLY readiness driver
 * (steps 2 / 3-surrogate / 4 / 5a / 6) because `TinyFiregridSimulation.driver`
 * is typed `Effect.Effect<A, E, Firegrid>` and the runner provides only
 * `Firegrid`. The strict step-5b assertion (direct
 * `HostPlaneChannelRouter.dispatch`) requires an additional layer in scope
 * and lives in the vitest smoke
 * (`packages/tiny-firegrid/test/agent-coordination-readiness/smoke.test.ts`),
 * which composes `Firegrid | FiregridHost | HostPlaneChannelRouter` from
 * the same host layer.
 *
 * See `FINDING.md` § "Why this is both a runner sim and a Vitest smoke"
 * for the runner-contract change that would let a single entry point
 * exercise both load-bearing paths.
 */
export default defineSimulation({
  id: "agent-coordination-readiness",
  description:
    "Readiness checklist for the integration-branch observation cutover (#703). Standard runner entry exercises steps 2/3-surrogate/4/5a/6 through the public client surface; the strict step-5b router-dispatch assertion runs in the paired vitest smoke.",
  host: agentCoordinationReadinessHost,
  driver: Effect.gen(function*() {
    const runId = `runner-${crypto.randomUUID()}`
    return yield* runAgentCoordinationReadinessSmokeViaClient(runId)
  }),
})

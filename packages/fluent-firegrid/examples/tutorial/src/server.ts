import { incidentReview } from "./01-basics.ts"
import { spawnTutorial } from "./02-spawn.ts"
import { timeoutTutorial } from "./03-timeout.ts"
import { retryTutorial } from "./04-retry.ts"
import { sagaTutorial } from "./05-saga.ts"
import { cancelTutorial } from "./06-cancel.ts"
import { stateTutorial } from "./07-state.ts"
import { clientsTutorial } from "./08-clients.ts"
import { remediationWorkflow, workflowTutorial } from "./09-workflows.ts"
import { interfacesTutorial } from "./10-ifaces.ts"
import { serdesTutorial } from "./11-serdes.ts"
export { deferredSurface } from "./deferred-surface.ts"

export const services = [incidentReview, remediationWorkflow] as const

// fluent-firegrid-keystone.EXAMPLES.2
export const tutorialTiers = [
  { tier: "01-basics", status: "implemented" },
  spawnTutorial,
  timeoutTutorial,
  retryTutorial,
  sagaTutorial,
  cancelTutorial,
  stateTutorial,
  clientsTutorial,
  workflowTutorial,
  interfacesTutorial,
  serdesTutorial,
] as const

import {
  gen,
  run,
  workflow,
} from "@firegrid/fluent-firegrid"
import {
  draftPatchPlan,
  notifyCoordinator,
  openRemediation,
  type IncidentInput,
} from "./fakes.ts"

export const remediationWorkflow = workflow({
  name: "remediationWorkflow",
  handlers: {
    // fluent-firegrid-keystone.EXAMPLES.3
    run: (input: IncidentInput) =>
      gen(function* () {
        const plan = yield* run(() => draftPatchPlan(input, {
          route: "coordinator",
          severity: "high",
        }), { name: "draft-remediation-plan" })
        const remediationId = yield* run(() => openRemediation(input, plan), {
          name: "open-remediation",
        })
        return yield* run(() => notifyCoordinator(remediationId), {
          name: "notify-coordinator",
        })
      }),
    status: (id: string) =>
      gen(function* () {
        return yield* run(() => `workflow:${id}:status:modeled`, {
          name: "workflow-status",
        })
      }),
  },
})

export const workflowTutorial = {
  tier: "09-workflows",
  status: "implemented: workflow({ name, handlers }) over one journal endpoint",
} as const

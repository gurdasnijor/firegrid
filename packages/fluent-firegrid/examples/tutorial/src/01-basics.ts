import { execute, gen, run, service } from "@firegrid/fluent-firegrid"
import {
  classifyIncident,
  draftPatchPlan,
  publishTrace,
  type IncidentInput,
} from "./fakes.ts"

export const incidentReview = service({
  name: "incidentReview",
  handlers: {
    // fluent-firegrid-keystone.EXAMPLES.1
    summarize: (ctx, input: IncidentInput) =>
      execute(
        ctx,
        gen(function* () {
          const triage = yield* run(() => classifyIncident(input), {
            name: "classify",
          })
          const plan = yield* run(() => draftPatchPlan(input, triage), {
            name: "draft-plan",
          })
          return yield* run(() => publishTrace(plan), {
            name: "publish-trace",
          })
        }),
      ),
  },
})

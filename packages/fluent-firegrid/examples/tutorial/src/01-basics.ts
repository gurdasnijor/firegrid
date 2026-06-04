import { all, execute, gen, run, service } from "@firegrid/fluent-firegrid"
import {
  classifyIncident,
  collectIncidentContext,
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
          const triageFuture = run(() => classifyIncident(input), {
            name: "classify",
          })
          const contextFuture = run(() => collectIncidentContext(input), {
            name: "collect-context",
          })
          const [triage, context] = yield* all([triageFuture, contextFuture])
          const plan = yield* run(() => draftPatchPlan({
            ...input,
            title: `${input.title} ${context}`,
          }, triage), {
            name: "draft-plan",
          })
          return yield* run(() => publishTrace(plan), {
            name: "publish-trace",
          })
        }),
      ),
  },
})

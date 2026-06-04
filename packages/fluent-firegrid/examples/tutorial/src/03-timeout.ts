import {
  gen,
  run,
  select,
  service,
  sleep,
} from "@firegrid/fluent-firegrid"
import { delayedValue } from "./fakes.ts"

export const incidentTimeout = service({
  name: "incidentTimeout",
  handlers: {
    // fluent-firegrid-keystone.EXAMPLES.1
    boundedLookup: (request: {
      readonly incidentId: string
      readonly workMs: number
      readonly budgetMs: number
    }) =>
      gen(function* () {
        const selected = yield* select({
          done: run(
            () => delayedValue(request.workMs, `lookup:${request.incidentId}`),
            { name: "lookup" },
          ),
          timeout: sleep(request.budgetMs, "lookup-budget"),
        })
        if (selected.tag === "timeout") return `timeout:${request.incidentId}`
        return yield* selected.future
      }),
  },
})

export const timeoutTutorial = {
  tier: "03-timeout",
  status: "implemented: timeout via select({ done, timeout: sleep(...) })",
} as const

import {
  execute,
  gen,
  object,
  sharedState,
  state,
} from "@firegrid/fluent-firegrid"

type IncidentCounterState = {
  readonly escalations: number
  readonly lastSignal: string
}

export const incidentCounter = object({
  name: "incidentCounter",
  handlers: {
    // fluent-firegrid-keystone.EXAMPLES.1
    current: (ctx, _: void) =>
      execute(
        ctx,
        gen(function* () {
          return (yield* sharedState<IncidentCounterState>().get("escalations")) ?? 0
        }),
      ),

    // fluent-firegrid-keystone.EXAMPLES.1
    recordEscalation: (ctx, signal: string) =>
      execute(
        ctx,
        gen(function* () {
          const s = state<IncidentCounterState>()
          const current = (yield* s.get("escalations")) ?? 0
          const next = current + 1
          s.set("escalations", next)
          s.set("lastSignal", signal)
          return {
            escalations: next,
            lastSignal: signal,
          }
        }),
      ),

    // fluent-firegrid-keystone.EXAMPLES.1
    reset: (ctx, _: void) =>
      execute(
        ctx,
        gen(function* () {
          state<IncidentCounterState>().clearAll()
        }),
      ),
  },
})

export const stateTutorial = {
  tier: "07-state",
  status: "implemented: state/sharedState over a durable state log",
} as const

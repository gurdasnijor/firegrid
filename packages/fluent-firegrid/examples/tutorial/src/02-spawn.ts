import {
  all,
  execute,
  gen,
  race,
  run,
  select,
  service,
  spawn,
  type Operation,
} from "@firegrid/fluent-firegrid"
import { delayedValue } from "./fakes.ts"

const replicateProbe = (
  label: string,
  durationMs: number,
): Operation<string> =>
  gen(function* () {
    return yield* run(() => delayedValue(durationMs, label), {
      name: `${label}-probe`,
    })
  })

export const incidentFanout = service({
  name: "incidentFanout",
  handlers: {
    // fluent-firegrid-keystone.EXAMPLES.1
    compareReplicas: (ctx, incidentId: string) =>
      execute(
        ctx,
        gen(function* () {
          const primary = spawn(replicateProbe(`${incidentId}:primary`, 20))
          const secondary = spawn(replicateProbe(`${incidentId}:secondary`, 10))
          const [left, right] = yield* all([primary, secondary])
          return `${left}|${right}`
        }),
      ),

    // fluent-firegrid-keystone.EXAMPLES.1
    fastestReplica: (ctx, incidentId: string) =>
      execute(
        ctx,
        gen(function* () {
          return yield* race([
            spawn(replicateProbe(`${incidentId}:slow`, 20)),
            spawn(replicateProbe(`${incidentId}:fast`, 1)),
          ])
        }),
      ),

    // fluent-firegrid-keystone.EXAMPLES.1
    taggedReplica: (ctx, incidentId: string) =>
      execute(
        ctx,
        gen(function* () {
          const selected = yield* select({
            slow: spawn(replicateProbe(`${incidentId}:slow`, 20)),
            fast: spawn(replicateProbe(`${incidentId}:fast`, 1)),
          })
          return `${String(selected.tag)}:${yield* selected.future}`
        }),
      ),
  },
})

export const spawnTutorial = {
  tier: "02-spawn",
  status: "implemented: spawn plus all/race/select over routine Futures",
} as const

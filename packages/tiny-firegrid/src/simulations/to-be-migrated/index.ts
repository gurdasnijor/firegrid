import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { FiregridLocalHostLive } from "@firegrid/host-sdk"
import { Effect } from "effect"
import { defineSimulation } from "../../types.ts"

export default defineSimulation({
  id: "to-be-migrated",
  description: "Placeholder for simulations that have not been migrated yet.",
  host: env =>
    FiregridLocalHostLive({
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      input: true,
    }),
  driver: Effect.flatMap(Firegrid, () => Effect.void),
})

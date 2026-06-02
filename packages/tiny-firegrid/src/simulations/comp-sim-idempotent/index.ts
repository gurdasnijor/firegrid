import { defineSimulation } from "../../types.ts"
import { compSimIdempotentDriver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "comp-sim-idempotent",
  description:
    "cap-3 / §7.3 — idempotent one-intent -> one-participant over the public "
    + "client surface (firegrid.sessions.createOrLoad keyed by external "
    + "[source, id]). Same key (incl. concurrent redeliveries) collapses to one "
    + "participant contextId; a different key stays distinct. Trace is the "
    + "deliverable (per-call create_or_load spans + a summary span of resolved "
    + "participant ids); no in-sim verdict.",
  host,
  driver: compSimIdempotentDriver,
})

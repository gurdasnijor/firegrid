import { defineSimulation } from "../../types.ts"
import { compDeriskOrderingDriver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "comp-derisk-ordering",
  description:
    "tf-0awo.20 — §3.1/§12 Seam 1b output-ordering de-risk. Drives a real ACP "
    + "agent through the public client surface and records, via a host-scoped "
    + "observer over the host-wide RuntimeOutputTable.events projection, the "
    + "append order vs (activityAttempt, sequence) of output rows. Probes "
    + "whether a second output drain is reachable via close -> re-prompt. The "
    + "trace is the deliverable; no verdict is computed in-sim.",
  host,
  driver: compDeriskOrderingDriver,
})

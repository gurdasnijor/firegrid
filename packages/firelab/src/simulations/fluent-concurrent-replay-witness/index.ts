import { defineSimulation } from "../../types.ts"
import { fluentConcurrentReplayWitnessDriver } from "./driver.ts"

// Hostless by design for tf-td1v: this verification-lane witness does not bind
// to a launched Firegrid host yet. The behavior under review is still
// production-backed: the driver imports @firegrid/fluent-firegrid and exercises
// execute/run against Firelab's real upstream DurableStreamTestServer.
export default defineSimulation({
  id: "fluent-concurrent-replay-witness",
  description:
    "Appendix A witness for fluent concurrent replay soundness: production "
    + "run/execute named keys replay from the journal while a positional-key mutation flips red.",
  launchHost: false,
  driver: fluentConcurrentReplayWitnessDriver,
})

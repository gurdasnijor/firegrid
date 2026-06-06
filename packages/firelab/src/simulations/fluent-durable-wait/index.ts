import { defineSimulation } from "../../types.ts"
import { driver } from "./driver.ts"
import { host } from "./host.ts"

export default defineSimulation({
  id: "fluent-durable-wait",
  description:
    "Drives provider event ingress into a post-claim fluent session authority that materializes waits, commits L2 outcomes, and acks DS wakes.",
  host,
  driver,
  coverage: {
    gates: [
      {
        id: "fluent_durable_wait.host_ran",
        description: "the host drove the durable wait scenario",
        claim: "spans.exists(s, named(s, \"firegrid.sim.fluent_durable_wait.host\"))",
      },
      {
        id: "fluent_durable_wait.intent_before_park",
        description: "wait intent was durably recorded before the park fact",
        claim: "spans.exists(reg, named(reg, \"fluent_runtime.store.turn.wait.register\") && spans.exists(park, named(park, \"fluent_runtime.store.session.append_event\") && attr(park, \"firegrid.session.event.name\") == \"fluent.durable_wait.turn.parked\" && startMs(reg) <= startMs(park)))",
      },
      {
        id: "fluent_durable_wait.provider_ingress",
        description: "provider events became queryable session facts before wake handling",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.state_change.append_fenced\"))",
      },
      {
        id: "fluent_durable_wait.claimed_drive",
        description: "the post-claim session authority evaluated waits after a real DS claim",
        claim: "spans.exists(acquire, named(acquire, \"fluent_runtime.worker_redrive.consumer.acquire\") && spans.exists(handle, named(handle, \"firegrid.sim.fluent_durable_wait.session_authority.handle_wake\") && startMs(acquire) <= startMs(handle) && spans.exists(match, named(match, \"fluent_runtime.sources.wait.match_pending\") && startMs(handle) <= startMs(match))))",
      },
      {
        id: "fluent_durable_wait.match_journaled",
        description: "a matching event was journaled by FluentStore",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.wait.match\"))",
      },
      {
        id: "fluent_durable_wait.product_before_ack",
        description: "durable product outcome was written before DS ack",
        claim: "spans.exists(outcome, named(outcome, \"fluent_runtime.store.session.append_event\") && attr(outcome, \"firegrid.session.event.name\") == \"fluent.durable_wait.wake.outcome\" && spans.exists(ack, named(ack, \"fluent_runtime.worker_redrive.consumer.ack\") && startMs(outcome) <= startMs(ack)))",
      },
      {
        id: "fluent_durable_wait.release",
        description: "the DS claim was released after durable product progress",
        claim: "spans.exists(s, named(s, \"fluent_runtime.worker_redrive.consumer.release\"))",
      },
    ],
    corroborations: [
      {
        id: "fluent_durable_wait.driver_asserted_visible_facts",
        description: "the driver asserted durable session/turn/wake facts",
        claim: "spans.exists(s, named(s, \"firelab.fluent_durable_wait.driver\"))",
      },
    ],
  },
})

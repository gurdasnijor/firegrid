import { defineSimulation } from "../../types.ts"
import { fluentRuntimeWorkbenchDriver } from "./driver.ts"
import { fluentRuntimeWorkbenchHost } from "./host.ts"

// Forge-proof acceptance sim for the fluent-runtime store. The firelab runner
// stands up the durable-streams server, launches the host (the real
// FluentRuntimeServerLive HTTP surface), runs the driver, captures the trace and
// computes the verdict. The host serves; the driver only reaches it over HTTP
// through a Gherkin feature, so every gate below binds to a `fluent_runtime.store.*`
// span that fired host-side (`firegrid.side != "driver"`) — the driver can't forge it.
export default defineSimulation({
  id: "fluent-runtime-workbench",
  description:
    "Forge-proof acceptance for the fluent-runtime managed-agent store: a Gherkin "
    + "feature drives session create / turn open+read and the control-plane "
    + "send/read/tag surface over the launched host's HTTP API; the verdict gates "
    + "on host-side store spans.",
  host: fluentRuntimeWorkbenchHost,
  driver: fluentRuntimeWorkbenchDriver,
  coverage: {
    gates: [
      {
        id: "store.session.create",
        description: "host opened a session stream (FluentStore.createSession)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.session.create\"))",
      },
      {
        id: "store.turn.start",
        description: "host opened a turn stream on prompt (FluentStore.startTurn)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.start\"))",
      },
      {
        id: "store.turn.read",
        description: "host read a turn stream back (FluentStore.readTurn)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.read\"))",
      },
    ],
  },
})

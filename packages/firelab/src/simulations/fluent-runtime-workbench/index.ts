import { defineSimulation } from "../../types.ts"
import { fluentRuntimeWorkbenchDriver } from "./driver.ts"
import { fluentRuntimeWorkbenchHost } from "./host.ts"

// Forge-proof acceptance sim for the fluent-runtime store. The firelab runner
// stands up the durable-streams server, launches the host (the real
// FluentRuntimeServerLive HTTP surface), runs the driver, captures the trace and
// computes the verdict. A domain-phrased .feature drives the durable timer/wait
// source endpoints (#942) via the typed client over HTTP, so every gate below
// binds to a `fluent_runtime.store.*` span that fired host-side
// (`firegrid.side != "driver"`) — the driver can't forge it.
export default defineSimulation({
  id: "fluent-runtime-workbench",
  description:
    "Forge-proof acceptance for the fluent-runtime managed-agent store: a domain "
    + "Gherkin feature drives durable sleep (register pending → fire when due → "
    + "replay) and durable wait (register pending → non-matching stays pending → "
    + "matching appends matched → replay) over the launched host's HTTP API; the "
    + "verdict gates on host-side store spans.",
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
        id: "store.turn.durable_sleep",
        description: "host registered a durable sleep timer (FluentStore.durableSleep)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.durable_sleep\"))",
      },
      {
        id: "store.turn.timer.fire",
        description: "host fired a due timer (FluentStore.fireDueTimers → timer fire)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.timer.fire\"))",
      },
      {
        id: "store.turn.durable_wait",
        description: "host registered a durable wait (FluentStore.durableWait)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.durable_wait\"))",
      },
      {
        id: "store.turn.wait.match",
        description: "host matched a pending wait against a candidate (FluentStore.matchPendingWaits)",
        claim: "spans.exists(s, named(s, \"fluent_runtime.store.turn.wait.match\"))",
      },
    ],
  },
})

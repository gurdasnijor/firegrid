import { Given, Then } from "@cucumber/cucumber"
import assert from "node:assert/strict"
import type { FluentWorld } from "../support/world.ts"

// These steps only execute when FIREGRID_REAL_AGENT=1 (otherwise the @real-agent
// Before hook skips the scenario before any step runs). They assert the gate
// wiring, not a product behavior — the product real-agent acceptance lives in
// the agent-binding/* features.

Given(
  "a scenario that requires a real native or ACP agent",
  function (this: FluentWorld) {
    // No-op: routing is by the @real-agent tag; the Before hook is the gate.
  },
)

Then("the live real-agent lane is enabled", function (this: FluentWorld) {
  assert.equal(
    this.realAgentEnabled,
    true,
    "real-agent lane should be enabled here (the Before hook skips otherwise)",
  )
})

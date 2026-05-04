import { describe, expect, it } from "vitest"

// launchable-substrate-host.PACKAGING.1
// launchable-substrate-host.PACKAGING.3
// Slice 1 ships only the package boundary. The smoke test confirms the
// workspace link to @durable-agent-substrate/substrate is wired so later
// slices can import the substrate client primitives without further
// scaffolding.
describe("launchable-substrate-host.PACKAGING.3 — @durable-agent-substrate/client package boundary is in place", () => {
  it("workspace-links @durable-agent-substrate/substrate so later slices can compose substrate primitives", async () => {
    const substrate = await import("@durable-agent-substrate/substrate")
    expect(substrate).toBeTypeOf("object")
    // Substrate is the foundation library; the client surface itself is
    // not yet exposed in this slice.
    expect(typeof substrate.WorkProducer).toBe("function")
  })
})

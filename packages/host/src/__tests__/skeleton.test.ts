import { describe, expect, it } from "vitest"

// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.9
// Slice 1 ships only the package boundary. The smoke test confirms the
// workspace links to @durable-agent-substrate/substrate and the
// embedded Durable Streams server are wired so later slices can build
// boot plans + launch the embedded dev server without further
// scaffolding.
describe("launchable-substrate-host.PACKAGING.4 — @durable-agent-substrate/host package boundary is in place", () => {
  it("workspace-links substrate and depends on @durable-streams/server so later slices can launch DurableStreamTestServer in-process", async () => {
    const substrate = await import("@durable-agent-substrate/substrate")
    const dsServer = await import("@durable-streams/server")
    expect(substrate).toBeTypeOf("object")
    expect(typeof dsServer.DurableStreamTestServer).toBe("function")
  })
})

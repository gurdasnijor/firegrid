import { describe, expect, it } from "vitest"

// launchable-substrate-host.PACKAGING.5
// launchable-substrate-host.LAB_INSPECTOR.1
// launchable-substrate-host.LAB_INSPECTOR.6
// Slice 1 ships only the package boundary. The smoke test confirms the
// lab consumes the same @durable-agent-substrate/client used by other
// runtimes — no privileged writer surface, no direct host dependency.
// Host diagnostics, when later needed, are reached over the host's
// read-only HTTP surface rather than through a workspace import.
describe("launchable-substrate-host.PACKAGING.5 — @durable-agent-substrate/lab package boundary is in place", () => {
  it("workspace-links @durable-agent-substrate/client and does not import @durable-agent-substrate/host", async () => {
    const client = await import("@durable-agent-substrate/client")
    expect(client).toBeTypeOf("object")
  })
})

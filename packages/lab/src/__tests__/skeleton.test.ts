import { describe, expect, it } from "vitest"

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
// firegrid-architecture-boundary.PACKAGE_BOUNDARIES.5
// firegrid-package-migration.PACKAGE_NAMES.4
//
// Boundary smoke: the lab consumes the same
// @durable-agent-substrate/client an application would use, and
// does NOT import the @firegrid/runtime package. Runtime →  lab and
// lab → runtime are both architecture defects; the only contract
// between the two is the stream URL injected by the runtime
// process binary.
describe("firegrid-architecture-boundary.DEPENDENCY_GRAPH — lab package boundary is in place", () => {
  it("workspace-links @durable-agent-substrate/client", async () => {
    const client = await import("@durable-agent-substrate/client")
    expect(client).toBeTypeOf("object")
  })
})

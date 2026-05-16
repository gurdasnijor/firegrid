import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const dirname = fileURLToPath(new URL(".", import.meta.url))

const clientSourceFiles = [
  "../src/firegrid.ts",
  "../src/index.ts",
] as const

describe("Firegrid client package boundary", () => {
  it("firegrid-architecture-boundary.DEPENDENCY_GRAPH.1 does not import runtime source or package entrypoints", async () => {
    const sources = await Promise.all(
      clientSourceFiles.map(file =>
        readFile(join(dirname, file), "utf8")),
    )

    for (const source of sources) {
      expect(source).not.toMatch(/@firegrid\/runtime/)
      expect(source).not.toMatch(/packages\/runtime/)
    }
  })

  it("firegrid-platform-invariants.LOCALITY.2 production client source has no Node-only imports", async () => {
    const sources = await Promise.all(
      clientSourceFiles.map(file =>
        readFile(join(dirname, file), "utf8")),
    )

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+["']node:/)
      expect(source).not.toMatch(/from\s+["'](?:fs|path|child_process|url)["']/)
      expect(source).not.toMatch(/@effect\/platform-node/)
    }
  })
})

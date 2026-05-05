import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.6
// firegrid-architecture-boundary.SURFACE_AREA.4
// firegrid-architecture-boundary.VOCABULARY.5
// firegrid-package-migration.PACKAGE_NAMES.4
//
// Boundary smoke: the lab consumes the same
// @firegrid/client an application would use, and
// does NOT import the @firegrid/runtime package. Runtime →  lab and
// lab → runtime are both architecture defects; the only contract
// between the two is the stream URL injected by the runtime
// process binary.
const here = dirname(fileURLToPath(import.meta.url))
const labPackageJsonPath = resolve(here, "..", "..", "package.json")
const workspaceYamlPath = resolve(here, "..", "..", "..", "..", "pnpm-workspace.yaml")

describe("firegrid-architecture-boundary.DEPENDENCY_GRAPH — lab app boundary is in place", () => {
  it("workspace-links @firegrid/client", async () => {
    const client = await import("@firegrid/client")
    expect(client).toBeTypeOf("object")
  })

  it("firegrid-architecture-boundary.SURFACE_AREA.4 — @firegrid/lab is a private app target without package exports", () => {
    const packageJson = JSON.parse(readFileSync(labPackageJsonPath, "utf8")) as Record<string, unknown>
    const scripts = packageJson.scripts as Record<string, unknown>

    expect(packageJson.name).toBe("@firegrid/lab")
    expect(packageJson.private).toBe(true)
    expect(scripts.build).toBeTypeOf("string")
    expect(scripts.dev).toBeTypeOf("string")
    expect(scripts.test).toBeTypeOf("string")
    expect(packageJson).not.toHaveProperty("main")
    expect(packageJson).not.toHaveProperty("types")
    expect(packageJson).not.toHaveProperty("exports")
  })

  it("firegrid-architecture-boundary.DEPENDENCY_GRAPH.6 — workspace apps are included outside reusable packages", () => {
    const workspaceYaml = readFileSync(workspaceYamlPath, "utf8")

    expect(workspaceYaml).toContain("packages/*")
    expect(workspaceYaml).toContain("apps/*")
  })
})

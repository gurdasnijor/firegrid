import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..", "..", "..")

const readJson = (path: string) =>
  JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as Record<
    string,
    unknown
  >

const activeTextFiles = (roots: ReadonlyArray<string>): ReadonlyArray<string> => {
  const files: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if ([".ts", ".tsx", ".js", ".json"].includes(extname(path))) {
        files.push(path)
      }
    }
  }

  for (const root of roots) {
    visit(resolve(repoRoot, root))
  }
  return files
}

// firegrid-package-migration.PACKAGE_NAMES.1
// firegrid-package-migration.PACKAGE_NAMES.2
// firegrid-package-migration.PACKAGE_NAMES.3
// firegrid-package-migration.PACKAGE_NAMES.4
// firegrid-package-migration.COMPATIBILITY.1
// firegrid-remediation-hardening.MIGRATION_BOUNDARIES.1
describe("firegrid-package-migration.PACKAGE_NAMES — active package names are Firegrid names", () => {
  it("uses Firegrid workspace package identities", () => {
    expect(readJson("package.json").name).toBe("firegrid")
    expect(readJson("packages/substrate/package.json").name).toBe(
      "@firegrid/substrate",
    )
    expect(readJson("packages/client/package.json").name).toBe(
      "@firegrid/client",
    )
    expect(readJson("packages/runtime/package.json").name).toBe(
      "@firegrid/runtime",
    )
    expect(readJson("apps/lab/package.json").name).toBe("@firegrid/lab")
  })

  it("does not publish legacy client compatibility exports", () => {
    const clientPackage = readJson("packages/client/package.json") as {
      readonly exports?: Record<
        string,
        { readonly types: string; readonly default: string }
      >
    }

    expect(clientPackage.exports?.["./compat"]).toBeUndefined()
    expect(clientPackage.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    })
    expect(clientPackage.exports?.["./event-streams"]).toEqual({
      types: "./dist/event-streams-public.d.ts",
      default: "./dist/event-streams-public.js",
    })
  })

  it("keeps legacy package imports out of active code and package manifests", () => {
    const legacyNamespace = "@durable-agent" + "-substrate/"
    const offenders = activeTextFiles([
      "apps",
      "packages",
    ]).filter((path) =>
      readFileSync(path, "utf8").includes(legacyNamespace),
    )

    expect(offenders.map((path) => path.replace(`${repoRoot}/`, ""))).toEqual(
      [],
    )
  })
})

// firegrid-package-migration.PACKAGE_DISTRIBUTION.1
// firegrid-package-migration.PACKAGE_DISTRIBUTION.2
// firegrid-package-migration.PACKAGE_DISTRIBUTION.3
// firegrid-package-migration.PACKAGE_DISTRIBUTION.5
// firegrid-package-migration.PACKAGE_DISTRIBUTION.6
// firegrid-package-migration.PACKAGE_DISTRIBUTION.7
describe("firegrid-package-migration.PACKAGE_DISTRIBUTION — client package artifacts are external-consumer shaped", () => {
  it("publishes built client, runtime, and substrate artifact entrypoints instead of source-only workspace paths", () => {
    const clientPackage = readJson("packages/client/package.json")
    const runtimePackage = readJson("packages/runtime/package.json")
    const substratePackage = readJson("packages/substrate/package.json")

    expect(clientPackage.private).toBeUndefined()
    expect(runtimePackage.private).toBeUndefined()
    expect(substratePackage.private).toBeUndefined()
    expect(clientPackage.main).toBe("./dist/index.js")
    expect(clientPackage.types).toBe("./dist/index.d.ts")
    expect(runtimePackage.main).toBe("./dist/index.js")
    expect(runtimePackage.types).toBe("./dist/index.d.ts")
    expect(substratePackage.main).toBe("./dist/index.js")
    expect(substratePackage.types).toBe("./dist/index.d.ts")
    expect(clientPackage.files).toEqual(["dist", "README.md"])
    expect(runtimePackage.files).toEqual(["dist", "README.md"])
    expect(runtimePackage.bin).toEqual({
      firegrid: "./dist/bin/firegrid.js",
      fg: "./dist/bin/firegrid.js",
    })
    expect(substratePackage.files).toEqual(["dist"])
  })
})

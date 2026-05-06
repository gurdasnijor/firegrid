import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
// firegrid-runtime-process.DEV_ENV_INJECTION.7
//
// The lab does not own a fixed-port default. It reads
// VITE_DURABLE_STREAMS_URL from the Vite process or a `?streamUrl=`
// query override, and otherwise renders an empty-state pointing at
// the attached workflow. The runtime binary is attached-only and does
// not inject browser env into spawned child processes.

const here = dirname(fileURLToPath(import.meta.url))

describe("lab attach: env-name contract with the firegrid runtime", () => {
  it("apps/lab/src/main.tsx reads VITE_DURABLE_STREAMS_URL and has no fixed-port default", () => {
    const main = readFileSync(resolve(here, "..", "main.tsx"), "utf8")
    expect(main).toContain('"VITE_DURABLE_STREAMS_URL"')
    expect(main).toContain("streamUrlSource")
    expect(main).toContain('"query"')
    expect(main).toContain('"vite-env"')
    expect(main).toContain("streamUrlSource={streamUrlSource}")
    // No fixed-port default constant — the legacy
    // http://127.0.0.1:4437/substrate/lab fallback is gone.
    expect(main).not.toContain("127.0.0.1:4437")
    expect(main).not.toContain("VITE_SUBSTRATE_STREAM_URL")
  })

  it("packages/runtime/bin/firegrid.ts is attached-only and has no dev-server child launcher", () => {
    const bin = readFileSync(
      resolve(
        here,
        "..",
        "..",
        "..",
        "..",
        "packages",
        "runtime",
        "bin",
        "firegrid.ts",
      ),
      "utf8",
    )
    expect(bin).toContain("DURABLE_STREAMS_URL")
    expect(bin).toContain("firegrid has no dev-server launcher subcommands")
    expect(bin).not.toContain("VITE_DURABLE_STREAMS_URL")
    expect(bin).not.toContain("Command.make")
    expect(bin).not.toContain("embeddedDev")
    expect(bin).not.toContain("SUBSTRATE_STREAM_URL")
  })
})

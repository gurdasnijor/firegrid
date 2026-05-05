import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
// firegrid-runtime-process.DEV_ENV_INJECTION.5
//
// The lab does not own a fixed-port default. It reads
// VITE_DURABLE_STREAMS_URL (canonical Firegrid env var, injected by
// `firegrid dev -- <child>`) or a `?streamUrl=` query override, and
// otherwise renders an empty-state pointing at the canonical
// workflow. This test pins the env-name contract on both sides:
// the lab reads `VITE_DURABLE_STREAMS_URL`, and the firegrid bin
// injects the same name into spawned child processes. Either side
// drifting fails this test loudly.

const here = dirname(fileURLToPath(import.meta.url))

describe("lab attach: env-name contract with the firegrid runtime", () => {
  it("packages/lab/src/main.tsx reads VITE_DURABLE_STREAMS_URL and has no fixed-port default", () => {
    const main = readFileSync(resolve(here, "..", "main.tsx"), "utf8")
    expect(main).toContain('"VITE_DURABLE_STREAMS_URL"')
    // No fixed-port default constant — the legacy
    // http://127.0.0.1:4437/substrate/lab fallback is gone.
    expect(main).not.toContain("127.0.0.1:4437")
    expect(main).not.toContain("VITE_SUBSTRATE_STREAM_URL")
  })

  it("packages/runtime/bin/firegrid.ts injects VITE_DURABLE_STREAMS_URL into the child env", () => {
    const bin = readFileSync(
      resolve(here, "..", "..", "..", "runtime", "bin", "firegrid.ts"),
      "utf8",
    )
    expect(bin).toContain("VITE_DURABLE_STREAMS_URL")
    expect(bin).toContain("DURABLE_STREAMS_URL")
    // Old SUBSTRATE_STREAM_URL env names must not survive the
    // cutover.
    expect(bin).not.toContain("SUBSTRATE_STREAM_URL")
  })
})

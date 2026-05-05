import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// durable-agent-runtime-lab.runtime-lab-inspector.WRITE_BOUNDARY.1
// durable-agent-runtime-lab.runtime-lab-inspector.WRITE_BOUNDARY.2
//
// Pins the lab's default attach URL and the host bin entry that
// serves it. The two values must agree so `pnpm --filter lab dev`
// attaches to `pnpm --filter @durable-agent-substrate/host
// dev:embedded` with no env / query-string ceremony. Neither side
// imports the other; the agreement is structural and lives in
// strings — this test fails loudly if either drifts.

const here = dirname(fileURLToPath(import.meta.url))

const expectedDefault = "http://127.0.0.1:4437/substrate/lab"
const expectedStreamName = "lab"
const expectedPort = 4437

describe("lab dev default attach point", () => {
  it("packages/lab/src/main.tsx defaults to the dev:embedded URL", () => {
    const main = readFileSync(resolve(here, "..", "main.tsx"), "utf8")
    expect(main).toContain(expectedDefault)
  })

  it("packages/host/bin/dev-embedded.ts boots an embedded server matching the default URL", () => {
    const dev = readFileSync(
      resolve(here, "..", "..", "..", "host", "bin", "dev-embedded.ts"),
      "utf8",
    )
    expect(dev).toContain(`streamName: "${expectedStreamName}"`)
    expect(dev).toContain(`durableStreamsPort: ${expectedPort}`)
    expect(dev).toContain('durableStreamsHost: "127.0.0.1"')
  })
})

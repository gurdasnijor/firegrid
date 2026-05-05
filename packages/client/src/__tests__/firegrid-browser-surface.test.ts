import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as FiregridSurface from "../firegrid/index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, "..")
const repoRoot = resolve(clientRoot, "..", "..", "..")

const readClient = (path: string) =>
  readFileSync(resolve(clientRoot, path), "utf8")

// firegrid-event-streams.CLIENT_API.4
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
// firegrid-architecture-boundary.SURFACE_AREA.3
describe("firegrid-event-streams.CLIENT_API.4 — Firegrid browser subpath is physically isolated", () => {
  it("exports EventStream APIs from a module graph with no substrate root or operation-client import", () => {
    expect(FiregridSurface.EventStreamClientLive).toBeTypeOf("function")
    expect(FiregridSurface.EventStream.define).toBeTypeOf("function")
    expect("FiregridClient" in FiregridSurface).toBe(false)
    expect("FiregridClientLive" in FiregridSurface).toBe(false)
    expect("EVENT_STREAM_ENVELOPE_TAG" in FiregridSurface).toBe(false)
    expect("makeEventStreamStateRow" in FiregridSurface).toBe(false)
    // @ts-expect-error firegrid-remediation-hardening.PUBLIC_SURFACES.4
    void FiregridSurface.FiregridClient
    // @ts-expect-error firegrid-remediation-hardening.PUBLIC_SURFACES.4
    void FiregridSurface.FiregridClientLive

    const publicSubpath = readClient("firegrid/index.ts")
    const eventClient = readClient("firegrid/event-client.ts")
    const combined = `${publicSubpath}\n${eventClient}`

    expect(combined).toContain(
      "@durable-agent-substrate/substrate/descriptors",
    )
    expect(combined).not.toContain("./operation-client")
    expect(combined).not.toContain("../client/service")
    expect(combined).not.toContain("SubstrateClientLive")
    expect(combined).not.toContain("@durable-agent-substrate/substrate\"")
    expect(combined).not.toContain("@durable-agent-substrate/substrate'")
    expect(combined).not.toContain("node:crypto")
    expect(combined).not.toContain("client.work.declare")
  })

  it("publishes descriptor and Firegrid browser-safe subpaths", () => {
    const substratePackage = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/substrate/package.json"), "utf8"),
    ) as { readonly exports: Record<string, string> }
    const clientPackage = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/client/package.json"), "utf8"),
    ) as { readonly exports: Record<string, string> }

    expect(substratePackage.exports["./descriptors"]).toBe(
      "./src/descriptors/index.ts",
    )
    expect(clientPackage.exports["./firegrid"]).toBe(
      "./src/firegrid/index.ts",
    )
    expect(clientPackage.exports["./compat"]).toBe(
      "./src/compat/index.ts",
    )
  })
})

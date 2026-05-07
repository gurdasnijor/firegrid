import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as FiregridSurface from "../event-streams-public.ts"
import * as ProjectionQuerySurface from "../projection-query.ts"

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

    const publicSubpath = readClient("event-streams-public.ts")
    const eventStreams = readClient("event-streams.ts")
    const combined = `${publicSubpath}\n${eventStreams}`

    expect(combined).toContain(
      "@firegrid/substrate/descriptors",
    )
    expect(combined).not.toContain("./operations")
    expect(combined).not.toContain("./internal/work-client")
    expect(combined).not.toContain("SubstrateClientLive")
    expect(combined).not.toContain("@firegrid/substrate\"")
    expect(combined).not.toContain("@firegrid/substrate'")
    expect(combined).not.toContain("node:crypto")
    expect(combined).not.toContain("client.work.declare")
  })

  it("publishes descriptor and Firegrid browser-safe subpaths", () => {
    const substratePackage = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/substrate/package.json"), "utf8"),
    ) as {
      readonly exports: Record<
        string,
        { readonly types: string; readonly default: string }
      >
    }
    const clientPackage = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/client/package.json"), "utf8"),
    ) as {
      readonly exports: Record<
        string,
        { readonly types: string; readonly default: string }
      >
    }

    expect(substratePackage.exports["./descriptors"]).toEqual({
      types: "./dist/descriptors/index.d.ts",
      default: "./dist/descriptors/index.js",
    })
    expect(clientPackage.exports["./event-streams"]).toEqual({
      types: "./dist/event-streams-public.d.ts",
      default: "./dist/event-streams-public.js",
    })
    expect(clientPackage.exports["./projection-query"]).toEqual({
      types: "./dist/projection-query.d.ts",
      default: "./dist/projection-query.js",
    })
    expect(clientPackage.exports["./firegrid"]).toBeUndefined()
    expect(clientPackage.exports["./compat"]).toBeUndefined()
  })
})

describe("firegrid-client-projection-api.BROWSER_SAFE_FACADE.1 — projection-query client surface stays browser-safe", () => {
  it("exports projection-query APIs from the approved client subpath without runtime, kernel, or raw StreamDB authority imports", () => {
    expect(ProjectionQuerySurface.ProjectionQueryClientLive).toBeTypeOf("function")
    expect(ProjectionQuerySurface.createProjectionQueryClient).toBeTypeOf("function")
    expect(ProjectionQuerySurface.observe).toBeTypeOf("function")
    expect(ProjectionQuerySurface.projectionFor).toBeTypeOf("function")
    expect(ProjectionQuerySurface.until).toBeTypeOf("function")
    expect(ProjectionQuerySurface.untilWhere).toBeTypeOf("function")
    expect(
      ProjectionQuerySurface.ProjectionCursor.initial({ name: "example" })._tag,
    ).toBe("firegrid/ProjectionCursor")

    const projectionQuery = readClient("projection-query.ts")
    expect(projectionQuery).toContain("@firegrid/substrate/event-plane")
    expect(projectionQuery).not.toContain("@firegrid/runtime")
    expect(projectionQuery).not.toContain("@firegrid/substrate/kernel")
    expect(projectionQuery).not.toContain("@firegrid/substrate\"")
    expect(projectionQuery).not.toContain("@firegrid/substrate'")
    expect(projectionQuery).not.toContain("@durable-streams/client")
    expect(projectionQuery).not.toContain("StreamDB")
    expect(projectionQuery).not.toContain("WorkClaim")
    expect(projectionQuery).not.toContain("RunWait")
    expect(projectionQuery).not.toContain("Completion")
  })
})

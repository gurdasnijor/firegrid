import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as ClientSurface from "../index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, "..")
const packageRoot = resolve(clientRoot, "..")
const readClient = (path: string) =>
  readFileSync(resolve(clientRoot, path), "utf8")

const readPackageFile = (path: string) =>
  readFileSync(resolve(packageRoot, path), "utf8")

const codeBlocks = (markdown: string): ReadonlyArray<string> =>
  Array.from(
    markdown.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g),
    (match) => match[1]!,
  )

const importSpecifiers = (source: string): ReadonlyArray<string> =>
  Array.from(
    source.matchAll(
      /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    ),
    (match) => match[1]!,
  )

const namedSpecifiersFor = (
  source: string,
  moduleName: string,
): ReadonlyArray<string> =>
  Array.from(
    source.matchAll(
      new RegExp(
        String.raw`(?:import|export)\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']${moduleName.replaceAll("/", String.raw`\/`)}["']`,
        "g",
      ),
    ),
    (match) =>
      match[1]!
        .split(",")
        .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/u)[0]!)
        .filter((part) => part.length > 0),
  ).flat()

const resolveLocalImport = (fromFile: string, specifier: string): string => {
  const base = resolve(dirname(fromFile), specifier)
  if (specifier.endsWith(".ts")) return base
  return `${base}.ts`
}

const collectLocalGraph = (entry: string): Map<string, string> => {
  const visited = new Map<string, string>()
  const pending = [resolve(clientRoot, entry)]

  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    const source = readFileSync(file, "utf8")
    visited.set(file, source)

    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue
      const next = resolveLocalImport(file, specifier)
      if (!existsSync(next)) {
        throw new Error(`Could not resolve ${specifier} from ${file}`)
      }
      pending.push(next)
    }
  }

  return visited
}

const relativeFiles = (graph: Map<string, string>): ReadonlyArray<string> =>
  Array.from(graph.keys(), (file) => file.slice(clientRoot.length + 1)).sort()

const forbiddenExternalModules = [
  "@firegrid/runtime",
  "@firegrid/substrate/kernel",
  "@firegrid/lab",
  "node:",
  "fs",
  "path",
  "url",
  "crypto",
] as const

const forbiddenSubstrateRootImports = [
  "RunWait",
  "Choreography",
  "DurableWaitsLive",
  "WorkProducer",
  "SubstrateProducerLive",
  "WorkClaim",
  "WorkClaimLive",
  "CompletionProducer",
  "CompletionId",
  "CurrentWorkContext",
  "currentWorkContextLayer",
] as const

const forbiddenExampleFragments = [
  "@firegrid/runtime",
  "@firegrid/substrate/kernel",
  "RunWait",
  "Choreography",
  "DurableWaitsLive",
  "WorkProducer",
  "SubstrateClient",
  "claim",
  "completion",
  "terminal",
  "DurableStream",
  "dev-server",
  "dev server",
] as const

// firegrid-remediation-hardening.PUBLIC_SURFACES.1
// firegrid-remediation-hardening.PUBLIC_SURFACES.2
// firegrid-remediation-hardening.TEST_GUARDRAILS.1
// firegrid-architecture-boundary.SURFACE_AREA.1
describe("firegrid-remediation-hardening.PUBLIC_SURFACES — client root exposes only Firegrid vocabulary", () => {
  it("the app-facing client root matches the Firegrid allowlist", () => {
    const allowed = new Set([
      "EventStream",
      "EventStreamAppendError",
      "EventStreamDecodeError",
      "EventStreamEncodeError",
      "EventStreamReadError",
      "FiregridClient",
      "FiregridClientLive",
      "Operation",
      "OperationCancelled",
      "OperationDecodeError",
      "OperationEncodeError",
      "OperationHandle",
      "OperationNotFound",
    ])
    expect(new Set(Object.keys(ClientSurface))).toEqual(allowed)
  })

  it("the @firegrid/client root surface contains no banned identifier vocabulary", () => {
    const banned = [
      // raw stream / DSS APIs
      "DurableStream",
      "createStateSchema",
      "openSubstrateDb",
      "rebuildProjection",
      "stream",
      // raw row builders
      "createPendingCompletion",
      "resolveCompletion",
      "rejectCompletion",
      "cancelCompletion",
      "startRun",
      "blockRun",
      "completeRun",
      "failRun",
      "cancelRun",
      "substrateState",
      "RunValue",
      "CompletionValue",
      "ClaimAttemptValue",
      // operator pipelines
      "Work",
      "WorkClaim",
      "WorkClaimLive",
      "processReadyWorkItem",
      // producer internals leaked
      "WorkProducer",
      "CompletionProducer",
      "SubstrateProducerLive",
      // legacy compatibility surface
      "SubstrateClient",
      "SubstrateClientLive",
      "SubstrateClientConfig",
      "SubstrateClientService",
      "DeclareWorkInput",
      "DeclareWorkResult",
      "SubstrateClientWork",
      "SubstrateWorkHandle",
      "WorkObservation",
      // wire helpers/constants belong to explicit descriptor/kernel subpaths
      "EVENT_STREAM_ENVELOPE_TAG",
      "EVENT_STREAM_ROW_TYPE",
      "OPERATION_ENVELOPE_TAG",
      "makeEventStreamEnvelope",
      "makeEventStreamStateRow",
      "eventStreamEnvelopeFromStateRow",
    ]
    const surface = Object.keys(ClientSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

// firegrid-remediation-hardening.PUBLIC_SURFACES.3
// firegrid-operation-messaging.APP_BOUNDARY.1
describe("firegrid-remediation-hardening.PUBLIC_SURFACES.3 — FiregridClient is the root client tag", () => {
  it("FiregridClient is a Context.Tag and FiregridClientLive is a callable Layer factory", () => {
    expect(typeof ClientSurface.FiregridClient).toBe("function")
    expect(typeof ClientSurface.FiregridClientLive).toBe("function")
    const layer = ClientSurface.FiregridClientLive({
      streamUrl: "http://example.invalid/substrate/none",
    })
    expect(layer).toBeTypeOf("object")
  })
})

// launchable-substrate-host.CLIENT_SURFACE.13
// v1 client choreography surface is intentionally NOT yet present at
// the root: scheduleAt lands in Slice 3, and sleep / waitFor /
// awaitAwakeable are server-side runtime primitives that never enter
// the client root.
describe("launchable-substrate-host.CLIENT_SURFACE.13 — v1 client root does not expose sleep / waitFor / awaitAwakeable", () => {
  it("the client root surface contains no run-internal choreography accessors", () => {
    const banned = ["sleep", "waitFor", "awaitAwakeable", "Choreography"]
    const surface = Object.keys(ClientSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

describe("firegrid-client-api.AUTHORITY_BOUNDARY.1, .2, .4, .5 — client source stays outside runtime and kernel authority", () => {
  it("the production client root does not import runtime, kernel, work producer, or internal work facade modules", () => {
    const root = readClient("index.ts")
    const operations = readClient("operations.ts")
    const service = readClient("service.ts")
    const eventStreams = readClient("event-streams.ts")
    const combined = `${root}\n${operations}\n${service}\n${eventStreams}`

    expect(combined).not.toContain("@firegrid/runtime")
    expect(combined).not.toContain("@firegrid/substrate/kernel")
    expect(combined).not.toContain("SubstrateClient")
    expect(combined).not.toContain("WorkProducer")
    expect(combined).not.toContain("SubstrateProducer")
    expect(combined).not.toContain("RunWait")
    expect(combined).not.toContain("Choreography")
    expect(combined).not.toContain("DurableWaitsLive")
    expect(combined).not.toContain("./internal/work-client")
    expect(combined).not.toContain("./internal/work-facet")
  })
})

describe("firegrid-client-api.AUTHORITY_BOUNDARY.5 — client production entrypoints stay browser-safe", () => {
  it("firegrid-client-api.AUTHORITY_BOUNDARY.1 — root graph imports no runtime, kernel, Node, or authority modules", () => {
    const graph = collectLocalGraph("index.ts")
    expect(relativeFiles(graph)).toEqual([
      "event-streams.ts",
      "index.ts",
      "operations.ts",
      "service.ts",
    ])

    for (const [file, source] of graph) {
      const specifiers = importSpecifiers(source)
      const offenders = forbiddenExternalModules.filter((forbidden) =>
        specifiers.some((specifier) =>
          forbidden.endsWith(":")
            ? specifier.startsWith(forbidden)
            : specifier === forbidden,
        ),
      )
      expect(
        offenders,
        `${file} imported forbidden modules: ${offenders.join(", ")}`,
      ).toEqual([])

      const substrateRootImports = namedSpecifiersFor(
        source,
        "@firegrid/substrate",
      )
      const authorityImports = forbiddenSubstrateRootImports.filter((name) =>
        substrateRootImports.includes(name),
      )
      expect(
        authorityImports,
        `${file} imported client-forbidden substrate authority: ${authorityImports.join(", ")}`,
      ).toEqual([])
    }
  })

  it("firegrid-event-streams.CLIENT_API.4 — event-stream subpath graph cannot reach operations or substrate root", () => {
    const graph = collectLocalGraph("event-streams-public.ts")
    expect(relativeFiles(graph)).toEqual([
      "event-streams-public.ts",
      "event-streams.ts",
    ])

    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as { readonly exports: Record<string, string> }
    expect(packageJson.exports).toEqual({
      ".": "./src/index.ts",
      "./event-streams": "./src/event-streams-public.ts",
    })

    for (const [file, source] of graph) {
      const specifiers = importSpecifiers(source)
      expect(
        specifiers.filter((specifier) => specifier === "@firegrid/substrate"),
        `${file} imported substrate root from browser-safe EventStream subpath`,
      ).toEqual([])
      expect(
        specifiers.filter((specifier) => specifier === "./operations.ts"),
        `${file} imported the operation client from browser-safe EventStream subpath`,
      ).toEqual([])
      expect(
        specifiers.filter((specifier) =>
          forbiddenExternalModules.some((forbidden) =>
            forbidden.endsWith(":")
              ? specifier.startsWith(forbidden)
              : specifier === forbidden,
          ),
        ),
      ).toEqual([])
    }
  })
})

describe("firegrid-client-api.DOCUMENTATION.2 — client README examples stay aligned with the public client surface", () => {
  it("README snippets demonstrate send/call/result/observe and emit/events without runtime or durable-authority paths", () => {
    const readme = readPackageFile("README.md")
    const snippets = codeBlocks(readme).join("\n")

    for (const required of [
      "FiregridClientLive",
      "Operation.define",
      "EventStream.define",
      "client.send",
      "client.observe",
      "client.result",
      "client.call",
      "client.emit",
      "client.events",
    ]) {
      expect(snippets).toContain(required)
    }

    const offenders = forbiddenExampleFragments.filter((fragment) =>
      snippets.includes(fragment),
    )
    expect(offenders).toEqual([])
  })
})

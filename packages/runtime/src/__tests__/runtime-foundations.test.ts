import { readFileSync } from "node:fs"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Substrate from "@firegrid/substrate"
import * as SubstrateKernel from "@firegrid/substrate/kernel"
import * as RuntimeSurface from "../index.ts"

const runtimeBinarySource = () =>
  readFileSync(
    new URL("../../bin/firegrid.ts", import.meta.url),
    "utf8",
  )

const runtimeRunSource = () =>
  readFileSync(
    new URL("../run.ts", import.meta.url),
    "utf8",
  )

class AppDependency extends Context.Tag(
  "firegrid/test/AppDependency",
)<AppDependency, { readonly value: string }>() {}

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.3
// firegrid-architecture-boundary.SURFACE_AREA.1
// firegrid-architecture-boundary.SURFACE_AREA.2
// firegrid-package-migration.RUNTIME_RENAME.1
// firegrid-package-migration.RUNTIME_RENAME.3
// firegrid-package-migration.RUNTIME_RENAME.5
// firegrid-runtime-process.RUNTIME_PACKAGE.2
// firegrid-runtime-process.CONFIG_SURFACE.2
//
// Foundations for the @firegrid/runtime public root surface. The
// public surface is intentionally tiny: a single attached Layer constructor,
// a typed app-owned run(...) Effect, the runtime + runtime-context Tags, and
// the small Firegrid runtime helper namespace.

describe("firegrid-architecture-boundary.SURFACE_AREA — runtime root exposes a tiny Firegrid surface", () => {
  it("FiregridRuntime + RuntimeContext are Context.Tag classes", () => {
    expect(typeof RuntimeSurface.FiregridRuntime).toBe("function")
    expect(typeof RuntimeSurface.RuntimeContext).toBe("function")
  })

  it("firegrid-runtime-process.RUNTIME_RUN_API.1 exposes typed run(...) at the runtime root", () => {
    expect(typeof RuntimeSurface.run).toBe("function")
  })

  it("FiregridRuntimeBoot.attached is the only construction entry point", () => {
    expect(typeof RuntimeSurface.FiregridRuntimeBoot.attached).toBe(
      "function",
    )
    const allowed = new Set(["attached"])
    for (const key of Object.keys(RuntimeSurface.FiregridRuntimeBoot)) {
      expect(allowed.has(key)).toBe(true)
    }
  })

  it("Firegrid namespace exposes subscribers.{timer, scheduledWork, projectionMatch} (transitional), handler, and eventStream", () => {
    expect(RuntimeSurface.Firegrid.subscribers.timer).toBeDefined()
    expect(RuntimeSurface.Firegrid.subscribers.scheduledWork).toBeDefined()
    expect(typeof RuntimeSurface.Firegrid.subscribers.projectionMatch).toBe(
      "function",
    )
    expect(typeof RuntimeSurface.Firegrid.handler).toBe("function")
    expect(typeof RuntimeSurface.Firegrid.eventStream).toBe("function")
    const subscriberKeys = Object.keys(
      RuntimeSurface.Firegrid.subscribers,
    )
    expect(new Set(subscriberKeys)).toEqual(
      new Set(["timer", "scheduledWork", "projectionMatch"]),
    )
    expect(new Set(Object.keys(RuntimeSurface.Firegrid))).toEqual(
      new Set(["subscribers", "handler", "eventStream"]),
    )
    expect("run" in RuntimeSurface.Firegrid).toBe(false)
  })
})

describe("firegrid-runtime-process.RUNTIME_RUN_API — typed app-owned runtime entrypoint", () => {
  it("firegrid-runtime-process.RUNTIME_RUN_API.2 + firegrid-runtime-process.RUNTIME_RUN_API.3 keeps app requirements visible after RuntimeContext is supplied", () => {
    const runtime = Layer.scopedDiscard(
      Effect.gen(function* () {
        yield* RuntimeSurface.RuntimeContext
        yield* AppDependency
      }),
    )

    const program = RuntimeSurface.run({
      connection: {
        streamUrl: "http://127.0.0.1:4437/v1/stream/firegrid",
      },
      runtime,
    })

    const typed: Effect.Effect<never, unknown, AppDependency> = program
    expect(typed).toBe(program)
  })

  it("firegrid-runtime-process.RUNTIME_RUN_API.1 + firegrid-runtime-process.RUNTIME_RUN_API.3 + firegrid-runtime-process.RUNTIME_RUN_API.8 + firegrid-runtime-process.RUNTIME_RUN_API.9 provides caller graphs to attached boot", () => {
    const source = runtimeRunSource()

    expect(source).toContain("FiregridRuntimeBoot.attached")
    expect(source).toContain("RuntimeContext | R")
    expect(source).toContain("Exclude<Exclude<R, RuntimeContext>")
    expect(source).toContain("Scope.Scope")
    expect(source).toContain("connection.streamUrl")
    expect(source).toContain("runtime: opts.runtime")
    expect(source).toContain("Effect.flatMap(FiregridRuntime")
    expect(source).toContain("Effect.never")
  })

  it("firegrid-runtime-process.RUNTIME_RUN_API.6 + firegrid-runtime-process.RUNTIME_RUN_API.7 keeps run explicit without library-side process exits", () => {
    const source = runtimeRunSource()

    expect(source).not.toContain("subscribers")
    expect(source).not.toContain("defaults")
    expect(source).not.toContain("process.exit")
    expect(source).not.toContain("NodeRuntime.runMain")
  })

  it("firegrid-runtime-process.RUNTIME_RUN_API.4 + firegrid-runtime-process.RUNTIME_RUN_API.5 keeps the binary graph-free and attached-only", () => {
    const source = runtimeBinarySource()

    expect(source).toContain("DURABLE_STREAMS_URL")
    expect(source).toContain("FiregridRuntimeBoot.attached({ streamUrl })")
    expect(source).not.toContain("FIREGRID_RUNTIME_MODULE")
    expect(source).not.toContain("import(")
    expect(source).not.toContain("@firegrid/client")
    expect(source).not.toContain("DurableStream.create")
    expect(source).not.toContain("child_process")
    expect(source).not.toContain("firegrid dev")
  })
})

// firegrid-runtime-process.CONFIG_SURFACE.1
// firegrid-runtime-process.CONFIG_SURFACE.2
//
// Boot-plan-from-env APIs and reified boot-plan types are
// intentionally absent. Runtime process configuration belongs at
// the binary process edge (bin/firegrid.ts).
describe("firegrid-runtime-process.CONFIG_SURFACE — no boot-plan-from-env / boot-plan reification on the public surface", () => {
  it("the runtime root does not expose bootPlanFromConfig / FiregridRuntimeLive / boot-plan unions", () => {
    const banned = [
      "bootPlanFromConfig",
      "attachedFromConfig",
      "ConfigError",
      "FiregridRuntimeLive",
      "FiregridRuntimeLiveOptions",
      "FiregridRuntimeBootPlan",
      "AttachedRuntimePlan",
      "EmbeddedDevRuntimePlan",
      "bootModeOf",
      "loadRuntimeGraph",
      "RuntimeGraphLoadError",
      "RuntimeGraphExportError",
    ]
    const surface = Object.keys(RuntimeSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
    expect(
      "attachedFromConfig" in RuntimeSurface.FiregridRuntimeBoot,
    ).toBe(false)
    expect(
      "bootPlanFromConfig" in RuntimeSurface.FiregridRuntimeBoot,
    ).toBe(false)
  })
})

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
describe("firegrid-architecture-boundary.DEPENDENCY_GRAPH — runtime does not redefine substrate-owned schemas", () => {
  it("the runtime root surface exposes no substrate row family identifiers", () => {
    const banned = [
      "RunValue",
      "CompletionValue",
      "ClaimAttemptValue",
      "TraceValue",
      "substrateState",
      "createPendingCompletion",
      "resolveCompletion",
      "startRun",
      "blockRun",
      "completeRun",
      "failRun",
      "cancelRun",
    ]
    const surface = Object.keys(RuntimeSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })

  it("substrate is the source of truth for row schemas", () => {
    expect(SubstrateKernel.RunValue).toBeDefined()
    expect(SubstrateKernel.CompletionValue).toBeDefined()
    expect(SubstrateKernel.ClaimAttemptValue).toBeDefined()
    expect(SubstrateKernel.TraceValue).toBeDefined()
    const root = Substrate as unknown as Record<string, unknown>
    expect(root.RunValue).toBeUndefined()
    expect(root.CompletionValue).toBeUndefined()
    expect(root.ClaimAttemptValue).toBeUndefined()
    expect(root.TraceValue).toBeUndefined()
  })

  it("the runtime root introduces no banned product-domain row families", () => {
    const banned = [
      "Fireline",
      "Firepixel",
      "ACP",
      "MCP",
      "Session",
      "Prompt",
      "Provider",
      "Sandbox",
      "ToolCall",
      "Transport",
      "ProcessTransport",
    ]
    const surface = Object.keys(RuntimeSurface)
    const offenders = banned.filter((b) =>
      surface.some((k) => k.toLowerCase() === b.toLowerCase()),
    )
    expect(offenders).toEqual([])
  })
})

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
describe("firegrid-architecture-boundary.DEPENDENCY_GRAPH — no withHost / SubstrateClient / host-era vocabulary on the runtime root", () => {
  it("the runtime root surface exposes no host-era or client identifiers", () => {
    const banned = [
      "withHost",
      "WithHostOptions",
      "WithHostEmbeddedDevOptions",
      "WithHostAttachedOptions",
      "SubstrateClient",
      "SubstrateClientLive",
      "SubstrateHost",
      "SubstrateHostBoot",
      "SubstrateHostLive",
      "HostProgramGraph",
      "HostPrograms",
      "HostProgramRuntime",
    ]
    const surface = Object.keys(RuntimeSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
    expect("withHost" in RuntimeSurface.FiregridRuntimeBoot).toBe(false)
  })
})

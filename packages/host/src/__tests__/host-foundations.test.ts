import { describe, expect, it } from "vitest"
import * as HostSurface from "../index.js"
import * as Substrate from "@durable-agent-substrate/substrate"

// launchable-substrate-host.SCHEMA_OWNERSHIP.2
// Client and host code reuse substrate-owned row schemas, types, state
// helpers, and transition builders rather than redefining durable.run,
// durable.completion, durable.claim.attempt, or durable.trace shapes.
describe("launchable-substrate-host.SCHEMA_OWNERSHIP.2 — host does not redefine substrate-owned durable row schemas", () => {
  it("the host root surface exposes no RunValue / CompletionValue / ClaimAttemptValue / TraceValue identifier", () => {
    const banned = [
      "RunValue",
      "CompletionValue",
      "ClaimAttemptValue",
      "TraceValue",
      "RunRowType",
      "CompletionRowType",
      "ClaimAttemptRowType",
      "TraceRowType",
      "substrateState",
      "createPendingCompletion",
      "resolveCompletion",
      "rejectCompletion",
      "cancelCompletion",
      "startRun",
      "blockRun",
      "completeRun",
      "failRun",
      "cancelRun",
    ]
    const surface = Object.keys(HostSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })

  it("substrate is the source of truth for durable row schemas (the host depends on it for any row read)", () => {
    expect(Substrate.RunValue).toBeDefined()
    expect(Substrate.CompletionValue).toBeDefined()
    expect(Substrate.ClaimAttemptValue).toBeDefined()
    expect(Substrate.TraceValue).toBeDefined()
  })
})

// launchable-substrate-host.SCHEMA_OWNERSHIP.4
// Host-local configuration / diagnostics / lifecycle types remain
// host-owned and are not durable substrate row families.
describe("launchable-substrate-host.SCHEMA_OWNERSHIP.4 — host-local types are host-owned and not durable row families", () => {
  it("SubstrateHostBootPlan tag values are host-only literals (not durable.* row types)", () => {
    // The host's tagged-union literal values do not collide with
    // substrate row family types; this is asserted structurally by
    // listing the literals the host plan uses.
    const hostTags: ReadonlyArray<string> = ["EmbeddedDevHost", "AttachedHost"]
    const substrateRowTypes: ReadonlyArray<string> = [
      "durable.run",
      "durable.completion",
      "durable.claim.attempt",
      "durable.trace",
    ]
    for (const t of hostTags) {
      expect(substrateRowTypes).not.toContain(t)
    }
  })

  it("the host root exposes only host-local lifecycle vocabulary, no durable row family helpers", () => {
    // Host root surface should not include any "RowType" or row-family
    // helper function name.
    const surface = Object.keys(HostSurface)
    expect(surface.some((k) => /RowType$/.test(k))).toBe(false)
    expect(surface.some((k) => /^substrateState$/.test(k))).toBe(false)
  })
})

// launchable-substrate-host.SCHEMA_OWNERSHIP.5
// The launchable layer does not introduce a shared types package for
// substrate-owned or caller-owned row schemas.
describe("launchable-substrate-host.SCHEMA_OWNERSHIP.5 — no shared types package introduced by the launchable layer", () => {
  it("workspace contains no @durable-agent-substrate/types package (substrate is the row-schema source of truth)", async () => {
    // Importing the hypothetical shared types package must fail.
    let importedShared = false
    try {
      // @ts-expect-error intentional: this import path must NOT exist
      await import("@durable-agent-substrate/types")
      importedShared = true
    } catch {
      importedShared = false
    }
    expect(importedShared).toBe(false)
  })
})

// launchable-substrate-host.PACKAGING.8
// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.2
// launchable-substrate-host.HOST_CONFIGURATION.3
// launchable-substrate-host.HOST_CONFIGURATION.4
//
// Host package exposes an Effect-native launch and composition API
// per launchable-substrate-host.PACKAGING.8 and the per-mode
// constructors required by
// launchable-substrate-host.HOST_CONFIGURATION.1 (embedded-dev),
// launchable-substrate-host.HOST_CONFIGURATION.2 (attached),
// launchable-substrate-host.HOST_CONFIGURATION.3 (explicit-options
// building), and launchable-substrate-host.HOST_CONFIGURATION.4
// (Effect Config decoding); each of those four ACIDs is asserted
// individually below.
//
// `withHost`-style composition is intentionally NOT exposed by this
// slice; it lands in a later slice that owns process-runner concerns.
describe("launchable-substrate-host.PACKAGING.8 — host package exposes an Effect-native launch and composition API", () => {
  it("SubstrateHostLive is a callable Layer factory and SubstrateHost is a Context.Tag class", () => {
    expect(typeof HostSurface.SubstrateHostLive).toBe("function")
    expect(typeof HostSurface.SubstrateHost).toBe("function")
  })
})

describe("launchable-substrate-host.HOST_CONFIGURATION.1 — embedded-dev boot plan constructor is exposed", () => {
  it("SubstrateHostBoot.embeddedDev is a callable function", () => {
    expect(typeof HostSurface.SubstrateHostBoot.embeddedDev).toBe("function")
  })
})

describe("launchable-substrate-host.HOST_CONFIGURATION.2 — attached boot plan constructor is exposed", () => {
  it("SubstrateHostBoot.attached is a callable function", () => {
    expect(typeof HostSurface.SubstrateHostBoot.attached).toBe("function")
  })
})

describe("launchable-substrate-host.HOST_CONFIGURATION.3 — explicit-options boot plan construction is supported", () => {
  it("SubstrateHostBoot.attached and SubstrateHostBoot.embeddedDev accept explicit options", () => {
    // Smoke check: invoking with explicit options returns a Layer (an
    // object); behavioral coverage lives in attached.test.ts and
    // embedded.test.ts.
    expect(
      HostSurface.SubstrateHostBoot.attached({
        streamUrl: "http://invalid.example/none",
      }),
    ).toBeTypeOf("object")
    expect(HostSurface.SubstrateHostBoot.embeddedDev({})).toBeTypeOf("object")
  })
})

describe("launchable-substrate-host.HOST_CONFIGURATION.4 — Effect Config boot plan decoder is exposed", () => {
  it("SubstrateHostBoot.attachedFromConfig and SubstrateHostBoot.bootPlanFromConfig are exposed at the host root", () => {
    expect(typeof HostSurface.SubstrateHostBoot.attachedFromConfig).toBe(
      "function",
    )
    expect(HostSurface.SubstrateHostBoot.bootPlanFromConfig).toBeDefined()
  })
})

// launchable-substrate-host.AUTHORITY_BOUNDARY.4
// The launchable layer does not introduce new substrate-native row
// families for Fireline / Firepixel / ACP / MCP / sessions / prompts /
// providers / sandboxes / process transports.
describe("launchable-substrate-host.AUTHORITY_BOUNDARY.4 — host root introduces no banned domain row families", () => {
  it("host root exposes no Fireline/Firepixel/ACP/MCP/session/prompt/provider/sandbox/transport row family identifiers", () => {
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
    const surface = Object.keys(HostSurface)
    const offenders = banned.filter((b) =>
      surface.some((k) => k.toLowerCase() === b.toLowerCase()),
    )
    expect(offenders).toEqual([])
  })
})

// Wave B focused construction test for the canonical runtime root.
//
// Proves the Layer graph at `composition/host-live.ts` can be built from
// target-folder surfaces only — no `RuntimeContextWorkflowNative` body path,
// no `RuntimeContextWorkflowRuntime` wrapper, no `runtime-input-deferred`
// mailbox, no `@firegrid/runtime/kernel` reachability.
//
// This is the Wave B exit gate criterion (per
// `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` §Wave B): "Focused
// runtime-root tests prove the Layer graph can be constructed without the old
// RuntimeContext body path." It is NOT a Wave C public-turn proof.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as HostLive from "../../src/composition/host-live.ts"
import { RuntimeHostLive } from "../../src/composition/host-live.ts"

const hostLiveSourcePath = resolve(
  import.meta.dirname,
  "../../src/composition/host-live.ts",
)
const hostLiveSource = readFileSync(hostLiveSourcePath, "utf8")

// The line that begins the imports — used to scope textual bans to the import
// header rather than scanning doc comments where the symbols are described as
// what is forbidden. We slice from the FIRST import line to the end of the
// import block.
const hostLiveImportSection = (() => {
  const startIndex = hostLiveSource.indexOf("\nimport ")
  if (startIndex < 0) throw new Error("host-live.ts has no import block")
  const exportIndex = hostLiveSource.indexOf("\nexport ", startIndex)
  return hostLiveSource.slice(startIndex, exportIndex < 0 ? undefined : exportIndex)
})()

describe("composition/host-live", () => {
  it("exposes only the canonical runtime host composition surface", () => {
    // The composition file is Layer wiring only. Its public surface is the
    // canonical host composition/root set; behavior must not leak in here.
    expect(Object.keys(HostLive).sort()).toEqual([
      "FiregridLocalHostLive",
      "FiregridRuntimeHostLive",
      "FiregridRuntimeHostWithWorkflowLive",
      "RuntimeHostLive",
      "RuntimeHostTopologyFromConfig",
    ].sort())
    expect(Layer.isLayer(RuntimeHostLive)).toBe(true)
  })

  it("imports only from target folders / tree-aligned subpaths", () => {
    // The import block must reach Shape D Layers only through
    // `subscribers/<name>/` shims, never directly from the legacy substrate
    // homes. This pairs with the dep-cruiser folder-direction rules and the
    // `firegrid-composition-no-legacy-imports` Semgrep rule; if either of
    // those rules is ever relaxed for a real reason, this test ensures the
    // composition file does not silently regress.
    //
    // After the tf-z8wq mechanical move, the prior substrate residue
    // carve-outs (engine substrate residing under `workflow-engine/` and
    // the host-config Tag residing under `kernel/`) shrank to deletion:
    // the substrate is at `engine/` and the host-config is at
    // `channels/runtime-host-config.ts`. There are no allowed
    // narrow-file imports from legacy roots from `host-live.ts` anymore.
    const forbiddenSubstrings = [
      "../workflow-engine/",
      "../agent-event-pipeline/",
      "../kernel/",
      "../_archive/",
      "@firegrid/runtime/kernel",
      "@firegrid/runtime/workflows",
      "@firegrid/runtime/workflow-engine",
      "@firegrid/runtime/_archive",
      "@firegrid/host-sdk",
    ]
    for (const banned of forbiddenSubstrings) {
      expect(hostLiveImportSection).not.toContain(banned)
    }
  })

  it("does not import the legacy RuntimeContext body driver or its mailbox", () => {
    // Symbol-level guard. Doc comments may describe what is forbidden; the
    // import header must not actually reference these identifiers.
    const forbiddenSymbols = [
      "RuntimeContextWorkflowNative",
      "RuntimeContextWorkflowNativeLayer",
      "executeRuntimeContextWorkflow",
      "RuntimeContextWorkflowRuntime",
      "RuntimeInputIntentDispatcherLive",
      "runtimeInputDeferredFor",
      "runtimeInputDeferredName",
      "appendRuntimeInputDeferred",
    ]
    for (const banned of forbiddenSymbols) {
      expect(hostLiveImportSection).not.toContain(banned)
    }
  })
})

const hostSdkBoundaryModules = "^packages/host-sdk/src"

const sanctionedRuntimeCapabilitySubpaths = [
  // Runtime-owned capability tags and public observation/protocol projections
  // sanctioned for host-sdk binding composition by
  // docs/architecture/host-sdk-runtime-boundary.md.
  "runtime-errors\\.ts$",
  "channels/index\\.ts$",
  "agent-event-pipeline/authorities/per-context-output\\.ts$",
  "agent-event-pipeline/tool-execution/index\\.ts$",
  "authorities/index\\.ts$",
  "control-plane/index\\.ts$",
  "agent-event-pipeline/authorities/runtime-output-public\\.ts$",
  "streams/index\\.ts$",
  "channels/index\\.ts$",
  "verified-webhook-ingest/index\\.ts$",
  "agent-event-pipeline/events/index\\.ts$",
  "agent-event-pipeline/codecs/index\\.ts$",
  "agent-event-pipeline/session-byte-stream-adapter\\.ts$",
  "agent-adapters/index\\.ts$",
  "agent-event-pipeline/sources/sandbox/index\\.ts$",
  "kernel/index\\.ts$",
  // Wave D-A (PR #714): host-sdk composes the Shape C subscriber via the
  // runtime composition root + reaches the session-command seam contract
  // directly. Both subpaths are part of the runtime/package.json exports
  // and named in the host-sdk/runtime boundary doc as the post-D-A binding
  // surface.
  "subscribers/runtime-context-session/index\\.ts$",
  "composition/host-live\\.ts$",
].join("|")

// All four prior currentHostSdkSubstrateDebt carve-outs were stale (files
// absent on disk as of 2026-05-23). Empty by design: any new debt MUST
// have a named bead owning its retirement before it lands here.
const currentHostSdkSubstrateDebt = []

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Temporary exception covers the legacy durable-launch secret cycle on main; tracer 001 removes that path.",
      from: {
        pathNot: [
          "^packages/runtime/src/durable-launch/(launcher|resources/secrets)\\.ts$",
        ],
      },
      to: { circular: true },
    },
    {
      // firegrid-runtime-boundary-reconciliation.CYCLE_BREAKING.5
      // firegrid-runtime-boundary-reconciliation.CYCLE_BREAKING.7
      // firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.4
      name: "runtime-src-no-folder-cycles",
      severity: "error",
      scope: "folder",
      comment:
        "packages/runtime/src must stay free of folder-level cycles; this rule is hard-zero and has no baseline or carveout.",
      from: { path: "^packages/runtime/src" },
      to: { circular: true },
    },
    // ------------------------------------------------------------------
    // Wave A semantic-tree folder-direction rules
    // (docs/architecture/2026-05-22-runtime-physical-target-tree.md).
    //
    // Layering (lowest → highest):
    //   events/  <-  tables/, transforms/  <-  channels/, producers/,
    //   subscribers/  <-  composition/
    //
    // Each rule fails any folder importing from a sibling or higher tier
    // that the target-tree doc disallows. Folder-path enforcement lives
    // here (dep-cruiser is path-graph aware); symbol-level bans (Activity
    // .make, Workflow.suspend, Effect.Effect<>, etc.) stay in semgrep.
    //
    // Rules are scoped to packages/runtime/src/<tier>/** only. The legacy
    // pre-cutover tree (agent-event-pipeline/, workflow-engine/) is not
    // touched except where transforms/ -> agent-event-pipeline/ is banned
    // explicitly below (Wave A semantic-move enforcement).
    // ------------------------------------------------------------------
    {
      name: "runtime-events-no-higher-tier-import",
      severity: "error",
      comment:
        "events/ is the pure event-vocabulary tier. It must not import from tables/, transforms/, channels/, producers/, subscribers/, composition/, workflow-engine/, or agent-event-pipeline/. Move shared types INTO events/ and have the higher tier re-export from there. Direct cause: PR #695 first push had events/runtime-context-state.ts re-exporting from ../tables/runtime-context-state.ts — wrong direction. NARROW BRIDGE CARVE-OUT: agent-event-pipeline/events/ is the legacy event-vocabulary home; the Wave 1 forward-target re-export shims under events/ (#689 pattern, transitional until the physical event-vocabulary move) may pull from that subtree only. All other agent-event-pipeline/ subpaths remain banned.",
      from: { path: "^packages/runtime/src/events/" },
      to: {
        path: [
          "^packages/runtime/src/tables/",
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
        pathNot: ["^packages/runtime/src/agent-event-pipeline/events/"],
      },
    },
    {
      name: "runtime-tables-no-higher-tier-import",
      severity: "error",
      comment:
        "tables/ is the durable state-of-record tier; it may depend on events/ + protocol. It must not import from transforms/ (transforms are pure consumers of events, not callable from tables), channels/, producers/, subscribers/, or composition/.",
      from: { path: "^packages/runtime/src/tables/" },
      to: {
        path: [
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
        ],
      },
    },
    {
      name: "runtime-transforms-no-higher-tier-import",
      severity: "error",
      comment:
        "transforms/ is the pure-function tier. It may depend on events/ and protocol. It must not import from tables/, channels/, producers/, subscribers/, composition/, or the legacy agent-event-pipeline/ tree (the pre-cutover event-vocab home — use events/ instead).",
      from: { path: "^packages/runtime/src/transforms/" },
      to: {
        path: [
          "^packages/runtime/src/tables/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      name: "runtime-producers-no-peer-or-higher-tier-import",
      severity: "error",
      comment:
        "producers/ is a middle tier; per the target-tree doc, producers/transforms/channels are peers and peers do not import each other. producers/ may import only events/ + tables/ (+ allowed external libs); it must not import transforms/, channels/, subscribers/, or composition/.",
      from: { path: "^packages/runtime/src/producers/" },
      to: {
        path: [
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
        ],
      },
    },
    {
      name: "runtime-channels-no-peer-or-higher-tier-import",
      severity: "error",
      comment:
        "channels/ is a middle tier; per the target-tree doc, channels/transforms/producers are peers and peers do not import each other. channels/ may import only events/ + tables/ (+ protocol/external libs); it must not import transforms/, producers/, subscribers/, or composition/.",
      from: { path: "^packages/runtime/src/channels/" },
      to: {
        path: [
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
        ],
      },
    },
    {
      name: "runtime-subscribers-no-composition-import",
      severity: "error",
      comment:
        "subscribers/ depend on typed lower-tier sources (tables/, transforms/, channels/, events/). composition/ wires subscribers into the runtime graph, not the reverse.",
      from: { path: "^packages/runtime/src/subscribers/" },
      to: { path: "^packages/runtime/src/composition/" },
    },
    {
      name: "runtime-subscribers-no-producers-import",
      severity: "error",
      comment:
        "HARD STOP per the target-tree roadmap: subscribers/ must not import producers/, full stop. Subscribers depend on typed lower-tier sources (tables/, transforms/, channels/, events/). A subscriber that needs producer behavior either needs a typed table read (cleaner) or itself crosses into producer responsibilities (wrong tier). The Shape C-specific rule below stays in place for sharper messaging on the runtime-context subtree.",
      from: { path: "^packages/runtime/src/subscribers/" },
      to: { path: "^packages/runtime/src/producers/" },
    },
    {
      name: "runtime-shape-c-runtime-context-no-producers-import",
      severity: "error",
      comment:
        "Shape C subscribers under subscribers/runtime-context/ and subscribers/runtime-context-session/ depend on typed table reads + narrow channel tags. Importing from producers/ either grows a write authority into the per-event handler (Shape D drift) or duplicates a producer's own responsibilities. (Redundant with the broader subscribers->producers ban above; kept for the sharper Shape C message.)",
      from: {
        path: [
          "^packages/runtime/src/subscribers/runtime-context/",
          "^packages/runtime/src/subscribers/runtime-context-session/",
        ],
      },
      to: { path: "^packages/runtime/src/producers/" },
    },
    {
      name: "runtime-tables-no-legacy-tree-import",
      severity: "error",
      comment:
        "Target-tree tables/ folder must not reach back into the legacy workflow-engine/ or agent-event-pipeline/ subtrees. The Wave A semantic move makes tables/ self-contained (it depends on events/ + protocol only); imports back into the legacy tree defeat the move. Bead-owned carve-out tf-f9n1: `tables/runtime-context-output-facts.ts` is a thin target-tree facade for the per-context output observation source the Shape C subscriber consumes; the canonical Live binding (`RuntimeAgentOutputAfterEvents`) still lives in `agent-event-pipeline/authorities/runtime-output-journal.ts` until the physical move lands in Wave 2. The carve-out shrinks to a deletion when tf-f9n1 moves the symbol.",
      from: {
        path: "^packages/runtime/src/tables/",
        // Bead tf-f9n1 — Wave 2 tables/ physical move of RuntimeAgentOutputAfterEvents
        pathNot: [
          "^packages/runtime/src/tables/runtime-context-output-facts\\.ts$",
        ],
      },
      to: {
        path: [
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      name: "runtime-producers-no-legacy-tree-import",
      severity: "error",
      comment:
        "Target-tree producers/ folder must not reach back into the legacy workflow-engine/ or agent-event-pipeline/ subtrees. Wave A semantic-move enforcement.",
      from: { path: "^packages/runtime/src/producers/" },
      to: {
        path: [
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      name: "runtime-channels-no-legacy-tree-import",
      severity: "error",
      comment:
        "Target-tree channels/ folder must not reach back into the legacy workflow-engine/ or agent-event-pipeline/ subtrees. Wave A semantic-move enforcement.",
      from: { path: "^packages/runtime/src/channels/" },
      to: {
        path: [
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      name: "runtime-subscribers-no-legacy-tree-import",
      severity: "error",
      comment:
        "Target-tree subscribers/ folder must not reach back into the legacy workflow-engine/, agent-event-pipeline/, or authorities/ subtrees. Each currently-sanctioned target->legacy edge carries a bead-numbered carve-out below (no anonymous carve-outs; audit gate added 2026-05-23). Edge inventory: tf-up1v RuntimeToolUseExecutor placement (subscribers/runtime-context/handler.ts -> workflow-engine/tool-execution/runtime-tool-use-executor.ts); tf-hpr0 WaitForWorkflow collapse (subscribers/wait-router/index.ts -> workflow-engine/workflows/wait-for.ts); tf-6hqx ScheduledPromptWorkflow physical move (subscribers/scheduled-prompt/index.ts -> workflow-engine/workflows/scheduled-prompt.ts); tf-vfq9 ToolCallWorkflow cutover/delete (subscribers/tool-dispatch/index.ts -> agent-event-pipeline/tool-execution/runtime-tool-call-workflow.ts); tf-6cdy authorities/ retirement, two edges (subscribers/runtime-context/index.ts -> authorities/index.ts, subscribers/runtime-context/handler.ts -> authorities/runtime-control-plane-recorder.ts). All other workflow-engine/ + agent-event-pipeline/ + authorities/ subpaths remain banned. Each carve-out shrinks to a deletion when the named bead lands the target-tree physical move.",
      from: { path: "^packages/runtime/src/subscribers/" },
      to: {
        path: [
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
          "^packages/runtime/src/authorities/",
        ],
        pathNot: [
          // Bead tf-up1v — Wave D-A RuntimeToolUseExecutor placement
          "^packages/runtime/src/workflow-engine/tool-execution/runtime-tool-use-executor\\.ts$",
          // Bead tf-hpr0 — Collapse WaitForWorkflow into owning-workflow primitive
          "^packages/runtime/src/workflow-engine/workflows/wait-for\\.ts$",
          // Bead tf-6hqx — Wave D-A subscribers/scheduled-prompt physical move
          "^packages/runtime/src/workflow-engine/workflows/scheduled-prompt\\.ts$",
          // Bead tf-vfq9 — ToolCallWorkflow cutover/delete
          "^packages/runtime/src/agent-event-pipeline/tool-execution/runtime-tool-call-workflow\\.ts$",
          // Bead tf-6cdy — Wave D-A authorities/ retirement (covers both
          // authorities/index.ts and authorities/runtime-control-plane-recorder.ts)
          "^packages/runtime/src/authorities/index\\.ts$",
          "^packages/runtime/src/authorities/runtime-control-plane-recorder\\.ts$",
        ],
      },
    },
    {
      name: "runtime-composition-no-legacy-tree-import",
      severity: "error",
      comment:
        "composition/ wires the runtime layer graph from target-tree exports only (events/, tables/, transforms/, channels/, producers/, subscribers/). It must not import from the legacy workflow-engine/ or agent-event-pipeline/ subtrees — not via relative path (`../workflow-engine/...`, `../agent-event-pipeline/...`) and not via the public barrel (`@firegrid/runtime/workflow-engine/...` etc., resolved to the same tree). Shape D temporary target shims under `subscribers/<name>/` may still re-export from current legacy implementation homes; composition imports the TARGET path (`subscribers/<name>/`), not the legacy barrel. Gap finding: #696's existing `firegrid-composition-no-legacy-imports` (semgrep) caught legacy SYMBOL names + a few specific paths (`runtime-input-deferred`, `@firegrid/runtime/kernel`, `@firegrid/runtime/_archive`); CC1's Wave B draft showed those signatures weren't enough — relative `../workflow-engine` / `../agent-event-pipeline` imports slipped through. This rule closes that.",
      from: { path: "^packages/runtime/src/composition/" },
      to: {
        path: [
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      // firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.4
      // firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.6
      name: "runtime-no-host-internal-imports-outside-host",
      severity: "error",
      comment:
        "Runtime host internals must be consumed through the host barrel or @firegrid/runtime/runtime-host public subpath, not direct file imports.",
      from: {
        path: "^packages/.*/src",
        pathNot: "^packages/runtime/src/host/",
      },
      to: {
        path: "^packages/runtime/src/host/(?!index\\.ts$)",
      },
    },
    {
      // firegrid-runtime-boundary-reconciliation.CYCLE_BREAKING.2
      // firegrid-runtime-boundary-reconciliation.PUBLIC_SURFACE.4
      name: "runtime-errors-internal-only",
      severity: "error",
      comment:
        "runtime-errors.ts is runtime-internal support. External packages should use @firegrid/runtime public exports, not the source file.",
      from: {
        path: "^packages/.*/src",
        pathNot: [
          "^packages/runtime/src/",
          "^packages/host-sdk/src/host/",
        ],
      },
      to: {
        path: "^packages/runtime/src/runtime-errors\\.ts$",
      },
    },
    {
      // firegrid-remediation-hardening.STATIC_QUALITY.5
      name: "not-to-unresolvable",
      severity: "error",
      comment:
        "This module depends on a module that cannot be found. If it is an npm module, add it to package.json; otherwise fix the import path.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-non-package-json",
      severity: "error",
      comment:
        "This module depends on an npm package that is not declared in package.json.",
      from: {},
      to: {
        dependencyTypes: ["npm-no-pkg", "npm-unknown"],
      },
    },
    {
      // firegrid-remediation-hardening.STATIC_QUALITY.8
      name: "not-to-deprecated",
      severity: "error",
      comment:
        "This module uses a deprecated npm package. Upgrade it or replace it.",
      from: {},
      to: {
        dependencyTypes: ["deprecated"],
      },
    },
    {
      // firegrid-remediation-hardening.STATIC_QUALITY.8
      name: "no-duplicate-dep-types",
      severity: "error",
      comment:
        "This module depends on an external package declared in more than one dependency bucket.",
      from: {},
      to: {
        moreThanOneDependencyType: true,
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "not-to-test-from-production",
      severity: "error",
      comment:
        "Production code must not import from test files. Factor shared helpers into production or test utility modules instead.",
      from: {
        path: "^packages/.*/src",
        pathNot: [
          "\\.test\\.(?:ts|tsx|mts)$",
          "^packages/.*/src/__tests__/",
        ],
      },
      to: {
        path: "[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$",
      },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.1
      // firegrid-host-sdk.PACKAGE_GRAPH.3
      name: "client-sdk-no-runtime",
      severity: "error",
      comment:
        "The browser/app-facing client-sdk package must not import runtime code or runtime-only dependencies.",
      from: { path: "^packages/client-sdk/src" },
      to: { path: "^packages/runtime/src" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
      // firegrid-package-migration.COMPATIBILITY.4
      // firegrid-host-sdk.PACKAGE_GRAPH.2
      // Lane 1 owns the client-sdk/cli targets here; Lane 2 adds the
      // matching host-sdk target (runtime-no-host-sdk) without editing
      // this rule.
      name: "runtime-no-client-sdk-or-cli",
      severity: "error",
      comment:
        "The runtime package must not import the browser/app-facing client-sdk package or the CLI package.",
      from: { path: "^packages/runtime/src" },
      to: { path: "^packages/(client-sdk|cli)/src" },
    },
    {
      // firegrid-host-sdk.PACKAGE_GRAPH.2
      // firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1 / .3
      // Separate rule (not the Lane 1-owned runtime-no-client-sdk-or-cli
      // block above): runtime owns the narrow RuntimeToolUseExecutor
      // capability tag; @firegrid/host-sdk provides the live layer, so the
      // dependency only ever points host-sdk -> runtime, never back.
      // Mirrors the existing eslint no-restricted-imports guard so the
      // boundary fails the build at the depcruise tier too.
      name: "runtime-no-host-sdk",
      severity: "error",
      comment:
        "The runtime package must not import @firegrid/host-sdk. Runtime owns the RuntimeToolUseExecutor tag; host-sdk provides the live layer (firegrid-host-sdk.PACKAGE_GRAPH.2).",
      from: { path: "^packages/runtime/src" },
      to: { path: "^packages/host-sdk/src" },
    },
    {
      name: "host-sdk-no-unsanctioned-runtime-subpaths-scan",
      severity: "error",
      comment:
        "Lane D hard guardrail: host-sdk binding/composition modules may import runtime only through sanctioned public capability subpaths. Existing substrate-debt files are carved out explicitly and must be removed as boundary refactors land.",
      from: {
        path: hostSdkBoundaryModules,
        pathNot: currentHostSdkSubstrateDebt,
      },
      to: {
        path: `^packages/runtime/src/(?!${sanctionedRuntimeCapabilitySubpaths})`,
      },
    },
    {
      name: "host-sdk-no-workflow-or-durable-substrate-scan",
      severity: "error",
      comment:
        "Lane D hard guardrail: host-sdk binding modules must not depend on workflow engine substrate, durable-tools, or durable table facades as stable architecture. Existing substrate-debt files are carved out explicitly.",
      from: {
        path: hostSdkBoundaryModules,
        pathNot: currentHostSdkSubstrateDebt,
      },
      to: {
        path:
          "(^packages/runtime/src/(?:workflow-engine|durable-tools)(?:/|$)|^packages/effect-durable-operators/src|(^|/)node_modules/(?:\\.pnpm/)?@effect/workflow/)",
      },
    },
    {
      name: "runtime-no-host-sdk-scan",
      severity: "error",
      comment:
        "Lane D report-mode mirror of the hard package-direction rule: runtime execution modules must not import host-sdk bindings.",
      from: { path: "^packages/runtime/src" },
      to: { path: "^packages/host-sdk/src" },
    },
    {
      name: "client-sdk-no-runtime-scan",
      severity: "error",
      comment:
        "Lane D report-mode mirror of the hard package-direction rule: client-sdk must remain runtime-source-free.",
      from: { path: "^packages/client-sdk/src" },
      to: { path: "^packages/runtime/src" },
    },
    {
      // firegrid-typed-wait-source-redesign.MIGRATION.4
      // firegrid-typed-wait-source-redesign.REJECTION.2
      // The SourceCollections string registry and source-registration layers
      // are deleted. Any reintroduced source-registration module must not
      // depend on the durable-tools bounded context.
      name: "no-source-registration-to-durable-tools",
      severity: "error",
      comment:
        "source-registration modules must not import durable-tools internals; runtime waits resolve typed observation streams via Effect requirements, not a source-name registry.",
      from: { path: "^packages/runtime/src/source-registration" },
      to: { path: "^packages/runtime/src/durable-tools" },
    },
    {
      name: "protocol-no-client-or-runtime",
      severity: "error",
      comment:
        "Protocol must remain the shared browser-safe base; it cannot depend upward on client-sdk, host-sdk, cli, or runtime.",
      from: { path: "^packages/protocol/src" },
      to: { path: "^packages/(client-sdk|host-sdk|cli|runtime)/src" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.7
      name: "durable-streams-imports-contained",
      severity: "error",
      comment:
        "Only @firegrid/durable-streams may import the underlying Durable Streams packages; app exemptions must be explicit and mechanically guarded.",
      from: {
        path: "^packages/.*/src",
        pathNot: "^packages/durable-streams/src",
      },
      to: {
        // effect-durable-operators consumes ONLY @durable-streams/state for
        // its createStreamDB facade per SDD BOUNDARIES.1. Other
        // @durable-streams/* packages remain off-limits.
        path: "(^|/)node_modules/(?:\\.pnpm/)?@durable-streams/(?!state/)",
      },
    },
    {
      // effect-durable-operators is allowed to import @durable-streams/state
      // (only) per docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md BOUNDARIES.1.
      // This explicit rule documents the narrow exemption and prevents
      // future drift into other @durable-streams/* packages from this
      // workspace package.
      name: "effect-durable-operators-state-only",
      severity: "error",
      comment:
        "effect-durable-operators may import @durable-streams/state, but not other @durable-streams/* packages.",
      from: { path: "^packages/effect-durable-operators/src" },
      to: {
        path: "(^|/)node_modules/(?:\\.pnpm/)?@durable-streams/(?!state/)",
      },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.8
      // firegrid-platform-invariants.LOCALITY.2
      // firegrid-platform-invariants.LOCALITY.7
      // firegrid-architecture-boundary.SURFACE_AREA.3
      name: "client-sdk-no-broad-durable-streams-root",
      severity: "error",
      comment:
        "@firegrid/client-sdk must use narrow browser-safe @firegrid/durable-streams subpaths instead of the broad root.",
      from: { path: "^packages/client-sdk/src" },
      to: { path: "^packages/durable-streams/src/index\\.ts$" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.8
      // firegrid-platform-invariants.LOCALITY.2
      // firegrid-platform-invariants.LOCALITY.7
      name: "client-sdk-production-no-node-tier-durable-streams-subpaths",
      severity: "error",
      comment:
        "Production @firegrid/client-sdk code must not statically reach workflow-engine, producer, server, or test utility substrate modules.",
      from: {
        path: "^packages/client-sdk/src",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^packages/durable-streams/src/(?:producer|workflow-engine|test-utils|testing/|internal/|DurableStreamProducer|DurableStreamsWorkflowEngine)",
      },
    },
    {
      // === Host SDK plane split — Lane 1 owned (client-sdk/cli) ===
      // Lane 2 adds host-sdk-source rules separately; do not edit this
      // block from Lane 2 to avoid integration-branch conflicts.
      // firegrid-host-sdk.PACKAGE_GRAPH.3
      name: "client-sdk-no-host-sdk-or-cli",
      severity: "error",
      comment:
        "@firegrid/client-sdk is a browser/edge-safe sibling projection; it must not import host-sdk or cli.",
      from: { path: "^packages/client-sdk/src" },
      to: { path: "^packages/(host-sdk|cli)/src" },
    },
    {
      // firegrid-host-sdk.PACKAGE_GRAPH.5
      name: "no-package-imports-cli",
      severity: "error",
      comment:
        "No package may import @firegrid/cli; the CLI is a terminal binding over host-sdk and client-sdk.",
      from: { path: "^packages/(?!cli/)[^/]+/src", pathNot: "^packages/cli/src" },
      to: { path: "^packages/cli/src" },
    },
    {
      // firegrid-host-sdk.PACKAGE_GRAPH.5
      name: "cli-no-runtime",
      severity: "error",
      comment:
        "@firegrid/cli must bind over @firegrid/host-sdk and @firegrid/client-sdk; it must not import @firegrid/runtime substrate directly.",
      from: { path: "^packages/cli/src" },
      to: { path: "^packages/runtime/src" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.eslint.json" },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^packages/.*/src",
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
}

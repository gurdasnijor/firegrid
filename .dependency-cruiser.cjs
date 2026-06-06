const hostSdkBoundaryModules = "^packages/host-sdk/src"
const hostSdkPublicCompositionSurface = "^packages/host-sdk/src/index\\.ts$"
const runtimeUnifiedPublicSurface = "^packages/runtime/src/unified/index\\.ts$"

const sanctionedRuntimeCapabilitySubpaths = [
  // Runtime-owned capability tags and public observation/protocol projections
  // sanctioned for host-sdk binding composition by
  // docs/architecture/host-sdk-runtime-boundary.md. Paths point at the
  // physically-moved homes (see
  // docs/architecture/2026-05-22-runtime-physical-target-tree.md) after the
  // agent-event-pipeline cleanup wave.
  "runtime-errors\\.ts$",
  "channels/index\\.ts$",
  "producers/ingress-writers/per-context-output\\.ts$",
  "subscribers/tool-dispatch/index\\.ts$",
  "authorities/index\\.ts$",
  "control-plane/index\\.ts$",
  "tables/runtime-output-public\\.ts$",
  "tables/runtime-output\\.ts$",
  "channels/observation-streams/index\\.ts$",
  "verified-webhook-ingest/index\\.ts$",
  "events/index\\.ts$",
  "events/agent-input\\.ts$",
  "events/agent-output\\.ts$",
  // Canonical post-PR-M1 source-tier subpaths (sandbox + codecs moved
  // from producers/ to sources/ per SDD #761). The producers/* paths
  // below remain as back-compat aliases until PR-M6.
  "sources/codecs/index\\.ts$",
  "sources/codecs/session-byte-stream-adapter\\.ts$",
  "sources/codecs/agent-adapters/index\\.ts$",
  "sources/sandbox/index\\.ts$",
  "producers/codecs/index\\.ts$",
  "producers/codecs/session-byte-stream-adapter\\.ts$",
  "producers/codecs/agent-adapters/index\\.ts$",
  "producers/sandbox/index\\.ts$",
  // Wave D-A (PR #714): host-sdk composes the Shape C subscriber via the
  // runtime composition root + reaches the session-command seam contract
  // directly. Both subpaths are part of the runtime/package.json exports
  // and named in the host-sdk/runtime boundary doc as the post-D-A binding
  // surface.
  "subscribers/runtime-context-session/index\\.ts$",
  "composition/host-live\\.ts$",
  // Body+kernel deletion wave: host-sdk installs the canonical host-scoped
  // WorkflowEngine binding from composition/. Replaces the deleted kernel
  // `RuntimeContextWorkflowRuntimeLive`. Lives in `composition/` per the
  // target-tree directive; surfaced as a public subpath in
  // runtime/package.json.
  "composition/host-workflow-engine\\.ts$",
  // tf-z8wq Wave 2: `kernel/` retired in this slice; the four leaf symbols
  // migrated to target homes. Sanctioned host-sdk consumers for those
  // moved leaves:
  //   - RuntimeHostConfig Tag → composition/runtime-host-config.ts
  //   - requireLocalRuntimeContextWithHostSession →
  //     subscribers/runtime-context/host-lookup.ts
  //   - RuntimeContextStateStore / makePerContextRuntimeContextStateStore →
  //     tables/runtime-context-state.ts (host-sdk callers retargeted off
  //     the retired kernel barrel in this slice)
  // See docs/architecture/2026-05-22-runtime-physical-target-tree.md
  // §Kernel Retirement.
  "composition/runtime-host-config\\.ts$",
  "subscribers/runtime-context/host-lookup\\.ts$",
  "tables/runtime-context-state\\.ts$",
].join("|")

// All four prior currentHostSdkSubstrateDebt carve-outs were stale (files
// absent on disk as of 2026-05-23). Empty by design: any new debt MUST
// have a named bead owning its retirement before it lands here.
const currentHostSdkSubstrateDebt = []

module.exports = {
  forbidden: [
    {
      name: "fluent-acp-process-tiny-import-surface",
      severity: "error",
      comment:
        "fluent-acp-process is the ACP harness process owner (spawn -> acp.Stream). Per SDD_FLUENT_HARNESS_ADAPTER_CONTRACT (F-A1/F-A11/F-A12/F-A13) it must not import fluent-runtime, the legacy runtime, durable-streams substrate, host/client SDKs, or any Store/Host/EventIngress/Sources/projection internals. Allowed: @agentclientprotocol/sdk + effect (+ @effect/platform).",
      from: { path: "^packages/fluent-acp-process/src/" },
      to: {
        path: [
          "^packages/fluent-runtime/",
          "^packages/runtime/",
          "^packages/effect-durable-streams/",
          "^packages/effect-durable-operators/",
          "^packages/host-sdk/",
          "^packages/client-sdk/",
          "^packages/protocol/",
          "^packages/observability/",
        ],
      },
    },
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
        "events/ is the pure event-vocabulary tier. It must not import from any higher tier. Move shared types INTO events/ and have the higher tier re-export from there.",
      from: { path: "^packages/runtime/src/events/" },
      to: {
        path: [
          "^packages/runtime/src/capabilities/",
          "^packages/runtime/src/tables/",
          "^packages/runtime/src/sources/",
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
          "^packages/runtime/src/workflow-engine/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      name: "runtime-capabilities-no-higher-tier-import",
      severity: "error",
      comment:
        "capabilities/ holds pure Context.Tag declarations. It may import events/ + tables/ for row type references in Tag service shapes. It must not import any behavior-bearing tier (sources/, transforms/, channels/, producers/, subscribers/, composition/) — those tiers depend on capabilities/, not the other way around.",
      from: { path: "^packages/runtime/src/capabilities/" },
      to: {
        path: [
          "^packages/runtime/src/sources/",
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
        ],
      },
    },
    {
      name: "runtime-tables-no-higher-tier-import",
      severity: "error",
      comment:
        "tables/ is the durable state-of-record tier; it may depend on events/ + capabilities/ + protocol. It must not import from sources/, transforms/, channels/, producers/, subscribers/, or composition/.",
      from: { path: "^packages/runtime/src/tables/" },
      to: {
        path: [
          "^packages/runtime/src/sources/",
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
        "transforms/ is the pure-function tier. It may depend on events/ + capabilities/ + protocol. It must not import from tables/, sources/, channels/, producers/, subscribers/, composition/, or the legacy agent-event-pipeline/ tree.",
      from: { path: "^packages/runtime/src/transforms/" },
      to: {
        path: [
          "^packages/runtime/src/tables/",
          "^packages/runtime/src/sources/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
          "^packages/runtime/src/agent-event-pipeline/",
        ],
      },
    },
    {
      name: "runtime-sources-no-peer-or-higher-tier-import",
      severity: "error",
      comment:
        "sources/ owns Kafka-Connect 'Source' emitters: live boundaries that produce typed Streams. Sources have no row authority and must not import tables/. They must not import peers (producers/, transforms/, channels/), subscribers/, or composition/. Allowed: events/, capabilities/, protocol, external transport SDKs.",
      from: { path: "^packages/runtime/src/sources/" },
      to: {
        path: [
          "^packages/runtime/src/tables/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
        ],
      },
    },
    {
      name: "runtime-producers-no-peer-or-higher-tier-import",
      severity: "error",
      comment:
        "producers/ owns Kafka-broker 'Producer' topic writers (post-SDD #761): layers that consume a Stream from sources/ and append rows to tables/. May import events/, capabilities/, tables/, sources/. Must not import peers (transforms/, channels/), subscribers/, or composition/. The per-context-output writer carve-out for channels/output-table-layer.ts is retained — the shared per-context RuntimeOutputTable factory is the single source of truth for the per-context output stream URL + table options.",
      from: { path: "^packages/runtime/src/producers/" },
      to: {
        path: [
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/channels/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
        ],
        pathNot: [
          "^packages/runtime/src/channels/output-table-layer\\.ts$",
        ],
      },
    },
    {
      name: "runtime-channels-no-peer-or-higher-tier-import",
      severity: "error",
      comment:
        "channels/ is a middle tier; channels/sources/transforms/producers are peers and peers do not import each other. channels/ may import events/, capabilities/, tables/ (+ protocol/external libs); it must not import sources/, transforms/, producers/, subscribers/, or composition/.",
      from: { path: "^packages/runtime/src/channels/" },
      to: {
        path: [
          "^packages/runtime/src/sources/",
          "^packages/runtime/src/transforms/",
          "^packages/runtime/src/producers/",
          "^packages/runtime/src/subscribers/",
          "^packages/runtime/src/composition/",
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
      name: "client-sdk-no-runtime-or-durable-substrate",
      severity: "error",
      comment:
        "The browser/app-facing client-sdk package must not import runtime code or durable-table substrate. MCP/RPC plus durable-streams wire imports are allowed; runtime and effect-durable-operators are not.",
      from: { path: "^packages/client-sdk/src" },
      to: {
        path: [
          "^packages/runtime/src",
          "^packages/effect-durable-operators/src",
          "^node_modules/effect-durable-operators",
          "effect-durable-operators",
        ],
      },
    },
    {
      name: "fluent-runtime-no-legacy-runtime",
      severity: "error",
      comment:
        "fluent-runtime is the lean managed-agent runtime workbench. It must not depend on the legacy runtime, host-sdk, protocol, workflow engine, or DurableTable package.",
      from: { path: "^packages/fluent-runtime/src" },
      to: {
        path: [
          "^packages/runtime/src",
          "^packages/host-sdk/src",
          "^packages/protocol/src",
          "^node_modules/effect-durable-operators",
          "effect-durable-operators",
          "^node_modules/@effect/workflow",
          "@effect/workflow",
        ],
      },
    },
    {
      name: "fluent-firegrid-scheduler-substrate-free",
      severity: "error",
      comment:
        "The fluent-firegrid scheduler is the substrate-free Operation/Future engine; durable streams stay behind execute/operations.",
      from: { path: "^packages/fluent-firegrid/src/scheduler\\.ts$" },
      to: {
        path: [
          "^packages/runtime/src",
          "^packages/host-sdk/src",
          "^packages/protocol/src",
          "^packages/fluent-runtime/src",
          "^packages/effect-durable-operators/src",
          "^node_modules/effect-durable-operators",
          "effect-durable-operators",
          "^node_modules/@effect/workflow",
          "@effect/workflow",
          "^node_modules/effect-durable-streams",
          "effect-durable-streams",
        ],
      },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
      // firegrid-package-migration.COMPATIBILITY.4
      // firegrid-host-sdk.PACKAGE_GRAPH.2
      // Lane 1 owns the client-sdk target here; Lane 2 adds the
      // matching host-sdk target (runtime-no-host-sdk) without editing
      // this rule.
      name: "runtime-no-client-sdk",
      severity: "error",
      comment:
        "The runtime package must not import the browser/app-facing client-sdk package. Carve-out: `runtime/src/bin/**` is the runtime-owned process composition tier introduced by the Shape C cutover. It sits above runtime substrate AND above client-sdk, composing both into the firegrid run/start/acp binaries. This is a binary boundary, not a substrate-import.",
      from: {
        path: "^packages/runtime/src",
        pathNot: "^packages/runtime/src/bin/",
      },
      to: { path: "^packages/client-sdk/src" },
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
        pathNot: [
          ...currentHostSdkSubstrateDebt,
          hostSdkPublicCompositionSurface,
        ],
      },
      to: {
        path: `^packages/runtime/src/(?!${sanctionedRuntimeCapabilitySubpaths})`,
      },
    },
    {
      name: "host-sdk-public-composition-surface-only-unified",
      severity: "error",
      comment:
        "The host-sdk root barrel is the public host-composition surface; it may re-export FiregridHost from runtime/unified but must not become a general runtime substrate barrel.",
      from: { path: hostSdkPublicCompositionSurface },
      to: {
        path: "^packages/runtime/src",
        pathNot: runtimeUnifiedPublicSurface,
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
        "Protocol must remain the shared browser-safe base; it cannot depend upward on client-sdk, host-sdk, or runtime.",
      from: { path: "^packages/protocol/src" },
      to: { path: "^packages/(client-sdk|host-sdk|runtime)/src" },
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
      // === Host SDK plane split — Lane 1 owned (client-sdk) ===
      // Lane 2 adds host-sdk-source rules separately; do not edit this
      // block from Lane 2 to avoid integration-branch conflicts.
      // firegrid-host-sdk.PACKAGE_GRAPH.3
      name: "client-sdk-no-host-sdk",
      severity: "error",
      comment:
        "@firegrid/client-sdk is a browser/edge-safe sibling projection; it must not import host-sdk.",
      from: { path: "^packages/client-sdk/src" },
      to: { path: "^packages/host-sdk/src" },
    },
    {
      name: "firelab-sim-no-fake-substitutes",
      severity: "error",
      comment:
        "firelab simulations must exercise production code: no fake codec/sandbox modules and no direct adapter internals from simulations.",
      from: {
        path: "^packages/firelab/src/simulations/",
      },
      to: {
        path: [
          "fake-codec\\.ts$",
          "acp-sandbox-fake\\.ts$",
          "production-flow-scenario\\.ts$",
          "production-flow-acp-scenario\\.ts$",
          "^packages/runtime/src/unified/adapter\\.ts$",
        ],
      },
    },
    {
      // tf-r06u.24 R2 — firelab sim airgap (WHOLE SIM, host.ts carved out).
      // Extends the eslint driver.ts/host.ts airgap (eslint.config.js:707-757) to
      // every simulation file except host.ts: a sim drives the PUBLIC client/host
      // seam; only host(env) composes the substrate. Anything else reaching into
      // runtime/host-sdk internals, protocol internals, or durable tables is
      // exercising a private seam — write it as a test in the owning package.
      // tf-bp2t intentionally carves out a hostless greenfield substrate
      // workbench: it does not claim to validate the Firegrid client/host seam.
      name: "firelab-sim-airgap-whole-sim",
      severity: "error",
      comment:
        "firelab sims drive the public client/host seam; only host.ts composes the substrate. No runtime/host-sdk/protocol internals, workflow internals, or durable-streams imports from a non-host.ts sim file.",
      from: {
        path: "^packages/firelab/src/simulations/",
        pathNot: [
          "/host\\.ts$",
          "^packages/firelab/src/simulations/fluent-runtime-workbench/sandbox-activity-host\\.ts$",
          "^packages/firelab/src/simulations/restate-primitive-compat/",
        ],
      },
      to: {
        path: [
          "^packages/runtime/src",
          "^packages/host-sdk/src",
          "^packages/protocol/src",
          "^node_modules/effect-durable-operators",
          "effect-durable-operators",
          "^node_modules/@effect/workflow",
          "@effect/workflow",
          "^node_modules/@durable-streams/",
          "@durable-streams/",
        ],
      },
    },
    {
      // tf-r06u.24 R3 — firelab test airgap (public-surface vitest only).
      // firelab/test exercises the PUBLIC surface (@firegrid/client-sdk is
      // allowed); a test reaching runtime/host-sdk/protocol internals belongs in
      // the OWNING package's test/ folder. Enforced via a dedicated test-scoped
      // depcruise run (the default lint:deps scope is src-only — see lint:deps).
      name: "firelab-test-no-internals",
      severity: "error",
      comment:
        "firelab tests are not simulation evidence; no runtime/host-sdk/protocol internals, workflow internals, or durable-streams imports.",
      from: {
        path: "^packages/firelab/test/",
      },
      to: {
        path: [
          "^packages/runtime/src",
          "^packages/host-sdk/src",
          "^packages/protocol/src",
          "^node_modules/effect-durable-operators",
          "effect-durable-operators",
          "^node_modules/@effect/workflow",
          "@effect/workflow",
          "^node_modules/@durable-streams/",
          "@durable-streams/",
        ],
      },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.eslint.json" },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^packages/.*/src",
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
}

const hostSdkBoundaryModules = "^packages/host-sdk/src"

const sanctionedRuntimeCapabilitySubpaths = [
  // Runtime-owned capability tags and public observation/protocol projections
  // sanctioned for host-sdk binding composition by
  // docs/architecture/host-sdk-runtime-boundary.md.
  "runtime-errors\\.ts$",
  "agent-event-pipeline/tool-execution/index\\.ts$",
  "authorities/index\\.ts$",
  "control-plane/index\\.ts$",
  "agent-event-pipeline/authorities/runtime-output-public\\.ts$",
  "streams/index\\.ts$",
  "agent-event-pipeline/events/index\\.ts$",
  "agent-event-pipeline/codecs/index\\.ts$",
  "agent-event-pipeline/session-byte-stream-adapter\\.ts$",
  "agent-adapters/index\\.ts$",
  "agent-event-pipeline/sources/sandbox/index\\.ts$",
].join("|")

const currentHostSdkSubstrateDebt = [
  "^packages/host-sdk/src/host/internal/runtime-context-helpers\\.ts$",
  "^packages/host-sdk/src/host/runtime-context-workflow-core\\.ts$",
  "^packages/host-sdk/src/host/runtime-context-workflow-runtime\\.ts$",
  "^packages/host-sdk/src/host/session-log-channel\\.ts$",
]

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

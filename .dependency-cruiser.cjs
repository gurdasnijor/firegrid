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
        path: "^(packages|apps)/.*/src",
        pathNot: [
          "\\.test\\.(?:ts|tsx|mts)$",
          "^(packages|apps)/.*/src/__tests__/",
        ],
      },
      to: {
        path: "[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$",
      },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.1
      name: "client-no-runtime",
      severity: "error",
      comment:
        "The browser/app-facing client package must not import runtime code or runtime-only dependencies.",
      from: { path: "^packages/client/src" },
      to: { path: "^packages/runtime/src" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
      // firegrid-package-migration.COMPATIBILITY.4
      name: "runtime-no-client",
      severity: "error",
      comment:
        "The runtime package must not import the browser/app-facing client package.",
      from: { path: "^packages/runtime/src" },
      to: { path: "^packages/client/src" },
    },
    {
      name: "protocol-no-client-or-runtime",
      severity: "error",
      comment:
        "Protocol must remain the shared browser-safe base; it cannot depend upward on client or runtime.",
      from: { path: "^packages/protocol/src" },
      to: { path: "^packages/(client|runtime)/src" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.6
      name: "packages-no-apps",
      severity: "error",
      comment:
        "Reusable packages must not import workspace apps. Apps may depend downward on packages, not the reverse.",
      from: { path: "^packages/.*/src" },
      to: { path: "^apps/.*/src" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.7
      name: "durable-streams-imports-contained",
      severity: "error",
      comment:
        "Only @firegrid/durable-streams may import the underlying Durable Streams packages; app exemptions must be explicit and mechanically guarded.",
      from: {
        path: "^(packages|apps)/.*/src",
        pathNot: "^packages/durable-streams/src",
      },
      to: {
        path: "(^|/)node_modules/(?:\\.pnpm/)?@durable-streams/",
      },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.8
      // firegrid-platform-invariants.LOCALITY.2
      // firegrid-platform-invariants.LOCALITY.7
      // firegrid-architecture-boundary.SURFACE_AREA.3
      name: "client-no-broad-durable-streams-root",
      severity: "error",
      comment:
        "@firegrid/client must use narrow browser-safe @firegrid/durable-streams subpaths instead of the broad root.",
      from: { path: "^packages/client/src" },
      to: { path: "^packages/durable-streams/src/index\\.ts$" },
    },
    {
      // firegrid-architecture-boundary.DEPENDENCY_GRAPH.8
      // firegrid-platform-invariants.LOCALITY.2
      // firegrid-platform-invariants.LOCALITY.7
      name: "client-production-no-node-tier-durable-streams-subpaths",
      severity: "error",
      comment:
        "Production @firegrid/client code must not statically reach workflow-engine, producer, server, or test utility substrate modules.",
      from: {
        path: "^packages/client/src",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^packages/durable-streams/src/(?:producer|workflow-engine|test-utils|testing/|internal/|DurableStreamProducer|DurableStreamsWorkflowEngine)",
      },
    },
    {
      name: "flamecast-client-no-runtime-source",
      severity: "error",
      comment:
        "Browser-side Flamecast code must not import runtime source; durable observation should go through browser-safe state/client surfaces.",
      from: { path: "^apps/flamecast/src/client" },
      to: { path: "^packages/runtime/src" },
    },
    {
      name: "flamecast-shared-no-runtime-source",
      severity: "error",
      comment:
        "Flamecast shared browser/runtime modules must not import runtime source directly.",
      from: { path: "^apps/flamecast/src/shared" },
      to: { path: "^packages/runtime/src" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.eslint.json" },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(packages|apps)/.*/src",
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
}

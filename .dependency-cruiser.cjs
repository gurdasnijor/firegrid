module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    // firegrid-remediation-hardening.STATIC_QUALITY.5
    {
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
      name: "not-to-deprecated",
      severity: "warn",
      comment:
        "This module uses a deprecated npm package. Upgrade it or replace it.",
      from: {},
      to: {
        dependencyTypes: ["deprecated"],
      },
    },
    {
      name: "not-to-spec",
      severity: "error",
      comment:
        "Production code must not import from test/spec files. Factor shared helpers into production or test utility modules instead.",
      from: {
        path: "^(packages|apps)/.*/src",
        pathNot: [
          "\\.test\\.ts$",
          "\\.test\\.tsx$",
          "^(packages|apps)/.*/src/__tests__/",
        ],
      },
      to: {
        path: "[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$",
      },
    },
    {
      name: "no-duplicate-dep-types",
      severity: "warn",
      comment:
        "This module depends on an external package declared in more than one dependency bucket.",
      from: {},
      to: {
        moreThanOneDependencyType: true,
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "client-no-runtime",
      severity: "error",
      from: { path: "^packages/client/src" },
      to: { path: "^packages/runtime/src" },
    },
    {
      name: "runtime-no-client",
      severity: "error",
      from: { path: "^packages/runtime/src" },
      to: { path: "^packages/client/src" },
    },
    {
      name: "lab-no-substrate-or-runtime",
      severity: "error",
      from: { path: "^apps/lab/src" },
      to: { path: "^packages/(substrate|runtime)/src" },
    },
    {
      name: "packages-no-apps",
      severity: "error",
      from: { path: "^packages/.*/src" },
      to: { path: "^apps/.*/src" },
      comment:
        "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
    },
    {
      name: "kernel-internals-stay-internal",
      severity: "error",
      from: { pathNot: ["^packages/substrate/src", "^packages/substrate/src/__tests__"] },
      to: {
        path: "^packages/substrate/src/(state-machine|operator|operator-errors|producer|waits|subscribers|stream|projection|retained-records|internal-claim)\\.ts$",
      },
      comment: "Use @durable-agent-substrate/substrate/kernel subpath, not deep imports.",
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "\\.test\\.ts$",
          "\\.test\\.tsx$",
          "\\.d\\.ts$",
          "vitest\\.config\\.ts$",
          "vite\\.config\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.eslint.json" },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(packages|apps)/.*/src",
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
}

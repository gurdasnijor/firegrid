module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
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
      from: { path: "^packages/lab/src" },
      to: { path: "^packages/(substrate|runtime)/src" },
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
        pathNot: ["\\.test\\.ts$", "\\.test\\.tsx$", "vitest\\.config\\.ts$", "vite\\.config\\.ts$"],
      },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.eslint.json" },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^packages/.*/src",
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
}

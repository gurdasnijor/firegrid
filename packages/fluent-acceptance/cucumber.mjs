// Cucumber-js configuration for the fluent acceptance lane.
//
// Step definitions are TypeScript, loaded under the `tsx` ESM loader (the run
// scripts launch cucumber-js via `tsx`, so `.ts` imports resolve directly).
//
// `strict: false` is a deliberate SCAFFOLD stance: the real fluent features are
// wired in but most of their steps are not implemented yet, so undefined steps
// must report as pending rather than fail the build. As each feature's steps
// land, that feature flips to strict in its own PR.

const common = {
  import: ["src/support/**/*.ts", "src/steps/**/*.ts"],
  format: ["summary", "progress-bar"],
  formatOptions: { snippetInterface: "async-await" },
  strict: false,
}

// Default lane: the harness smoke + the real fluent features, EXCLUDING the
// live real-agent scenarios (those need creds and a live native/ACP harness).
export default {
  ...common,
  paths: ["features/**/*.feature", "../../features/fluent/**/*.feature"],
  tags: "not @real-agent",
}

// Live lane: only the real-agent scenarios. Gated by FIREGRID_REAL_AGENT=1 (a
// Before hook skips them with a clear precondition when the flag is absent).
export const real = {
  ...common,
  paths: ["features/**/*.feature", "../../features/fluent/**/*.feature"],
  tags: "@real-agent",
}

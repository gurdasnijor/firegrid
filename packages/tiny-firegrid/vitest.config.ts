import { configDefaults, defineConfig } from "vitest/config"

// TFIND-048 (coordinator correctness-bar ruling): the full real-LLM
// Codex ACP end-to-end (`*.smoke.test.ts`) is a DOCUMENTED-FLAKY
// NON-GATING smoke — excluded from the CI gate here, runnable on
// demand via `pnpm test:smoke`. The deterministic host-provisioning
// seam assertion (`codex-acp-host-provisioning-seam.test.ts`) stays in
// the gate.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.smoke.test.ts"],
  },
})

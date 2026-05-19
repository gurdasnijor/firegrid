import { configDefaults, defineConfig } from "vitest/config"

// On-demand runner for the documented-flaky real-LLM Codex ACP smoke
// (`pnpm test:smoke`). NOT part of the CI gate (see vitest.config.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.smoke.test.ts"],
    exclude: [...configDefaults.exclude],
  },
})

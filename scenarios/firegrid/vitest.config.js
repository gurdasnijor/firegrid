import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@firegrid/runtime/durable-clock",
        replacement: fileURLToPath(
          new URL("../../packages/runtime/src/durable-clock/index.ts", import.meta.url),
        ),
      },
      {
        find: "@firegrid/runtime",
        replacement: fileURLToPath(
          new URL("../../packages/runtime/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
})

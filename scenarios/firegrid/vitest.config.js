import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const sourceAlias = [
  {
    find: "@firegrid/substrate/descriptors",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/descriptors/index.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate/event-plane",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/event-plane/index.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate/id-gen",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/id-gen.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate/kernel",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/kernel/index.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/index.ts", import.meta.url),
    ),
  },
]

export default defineConfig({
  resolve: {
    alias: sourceAlias,
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
})

import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const alias = [
  ["@firegrid/client", "../../packages/client/src/index.ts"],
  ["@firegrid/runtime", "../../packages/runtime/src/index.ts"],
  [`@firegrid/substrate${"/kernel"}`, "../../packages/substrate/src/kernel/index.ts"],
  ["@firegrid/substrate/descriptors", "../../packages/substrate/src/descriptors/index.ts"],
  ["@firegrid/substrate/id-gen", "../../packages/substrate/src/id-gen.ts"],
  ["@firegrid/substrate", "../../packages/substrate/src/index.ts"],
] as const

export default defineConfig({
  resolve: {
    alias: alias.map(([find, path]) => ({
      find,
      replacement: fileURLToPath(new URL(path, import.meta.url)),
    })),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.mts"],
  },
})

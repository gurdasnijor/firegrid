import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const sourceAlias = [
  ["@firegrid/client/event-streams", "../../packages/client/src/event-streams-public.ts"],
  ["@firegrid/client", "../../packages/client/src/index.ts"],
  ["@firegrid/substrate/descriptors", "../../packages/substrate/src/descriptors/index.ts"],
  ["@firegrid/substrate/id-gen", "../../packages/substrate/src/id-gen.ts"],
  ["@firegrid/substrate", "../../packages/substrate/src/index.ts"],
] as const

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: sourceAlias.map(([find, path]) => ({
      find,
      replacement: fileURLToPath(new URL(path, import.meta.url)),
    })),
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 4441,
    strictPort: false,
  },
})

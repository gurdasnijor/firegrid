import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const sourceAlias = [
  {
    find: "@firegrid/client/event-streams",
    replacement: fileURLToPath(
      new URL("../../packages/client/src/event-streams-public.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/client",
    replacement: fileURLToPath(
      new URL("../../packages/client/src/index.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate/descriptors",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/descriptors/index.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate/id-gen",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/id-gen.ts", import.meta.url),
    ),
  },
  {
    find: "@firegrid/substrate",
    replacement: fileURLToPath(
      new URL("../../packages/substrate/src/index.ts", import.meta.url),
    ),
  },
] as const

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: sourceAlias,
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 4439,
    strictPort: false,
  },
})

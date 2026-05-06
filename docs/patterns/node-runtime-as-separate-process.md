# Pattern: Node runtime as a separate process from the browser dev server

Use this pattern when an application ships both a browser UI and a Node-tier
runtime. The two tiers run as separate processes; the browser dev server does
not load `@firegrid/runtime` as a plugin or middleware.

This is the canonical topology for any product that builds on
`@firegrid/runtime` and `@firegrid/client` together. Loading the runtime into
the browser dev server's process — for example, as a Vite plugin — fails for
two reasons: the runtime is Node-tier and not browser-bundleable, and public
package `exports` are dist-only so workspace consumers either need source-path
aliases or a build step before resolution succeeds.

Authorizing ACIDs:

- `firegrid-platform-invariants.LOCALITY.1` — `@firegrid/runtime` is Node-tier
  and not imported from browser, edge, or Worker code.
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1` — runtime handlers and
  subscribers run in a Node-tier process.
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.5` — products that ship
  both a browser UI and a Node-tier runtime keep them as separate processes;
  the runtime is not loaded as a plugin or middleware into a browser bundler.
- `firegrid-platform-invariants.PACKAGE_DISCIPLINE.7` — built `dist/` artifacts
  are not committed; public manifest `exports` resolve through dist after build.

## Project layout

```text
apps/example/
  package.json
  tsconfig.json
  vite.config.ts
  src/
    shared/
      descriptors.ts          # operations, EventStreams, EventPlanes
    runtime/
      main.ts                 # Node entrypoint; imports @firegrid/runtime + @firegrid/client
    web/
      main.tsx                # Browser entrypoint; imports @firegrid/client only
      App.tsx
```

`src/shared/descriptors.ts` is imported by both `src/runtime/main.ts` and
`src/web/main.tsx`. It contains only schema descriptors; no Node-only or
browser-only code.

## Application package manifest

```json
{
  "name": "@example/app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:web": "vite",
    "dev:runtime": "tsx src/runtime/main.ts",
    "dev": "concurrently \"pnpm dev:web\" \"pnpm dev:runtime\""
  },
  "dependencies": {
    "@firegrid/client": "workspace:*",
    "@firegrid/runtime": "workspace:*",
    "@firegrid/substrate": "workspace:*",
    "effect": "..."
  },
  "devDependencies": {
    "concurrently": "...",
    "tsx": "...",
    "vite": "..."
  }
}
```

`pnpm dev` starts both processes in the same terminal. The web process owns
the browser dev server; the runtime process owns durable handler execution.

## Workspace source resolution

Public package `exports` are dist-only per
`firegrid-platform-invariants.PACKAGE_DISCIPLINE.7`. Workspace consumers that
want to skip the build step rely on tsconfig path aliases plus the source
shims that Firegrid already maintains for its own lab and scenarios.

Two options:

1. **Path aliases at the workspace root** — add the source paths in the
   workspace `tsconfig.base.json` so `@firegrid/runtime` resolves to source
   during dev typecheck and runtime execution. This is what `lab/` and
   `features/durable-agent-runtime-lab/` already do internally.
2. **Build before dev** — run `pnpm --filter @firegrid/runtime build` and
   `pnpm --filter @firegrid/client build` before `pnpm dev`. Required when
   path aliases are not configured for the consumer.

For app workspaces inside this repository, option 1 is recommended because the
existing tsconfig and vitest aliases already cover it.

## Vite config

The Vite config does not import `@firegrid/runtime`. It is browser-tier only.

```ts
// vite.config.ts
import { defineConfig } from "vite"

export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist/web",
  },
  // No @firegrid/runtime imports here. The runtime runs in a separate process.
})
```

## Node runtime entrypoint

The Node entrypoint composes runtime and client and starts the durable
process. See
[node-runtime-with-client-emit](./node-runtime-with-client-emit.md) for the
full handler shape.

```ts
// src/runtime/main.ts
import { Effect } from "effect"
import { FiregridClientLive } from "@firegrid/client"
import { Firegrid, run } from "@firegrid/runtime"
import { handlers } from "./handlers.ts"
import { providers } from "./providers.ts"

const streamUrl = process.env.FIREGRID_STREAM_URL!

const runtime = Firegrid.composeRuntime({
  handlers,
  subscribers: [],
  provide: [
    FiregridClientLive({ streamUrl }),
    ...providers,
  ],
})

await Effect.runPromise(run({ connection: { streamUrl }, runtime }))
```

This file is never bundled by Vite. It runs under `tsx`, `node --import tsx`,
or compiled JavaScript in production.

## Browser entrypoint

The browser entrypoint imports only `@firegrid/client` and the shared
descriptors:

```ts
// src/web/main.tsx
import { Effect } from "effect"
import { FiregridClient, FiregridClientLive } from "@firegrid/client"
import { TimelineEvents } from "../shared/descriptors.ts"

const ClientLive = FiregridClientLive({
  streamUrl: import.meta.env.VITE_FIREGRID_STREAM_URL,
})

// React, Solid, or other framework code consumes FiregridClient as an Effect
// service through whatever runtime adapter the application chooses.
```

The browser bundle does not contain `@firegrid/runtime`. Vite's tree shake
plus the dev `optimizeDeps` configuration ensures Node-tier modules never
appear in the browser-bundled output.

## Why not a Vite plugin

Putting `@firegrid/runtime` into `vite.config.ts` and starting the runtime
when the dev server boots looks attractive — one process to start, the runtime
"comes up with" the UI. It fails because:

1. `@firegrid/runtime`'s public `exports` resolve to `dist/` per
   `firegrid-platform-invariants.PACKAGE_DISCIPLINE.7`. Workspace dev runs
   from source through tsconfig path aliases; Vite's plugin resolution does
   not honor those aliases by default and resolves the manifest's `exports`
   instead, which fails before build.
2. `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.5` explicitly forbids
   loading the runtime as a browser-bundler plugin; the runtime is Node-tier
   and the browser bundler is not its host.
3. Ownership transfer (`firegrid-runtime-ownership-transfer.*`) and runtime
   presence (`firegrid-runtime-presence.*`) assume the runtime is a
   first-class durable participant, not a side effect of opening a browser
   tab. Coupling the runtime lifecycle to the dev server hides that.

## Anti-patterns

- Single-process: `vite dev` that loads `@firegrid/runtime` through a
  configFile import.
- Bundling the runtime into the browser build for "convenience".
- Sharing in-memory state between browser and runtime through globals; the
  contract is durable rows only per
  `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.5`.

# Pattern: Runtime Host Is Node-Tier, Not A Browser Dev-Server Plugin

Use this pattern when an app has both a browser UI and Firegrid runtime handlers.
The important boundary is that runtime code is hosted by a Node-tier app/runtime
owner. It is not loaded through Vite, Webpack, esbuild, Rspack, or browser code.

Authorizing ACIDs:

- `firegrid-platform-invariants.LOCALITY.1`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.5`
- `firegrid-platform-invariants.PACKAGE_DISCIPLINE.7`

## Embedded App Dev

For product app development, a single app command may start or coordinate the
browser dev server, local Firegrid infrastructure, and Node runtime host. That
is an app-level dev orchestrator.

```json
{
  "scripts": {
    "dev": "tsx src/dev/main.ts",
    "dev:web": "vite --host 127.0.0.1",
    "dev:runtime": "tsx src/runtime/main.ts"
  }
}
```

Rules for embedded dev:

- The developer should not need to provide `DURABLE_STREAMS_URL` for the default
  app dev command.
- The browser should not discover runtime state from generated files such as
  `public/topology.json`.
- Any local stream/server setup belongs to the app dev orchestrator or Firegrid
  dev infrastructure, not to browser code and not hidden inside the runtime
  handler module.
- Runtime code still uses `Firegrid.composeRuntime(...)` and
  `run({ connection, runtime })` after the orchestrator provides its connection.

## Attached Runtime Mode

The published `firegrid` binary is attached-only. It is for advanced runtime
attachment where an external process supplies `DURABLE_STREAMS_URL`.

That binary does not launch Durable Streams, does not spawn child dev processes,
and does not replace embedded app dev. See `packages/runtime/bin/firegrid.ts`
and `packages/runtime/README.md`.

## Runtime Entrypoint Shape

```ts
import { FiregridClientLive } from "@firegrid/client"
import { Firegrid, run } from "@firegrid/runtime"
import { Effect } from "effect"
import { handlers } from "./handlers.ts"

export const makeRuntime = (cfg: {
  readonly streamUrl: string
  readonly runtimeId: string
}) =>
  Firegrid.composeRuntime({
    handlers,
    subscribers: [],
    provide: [
      FiregridClientLive({
        streamUrl: cfg.streamUrl,
        clientId: cfg.runtimeId,
      }),
    ],
  })

export const runRuntime = (cfg: {
  readonly streamUrl: string
  readonly runtimeId: string
}) =>
  run({
    connection: { streamUrl: cfg.streamUrl },
    runtime: makeRuntime(cfg),
  })

await Effect.runPromise(runRuntime(configFromHost))
```

## Why Not A Vite Plugin

A Vite plugin can make the runtime appear to start with the UI, but it breaks
the package and topology boundaries:

- browser bundlers are not the runtime host;
- dist-only `exports` can resolve before packages are built;
- runtime lifecycle becomes an accidental side effect of opening the browser dev
  server;
- process-local state can leak into UI code instead of durable rows.

Use an embedded dev orchestrator for one-command local dev, or an attached
runtime process for advanced deployments. Do not put `@firegrid/runtime` in the
browser bundler path.

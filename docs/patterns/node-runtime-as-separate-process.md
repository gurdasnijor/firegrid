# Pattern: Runtime Host Is Node-Tier, Not A Browser Dev-Server Plugin

Use this pattern when an app has both a browser UI and Firegrid runtime handlers.
The runtime code runs in a Node-tier host. It is not loaded through Vite,
Webpack, esbuild, Rspack, or browser code.

This pattern is deliberately narrow: it shows the runtime boundary and the
runtime entry shape. It does not invent a product dev launcher.

Authorizing ACIDs:

- `firegrid-platform-invariants.LOCALITY.1`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.5`
- `firegrid-platform-invariants.PACKAGE_DISCIPLINE.7`

## Runtime Entrypoint Shape

Runtime entrypoints compose the app's handlers and Layers, then pass that graph
to `run({ connection, runtime })`.

```ts
import { FiregridClientLive } from "@firegrid/client"
import { Firegrid, run } from "@firegrid/runtime"
import { Effect } from "effect"
import { handlers } from "./handlers.ts"

const streamUrl = config.streamUrl
const runtimeId = config.runtimeId

const runtime = Firegrid.composeRuntime({
  handlers,
  subscribers: [],
  provide: [
    FiregridClientLive({
      streamUrl,
      clientId: runtimeId,
    }),
  ],
})

await Effect.runPromise(
  run({
    connection: { streamUrl },
    runtime,
  }),
)
```

`config` is supplied by the runtime host. In attached mode, the published
`firegrid` binary reads `DURABLE_STREAMS_URL` at the process edge; see
`packages/runtime/bin/firegrid.ts`. Product app dev commands may choose another
host/config source, but this pattern does not prescribe that launcher.

## What This Pattern Forbids

- importing `@firegrid/runtime` from browser code;
- loading runtime code as a Vite/Webpack/esbuild/Rspack plugin;
- using a browser dev server as the runtime lifecycle owner;
- writing generated browser-public files such as `public/topology.json` as the
  runtime/browser contract;
- committing built `dist/` artifacts to make package `exports` work in dev.

## Why Not A Vite Plugin

A browser dev-server plugin can make the runtime appear to start with the UI, but
it breaks the package and topology boundaries:

- browser bundlers are not the runtime host;
- dist-only `exports` can resolve before packages are built;
- runtime lifecycle becomes an accidental side effect of opening the browser dev
  server;
- process-local state can leak into UI code instead of durable rows.

Keep the runtime in a Node-tier host and keep browser code on browser-safe
Firegrid client surfaces.

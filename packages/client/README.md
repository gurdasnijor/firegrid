# @firegrid/client

Browser-safe Firegrid client APIs.

The client writes launch intent to a Durable Streams URL. It does not import `@firegrid/runtime`, start processes, claim work, or depend on Node-only provider SDKs.

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import { Effect, Layer, Stream } from "effect"

const FiregridBrowserLive = FiregridLive.pipe(
  Layer.provide(
    Layer.succeed(FiregridConfig, {
      launchStreamUrl: import.meta.env.VITE_DURABLE_STREAMS_URL,
    }),
  ),
)

const program = Effect.gen(function* () {
  const firegrid = yield* Firegrid
  const handle = yield* firegrid.launch({
    runtime: local.jsonl({
      argv: ["npx", "-y", "my-agent"],
    }),
  })

  return yield* handle.changes.pipe(Stream.take(1), Stream.runCollect)
}).pipe(Effect.provide(FiregridBrowserLive))
```

`launch(...)` assigns the launch id internally and appends normalized durable launch intent. Runtime execution, sandbox streaming, journaling rules, readiness, restart, and product/session materialization are not part of the client launch input.

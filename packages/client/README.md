# @firegrid/client

Browser-safe Firegrid client APIs.

The client writes launch intent to a Durable Streams URL. It does not import `@firegrid/runtime`, start processes, claim work, or depend on Node-only provider SDKs.

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
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
    launchId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    target: {
      kind: "command",
      spec: {
        argv: ["npx", "-y", "my-agent"],
        protocol: "acp",
      },
    },
    planes: {
      session: {
        "provider-wire": {
          kind: "stream",
          role: "events",
          streamUrl: "https://durable.example/v1/stream/session-provider-wire",
        },
      },
    },
  })

  return yield* handle.changes.pipe(Stream.take(1), Stream.runCollect)
}).pipe(Effect.provide(FiregridBrowserLive))
```

Use `handle.diagnosticStream(name)` when a product package needs to inspect a raw named stream. Product-facing APIs should normally wrap launch handles with projections such as sessions, messages, transcripts, or provider events.

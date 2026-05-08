# @firegrid/client

Browser-safe Firegrid client APIs.

The client writes launch intent to a Durable Streams URL. It does not import `@firegrid/runtime`, start processes, claim work, or depend on Node-only provider SDKs.

```ts
import { Firegrid } from "@firegrid/client"
import { Effect } from "effect"

const program = Effect.scoped(
  Firegrid.scoped({
    launchStreamUrl: import.meta.env.VITE_DURABLE_STREAMS_URL,
  }).pipe(
    Effect.flatMap(client =>
      client.launch({
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
      }).pipe(
        Effect.flatMap(handle => handle.snapshot),
      )
    ),
  ),
)
```

Use `handle.diagnostic.stream(name)` when a product package needs to inspect a raw named stream. Product-facing APIs should normally wrap launch handles with projections such as sessions, messages, transcripts, or provider events.

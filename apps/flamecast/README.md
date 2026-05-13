# Flamecast Toy Stdio Agents

Minimal local Flamecast toy that proves a browser prompt can launch a Firegrid
`local-process` runtime, deliver stdin through `RuntimeIngressTable`, and read
assistant output from `RuntimeOutputTable`.

This is local-only for now; it does not require an Electric Cloud token.
There is no Flamecast session API in this toy. The UI uses `@firegrid/client`
for launch/prompt/open and observes Firegrid collections with TanStack live
queries.

## Run Locally

Start a local Durable Streams server:

```bash
node --import tsx -e 'import { DurableStreamTestServer } from "@durable-streams/server"; const server = new DurableStreamTestServer({ port: 8080, host: "127.0.0.1" }); const url = await server.start(); console.log(`Durable Streams test server listening at ${url}`); await new Promise(() => {})'
```

In another shell, start the toy runtime host:

```bash
export DURABLE_STREAMS_BASE_URL="http://127.0.0.1:8080"
export FIREGRID_RUNTIME_NAMESPACE="flamecast-toy-local"
pnpm --filter @firegrid/flamecast runtime
```

In a third shell, start the Vite UI with matching browser-visible config:

```bash
export VITE_DURABLE_STREAMS_BASE_URL="http://127.0.0.1:8080"
export VITE_FIREGRID_RUNTIME_NAMESPACE="flamecast-toy-local"
pnpm --filter @firegrid/flamecast dev
```

Open `http://127.0.0.1:4441`.

## Notes

- `flamecast-toy-stdio-agents.WEB_ASSETS.1`
- `flamecast-toy-stdio-agents.WEB_ASSETS.2`
- `flamecast-toy-stdio-agents.RUNBOOK.1`
- `flamecast-toy-stdio-agents.FIREGRID_BOUNDARY.2`
- `flamecast-toy-stdio-agents.FIREGRID_BOUNDARY.3`
- The toy runtime composes current Firegrid runtime tables and `startRuntime`;
  it does not use the removed Flamecast durable wrapper path.
- The local stdio command exits after one prompt. Follow-up turns are launched
  as fresh runtime contexts in this toy.
- Electric Cloud smoke is intentionally left as follow-up; this PR validates the
  local host/server path first.

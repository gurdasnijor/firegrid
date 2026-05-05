# Firegrid

Canonical design source:

- [Firegrid Architecture and Operation Messaging Boundary](docs/SDD_FIREGRID_ARCHITECTURE_AND_INVOCATION_BOUNDARY.md)
- [Durable Agent Substrate SDD](docs/SDD_DURABLE_AGENT_SUBSTRATE.md)
- [Docs map](docs/README.md)

Other canonical SDDs:

- [Client Event Planes And State Producers](docs/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md)
- [Choreography Facade](docs/SDD_CHOREOGRAPHY_FACADE.md)
- [Launchable Substrate Host And Lab](docs/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md)

Acai specs live under `features/firegrid/` (canonical) and
`features/durable-agent-substrate/` (substrate kernel).

## Current State

The repo is migrating to the Firegrid product / package vocabulary:
`@firegrid/runtime` (server-side participant; was
`@durable-agent-substrate/host`), `@firegrid/lab` (browser
inspector), and the still-named substrate (`@durable-agent-substrate/substrate`)
+ client (`@durable-agent-substrate/client`) packages. Operation
messaging and EventStream descriptor APIs are the next slices.

Run the baseline validation before editing:

```sh
pnpm check
```

Implementation work starts from the Acai specs and includes full
Acai ACID references in test names or nearby comments.

## Run the lab

The lab is a read-only Durable Streams inspector. From the repo root,
run:

```sh
pnpm dev:lab
```

That uses the local `@firegrid/runtime` package to launch an embedded
Durable Streams server, injects the resolved URL into Vite as
`VITE_DURABLE_STREAMS_URL`, and forwards stdio. Open the printed Vite
URL and the lab attaches with no manual wiring. Ctrl-C tears down both
the embedded Durable Streams server and the child via the same Effect
scope.

The equivalent package-script form is:

```sh
pnpm --filter @firegrid/runtime run firegrid dev -- pnpm --filter @firegrid/lab dev
```

For attached mode against an existing Durable Streams endpoint,
set `DURABLE_STREAMS_URL` in the env and run the runtime script with
no subcommand, or call the runtime constructors directly:

```sh
pnpm --filter @firegrid/runtime run firegrid
DURABLE_STREAMS_URL=https://… pnpm --filter @firegrid/runtime run firegrid
```

The lab can be pointed elsewhere via `?streamUrl=...` in the
browser URL or by setting `VITE_DURABLE_STREAMS_URL` directly.

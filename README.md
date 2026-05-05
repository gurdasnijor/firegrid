# Durable Agent Substrate

Canonical design source:

- [Durable Agent Substrate SDD](docs/SDD_DURABLE_AGENT_SUBSTRATE.md)
- [Docs map](docs/README.md)

Current canonical SDDs:

- [Client Event Planes And State Producers](docs/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md)
- [Choreography Facade](docs/SDD_CHOREOGRAPHY_FACADE.md)
- [Launchable Substrate Host And Lab](docs/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md)

Acai specs live under `features/durable-agent-substrate/` and are the stable
acceptance criteria for implementation.

## Current State

This repo is implementing the substrate in spec-driven slices. The launchable
host/client/lab work is currently in phase 13.

Run the baseline validation before editing:

```sh
pnpm check
```

Implementation work should start from the Acai specs and include full Acai ACID
references in test names or nearby comments.

## Run the lab

The browser lab inspects a Durable Streams endpoint. The repo wires both
processes together through Turborepo so a single command starts everything:

```sh
pnpm dev:lab
```

This runs `turbo run dev:lab --parallel`, which fans out to:

- `packages/host` `dev:embedded` — boots a no-write embedded
  `DurableStreamTestServer` at `http://127.0.0.1:4437/substrate/lab`. No Host
  Program Graph; no scenario runner; no client writes.
- `packages/lab` `dev` — Vite dev server at `http://localhost:4439/` that
  defaults to the URL above.

Open `http://localhost:4439/` once both lines log ready; Ctrl-C tears both down.

If you want each side in its own terminal for debugging, the split commands
are still available:

```sh
pnpm --filter @durable-agent-substrate/host dev:embedded
pnpm --filter @durable-agent-substrate/lab dev
```

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

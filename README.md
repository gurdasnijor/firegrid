# Durable Agent Substrate

Canonical design source:

- [Durable Agent Substrate SDD](docs/SDD_DURABLE_AGENT_SUBSTRATE.md)

Ahead-of-stream SDD proposal:

- [Choreography And Agent Tool Bindings](docs/SDD_CHOREOGRAPHY_TOOL_BINDINGS.md)

Acai specs live under `features/durable-agent-substrate/` and should be
rebuilt from the SDD as the design stabilizes.

## Current State

This repo is intentionally docs/specs first. There is no implementation package
yet.

Run the baseline validation before editing:

```sh
pnpm check
```

Next implementation work should start from the Acai specs, then add the minimum
TypeScript package needed to satisfy the first vertical slice:

```text
durable.run + durable.completion + durable.claim.attempt
  -> Durable Streams State projection rebuild
  -> ReadyWorkProjection
  -> claim-before-invoke operator proof
```

When implementation starts, tests should include full Acai ACID references in
test names or nearby comments. The docs/spec-only baseline intentionally has no
implementation references yet.

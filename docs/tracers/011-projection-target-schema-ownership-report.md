# 011 Projection Target Schema Ownership Report

## Outcome

Projection targets now own State Protocol schema, event encoding, fold, and
query adapters. `StateProtocolStrategy` no longer imports session protocol
schemas or `SessionProjectionQuery`; it only asks the projection target for a
State Protocol capability and uses that capability to write and query Durable
State.

The session projection continues to run and query through raw-fold and State
Protocol through the common strategy API. A tiny non-session count projection
proves raw-fold is not session-specific and proves State Protocol unsupported
capability is reported by target capability, not by a hardcoded target name.

`scenarios/firegrid/src/tracer-011.test.ts` proves the same boundary at scenario
level by appending retained runtime-output facts to Durable Streams, running the
session projection through `makeStateProtocolStrategy`, and querying derived
session messages through the target-owned State Protocol query adapter. The
scenario writes with one State Protocol strategy instance and queries with a
fresh strategy instance, so query does not depend on process-local target memory.

## Directory Alignment

The primary materialization namespace remains under
`packages/runtime/src/data-plane/materialization`. Moving it to
`packages/runtime/src/materialization` would be a broader import churn than this
tracer needs. The target/schema ownership boundary is now expressed inside the
existing namespace and can move later as a mechanical follow-up.

Stale paths that remain:

- `packages/runtime/src/data-plane/materialization/**`: still the active
  materialization namespace; inside 011 scope, not moved in this PR.
- `packages/runtime/src/data-plane/materialization/sinks/state-protocol/**`:
  remains as a generic State Protocol writer namespace; the stale session
  sink/encoder helpers were removed in this tracer.
- `packages/runtime/src/control-plane/**` and
  `packages/runtime/src/runtime-host/**`: outside 011 scope and untouched.

## Remaining Concerns

State Protocol query support is still snapshot-oriented: `subscribe` streams the
current query result rather than a live Durable State subscription. Materialize
still needs a strategy adapter in a later tracer.

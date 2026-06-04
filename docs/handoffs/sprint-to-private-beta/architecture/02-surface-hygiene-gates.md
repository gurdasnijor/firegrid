# Surface Hygiene Gates

Surface hygiene is the part users copy. It must be treated as a first-class
private-beta acceptance dimension, not cleanup after the architecture is done.

## Gate A: Barrel-Export Audit

Goal: host-sdk/client-sdk public barrels do not export substrate internals as
normal API.

Audit should flag:

- `*EngineLive`, `*ReconcilerDaemonLive`, `*SubstrateLive` exported from
  host-sdk public barrels;
- runtime observation types re-exported through host-sdk;
- durable table/facade exports from client-sdk barrels;
- `RuntimeControlRequestWorkflowEngineLive`,
  `RuntimeControlRequestReconcilerDaemonLive`, `hostProjectionObserver`,
  `RuntimeAgentOutputObservation`, `HostRuntimeObservationStreamsLive`, and
  similar internal seams in public import paths.

Acceptance:

- exports removed, moved to package-private paths, or listed in a short
  compatibility-shim ledger with deletion target;
- docs/examples stop importing them;
- `pnpm run lint:deps` stays green or the carveout shrinks.

## Gate B: Cannon Completeness Check

Goal: canonical docs are compact and self-consistent.

Acceptance:

- every doc referenced from `docs/cannon/README.md` exists;
- every non-cannon SDD referenced by cannon is either mirrored, explicitly
  historical, or replaced by a cannon doc;
- package READMEs link to `docs/cannon/README.md` for architecture;
- stale package architecture docs are refreshed or marked historical.

Known item: `packages/runtime/ARCHITECTURE.md` still describes older package
names and should not be used as dispatch source until refreshed.

## Gate C: Methodology And Examples Sweep

Goal: examples validate public surfaces instead of normalizing internal imports.

Acceptance:

- `packages/firelab/docs/methodology.md` does not instruct new sims to use
  `hostProjectionObserver` from `@firegrid/host-sdk`;
- current sims using that helper are migrated to one of:
  - client-sdk waits for client-visible assertions;
  - semantic channels for application event/fact observation;
  - package-local runtime observation over runtime-owned tags for host-only
    instrumentation;
- public examples import only the package they are demonstrating plus protocol
  and documented composition packages;
- no end-user-like sim hides SDK gaps behind local helper wrappers.

Known sims to inspect:

- `codex-acp-tool-calls`
- `inv1-stream-zip-body`
- `wait-pre-attach-roundtrip`
- `phase0-wave-2b-stream-zip-restart-replay`
- `acp-sdk-example-agent`

## Gate D: Span-Name Contract Baseline

Goal: observability that docs, tests, dashboards, or perf gates depend on is
treated as product surface.

Minimum deliverable:

- a small stable span-name registry for private beta;
- prefix ownership rules, for example `firegrid.runtime.*`,
  `firegrid.session.*`, `firegrid.client.*`, `firegrid.host.*`;
- explicit internal prefixes that may change;
- stable attribute keys used by docs or simulations.

Current evidence:

- `simulate:perf` for `acp-sdk-example-agent` shows `firegrid.durable_table.rows`
  spans dominating wall time because they are open stream waits, not active CPU
  work. Perf tooling should distinguish active work from subscription wait wall
  time.
- traces still show a `durableTools` stream namespace label after durable-tools
  deletion. This may be only a historical stream name, but it should be cleaned
  or documented before beta trace artifacts are published.

## Gate E: Schema/Operation Single Source

Goal: projection packages do not define their own semantic operation catalogs.

Acceptance:

- `packages/protocol/src/session-facade/operations.ts` is the single operation
  catalog for session/client operation schemas;
- `packages/client-sdk/src/operations.ts` becomes a re-export or disappears;
- future CLI, MCP, REST, gRPC, and JSON-RPC projections import protocol catalog
  entries rather than copying them;
- error schemas follow the same rule: shared domain errors in protocol,
  runtime-internal failures in runtime, binding-edge errors in the owning
  projection package.


# Decisions

Status: build-facing draft

Decisions are planning references. Specs remain authoritative; each decision
below cites the Acai requirements that currently enforce it.

| ID | Decision | Enforced by |
| --- | --- | --- |
| D-01 | Product specs live under `features/flamecast`; Firegrid product-neutral specs live under `features/firegrid`. | `flamecast-product-contract.REPO_LOCATION.1`, `firegrid-platform-invariants.ENFORCEMENT.1` |
| D-02 | Shared boundary and locality rules live in `firegrid-platform-invariants` and lane specs cite them rather than restating them. | `firegrid-platform-invariants.ENFORCEMENT.1`, `firegrid-platform-invariants.ENFORCEMENT.2` |
| D-03 | Browser/app query surfaces are read-oriented and do not expose raw StreamDB mutation, kernel access, claim authority, or terminal authority. | `firegrid-client-projection-api.BROWSER_SAFE_FACADE.4`, `firegrid-client-projection-api.INVARIANTS.2`, `firegrid-projection-query.AUTHORITY_BOUNDARY.1` |
| D-04 | Projection query uses descriptor-scoped `snapshot`, `stream`, `until`, and `events` semantics with typed decode/retention-gap errors. | `firegrid-projection-query.QUERY_HANDLES.1`, `firegrid-projection-query.EXPECTED_ERRORS.1`, `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2` |
| D-05 | Implement framework-neutral client projection/query first; React/framework adapters are downstream thin wrappers after more call sites prove shape. | `firegrid-client-projection-api.FRAMEWORK_ADAPTER_DEFERRAL.1`, `firegrid-client-projection-api.FRAMEWORK_ADAPTER_DEFERRAL.2` |
| D-06 | Use Durable Streams offsets and protocol signals internally, but expose opaque Firegrid cursor/error types. | `firegrid-projection-query.CURSOR_AND_REPLAY.1`, `firegrid-client-projection-api.RECONNECT_SEMANTICS.1` |
| D-07 | Runtime presence minimally carries runtime id, host id, node id, topology identity, public ingress endpoints, readiness, timestamps, and public metadata. | `firegrid-runtime-presence.DESCRIPTOR.1` |
| D-08 | Runtime presence is advisory discovery state, not leader election, command routing, or credential storage. | `firegrid-runtime-presence.CONSISTENCY.1`, `firegrid-runtime-presence.NON_SCOPE.3`, `firegrid-platform-invariants.SECURITY.3` |
| D-09 | Shifted hosts need lease/epoch evidence, old-owner release/drain/stale proof, new-owner fence/claim, projection rebuild, materialization, and provider reattach classification before side effects. | `firegrid-runtime-ownership-transfer.LEASE_FENCE_EPOCH.1`, `firegrid-runtime-ownership-transfer.TRANSFER_PRECONDITIONS.1`, `firegrid-runtime-ownership-transfer.TRANSFER_PRECONDITIONS.4`, `firegrid-runtime-ownership-transfer.TRANSFER_PRECONDITIONS.5` |
| D-10 | Provider reattach profiles start as `no_reattach`, `reprovision_from_history`, `load_via_protocol`, and `supervised_live_process`. | `firegrid-runtime-ownership-transfer.REATTACH_PROFILES.1` |
| D-11 | Trace context in durable rows is optional and product-neutral; correctness and authorization do not depend on trace metadata. | `firegrid-observability.TRACE_METADATA.1`, `firegrid-observability.NON_AUTHORITY.1`, `firegrid-platform-invariants.SECURITY.5` |
| D-12 | V1 cancellation remains app-owned control rows plus typed handler failure. Any future `client.cancel` helper must lower to the same durable facts. | `firegrid-agent-runtime-substrate.APP_OWNED_CONTROL_ROWS.1`, `firegrid-agent-runtime-substrate.APP_OWNED_CONTROL_ROWS.4` |
| D-13 | Firegrid records generic scheduled work; Flamecast owns scheduled self-prompt and promptability policy. | `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1`, `firegrid-scheduling-tool-bindings.NON_SCOPE.1`, `flamecast-product-contract.LOWERING.9` |
| D-14 | Prompt transport is app-owned durable intent over Firegrid mechanics; Firegrid may provide claimed-intent helpers but no prompt/mailbox product API. | `firegrid-claimed-intent-transport.INTENT_DESCRIPTOR.1`, `firegrid-claimed-intent-transport.NON_SCOPE.1`, `flamecast-product-contract.LOWERING.9` |
| D-15 | Runtime locality is split: `@firegrid/runtime` is Node-tier; `@firegrid/client` is browser/edge-safe. | `firegrid-platform-invariants.LOCALITY.1`, `firegrid-platform-invariants.LOCALITY.2`, `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1` |
| D-16 | LT-02 is the first product-shaped proof: Flamecast UI starts a session and a local Node runtime executes through Firegrid. | `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`, `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2`, `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1`, `flamecast-product-contract.LOWERING.2` |
| D-17 | LT-02 unblocks through the EventPlane timeline path first: runtime writes Flamecast session index/timeline/control rows through app-owned EventPlane producers, and the UI reads them through browser-safe `@firegrid/client` projection/query handles. Runtime-side EventStream append remains a later optional lane. | `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1`, `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2`, `firegrid-client-projection-api.RECONNECT_SEMANTICS.1`, `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.2`, `firegrid-platform-invariants.AUTHORITY.4` |

## Decision Use

When implementation work cites a decision, it should also cite the most
specific ACID that enforces the behavior. Decision IDs are useful for human
planning; ACIDs are the implementation and review authority.

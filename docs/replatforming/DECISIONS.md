# Decisions

Status: draft

Decisions are planning references. Where possible, add ACID citations after the
relevant feature specs land.

| ID | Decision |
| --- | --- |
| D-01 | Product specs live under `features/flamecast`; Firegrid product-neutral specs live under `features/firegrid`. |
| D-02 | Add `firegrid-platform-invariants.feature.yaml` first so lanes cite shared boundary and locality ACIDs. |
| D-03 | Browser/app query surfaces are read-oriented. Browser code does not gain raw StreamDB mutation, kernel access, claim authority, or terminal authority. |
| D-04 | Projection query uses descriptor-scoped `snapshot`, `stream`, `until`, and `events` semantics with typed decode/retention-gap errors. |
| D-05 | Implement framework-neutral client projection/query first; React/framework adapters are downstream thin wrappers after more call sites prove shape. |
| D-06 | Use Durable Streams offsets and protocol signals as internal resume primitives, but expose opaque Firegrid cursor/error types. |
| D-07 | Runtime presence minimally carries runtime id, host id, node id, topology identity, public ingress endpoints, readiness, timestamps, and public metadata. |
| D-08 | Runtime presence is advisory discovery state, not leader election, command routing, or credential storage. |
| D-09 | Shifted hosts need lease/epoch evidence, old-owner release/drain/stale proof, new-owner fence/claim, projection rebuild, materialization, and provider reattach classification before side effects. |
| D-10 | Provider reattach profiles start as `no_reattach`, `reprovision_from_history`, `load_via_protocol`, and `supervised_live_process`. |
| D-11 | Trace context in durable rows is optional and product-neutral; correctness and authorization do not depend on trace metadata. |
| D-12 | V1 cancellation remains app-owned control rows plus typed handler failure. Any future `client.cancel` helper must lower to the same durable facts. |
| D-13 | Firegrid records generic scheduled work; Flamecast owns scheduled self-prompt and promptability policy. |
| D-14 | Prompt transport is app-owned durable intent over Firegrid mechanics; Firegrid may provide claimed-intent helpers but no prompt/mailbox product API. |
| D-15 | Runtime locality is split: `@firegrid/runtime` is Node-tier; `@firegrid/client` is browser/edge-safe. |

## Decision Use

When a feature spec exists, update the relevant decision with an `Enforced by`
section that cites ACIDs. Example:

```text
Enforced by:
  - firegrid-runtime-presence.DESCRIPTOR.1
  - firegrid-platform-invariants.LOCALITY.2
```

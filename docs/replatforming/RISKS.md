# Risks

Status: build-facing draft

Risks are tracked here for planning. Enforcement lives in ACIDs and review
guardrails.

| ID | Risk | Mitigation | ACID anchors |
| --- | --- | --- | --- |
| R-01 | Firegrid absorbs Flamecast product semantics. | Review every lane against the boundary specs. | `firegrid-platform-invariants.BOUNDARY.1`, `flamecast-product-contract.INVARIANTS.1` |
| R-02 | Specs and prose drift. | Prose cites ACIDs; feature YAML remains source of truth. | `firegrid-platform-invariants.ENFORCEMENT.1`, `firegrid-platform-invariants.ENFORCEMENT.2`, `firegrid-platform-invariants.ENFORCEMENT.4` |
| R-03 | Replatform work accidentally uses local sibling paths or internal Firegrid APIs. | Packed package-consumption checks for cross-repo work; public package imports only. | `firegrid-platform-invariants.PACKAGE_DISCIPLINE.1`, `firegrid-platform-invariants.PACKAGE_DISCIPLINE.4`, `firegrid-platform-invariants.PACKAGE_DISCIPLINE.6` |
| R-04 | Runtime locality is missed and `@firegrid/runtime` is imported into Worker/browser code. | Split UI/client and Node runtime paths. | `firegrid-platform-invariants.LOCALITY.1`, `firegrid-platform-invariants.LOCALITY.2`, `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1` |
| R-05 | Projection/query leaks raw StreamDB or Durable Streams State authority. | Descriptor-scoped read facade with opaque cursor and typed errors. | `firegrid-projection-query.AUTHORITY_BOUNDARY.1`, `firegrid-projection-query.AUTHORITY_BOUNDARY.2`, `firegrid-client-projection-api.BROWSER_SAFE_FACADE.4` |
| R-06 | Durable subscriber claims are mistaken for exactly-once external side effects. | State at-least-once semantics; require app idempotency or target-side fencing. | `firegrid-durable-subscriber-webhooks.DELIVERY_SEMANTICS.1`, `firegrid-platform-invariants.SECURITY.6` |
| R-07 | Runtime presence becomes command bus or credential directory. | Keep presence advisory and public-metadata-only. | `firegrid-runtime-presence.CONSISTENCY.1`, `firegrid-runtime-presence.INGRESS_SELECTION.3`, `firegrid-platform-invariants.SECURITY.3` |
| R-08 | Remote handoff duplicates provider side effects. | Lease/fence/rebuild proof before side effects; provider reattach classification. | `firegrid-runtime-ownership-transfer.TRANSFER_PRECONDITIONS.1`, `firegrid-runtime-ownership-transfer.DUPLICATE_SIDE_EFFECT_PREVENTION.1` |
| R-09 | Observability metadata leaks secrets or becomes auth. | Redact or reject secret-shaped values; trace metadata is context only. | `firegrid-observability.TRACE_METADATA.4`, `firegrid-observability.NON_AUTHORITY.1`, `firegrid-platform-invariants.SECURITY.4` |
| R-10 | Flamecast cleanup removes product behavior before replacement is proven. | Cleanup lanes quarantine/wrap first; delete only after product-shaped proof. | `flamecast-product-contract.NON_SCOPE.1`, `flamecast-product-contract.LOWERING.1` |
| R-11 | Litmus tests remain narrative and not executable. | Start with LT-02 as an app chassis, not another throwaway smoke script. | `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2`, `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1` |
| R-12 | Scheduling/prompt transport introduces agent vocabulary into Firegrid core. | Generic scheduling and claimed-intent specs; product adapters stay downstream. | `firegrid-scheduling-tool-bindings.NON_SCOPE.1`, `firegrid-claimed-intent-transport.NON_SCOPE.1` |

## Review Triggers

Escalate if:

- a Firegrid package adds product terms such as provider, AgentSpec, session,
  prompt, permission, capability, sandbox, WorkOS, OAuth, or callbackEvents as
  native Firegrid vocabulary;
- app/downstream code imports `@firegrid/substrate/kernel`;
- a smoke or chassis writes fake terminal rows or raw durable run rows;
- runtime examples bypass `Firegrid.composeRuntime`;
- a docs-only/spec-only PR edits source, manifests, generated reports, or
  unrelated handoff/research files;
- an execution agent starts building a throwaway smoke/demo where LT-02 calls
  for a real `apps/flamecast` chassis.

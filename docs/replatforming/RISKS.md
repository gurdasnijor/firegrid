# Risks

Status: draft

Risks should cite ACIDs once specs exist.

| ID | Risk | Mitigation |
| --- | --- | --- |
| R-01 | Firegrid absorbs Flamecast product semantics. | Start with `firegrid-platform-invariants`; review every lane against ownership boundary. |
| R-02 | Specs and prose drift. | Prose docs cite ACIDs; feature YAML remains source of truth. |
| R-03 | Replatform smoke accidentally uses local sibling paths or internal Firegrid APIs. | Packed package-consumption smoke with forbidden-token guard and package import checks. |
| R-04 | Runtime locality is missed and `@firegrid/runtime` is imported into Worker/browser code. | Package-boundary tests and explicit topology ACIDs. |
| R-05 | Projection/query leaks raw StreamDB or Durable Streams State authority. | Descriptor-scoped read facade with opaque cursor and typed errors. |
| R-06 | Durable subscriber claims are mistaken for exactly-once external side effects. | State at-least-once semantics; require app idempotency or target-side fencing. |
| R-07 | Runtime presence becomes command bus or credential directory. | Presence invariants: public metadata only, advisory, no private routing or secrets. |
| R-08 | Remote handoff duplicates provider side effects. | Lease/fence/rebuild proof before side effects; provider reattach classification. |
| R-09 | Observability metadata leaks secrets or becomes auth. | Redaction checks; trace metadata is context only. |
| R-10 | Flamecast cleanup removes product behavior before replacement is proven. | Cleanup lanes only quarantine/wrap until a Firegrid-backed smoke proves parity. |
| R-11 | Litmus tests remain narrative and not executable. | Add Acai-backed litmus scenario specs before smoke implementation. |
| R-12 | Scheduling/prompt transport introduces agent vocabulary into Firegrid core. | Generic scheduling and claimed-intent specs; product adapters stay downstream. |

## Review Triggers

Escalate if:

- a Firegrid package adds product terms such as provider, AgentSpec, session,
  prompt, permission, capability, sandbox, WorkOS, OAuth, or callbackEvents;
- app/downstream code imports `@firegrid/substrate/kernel`;
- a smoke writes fake terminal rows or raw durable run rows;
- runtime examples bypass `Firegrid.composeRuntime`;
- a docs-only/spec-only PR edits source, manifests, generated reports, or
  unrelated handoff/research files.

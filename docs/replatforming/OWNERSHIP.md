# Ownership Boundary

Status: draft

This document is the launch contract. Once Acai specs exist, rows should cite
ACIDs from `features/firegrid/*` and `features/flamecast/*`.

## Launch Contract

| Flamecast concept | Firegrid primitive | Owner boundary |
| --- | --- | --- |
| Session create | `Operation.define` input | Flamecast owns input shape; Firegrid owns durable operation lifecycle. |
| Session lifecycle | Operation state/result/error | Firegrid owns lifecycle mechanics; Flamecast owns product state interpretation. |
| Normalized events | `EventStream.define` | Flamecast owns event schema; Firegrid owns append/read/replay mechanics. |
| Provider callback event | EventPlane row or durable delivery row | Flamecast owns payload/auth; Firegrid owns durable append/projection/wait mechanics. |
| Capability request/result | EventPlane rows + RunWait | Flamecast owns capability taxonomy; Firegrid owns wait/wake mechanics. |
| Permission required/resolved | EventPlane rows + public Pending gate | Flamecast owns permission policy and UI. |
| Provider compatibility failure | Typed operation error | Flamecast owns compatibility rules; Firegrid carries typed failure. |
| Provider adapter execution | `Firegrid.composeRuntime` handler | Flamecast owns adapter and credentials; Firegrid owns runtime composition. |
| Resources/secrets | Opaque references and materialization rows | Flamecast owns secret storage/injection; Firegrid owns durable materialization mechanics. |
| Webhook/callback delivery | Durable subscriber channel | Flamecast owns signing/tokens/payload; Firegrid owns delivery/retry/dead-letter mechanics. |
| Runtime ingress | Runtime presence descriptor | Firegrid owns durable public presence record; Flamecast owns routing/auth. |
| Agent host shift | Ownership transfer + materialization + presence | Firegrid owns lease/fence/rebuild mechanics; Flamecast owns provider reattach profile. |
| Scheduling tools | Neutral scheduling bindings | Firegrid owns sleep/wait/schedule lowering; Flamecast owns agent tool adapter. |
| Prompt transport | Claimed intent transport | Firegrid owns generic intent/claim/terminal mechanics; Flamecast owns prompt semantics. |

## Concern Matrix

| Concern | Firegrid owns | Flamecast owns |
| --- | --- | --- |
| Persistence | Durable operations, app-owned rows, projection/query mechanics. | Org policy, route/API semantics, archival/delete policy. |
| Observability | Effect substrate spans, trace metadata carriers, terminal/error correlation. | Business spans, redaction, exporters, retention, vendor correlation. |
| Discovery | Durable identity/presence projections. | Agent registry, provider registry, org visibility, templates. |
| Session query | EventStream replay, projection query, retention-gap errors. | Transcript/event shape, pagination, product routes. |
| Web ergonomics | Browser-safe projection/event handles and typed errors. | React UI, WorkOS auth, route design. |
| Resources/secrets | Resource/materialization facts and opaque secret references. | Secret storage, provider env rules, sandbox layout. |
| Webhook ingest | Delivery channel mechanics, retries, dead letters, waits. | Callback auth, tokens, signing, payload schemas. |
| Runtime presence | Durable public presence and freshness. | DNS/TLS, registration policy, callback target selection. |
| Remote handoff | Replay, projection rebuild, lease/fence, materialization mechanics. | Provider reattach, sandbox deployment, UX behavior. |
| Scheduling | Neutral durable sleep/wait/schedule/awakeable lowering. | Tool names, provider conversion, policy gates. |
| Prompt transport | Generic claimed-intent mechanics. | Prompt schema, promptability, provider transport. |

## Invariant

If a concept names a product, provider, session, prompt, permission, capability,
tool, sandbox, credential, org, or UI, it starts on the Flamecast side unless a
Firegrid Acai spec explicitly proves a product-neutral primitive.

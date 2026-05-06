# Ownership Boundary

Status: build-facing draft

This document is the launch contract for Flamecast-on-Firegrid work. It maps
Flamecast concepts to Firegrid primitives without moving product semantics into
Firegrid packages.

## Launch Contract

| Flamecast concept | Firegrid primitive | Owner boundary | ACID anchors |
| --- | --- | --- | --- |
| Session create | `Operation.define` input | Flamecast owns input shape; Firegrid owns durable operation lifecycle. | `flamecast-product-contract.SESSIONS_API.1`, `flamecast-product-contract.LOWERING.1`, `firegrid-agent-runtime-substrate.LONG_LIVED_OPERATION.1` |
| Session lifecycle | Operation state/result/error | Firegrid owns lifecycle mechanics; Flamecast owns product state interpretation. | `flamecast-product-contract.SESSIONS_API.2`, `firegrid-agent-runtime-substrate.LONG_LIVED_OPERATION.2`, `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.5` |
| Normalized events | `EventStream.define` | Flamecast owns event schema; Firegrid owns append/read/replay mechanics. | `flamecast-product-contract.EVENTS.1`, `flamecast-product-contract.LOWERING.3`, `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2` |
| Provider callback event | EventPlane row or durable delivery row | Flamecast owns payload/auth; Firegrid owns durable append/projection/wait mechanics. | `flamecast-product-contract.CALLBACKS.1`, `firegrid-durable-subscriber-webhooks.CHANNEL_DESCRIPTOR.1`, `firegrid-durable-subscriber-webhooks.DELIVERY_PRODUCER.1` |
| Capability request/result | EventPlane rows + `RunWait` | Flamecast owns capability taxonomy; Firegrid owns wait/wake mechanics. | `flamecast-product-contract.AGENTSPEC.3`, `flamecast-product-contract.LOWERING.4`, `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.2` |
| Permission required/resolved | EventPlane rows + public Pending gate | Flamecast owns permission policy and UI. | `flamecast-product-contract.EVENTS.4`, `firegrid-agent-runtime-substrate.APP_OWNED_CONTROL_ROWS.1`, `firegrid-platform-invariants.AUTHORITY.5` |
| Provider compatibility failure | Typed operation error | Flamecast owns compatibility rules; Firegrid carries typed failure. | `flamecast-product-contract.AGENTSPEC.4`, `flamecast-product-contract.LOWERING.6`, `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.5` |
| Provider adapter execution | `Firegrid.composeRuntime` handler | Flamecast owns adapter and credentials; Firegrid owns runtime composition. | `flamecast-product-contract.PROVIDER_API.1`, `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2`, `firegrid-platform-invariants.AUTHORITY.4` |
| Resources/secrets | Opaque references and materialization rows | Flamecast owns secret storage/injection; Firegrid owns durable materialization mechanics. | `flamecast-product-contract.IDENTITY_AUTH.3`, `firegrid-execution-plane-resources.RESOURCE_IDENTITY.1`, `firegrid-execution-plane-resources.SECRET_REFERENCES.1` |
| Webhook/callback delivery | Durable subscriber channel | Flamecast owns signing/tokens/payload; Firegrid owns delivery/retry/dead-letter mechanics. | `flamecast-product-contract.CALLBACKS.2`, `firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.5`, `firegrid-durable-subscriber-webhooks.DELIVERY_SEMANTICS.1` |
| Runtime ingress | Runtime presence descriptor | Firegrid owns durable public presence record; Flamecast owns routing/auth. | `firegrid-runtime-presence.DESCRIPTOR.1`, `firegrid-runtime-presence.INGRESS_SELECTION.1`, `firegrid-platform-invariants.SECURITY.2` |
| Agent host shift | Ownership transfer + materialization + presence | Firegrid owns lease/fence/rebuild mechanics; Flamecast owns provider reattach profile. | `firegrid-runtime-ownership-transfer.LEASE_FENCE_EPOCH.1`, `firegrid-runtime-ownership-transfer.TRANSFER_PRECONDITIONS.1`, `firegrid-runtime-ownership-transfer.REATTACH_PROFILES.1` |
| Scheduling tools | Neutral scheduling bindings | Firegrid owns sleep/wait/schedule lowering; Flamecast owns agent tool adapter. | `firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1`, `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1`, `firegrid-scheduling-tool-bindings.NON_SCOPE.1` |
| Prompt transport | Claimed intent transport | Firegrid owns generic intent/claim/terminal mechanics; Flamecast owns prompt semantics. | `firegrid-claimed-intent-transport.INTENT_DESCRIPTOR.1`, `firegrid-claimed-intent-transport.CLAIM_BEFORE_DISPATCH.1`, `firegrid-claimed-intent-transport.NON_SCOPE.1` |

## Concern Matrix

| Concern | Current Flamecast state | Firegrid owns | Flamecast owns |
| --- | --- | --- | --- |
| Persistence | Postgres agents/sessions, R2 resources, ClickHouse events, Durable Object session state. | Durable operations, app-owned rows, projection/query mechanics. | Org policy, route/API semantics, archival/delete policy. |
| Observability | Product-local OpenTelemetry helpers in `src/observability/trace.ts`. | Effect substrate spans, trace metadata carriers, terminal/error correlation. | Business spans, redaction, exporters, retention, vendor correlation. |
| Discovery | Agent bundles and metadata in product stores. | Durable identity/presence projections. | Agent registry, provider registry, org visibility, templates. |
| Session query | WebSocket replay, ClickHouse, snapshot JSONL transcript extraction. | EventStream replay, projection query, retention-gap errors. | Transcript/event shape, pagination, product routes. |
| Web ergonomics | REST polling and raw live-event URL/cursor merge logic. | Browser-safe projection/event handles and typed errors. | React UI, WorkOS auth, route design. |
| Resources/secrets | R2 sidecars for skills, MCP config, credentials, env vars, workspace files. | Resource/materialization facts and opaque secret references. | Secret storage, provider env rules, sandbox layout. |
| Webhook ingest | Ad hoc REST callback/provider-event ingest. | Delivery channel mechanics, retries, dead letters, waits. | Callback auth, tokens, signing, payload schemas. |
| Runtime presence | Host/runtime details implicit in product infra. | Durable public presence and freshness. | DNS/TLS, registration policy, callback target selection. |
| Remote handoff | Local-to-remote story is product/provider-specific. | Replay, projection rebuild, lease/fence, materialization mechanics. | Provider reattach, sandbox deployment, UX behavior. |
| Scheduling | Firegrid has waits/scheduling primitives; Flamecast owns provider tools. | Neutral durable sleep/wait/schedule/awakeable lowering. | Tool names, provider conversion, policy gates. |
| Prompt transport | Product prompt APIs and Fireline prior-art intent rows. | Generic claimed-intent mechanics. | Prompt schema, promptability, provider transport. |

## Invariant

If a concept names a product, provider, session, prompt, permission, capability,
tool, sandbox, credential, org, or UI, it starts on the Flamecast side unless a
Firegrid Acai spec explicitly proves a product-neutral primitive.

Primary enforcement anchors:

- `firegrid-platform-invariants.BOUNDARY.1`
- `firegrid-platform-invariants.BOUNDARY.2`
- `firegrid-platform-invariants.TERMINOLOGY.1`
- `flamecast-product-contract.INVARIANTS.1`

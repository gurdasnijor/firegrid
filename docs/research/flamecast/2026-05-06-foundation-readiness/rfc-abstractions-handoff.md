# RFC Abstractions Handoff

Source: CA3 `FC-RFC-ABSTRACTIONS-HANDOFF` read-only report.

## Purpose

This report extracts abstractions from the stream-first agent substrate RFC that
are useful to Flamecast, while keeping them out of Firegrid core unless they are
product-neutral substrate mechanics.

## Flamecast-Owned Abstractions

- `AgentSpec` v1: provider, model, instructions, capabilities, contributors,
  provider options, provider auth, and metadata.
- Provider registry and Provider API: manifests, checks, provider auth/options
  validation, provider-specific adapters.
- Capability, resource, and sandbox model: `CapabilitySpec`,
  `ContributorSpec`, provider capability metadata, compatibility errors,
  resource references, and sandbox contributor policy.
- Session/prompt adapter model: provider adapters for `think`, cloud Claude,
  Claude Code, Anthropic Managed Agents, Cursor, Devin, and similar systems.
- Conductor, middleware, and topology: serializable specs, deterministic chain
  ordering, approval gates, capability mutation, and tool attachment.
- Normalized Event v1: versioned event schema and provider-normalization rules.
- Approvals and permissions: Flamecast permission schemas, authorization,
  callback/UI policy, denial mapping, and timeout/cancel semantics.
- Timers, idempotency, restart, and conformance profiles over neutral substrate
  mechanics.

## Firegrid Ergonomic Opportunities

These must remain product-neutral:

- Typed external event ingestion helper for app-owned EventPlane/EventStream
  writes with idempotency, sequence, producer identity, and conflict result.
- Public cancellation/interrupt decision, or documentation that products model
  cancellation as app-owned EventPlane control rows.
- Public waiting/blocked-state decision, or documentation that products expose
  permission state through app-owned EventPlane projections.
- Idempotent append/terminal helper for first-valid-terminal-wins patterns.
- Restart/recovery helper or checklist for replay-to-live-boundary and pending
  waits.
- EventStream replay/materializer examples or helpers.

## Anti-Abstractions

Do not move these into Firegrid:

- Flamecast provider, capability, auth, SDK, webhook, sandbox, billing, UI, or
  adapter lifecycle semantics.
- Fireline/Firepixel/Flamecast row families as Firegrid-native rows.
- Standard Webhooks signing or outbound HTTP fanout.
- Provider lifecycle management, sandbox provisioning, credential resolution, or
  transport policy.
- Direct durable row authorship, kernel imports, dynamic runtime module loading,
  or dev-launcher patterns.

## Recommended Handoff Lanes

Flamecast:

1. `AgentSpec + Provider Manifest/Check`
2. `Event/Callback v1`
3. `Provider Adapter/Restart Profile`

Firegrid:

1. Product-neutral external-event/wait smoke or helper docs.
2. Product-neutral cancellation/wait-state API decision.


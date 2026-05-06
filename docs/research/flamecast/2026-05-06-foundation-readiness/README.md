# Flamecast Foundation Readiness Research

Date: 2026-05-06

This packet is the durable repo-local landing zone for the Flamecast-on-Firegrid
foundation readiness research. It preserves the cmux reports that were
previously only available in agent scrollback or temporary scratch paths.

## Boundary

Firegrid should remain the durable operation, event-stream, event-plane, and
wait substrate. Flamecast owns product semantics: AgentSpec, providers,
capabilities, contributors, providerAuth/providerOptions, adapter lifecycle,
sandboxing, SDK ergonomics, webhooks, benchmarks, UI, and provider/runtime
product behavior.

## Reports

- [API and Events Readiness](./api-events-readiness.md)
- [SDK and Capabilities Readiness](./sdk-capabilities-readiness.md)
- [Independent Gaps Verdict](./independent-gaps-verdict.md)
- [RFC Abstractions Handoff](./rfc-abstractions-handoff.md)
- [Future PR Guardrail Checklist](./future-pr-guardrail-checklist.md)

## Suggested Next Lanes

1. Firegrid spec lane: `NW-FC-FOUNDATION-SDD`
   - Ratify product-neutral long-lived session-style operation mechanics.
   - Cover multi-turn `RunWait` cycles, reconnect/replay posture, cancellation
     as app-owned control rows, and runtime locality.

2. Flamecast spec lane: `AgentSpec + Provider Manifest/Check`
   - Define Flamecast-owned `AgentSpec`, `CapabilitySpec`,
     `ContributorSpec`, `ProviderManifest`, `ProviderAuth`,
     `providerOptions`, `CompatibilityError`, and `/providers` contracts.

3. Cross-repo smoke lane, after specs land
   - Use packed Firegrid artifacts and public package surfaces only.
   - Prove a minimal Flamecast-shaped session operation, normalized event
     stream, external callback/decision row, `RunWait` wake, and typed
     terminalization.


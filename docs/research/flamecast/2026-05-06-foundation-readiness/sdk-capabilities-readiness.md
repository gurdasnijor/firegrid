# SDK and Capabilities Readiness

Source: CA1 `FC-FOUNDATION-READINESS/SDK-CAPABILITIES` read-only reports.

## Verdict

Firegrid can be the durable operation/event/wait substrate underneath Flamecast
sessions, but not the Flamecast product API itself. Flamecast should own
`AgentSpec`, provider registry, capability resolution, provider auth/options,
sandbox/provider lifecycle, benchmarks, public SDK ergonomics, and product
semantics.

## Readiness Matrix

### AgentSpec

Partial. Current Flamecast input is split across `agent`, `model`, `machine`,
and `agentSpec { systemPrompt, skills, mcps }`. The PRD wants:

- `provider`
- `model`
- `instructions`
- `capabilities`
- `contributors`
- `providerOptions`
- `providerAuth`
- `metadata`

Firegrid can carry this as a Flamecast-owned operation input schema, but
Flamecast owns semantics, defaults, versioning, persistence, redaction, and
compatibility-check timing.

### Capabilities

Partial internally, missing publicly. Runtime abilities exist implicitly in
`think` and `claude-code` variants, but there is no public `CapabilitySpec`,
resolution result, or provider manifest metadata. Firegrid can host waits and
events for capability fulfillment; Flamecast owns capability taxonomy and
resolution.

### Provider Auth and Options

Partial. Flamecast has WorkOS/API-key auth, environment injection, GitHub and
Smithery sidecars, and provider-specific runtime internals. Firegrid should not
own secrets. Firegrid handlers can receive scoped layers or opaque credential
references from Flamecast runtime composition.

### Provider Swapping and Compatibility

Missing as PRD-grade API. Current compatibility is runtime/layout-oriented and
ad hoc. Firegrid can surface typed operation errors, but Flamecast must decide
whether a provider supports requested model, instructions, capability, or
contributor behavior.

### SDK Shape

Missing as a package. The current repository is private and does not expose an
`@flamecast/sdk` package. Once Flamecast defines descriptors and package policy,
an SDK can wrap Firegrid client behavior, but SDK naming and ergonomics remain
Flamecast-owned.

## Current Firegrid Support

- `Operation` and `EventStream` descriptors for Flamecast-owned commands and
  events.
- `@firegrid/client` `send`, `observe`, `result`, and `events`.
- `@firegrid/runtime` `Firegrid.handler`, `Firegrid.eventStream`,
  `Firegrid.composeRuntime`, and `run`.
- `@firegrid/substrate` `RunWait`, `projectionMatch`, and
  `triggerMatchersLayer`.
- `@firegrid/substrate/event-plane` for Flamecast-owned provider, capability,
  permission, and tool-result state.

## Smallest Next Lanes

1. `AgentSpec + CapabilitySpec + ProviderManifest + CompatibilityError`.
2. Provider check/preflight endpoint before Firegrid operation execution.
3. ProviderAuth/providerOptions redaction, storage, and runtime injection.
4. Firegrid-backed SDK smoke design using packed public Firegrid artifacts.
5. Durable capability wait lane using Flamecast EventPlane rows, `RunWait`,
   `projectionMatch`, and public `Pending` observation.


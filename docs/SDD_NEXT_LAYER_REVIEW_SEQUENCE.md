# Next Layer SDD Review Sequence

Status: proposal
Created: 2026-05-04
Owner: Durable Agent Substrate

This proposal breaks the remaining durable-agent-substrate work into reviewable
concerns. The goal is to service Fireline/Firepixel runtime needs without
turning the substrate into a Fireline-specific runtime, ACP adapter, workflow
SDK, or generic messaging framework.

## Review Order

1. Client event planes and state producers
   - SDD: `docs/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md`
   - Spec: `features/durable-agent-substrate/client-event-plane-registration.feature.yaml`
   - Why first: ACP, Claude Code, Codex, tool execution, and Fireline domain
     rows all need a supported way to define events, materializers, and typed
     producers without making those events substrate-native.

2. Effect pipeline facade
   - SDD: `docs/SDD_EFFECT_PIPELINE_FACADE.md`
   - Spec: `features/durable-agent-substrate/effect-pipeline-facade.feature.yaml`
   - Why second: Fireline/Firepixel should use projection observation and
     claim-before-side-effect pipelines instead of manually composing
     `processReadyWorkItem`, retained folds, run builders, and completion rows.

3. Choreography and agent tool bindings
   - SDD: `docs/SDD_CHOREOGRAPHY_TOOL_BINDINGS.md`
   - Spec: `features/durable-agent-substrate/choreography-tool-bindings.feature.yaml`
   - Why third: Fireline-style operations such as `sleep`, `waitFor`,
     `scheduleMe`, `execute`, `spawn`, and `spawnAll` must be available through
     runtime APIs and agent tool bindings while remaining above the substrate
     kernel.

4. Launchable substrate host and lab
   - SDD: `docs/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md`
   - Spec: `features/durable-agent-substrate/launchable-substrate-host.feature.yaml`
   - Why fourth: passing tests are not enough to validate Fireline/Firepixel-
     shaped runtime behavior. We need a narrow substrate client, a launchable
     observer/operator host, and a lab inspector that exercises real durable
     streams/state without introducing a host mutation control plane.

## Non-Goals For This PR

- No implementation changes.
- No ACP/MCP/Claude/Codex adapter code.
- No Fireline or Firepixel package import.
- No final naming freeze.
- No broad `DurableChannel`, `CompletionChannel`, framework registry, or raw
  append facade.

## Communication Model

Each SDD should be reviewable independently in GitHub. Approval means the
corresponding Acai spec can drive a future implementation slice. Rejection or
comments should be folded into the SDD/spec before any implementation begins.

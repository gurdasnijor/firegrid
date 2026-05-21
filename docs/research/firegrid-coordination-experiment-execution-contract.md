# Firegrid Coordination Experiment Execution Contract

Date: 2026-05-21
Status: internal V0 contract

This is the Firegrid-specific companion to
`docs/research/agent-orchestration-vs-choreography-experiment.md`. The public
experiment doc states the general research design. This document states the
system contract for the first Firegrid implementation.

## Scope

The V0 run covers only the A/B/C arms:

- A: one frontier-model participant owns the whole task.
- B: a developer-authored fixed graph and handoff path.
- C: choreographed peers observing and publishing shared claims/artifacts.

Independent attempts and other topology variants are deferred until A/B/C have
produced a clean trace-backed result.

## Runtime Contract

Live experiment runs must use real frontier-model participants. The current
showcase path uses the public client/session surface with an ACP-compatible
frontier runtime and the locked runtime-context MCP primitive profile.

The driver may:

- create or load sessions through `Firegrid.sessions.createOrLoad`;
- send task/role prompts through `session.prompt`;
- start sessions through `session.start`;
- wait for lifecycle completion through `session.wait.forAgentOutput`;
- annotate high-level run/arm/participant lifecycle spans.

The driver must not:

- reach into host-sdk, runtime, kernel, channel bindings, or durable table
  internals;
- partition choreographed work after launch;
- compute a canonical `GREEN`/`RED` verdict while the run is executing;
- score arms through driver-side `scoreArm` logic;
- scrape participant text or tool-use output into a parallel evidence model.

## Channel And Tool Contract

Participant-visible coordination must flow through public channel/tool
contracts. The experiment may define typed channels for claims, artifacts,
reports, score metadata, task events, and neutral callable checks, but
participant code must access them through public agent tools such as
`wait_for`, `wait_for_any`, `send`, and `call`.

Prompts should name the task, available tools, role constraints, and success
criteria. They should not include exact JSON payload examples whose echo could
be mistaken for successful evidence. Participants should use the runtime tool
catalog and choose task-specific ids, titles, summaries, and body text.

Router-backed channel ergonomics are part of the product surface, not a
simulation shortcut. If a run needs easier routing, filtering, or channel
discovery than the current public surface provides, capture that as a product
blocker instead of adding a simulation-only helper.

## Evidence Contract

The native tiny-firegrid artifacts are the evidence system:

- `trace.jsonl` spans and span attributes;
- `simulate:show` hierarchical run summaries;
- `simulate:perf` timing and hot-polling checks;
- durable channel rows and call rows for claims, artifacts, reports, and tools.

The post-run analysis document interprets those artifacts after the run. It may
quote or summarize trace rows and durable rows, but it should not depend on an
in-driver transcript scraper or bespoke tool-count harness.

## Fixture Contract

Deterministic or fixture agents are allowed only for CI and regression smoke.
They validate public session launch and channel-tool plumbing. They are not the
experiment artifact and must not be reported as evidence that frontier agents
made meaningful coordination choices.

## Known Dependencies And Blockers

The canonical experiment should depend on product-grade public surfaces rather
than local harness workarounds. Current live dependencies:

- `tf-9x11`: host-plane router support for public channel/tool routing.
- `tf-1r3h`: sync/async closure semantics for participant lifecycle and waits.
- `tf-2osu`: public experiment ergonomics needed to keep harnesses thin.

If any of these gaps prevent a clean A/B/C live run, the result should be
reported as blocked or inconclusive with a replacement plan, not papered over
with another bespoke evidence harness.

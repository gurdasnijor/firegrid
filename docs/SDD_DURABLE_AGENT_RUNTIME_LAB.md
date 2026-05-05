# Durable Agent Runtime Lab SDD

Status: proposal
Created: 2026-05-04
Owner: Durable Agent Runtime Lab

## Purpose

The durable substrate foundation is now large enough that the next risk is not
another substrate primitive. The next risk is whether real agent runtimes can
bring their own event vocabulary, materializers, adapters, and UI needs without
forcing those concepts into substrate-native row families.

This SDD defines a separate validation surface:

```text
durable-agent-runtime-lab
  validates agent-runtime integration on top of durable-agent-substrate
```

The runtime lab is not a new substrate layer. It is a consumer and validation
environment for the substrate. It may define ACP-shaped or Fireline-shaped
event planes, example host graphs, lab panels, and stress harnesses. Those
artifacts prove the substrate contract without changing substrate authority.

## Lab Versus Integration Tests

The runtime-lab product has two related but distinct execution surfaces:

- integration tests are CI validation harnesses. They run ordinary Effect
  programs, Host Program Graphs, ACP fixtures, and materializers to assert
  invariants such as restart safety, duplicate handling, and waitFor
  resolution;
- the lab is a human-facing browser workbench. It renders substrate state and
  runtime-owned event-plane state so developers can inspect what happened.

They may share fixtures and ordinary Effect programs, but they are not the same
deliverable. A validation can land first as an integration test when the browser
UI is not ready. A lab panel can later reuse the same event plane, materializer,
or program to make the state visible. Neither path should create a separate
scenario runtime abstraction.

## Product Boundary

`durable-agent-substrate` owns foundation invariants:

- durable run, completion, claim, and trace row families;
- completion and claim authority;
- ready-work derivation;
- choreography primitives;
- client, host, and Host Program Graph package boundaries;
- no host mutation control plane.

`durable-agent-runtime-lab` owns consumer/runtime validation:

- ACP event-plane fixtures and materializers;
- Fireline/Firepixel adapter fit checks;
- lab inspection flows;
- example Effect programs;
- restart, concurrency, and stress scenarios that exercise runtime integration.

Runtime-lab specs may live in this repository while the implementation is still
co-developed with the substrate. They should not expand substrate-owned row
families. If a runtime-lab slice needs a substrate primitive, it should first
state the gap and then add a substrate spec in the substrate product.

## Initial Features

### ACP Event-Plane Runtime Validation

ACP is the first runtime-owned event stream validation target because it has a
well-defined agent/client vocabulary and an existing TypeScript example agent.
The validation should prove:

```text
ACP agent/client events
  -> runtime-owned event plane
  -> runtime-owned materializer
  -> HostProgramGraph projection-match evaluator
  -> substrate projection_match completion
  -> blocked durable work becomes ready
```

The ACP fixture may be derived from the Agent Client Protocol TypeScript SDK
example agent. It should generate session setup, prompt, `sessionUpdate`,
`tool_call`, and `tool_call_update` events. The schemas and materializer remain
owned by the runtime-lab fixture.

### Runtime Lab Inspector

The lab should inspect both substrate-owned state and runtime-owned event-plane
state:

- substrate runs, completions, ready work, and claim attempts;
- raw Durable Streams events and registry entries;
- runtime-owned ACP rows and materialized ACP state;
- replay plus live-follow paths.

Writes remain client-mediated. Browser lab code must not import the host or
substrate foundation as a privileged writer.

The inspector is not the integration-test harness. Its job is legibility:
show raw durable records, materialized runtime state, and substrate projections
side by side. The integration tests own pass/fail assertions; the browser lab
helps humans debug and stress those flows.

### Fireline / Firepixel Adapter Fit

Fireline and Firepixel are higher-level consumers. This product should validate
how their concepts map onto the substrate:

- session launch and prompt intents;
- prompt updates and terminal prompt results;
- required actions and permission decisions;
- tool-call lifecycle;
- provider and session kernels as Host Program Graph adapter layers.

The target is an adapter fit report and small executable examples, not a move
of Fireline/Firepixel vocabulary into substrate-owned rows.

### Runtime Stress And Restart

The runtime-lab should stress the integration contract:

- concurrent hosts on the same stream;
- restart from durable state only;
- duplicate ACP events and duplicate completions;
- projection rebuild versus live-follow consistency;
- retry/idempotency behavior in runtime-owned active subscribers.

These checks should validate durable authority through substrate projections and
runtime-owned materializers, not through host-local caches.

## Non-Goals

- No ACP, Fireline, Firepixel, session, prompt, provider, sandbox, or tool-call
  row families become substrate-native.
- No host mutation endpoint is introduced for runtime-lab scenarios.
- No browser lab privileged writer surface.
- No production auth, metrics, or hosted deployment story.
- No global runtime registry. Example maps stay local and explicit.

## Relationship To Acai Products

Use `durable-agent-substrate` ACIDs for substrate-owned behavior and invariants.
Use `durable-agent-runtime-lab` ACIDs for runtime validation behavior. When a
runtime-lab feature discovers a missing substrate primitive, add or amend the
substrate product spec before changing substrate code.

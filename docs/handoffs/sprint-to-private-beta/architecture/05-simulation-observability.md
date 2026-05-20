# Simulation And Observability

## Data-Plane Tour Simulation

Candidate handoff sim:

`packages/tiny-firegrid/src/simulations/acp-sdk-example-agent/`

Purpose: exercise the installed `@agentclientprotocol/sdk` example agent through
the public Firegrid client/session projection, not through host-sdk internals.

Current public surface covered by the driver:

- `firegrid.launch(...)`
- `firegrid.prompt(...)`
- `firegrid.open(...).snapshot`
- `firegrid.watchContexts(...)`
- `firegrid.sessions.createOrLoad(...)`
- `firegrid.sessions.attach(...)`
- `firegrid.sessions.prompt(...)`
- `firegrid.permissions.respond(...)`
- `local.jsonl({ agentProtocol: "acp", argv: ["node", agentPath] })`
- `session.whenReady`
- `session.permissions.autoApprove("allow")`
- `session.prompt(...)`
- `session.start()`
- `session.snapshot()`
- `session.wait.forAgentOutput(...)`
- `session.wait.forPermissionRequest(...)`

Latest clean run:

`2026-05-20T22-03-21-597Z__acp-sdk-example-agent`

Trace:

`packages/tiny-firegrid/.simulate/runs/2026-05-20T22-03-21-597Z__acp-sdk-example-agent/trace.jsonl`

Perf read:

- 1158 spans over 5345ms;
- no idle gaps above threshold;
- top wall time is expected ACP example prompt behavior;
- long `firegrid.durable_table.rows` spans are open stream waits over
  `firegrid.runtimeOutput.events`, not active storage/CPU work;
- HTTP rolls are tens of milliseconds total.

Conclusion: the sim is useful as a broad data-plane tour and public-surface
ergonomics probe. It should not be used as a strict perf benchmark until perf
tooling separates active work from stream-wait wall time.

## Ergonomics Findings From The Sim

Do not hide SDK gaps with simulation-only helpers.

Observed gaps:

- examples currently need manual repeated `session.wait.forAgentOutput()` calls
  and tag narrowing; a public typed/predicate output wait helper may be worth
  adding;
- `session.permissions.autoApprove("allow")` should be started after
  `session.whenReady` or hardened so early startup cannot silently kill the
  scoped auto-approval fiber;
- top-level and scoped session surfaces should stay projections of the same
  protocol operation catalog.

## Runner Correctness Finding

One intermediate failed run produced a driver span with error status while
`simulate:run` still exited zero with `outcome=DriverCompleted`.

Before tiny-firegrid runs become private-beta gates:

- driver span errors must fail the simulation command;
- failed driver exits must fail the simulation command;
- `simulate:show` / `simulate:perf` should make failed-driver status visible in
  the summary.

## Observability Contract

Span names consumed by docs, tests, dashboards, or perf gates are public enough
to need a baseline contract.

Minimum next step:

- create a private-beta span registry for stable external span names;
- classify internal span names separately;
- define stable attribute keys;
- update sims to assert only stable names unless they are explicitly testing an
  internal implementation.

Known cleanup:

- `durableTools` still appears as an HTTP stream namespace label in the ACP sim
  trace. Grep and decide whether this is only historical naming or a real
  substrate leak. Rename or document before publishing trace artifacts.

## Methodology Rewrite

`packages/tiny-firegrid/docs/methodology.md` should say:

- drivers should use public client-sdk/session APIs when validating public
  behavior;
- host files may compose host Layers and test adapters;
- host-only stop conditions are harness-private instrumentation and should not
  be imported from host-sdk public barrels;
- semantic event/fact assertions should prefer channels;
- runtime-internal package tests may use runtime observation tags directly.

It should not instruct new simulations to use `hostProjectionObserver` from
`@firegrid/host-sdk`.


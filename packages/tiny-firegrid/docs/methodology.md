# tiny-firegrid methodology

Tiny-firegrid is a discovery tool. Its deliverables are **findings** — prose
files in `docs/findings/tf-*.md` (and beads with the `tfind:NNN` join key) that
name a specific public-surface gap, divergence, or behavior of the production
Firegrid system. Simulations exist to produce evidence (traces) for findings;
the runner exists to produce simulations.

This document describes the discipline the package follows so that when you
write a sim, read a trace, or file a finding, you know which job you're doing.

## Three jobs, three boundaries

1. **The simulation** drives the public Firegrid client/host seam through some
   scenario and instruments what it observes. **It does not draw conclusions.**
   A sim that returns `{ claimStatus: "passed", findings: [...] }` is the wrong
   shape — it pre-commits to its own verdict and hides where the human judgment
   lives. A sim that returns `void` (or an opaque value the next caller needs)
   and emits a well-named tree of spans is the right shape.

2. **The trace** is the durable artifact and the source of truth. One
   `trace.jsonl` per run, one JSON object per span, including resource
   attributes that identify the run (`firegrid.simulation.id`,
   `firegrid.run.id`, `firegrid.namespace`, `firegrid.durable_streams.base_url`)
   and span attributes that describe what happened. Nothing else in the
   `runs/<runId>/` directory is "the answer"; that file is.

3. **The finding** is prose with citations. It names the public surface that
   was probed, points at the trace evidence (`runs/<runId>/trace.jsonl`, line
   N, span name X), states what the production code does today vs. what the
   author expected, and classifies the gap. Findings live in
   `docs/findings/tf-<short>.md` and are tracked via beads with `tfind:NNN`.

## What counts as a simulation

- A folder under `src/simulations/<id>/` with `index.ts`, `driver.ts`, `host.ts`
  (split is preferred for navigability; flatter shapes are fine for very small
  sims).
- A default export that satisfies `TinyFiregridSimulation<A>`: an `id` (must
  match the folder), `description`, `host(env): Layer<FiregridHost>`, and
  `driver: Effect<A, _, Firegrid>`.
- The driver imports **only** from `@firegrid/client-sdk` (and Effect). It
  should use public session APIs such as `sessions.createOrLoad`,
  `session.wait.forAgentOutput`, `session.wait.forPermissionRequest`,
  `session.permissions.respond`, and `session.permissions.autoApprove` when it
  is validating public behavior. It must not import host-sdk, runtime,
  protocol internals, or codec/sandbox primitives. If the scenario needs those,
  it's exercising a private seam, not the public client surface — write the
  test in the owning package's `test/` folder instead.
- The host file may import `@firegrid/host-sdk` to compose a host layer
  (`FiregridLocalHostLive`, `FiregridMcpServerLayer`, etc.) and package-owned
  test adapters, but only as host composition. Host-only stop conditions are
  harness-private instrumentation, not API examples, and should not be imported
  from host-sdk public barrels.

## The workbench pattern

When a *production* tier doesn't exist yet (or was deleted) but you need to
prove its dynamics and design its contract, build a **workbench sim**. The same
artifact then pays off three ways: it proves the dynamics, it *is* the design
bench for the production tier, and it becomes a standing regression sim. The
loop:

1. **Design the contract as an Effect `Context.Tag`.** The Tag interface is the
   misuse-resistant contract the production tier will implement — get it right
   here, where it's cheap. (Prefer composing Effect-native building blocks over
   re-rolling infra — e.g. surface MCP via `@effect/ai`'s `McpServer`, not a
   hand-rolled JSON-RPC server.)
2. **Stub the impl in `host(env)` as a `Layer.succeed` / scoped layer.** The
   stub is real enough to exercise the dynamics (it stands up the actual
   endpoint/effect), but lives only in the sim's host composition.
3. **Drive it through the public client surface in `driver.ts`** —
   `@firegrid/client-sdk` only. The driver proves an agent/consumer reaches the
   capability through the *public* seam, not by poking the stub directly.
4. **Verify dynamics + invariants from the trace** (`simulate show` / `simulate
   perf` over `trace.jsonl`) and write a **prose finding** (`docs/findings/
   tf-*.md`). Do not compute a verdict object in-script (see "Three jobs").

Worked example: the **MCP-host discovery sim** (`tf-r06u.23`, converting the
retired `mcp-reach` spike). It designs an `McpHost` `Context.Tag` (the contract
the production host-owned MCP-surfacing tier, `tf-r06u.28`, implements), stubs
it in `host(env)` (standing up an `@effect/ai` `McpServer` over HTTP serving the
choreography toolkit), and the `client-sdk` driver prompts a session so a
downstream ACP agent *discovers and calls* a Firegrid-surfaced tool — verified
from the wire/trace, written up as a prose finding. Live-adapter runs are
env-gated (the `FIREGRID_UKV_RUN_ACP_LIVE` precedent).

## Static airgap enforcement (misuse-resistance)

The driver/host airgap above is not honor-system — it is enforced in CI, and
re-introducing a violation turns the build **red**:

- **Layout allowlist** (`scripts/tiny-firegrid-layout-check.mjs`): `src/` holds
  only `{simulations/, runner/, experiment*, bin/, index.ts, types.ts}`. A spike
  dropped under a new top-level dir (the retired `prototypes/`) fails the gate.
- **Sim airgap** (dep-cruiser, whole sim, `host.ts` carved out): no non-`host.ts`
  sim file may import `@firegrid/{runtime,host-sdk}/src`, protocol internals, or
  `effect-durable-operators`.
- **Host factory lock** (eslint, `host.ts`): the host may reach substrate, but
  must import and call the real `FiregridHost` factory from
  `@firegrid/runtime/unified`, and must not import `@firegrid/client-sdk`.
  This keeps driver/client behavior and host/substrate composition separated.
- **Test airgap** (dep-cruiser, `test/`): tests are public-surface
  (`@firegrid/client-sdk` allowed); a test reaching runtime/host-sdk/protocol
  internals belongs in the owning package's `test/`.
- **No standalone-script shape** (eslint, `src/`): no `Effect.runPromise*` /
  `runSync*` self-running; no `process.exit` inside a sim. A sim is run *by* the
  runner, not as a script.

Existing pre-airgap violators are grandfathered through explicit,
**bead-owned** excludes (never anonymous) that shrink over time — same
discipline as the Semgrep baseline ledger. New code gets no exemption.

`host.ts` is still the simulation trust boundary: eslint can prove that the
real host factory is present and called, but it cannot prove every Layer
composed around that call is semantically honest. Reviewers must still inspect
host composition for inline fake adapters, stub channel bindings, no-op Layers,
or other overrides that would replace production Tags before the real factory
path executes.

## Stopping a simulation

Stop is an external signal, not an in-driver predicate. The runner creates a
`stopSignal` effect for each run and passes it to `host(env)`. Drivers stay on
the public client surface and keep polling until the runner timeout, SIGINT, or
some host-scoped fiber completes that signal.

When a simulation needs to stop early after demonstrated success, prefer the
public client surface first. If the condition is visible to users, make the
driver wait through `session.wait.*` and return after it observes the marker;
the runner treats driver completion as a valid simulation outcome. If the
condition is a semantic application event or fact, prefer channel bindings and
wait on the channel rather than scraping runtime-output rows.

Use host-scoped observers only for conditions that are genuinely harness-private
and not user-visible. Keep those observers local to the sim or to the owning
package test, compose them from ordinary Effect `Stream` operations or
runtime-owned observation tags, and complete `env.stopSignal` from that local
fiber. Runtime-internal package tests may use runtime observation tags directly;
tiny-firegrid sims that demonstrate public behavior should not turn those tags
into public host-sdk examples.

## Triage rubric

When you read a trace and something doesn't match expectation, classify the
gap before filing. The category drives where the finding goes and who acts on
it.

| Category | Meaning | Where it goes |
|---|---|---|
| **1. Spec gap** | Public surface contract is undefined or wrong | Finding + bead, owning-package issue |
| **2. Implementation gap** | Spec is clear, implementation diverges | Finding + bead, owning-package issue |
| **3. Sim authoring gap** | The simulation is reaching past the public surface or asserting against the wrong dimension | Fix the sim, no production work |
| **4. Tooling gap** | The runner / viewer / OTel instrumentation isn't surfacing what you need | File against tiny-firegrid itself |
| **5. Methodology gap** | This document or the contributing notes don't tell you what to do | Update this document |

Bias toward category 3 on first inspection. The default failure mode is "my
sim's expectations are wrong," not "Firegrid is wrong." Categories 1 and 2 need
direct-source verification — read the production code the sim is probing
before concluding the production code is the problem. Inference + assertion is
not verified ground-truth.

## Trace discipline

- **Span names are templates.** No IDs, base64 fragments, or attempt counters
  in the name. The viewer (`simulate:show`) collapses common interpolation
  patterns but the underlying fix is at the call-site: lift the IDs to
  attributes.
- **One trace per logical operation.** When the production code makes the
  trace into a single causal graph (queue context propagation through Durable
  Streams rows — currently a tracked production-side change), a sim's trace
  should follow the client request through every host hop it caused. Until
  that lands, expect multiple trace roots in one `trace.jsonl`; the viewer
  groups by parent/child within each root.
- **`firegrid.side` is a propagated annotation, not a wrapper.** The runner
  uses `Effect.annotateSpans("firegrid.side", side)` so every descendant span
  inherits the dimension. This lets you filter "everything the host did under
  this driver call" with one attribute predicate.

## What does not go in this package

- Production observability fixes (template-izing host-sdk span names, adding
  `firegrid.context.id` propagation, queue context propagation, the
  codec → SDK diagnostic span). Those changes live in `@firegrid/host-sdk`,
  `@firegrid/runtime`, `@firegrid/client-sdk`, and `effect-durable-operators`,
  and they are tracked separately from tiny-firegrid's runner work.
- Conclusion-shaped artifacts (`run.json` with `claimStatus`, `findings: [...]`
  arrays in TypeScript). The trace is the output; findings are prose.

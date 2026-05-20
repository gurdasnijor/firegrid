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
  must not import host-sdk, runtime, protocol internals, or codec/sandbox
  primitives. If the scenario needs those, it's exercising a private seam, not
  the public client surface — write the test in the owning package's `test/`
  folder instead.
- The host file may import `@firegrid/host-sdk` to compose a host layer
  (`FiregridLocalHostLive`, `FiregridMcpServerLayer`, etc.), but only the layer
  factories — not the runtime context's private machinery.

## Stopping a simulation

Stop is an external signal, not an in-driver predicate. The runner creates a
`stopSignal` effect for each run and passes it to `host(env)`. Drivers stay on
the public client surface and keep polling until the runner timeout, SIGINT, or
some host-scoped fiber completes that signal.

When a simulation needs to stop early after demonstrated success or a specific
observed condition, fork a named observer fiber from the host layer. That fiber
should use `hostProjectionObserver` from `@firegrid/host-sdk` when the condition
is visible in per-context runtime-output rows, then yield
`env.stopSignal.complete` when its predicate fires. The helper stamps
`firegrid.wait.bucket="projection"` on the observer span. Keep that observer
separate from the driver: the driver remains a pure client loop, the trace
remains the output, and the host scope owns the observer lifetime.

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
- A migrate CLI for the `to-be-migrated/` backlog. The migration is mechanical
  and the discipline ("port one sim, write a finding, repeat") doesn't need
  tooling.

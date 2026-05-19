# Runbook — §7.7 observability proof ("everyone sees what is happening")

factory-vision §7.7 capability: the durable event stream materializes
into **queryable rows** such that every **wait**, every **delegation**,
every **tool call**, and every **decision** a run performed is an
inspectable row reachable through **the same query interface operators
use** — the per-run DuckDB (`simulate:query` / `simulate:duckdb` →
`tiny_firegrid_spans`). This runbook documents the falsifiable check
that asserts it.

## The check

`packages/tiny-firegrid/scripts/assert-s77-observability.mjs` —
self-contained (reads only a run's own DuckDB via the `duckdb` binary,
the operator interface; no production-package import). Falsifiable: a
REQUIRED class with **zero** queryable rows exits non-zero and prints a
surfaced FINDING — it is never papered.

```
# inputs (deterministic, no API key):
pnpm --filter @firegrid/tiny-firegrid simulate:run -- stdio-jsonl-tool-execution-pipeline
pnpm --filter @firegrid/tiny-firegrid simulate:run -- multi-context-production-consuming-pipeline
# proof:
node packages/tiny-firegrid/scripts/assert-s77-observability.mjs
# or against a specific run dir / sim-id substring:
node packages/tiny-firegrid/scripts/assert-s77-observability.mjs <run-or-substr> [...]
```

## §7.7 class → row predicate (grounded in observed span inventories)

Classes are classified by `span_name` predicate over the operator-facing
`tiny_firegrid_spans` table:

| class | predicate (substring of `span_name`) | observed evidence rows |
|---|---|---|
| **wait** | `%wait%` | `runtime_context.workflow.output.wait`, `durable_tools.wait_for.*`, `durable_tools.wait_router.*`, `durable_tools.wait_store.wait.*` |
| **delegation** | `%runtime-context.session.start.%` / `%runtime_context.claim_and_run%` / `%runtime_context.workflow.session.start%` | one `session.start.<ctx>` row per delegated context; multi-context run shows 3 distinct contexts |
| **tool call** | `%tool_use.execute%` / `%tool_use.activity%` / `%tools/call%` / `%agent_tool%` | `host.runtime_substrate.tool_use.execute`, `runtime_context.workflow.tool_use.activity` |
| **decision** | `%control_plane.run.allocate%` / `%control_request.claim%` / `%workflow_engine.activity.claim%` / `%permission%` | `runtime_control_plane.run.allocate_attempt`, `host.control_request.claim` |

The check also reports `contexts` (distinct `firegrid.context.id` in
matched rows) so delegation breadth is visible.

## Why two runs (proof coverage, stated honestly)

No single hermetic sim exercises all four classes: the agent-driven sims
that issue real tool-calls / permission decisions
(`codex-acp-tool-call-pipeline`, `permission-flow-pipeline`,
`delegation-parent-child-pipeline`) require a live agent / `OPENAI_API_KEY`
and **time out (90s) in a hermetic env**. The deterministic sims that
complete split the classes:

- `stdio-jsonl-tool-execution-pipeline` performs **wait, tool_call,
  decision** (real `tool_use.execute` rows).
- `multi-context-production-consuming-pipeline` performs **wait,
  delegation (3 contexts), decision**.

Each class is asserted only against a sim that *genuinely performs it*
(`REQUIRED_BY_SIM` in the script). A class a sim does not perform is
reported `optional` and never forced to pass — that would be papering.
The **union** of the two required sets covers all four §7.7 classes, and
the check fails (`§7.7 INCOMPLETE`, non-zero) if the union does not.

Observed proof (this branch's runs):

```
stdio-jsonl…:  wait ✓103  tool_call ✓2  decision ✓11   (delegation ·7 optional)
multi-context…: wait ✓385 delegation ✓21/3ctx decision ✓27 (tool_call ·0 optional)
verdict: classes proven materialized = decision, delegation, tool_call, wait
✓ §7.7 PROVEN
```

## Reading a FINDING (do not paper)

- `✗ <class> … [REQUIRED]` + `§7.7 FINDING`: a sim that performs `<class>`
  produced **0** queryable rows for it — the durable stream did not
  materialize that choreography as an inspectable row. This is a real
  §7.7 observability gap. Surface it (file a finding); do **not** widen
  the predicate or move the class to optional to make it green — that is
  papering and defeats the proof.
- `§7.7 INCOMPLETE`: required runs passed individually but the union
  misses a class — a proof-coverage gap. Resolve by adding an exercising
  run (e.g. running an agent-driven sim with credentials available),
  **not** by relaxing the required sets.
- `duckdb query failed`: the operator query interface itself did not
  answer — that is itself a §7.7 failure (the rows are not queryable).

## Scope

Descriptive proof of the §7.7 *capability*, not a behavioral assertion
about any one choreography's correctness. It proves the factory is
legible from outside: what happened is inspectable through the operator
query surface.

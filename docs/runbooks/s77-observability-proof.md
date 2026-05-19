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

## Keyed sims & keyless CI (env-gate contract)

The Anthropic/OpenAI keys live in local lanes' `~/.zshenv`; **CI runners
do not have them and must not** (never bake a key into CI).

**CI reality (verified, stated honestly):** no key-dependent sim is
executed by CI. There is no `packages/tiny-firegrid/test/` dir, the
tiny-firegrid `test` script is empty (`turbo run test` runs none of
them), `ci.yml` invokes no `simulate`/`proof`/`demo`, and the §7.7
check above audits only deterministic completing sims (agent-gated
classes are `optional`, never forced). So today there is **no false CI
failure** from missing keys — this section is defense-in-depth + the
contract for local/demo keyless runs and any future smoke wrapper.

**Driver contract:** a keyed sim run without its key **fails fast with
an explicit authoritative reason**, it does not silently hang. Uniform
guard (mirrors `dark-factory-pipeline`):

| sim | key | keyless behavior |
|---|---|---|
| `dark-factory-pipeline` | `ANTHROPIC_API_KEY` | fast `Effect.fail` "requires ANTHROPIC_API_KEY for claude-agent-acp" |
| `permission-flow-pipeline` | `ANTHROPIC_API_KEY` | fast `Effect.fail` "requires ANTHROPIC_API_KEY for claude-code-acp" (was a silent ~90s `SimulationRunTimeout` before this guard) |
| `codex-acp-tool-call-pipeline` | `OPENAI_API_KEY` | fast `Effect.fail` "requires OPENAI_API_KEY for codex-acp" (was a silent ~90s timeout) |
| `execute-provider-side-effect-pipeline` | — none — | **not key-dependent**: agent-free deterministic stdio-jsonl child; completes hermetically. (Correcting a mis-categorization: it requires no key.) |

The guard fires **only** when the key is absent; the real-key
assertion is untouched (no weakening). Failure is non-zero on purpose:
a keyed proof sim that "passed" without its key would prove nothing —
faking exit-0 success would be papering and would hollow out the §6 /
§7.7 proofs.

**The exit-0 "skip" belongs at the test-harness layer, not the driver.**
Any future smoke test that wraps a keyed sim must env-gate with the
established `.smoke` discipline — `const maybeIt = hasKey() ? it :
it.skip` (skip with an explicit reason, suite exits 0) — exactly as the
codex-acp `.smoke` pattern does for `OPENAI_API_KEY`. Do not move the
exit-0 into the sim itself.

**`demo:s6` / `simulate proof` keyless:** `demo:s6` runs
`dark-factory-pipeline` (now fails fast with the authoritative reason),
prints `re-run with a valid ANTHROPIC_API_KEY`, and propagates the
non-zero exit; it does not render a proof from a non-existent run. This
is correct degrade behavior and is **not** run by CI. `simulate proof`
on a run with no §6 summary reports `run … has no §6 proof summary`
(non-zero) — also correct, also not CI-run.

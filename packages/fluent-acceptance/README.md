# `@firegrid/fluent-acceptance`

Cucumber-js E2E acceptance harness for the **fluent** feature set — the
*verification lane*. It drives firelab / tiny-firegrid (and, for `@real-agent`
scenarios, a real native/ACP agent harness) from the Gherkin features in
`features/fluent/**/*.feature`, and asserts **product-observable** outcomes.

This package is **isolated from production runtime files**. It depends only on
test/driver surfaces; it never imports or mutates `fluent-runtime` production
code.

## Principles

- **Product-observable `Then`, not trace-CEL.** Verdicts come from observable
  state — durable-stream contents, closed streams, fork boundaries, deduped
  appends, resumed agent output, approval responses, client-visible projections.
  OpenTelemetry traces are **diagnostics only**, never the primary pass/fail.
- **`@real-agent` is an explicit live lane.** Half-1 agent-binding scenarios must
  prove the real binding — a fake recorder/codec is not acceptance proof. They run
  only when the live lane is enabled; otherwise they **skip with a clear
  precondition**.

## Running

```bash
# default lane — excludes @real-agent (no creds / live harness needed)
pnpm --filter @firegrid/fluent-acceptance test:acceptance:fluent

# live lane — @real-agent scenarios. Without the flag they SKIP with a
# precondition; with it (plus native/ACP agent creds) they run for real.
FIREGRID_REAL_AGENT=1 \
  pnpm --filter @firegrid/fluent-acceptance test:acceptance:fluent:real
```

## Layout

| Path | Purpose |
|---|---|
| `cucumber.mjs` | Profiles: `default` (`not @real-agent`) and `real` (`@real-agent`). |
| `src/support/world.ts` | `FluentWorld` — SUT handles + product-observable read helpers. |
| `src/support/hooks.ts` | `@real-agent` precondition gate (skips unless `FIREGRID_REAL_AGENT=1`). |
| `src/steps/*.steps.ts` | Step definitions. |
| `features/*.feature` | Harness self-tests (smoke + the live-lane gate). |
| `../../features/fluent/**/*.feature` | The product fluent features (scanned once they land on `main`). |

## V1 scope (this PR)

V1 is the **scaffold**: the runner, the World/read-helper seam, the `@real-agent`
gate, and a self-contained smoke proving the pipeline (runner → World → steps →
observable `Then`) with no external infra. `strict: false` is a deliberate
scaffold stance so the product features (not yet on `main`) report as pending
rather than failing; each feature flips to strict as its steps land.

**Not yet here (follow-on PRs):**

- V2 — a firelab-backed driver in the World (real durable-streams envelopes +
  client projections), starting with `substrate/fluent-substrate-semantics`.
- V3 — `coordination/fluent-durable-{sleep,wait}` steps (depend on the
  production park/wake/timer primitives).
- V4 — `@real-agent` agent-binding steps driving a real claude-acp / codex
  harness (adapter-contract, native-resume, approval-fidelity, park-interface).

## Notes

- The product `features/fluent/**` files are authored in another lane and are not
  yet on `main`; the config already points at them, so the default lane will
  discover them automatically once merged.
- Coordinate with Tooling if the firelab **drive** API (`runSimulation` /
  `defineSimulation`) changes; the harness pins to that surface, not to the
  coverage-spec layout.

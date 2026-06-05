# fluent-concurrent-replay-witness

`tf-td1v` verification-lane witness for
`features/fluent/substrate/fluent-concurrent-replay-soundness.feature` and the
Appendix A proof in `docs/sdds/fluent-firegrid-sdd.md`.

This is intentionally `launchHost: false`, but the green path is
production-backed: the driver imports `@firegrid/fluent-firegrid` and exercises
`execute(ctx, Effect.all([run(...)]), { concurrency: "unbounded" })` against the
real upstream `DurableStreamTestServer` that Firelab starts for each run.

Scope: Appendix A named-vs-positional replay only. This does not claim coverage
for the race winner or loser-policy scenarios in
`features/fluent/substrate/fluent-concurrent-replay-soundness.feature`.

- named keys run through production `run(...)` under unbounded concurrency, then
  replay against the same real journal stream and must not execute replay actions
  or append new journal rows;
- the positional construction-counter mutation still uses production `run(...)`
  but derives bad keys as `${index}:${name}` in scheduling order, and flips red
  when replay scheduling order differs;
- the witness rejects vacuity by requiring first-epoch actions plus persisted
  journal rows before the replay assertions can pass.

Production seam exercised here:

1. `execute(ctx, effect)` provides the durable journal layer for the handler.
2. `run(key, action)` accepts a caller-supplied replay-stable string key and
   returns a plain `Effect`.
3. Re-driving the same handler twice against the same journal endpoint serves
   the second pass from the journal.
4. A replay miss is observable as an extra action execution and an extra
   `StepSucceeded` row read back through `effect-durable-streams`.

Once this moves from hostless workbench to launched-host coverage, promote the
production `journal.step` / `step.action` spans into forge-proof firelab gates.

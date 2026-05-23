# subscribers/scheduled-prompt/

SHAPE: D — DurableClock deadline

Workflow-shaped subscriber that delivers a scheduled prompt at a true-future
wall-clock deadline. The workflow body owns one load-bearing capability:

- **DurableClock deadline** — the subscriber sleeps until a wall-clock instant
  in a way that survives host restart. The deadline is the source of truth
  for delivery; restart resumes the same sleep, not a re-derived one.

No `Activity.make`-shaped side effects beyond the durable timer; delivery
itself is a single idempotent input-intent append.

## Status

The body still lives at `workflow-engine/workflows/scheduled-prompt.ts`; this
folder forwards via `index.ts`. The physical move into `./workflow.ts` is
blocked on reshaping its `producers/ingress-writers/scheduled-prompt-append.ts`
dependency — `runtime-subscribers-no-producers-import` is a HARD STOP rule
that forbids any subscribers/ file from importing producers/. The mover (this
lane) stopped per the dispatch directive rather than open a carve-out; see
`docs/architecture/2026-05-23-tf-6hqx-scheduled-prompt-move-blocker.md` for the report. Wave 2 lands the physical move after
the producer dependency is reshaped (typed-table read, or producer-side
relocation, or a typed channel write route).

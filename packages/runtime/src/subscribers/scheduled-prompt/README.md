# subscribers/scheduled-prompt/

SHAPE: D — DurableClock deadline

Workflow-shaped subscriber that delivers a scheduled prompt at a true-future
wall-clock deadline. The workflow body owns one load-bearing capability:

- **DurableClock deadline** — the subscriber sleeps until a wall-clock instant
  in a way that survives host restart. The deadline is the source of truth
  for delivery; restart resumes the same sleep, not a re-derived one.

No `Activity.make`-shaped side effects; delivery itself is a single send via
the channel router.

Wave 2 moves `workflow-engine/workflows/scheduled-prompt.ts` here.

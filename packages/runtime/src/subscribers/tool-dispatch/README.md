# subscribers/tool-dispatch/

SHAPE: D — Activity memoization

Workflow-shaped subscriber for tool-use side effects. The workflow body owns
exactly one load-bearing capability:

- **Activity memoization** — once a tool call commits a result, replay re-uses
  the memoized output rather than re-invoking the tool. This is the durable
  exactly-once boundary for non-idempotent side effects (HTTP calls,
  file-system writes, external API invocations).

No other workflow-machinery features are used here. No `DurableClock`, no
parked input mailbox, no cross-execution handoff.

Wave 2 moves `workflow-engine/workflows/tool-call.ts` here.

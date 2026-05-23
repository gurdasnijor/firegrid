# subscribers/wait-router/

SHAPE: D — durable wait/timeout

Workflow-shaped subscriber that resolves agent `wait_for(channel, trigger)`
calls. The workflow body owns one load-bearing capability:

- **Durable wait with timeout** — the subscriber parks across restarts on a
  durable wait condition (a `FieldEqualsTrigger` over a typed observation
  stream) with a configurable timeout. The durable wait survives host restart;
  a non-workflow subscriber cannot guarantee that.

No `Activity.make`-shaped side effects; matching is the pure
`evaluateFieldEquals` transform.

Wave 2 moves `workflow-engine/workflows/wait-for.ts` here.

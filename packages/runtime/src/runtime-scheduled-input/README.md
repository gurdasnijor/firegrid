# Runtime Scheduled Input

This module is a narrow production-shaped primitive for delayed runtime ingress.
It is not Firegrid's choreography facade, and it is not a generic scheduler.

The path proved here is one built-in workflow handler:

```txt
scheduled runtime input fact keyed by scheduleId
  -> ScheduleRuntimeInputWorkflow(scheduleId)
  -> DurableClock.sleep(...)
  -> re-read pending schedule
  -> append RuntimeIngressTable input
  -> provider delivery
```

It exists to satisfy:

- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.2`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.3`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.4`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.5`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.6`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.7`
- `firegrid-workflow-driven-runtime.BOUNDARIES.6`
- `firegrid-workflow-driven-runtime.VALIDATION.3`

## Handler Model

This module should be read through an Inngest-like model:

```txt
Function = Trigger + Handler + Policy
```

The useful abstraction is not a separate wall-clock scheduler primitive. It is
durable events or facts that trigger workflow handlers, plus durable step
primitives inside those handlers. Event-with-predicate and cron are trigger
shapes. One-shot wall-clock delays usually belong in handler bodies as
`step.sleepUntil`-style steps.

In this module:

- scheduled runtime input row = durable schedule/request fact
- `ScheduleRuntimeInputWorkflow` = built-in handler for that fact
- `DurableClock.sleep` = `step.sleepUntil`-style durable step primitive
- `appendRuntimeIngress` = durable dispatch side effect, analogous to a
  `step.run` action
- `scheduleId` + `insertOrGet` = request idempotency for this built-in handler

Future choreography work can model built-in handlers as Trigger + Handler +
Policy. `schedule_me(when, prompt)` can lower to an event or request fact
handled by a workflow that uses `DurableClock.sleep` and appends runtime
ingress. Idempotency, concurrency, cancellation, and retry policy should
eventually belong to handler registration or policy instead of being scattered
across ad hoc row fields.

This PR remains only the first built-in handler proof for delayed runtime input.

## RFC Mapping

`docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/choreography-and-combinators.md`
defines agent-facing choreography tools. This module only proves the runtime
input leaf path beneath one future tool.

- `sleep(durationMs)`: workflows can call `DurableClock.sleep` directly. This
  module is not needed.
- `wait_for(trigger)`: use the existing durable-tools `WaitFor` path. This
  module is not involved.
- `schedule_me(when, prompt)`: a future agent-facing tool or choreography facade
  should lower to scheduled runtime input: durable schedule intent/workflow
  state, then `DurableClock.sleep`, then `RuntimeIngressTable` input append,
  then provider delivery. This module proves only that lower half.
- `spawn` / `spawn_all`: future child `RuntimeContextWorkflow` work. This
  module is not involved.
- `execute`: future sandbox or tool activity path. This module is not involved.

The future choreography facade and tool binding surface should sit above or
beside this module. They should not be implemented inside this module.

## Non-Goals

- no public `schedule_me` facade
- no Firegrid-owned general timer table
- no generic scheduler API
- no ACP, MCP, or tool binding surface
- no product-local scheduler or consumer framework
- no generalized Trigger ADT
- no cron implementation
- no expression predicates
- no function registration system
- no handler policy, concurrency, rate-limit, retry, or cancellation model

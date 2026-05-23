# subscribers/runtime-control/

SHAPE: D — cross-execution handoff

Workflow-shaped subscribers for host-control requests (cancel, resume, close,
prompt-now, etc.). The workflow body owns one load-bearing capability:

- **Cross-execution handoff** — a control request is claimed by a kernel
  workflow that exclusively owns the target RuntimeContext's lifecycle.
  Claim/dispatch/result correlation across host restart requires a durable
  execution boundary; a non-workflow subscriber cannot guarantee single-writer
  ownership of the controlled RuntimeContext.

Wave 2 moves `workflow-engine/workflows/runtime-control-request.ts` here.

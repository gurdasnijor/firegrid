# subscribers/runtime-control/

SHAPE: D — cross-execution handoff

Workflow-shaped subscribers for host-control requests (cancel, resume, close,
prompt-now, etc.). The workflow body owns one load-bearing capability:

- **Cross-execution handoff** — a control request is claimed by a kernel
  workflow that exclusively owns the target RuntimeContext's lifecycle.
  Claim/dispatch/result correlation across host restart requires a durable
  execution boundary; a non-workflow subscriber cannot guarantee single-writer
  ownership of the controlled RuntimeContext.

Lane 4 runtime-control drain (this PR) moved the host-control surface here:

- `workflow-engine/workflows/runtime-control-request.ts` → `./workflows.ts`
- `control-plane/control-request-dispatcher.ts` → `./dispatcher.ts`
- `control-plane/lifecycle-evidence.ts` → `./lifecycle-evidence.ts`

The runtime-internal `control-plane/` folder is deleted. Authority Tags
(`RuntimeContextInsert`, `RuntimeContextRead`, etc.) stayed in
`@firegrid/runtime/authorities`; the subscriber-shaped reconciler + workflow
defs live here under `@firegrid/runtime/subscribers/runtime-control`.

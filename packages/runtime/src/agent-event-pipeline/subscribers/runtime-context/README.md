# Runtime-Context Subscriber (Shape C landing zone)

This directory is the **single landing path** for the Shape C RuntimeContext
cutover. The greenfield rewrite of `RuntimeContextWorkflowNative` lands here as
a per-event, per-`contextId` keyed handler — load durable state, run a pure
transition, save, dispatch through capability tags, return.

Required reading before adding code here:

- [`docs/cannon/architecture/runtime-design-constraints.md`](../../../../../../docs/cannon/architecture/runtime-design-constraints.md)
- [`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md)
- [`docs/architecture/2026-05-22-shape-c-cutover-baseline.md`](../../../../../../docs/architecture/2026-05-22-shape-c-cutover-baseline.md)
- [`packages/runtime/src/agent-event-pipeline/TOPOLOGY.md`](../../TOPOLOGY.md)

## Shape rule (gate enforced)

Code in this directory **MUST** be Shape C:

```text
R = state-store tag
  | typed read source tag (or IngressChannel)
  | narrow write tag (or EgressChannel)
  | live dispatch tags (AgentSession, RuntimeToolUseExecutor)
```

**`WorkflowEngine.WorkflowEngine` / `WorkflowEngine.WorkflowInstance` MUST NOT
appear in `R`.** That is the visible Shape D signal; a tool/wait/scheduled-prompt
workflow that genuinely earns it lives under `../../tool-execution/` or
`../../../workflow-engine/workflows/`, never here.

`Activity.make`, `Workflow.suspend`, `Workflow.execute`, and any direct
reference to `WorkflowEngine.WorkflowEngine` / `WorkflowEngine.WorkflowInstance`
inside files under this directory will fail
`firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber`. The rule's
`semgrep-error-baseline.json` ledger is empty by design: a violation is not an
admissible bridge exception; it means the code belongs in a Shape D location.

## What lands here

```
runtime-context/
  README.md                 (this file)
  index.ts                  (barrel — re-exports handler entry + layer)
  handler.ts                (per-event Effect<void, RuntimeContextError, R>)
  layer.ts                  (RuntimeContextSubscriberLive: Layer<…, never, never>)
  state-load.ts             (load/save against RuntimeContextStateStore — pure
                             wrappers if any; transition logic stays in
                             ../../transforms/)
```

The pure transition functions stay in `../../transforms/` (already gated by
`firegrid-transforms-no-effect-shaped-exports`). The state store, output
read/write, and channel tags stay in their owning folders. The handler here
**only wires** load → pure transition → save → dispatch.

## Import direction

```text
@firegrid/protocol/…                           ← never imported INTO here as a
                                                 redefinition; imported AS A
                                                 SOURCE of row/channel schemas
../events/, ../authorities/, ../transforms/    ← read freely
../codecs/, ../sources/                        ← capability tags only
../../channels/                                ← capability tags only
../../workflow-engine/**                       ← FORBIDDEN (Shape D substrate)
```

If a planned addition to this directory needs the workflow engine, it is not
Shape C. Either move it to `../../tool-execution/` (or a justified Shape D
landing under `../../../workflow-engine/workflows/` with a written
workflow-machinery justification per the SDD Gate), or rewrite it so the wait
becomes a durable completion keyed by domain identity (C4).

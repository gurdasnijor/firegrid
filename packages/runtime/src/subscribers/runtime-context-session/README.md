# subscribers/runtime-context-session/

SHAPE: C

Codec-session command sink. Owns the runtime-side
`RuntimeContextWorkflowSession` capability tag and command/evidence types.
Host packages implement the live codec adapter against this contract; they
do NOT import the retired workflow body, the retired workflow Layer, the
retired workflow payload schema, or the retired engine-execute helper
from the kernel barrel. Those symbols are deleted (see the body+kernel
deletion wave PR). The host-sdk boundary import gate continues to bar any
re-introduction.

Public subpath: `@firegrid/runtime/subscribers/runtime-context-session`.

The implementation now lives in `handler.ts` next to this README, and
`index.ts` re-exports the runtime-owned command-sink contract from it. The
file holds only the seam shape — types, evidence schemas, and the
`Context.Tag`. It does not import `@effect/workflow`, the workflow body, or
any composition Layer, and the workflow body now imports the seam from this
folder rather than the other way around.

`handler.ts` is the file the topology check looks for; it carries no
`Activity.make`, `WorkflowEngine`, `WorkflowInstance`, `DurableDeferred`, or
`DurableClock` references, in line with the Shape C constraints in
[`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md)
§"Shape C".

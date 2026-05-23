# subscribers/runtime-context-session/

SHAPE: C

Codec-session command sink. Owns the runtime-side
`RuntimeContextWorkflowSession` capability tag and command/evidence types.
Host packages implement the live codec adapter against this contract; they
do NOT import `RuntimeContextWorkflowNative`, the workflow Layer, the
workflow payload schema, or `executeRuntimeContextWorkflow` from the kernel
barrel. Those symbols are runtime-internal substrate and barred across the
host-sdk boundary by the import gate.

Public subpath: `@firegrid/runtime/subscribers/runtime-context-session`.
`index.ts` is the Wave 1 forward-target re-export of the runtime-owned
command-sink tag and types from their current physical location in
`workflow-engine/workflows/runtime-context.ts`. Wave 2 moves the
implementation into this folder; the subpath stays stable.

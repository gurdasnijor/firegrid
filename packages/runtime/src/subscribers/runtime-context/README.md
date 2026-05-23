# subscribers/runtime-context/

SHAPE: C

Stateful per-event RuntimeContext handler. The `R` channel may name
`RuntimeContextStateStore` (state — imported from
`@firegrid/runtime/tables/runtime-context-state`) and the channel/clock tags
it dispatches into. It MUST NOT name `WorkflowEngine`, `WorkflowInstance`,
or use `Activity.make` / `DurableDeferred` / parked-body patterns.

`handler.ts` lives here. It was moved from
`packages/runtime/src/agent-event-pipeline/subscribers/runtime-context/` as
the first Wave 2 artifact landing in this folder. The companion factorings
(`state-ops.ts`, `action-dispatch.ts`) are not yet split out — the per-event
handler is small enough that the single-file shape is still the right one;
splits land when a new entry point or dispatch axis needs an explicit seam.

Reserved public subpath: `@firegrid/runtime/subscribers/runtime-context`. The
subpath is reserved, not yet wired in `package.json` exports — host-sdk
consumers do not depend on the handler directly today (composition wires it
into `runtime-keyed-subscriber` dispatch).

Import boundary (Shape C, per
`docs/architecture/2026-05-22-runtime-physical-target-tree.md`):

- `events/agent-input` — `AgentInputEvent` vocabulary
- `tables/runtime-context-state` — durable state store tag + schema
- `transforms/runtime-context-transition` — pure
  `transitionInputEvent` / `transitionOutputEvent` + action type
- `transforms/decode-ingress-row` — pure
  `agentInputEventFromRuntimeIngressRow`
- `subscribers/runtime-context-session` — session-command sink tag

The fact-matrix dispatch primitive (`runtime-keyed-subscriber/`) wires this
handler to its keyed event source.

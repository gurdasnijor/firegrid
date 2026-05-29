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

## When does a tool need this folder?

**See [docs/architecture/shape-c-vs-shape-d.md](../../../../../docs/architecture/shape-c-vs-shape-d.md)** for the full
decision procedure. Quick reference for tools:

Two paths run tool calls in the runtime. They are independent and you
should pick the right one.

| Path | Where it runs | When | Idempotency by |
| --- | --- | --- | --- |
| **Shape D — MCP-entry tool dispatch** | `ToolCallWorkflow` here, dispatched via `WorkflowEngine.execute` | The agent invokes a tool through the MCP-entry channel (i.e. tools exposed through `composition/mcp-host.ts`). The executor's effects are non-idempotent (HTTP, fs, external API). | `Workflow.idempotencyKey: ({ toolUseId }) => toolUseId` over `WorkflowEngineTable` — at-most-once across process restart, replay, and concurrent dispatch. **No separate `tables/runtime-tool-result.ts` exists or is needed.** |
| **Shape C — in-handler tool dispatch** | `runToolAndSend` in `subscribers/runtime-context/handler.ts` | The agent emits a `ToolUse` event through the stdio-jsonl codec (the agent's own ToolUse output, not the MCP-entry path). | Event-id-keyed via `eventAlreadyProcessed` — the handler is a pure reducer, the same event row is observed at most once. No workflow body needed. |

ACP-mode tool execution is **observation-only**: the provider executes
the tool, the handler skips. No dispatch path runs.

### Criterion

If you're adding a tool that the agent calls through MCP, dispatch lands
here. Use `ToolCallWorkflow`; let `Workflow.idempotencyKey: ({ toolUseId
}) => toolUseId` carry exactly-once. **Do not** add a
`tables/runtime-tool-result.ts` primitive — `WorkflowEngineTable`'s
memoization is the at-most-once boundary.

If you're adding handling for a `ToolUse` event the agent emits over
stdio-jsonl, dispatch lands in `subscribers/runtime-context/handler.ts`
under the existing `runToolAndSend`. No workflow.

### Falsifiers

These are the regressions the
`shape-d-tool-dispatch-mcp-entry` simulation watches for. Each would
move the Shape D path into a different architecture:

- Dispatch needs `RuntimeContextWorkflowRuntime` / `AgentToolHost` /
  `provideRuntimeContext` to invoke `.execute(...)` → YELLOW, keep the
  host-sdk bridge.
- At-most-once breaks across a restart boundary without a separate
  result table → RED, `WorkflowEngineTable` memoization is insufficient
  and a `tables/runtime-tool-result.ts` primitive becomes necessary.
- Same `toolUseId` re-invokes the executor on a second call → RED,
  idempotency contract is broken.

The simulation tests at
`packages/tiny-firegrid/src/simulations/shape-d-tool-dispatch-mcp-entry/`
assert each falsifier as a negative guard. See
`FINDING.md` in that folder for the full proof and the production paired
deletions that follow once D-A lands.

## Locked agent tool surface

The runtime-context MCP route exposes a fixed, asserted set of agent
primitives. **Adding a new tool to that surface requires an explicit
gate.** The locked list (per the `agentic-patterns-primitive-profile`
simulation):

| Primitive | Role |
| --- | --- |
| `call` | Callable channel dispatch (request/response). |
| `send` | Egress channel dispatch (fire-and-acknowledge). |
| `wait_for` | Ingress channel observation, predicate-matched. |
| `wait_for_any` | Race waits over multiple ingress channels; return the first match. |

Explicitly **forbidden** from the runtime-context surface (the test
asserts none appear in `tools/list`):

`execute`, `schedule_me`, `session_cancel`, `session_close`,
`session_new`, `session_prompt`, `sleep`, `spawn`, `spawn_all`.

The forbidden list captures legacy ergonomic helpers and substrate
leaks. Tools that look like product behavior (scheduling, session
lifecycle, multi-agent fan-out) belong elsewhere: an app's own MCP
server, the channel router, or the agent body plan — not the runtime
primitive surface.

### What the test additionally guards

The same simulation asserts the `tools/list` response contains **none**
of: `DurableTable`, `RuntimeControlPlaneTable`, `RuntimeOutputTable`,
`WorkflowEngine`, `RuntimeContextWorkflow`, `hostSession`, `streamUrl`.
That's the substrate-leak guard: no agent-facing schema should mention
runtime internals.

### Adding a primitive

The gate is the test at
`packages/tiny-firegrid/test/agentic-patterns-primitive-profile.test.ts`.
A new primitive PR must:

1. Update `agenticPatternsPrimitiveToolNames` in
   `packages/tiny-firegrid/src/simulations/agentic-patterns-primitive-profile/profile.ts`.
2. Justify why the primitive is substrate-shaped (composable, narrow,
   not a product behavior).
3. Provide the corresponding `Tool.make` in
   `packages/runtime/src/subscribers/tool-dispatch/bindings/tools.ts`
   with a schema that does not mention any substrate-leak string.

Tools that fail the substrate-leak guard fail the test loud.

Files (post tf-up1v cleanup):

- `workflow.ts` — `ToolCallWorkflow` definition + payload schema + `RuntimeToolCallWorkflowLayer` handler. Physically moved from `workflow-engine/workflows/tool-call.ts` + the previous `runtime-tool-call-workflow.ts` (folded together).
- `runtime-tool-use-executor.ts` — `RuntimeToolUseExecutor` capability tag + `RuntimeToolUseExecutor.layer(...)` helper. Physically moved from `workflow-engine/tool-execution/runtime-tool-use-executor.ts`.
- `runtime-agent-tool-execution.ts` — runtime-owned validated executor service.
- `dispatch.ts` — `ToolDispatch` Tag + `ToolDispatchLive` host-install Layer.
- `index.ts` — public barrel (`@firegrid/runtime/subscribers/tool-dispatch`).

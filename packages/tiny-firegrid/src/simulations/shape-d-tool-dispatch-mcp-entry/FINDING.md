# shape-d-tool-dispatch-mcp-entry — D-Tool shape validation

**Verdict: GREEN (option A).** The current Shape D `ToolCallWorkflow` +
`RuntimeToolUseExecutor` pair can replace the host-sdk
`workflowRuntime.run({ workflowName, supportLayer, effect })` bridge
without a new `tables/runtime-tool-result.ts` primitive and without
salvaging anything from #684. At-most-once for the MCP-entry tool path
is the SDD C3 result identity that `Workflow.idempotencyKey: ({ toolUseId
}) => toolUseId` already provides over `WorkflowEngineTable`. No
additional durable surface is required.

## Precondition (D-A)

This sim validates the SHAPE only. Production dispatch of the paired
deletions below requires D-A first:

- D-A delivers Wave C cutover: `FiregridRuntimeHostLive` composes
  `composition/host-live.ts` instead of `RuntimeContextWorkflowRuntimeLive`.
- Once that lands, `RuntimeContextWorkflowRuntime` loses its other
  consumers and the tool-call wrapper at
  `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:76-102`
  becomes the last hold-out — safe to delete.
- Without D-A, deleting the wrapper here orphans the live
  `FiregridRuntimeHostLive` composition for the in-handler tool path
  (the Shape C handler's `runToolAndSend` at
  `subscribers/runtime-context/handler.ts:200`).

## What was proved (11/11 vitest tests green)

### Option A shape works through router-installed Shape D Layer (5)

1. **Direct invocation.** `executeMcpEntryTool(payload)` calls
   `WorkflowEngine.execute(ToolCallWorkflow, payload)` and returns the
   `ToolResult`. No `RuntimeContextWorkflowRuntime.run`,
   `workflowName`, `supportLayer`, or `provideRuntimeContext` plumbing.
2. **Same `toolUseId` → executor invoked exactly once.** Memoized
   first-valid-terminal-wins; second call with even a different
   `input` field returns the first result (idempotency key is
   `toolUseId` alone, matching production).
3. **Different `toolUseId` → executor invoked per call.** Memo is
   keyed by `(workflowName, idempotencyKey)`; no false sharing.
4. **Restart survival.** After dropping the in-memory handler registry
   (mirrors process restart) and re-registering, a repeat call with
   the same `toolUseId` does NOT re-invoke the executor — the durable
   memo returns the first call's result. This is the load-bearing
   claim: at-most-once is preserved purely by
   `Workflow.idempotencyKey` over the workflow-engine substrate, with
   no new `tables/runtime-tool-result.ts`.
5. **Failure surfaces.** A failing executor causes the dispatch to
   fail loud (no half-memo); production behavior unchanged.

### Negative shape (6)

6. **`host-facade.ts` does NOT import the bridge symbols.** No
   `RuntimeContextWorkflowRuntime`, `workflowRuntime`, `workflowRuntime.run`,
   `supportLayer`, `toolCallWorkflowSupportLayer`, `AgentToolHost`,
   `provideRuntimeContext` references.
7. **Entire sim contains NO #684 anti-pattern symbols.** No
   `RuntimeToolResultTable` / `RuntimeToolResultRow` /
   `runtimeToolResultAtMostOnce` / `RuntimeToolResultStore`; no
   `RuntimeWaitCompletionTable` / `RuntimeWaitCompletionStore` /
   `runtimeWaitForMatch`; no `RuntimeObservationStreams` / `callerFact`
   / `RuntimeAgentOutputAfterEvents`; no `wait-routing/` path; no
   `@firegrid/runtime/streams` import; no `WorkflowEngineTable` leak.
8. **Facade `R` channel is exactly `{ WorkflowEngine }`** — compile-
   time assertion. Adding `RuntimeContextWorkflowRuntime`,
   `AgentToolHost`, or any other host-bound capability would fail
   typecheck.
9. **Registration `R` channel is exactly `{ WorkflowEngine,
   RuntimeToolUseExecutor }`** — compile-time assertion. The host
   composition provides both at boot; nothing else is needed.
10. **Idempotency key is literally `({ toolUseId }) => toolUseId`** —
    body-text assertion. Production
    (`packages/runtime/src/workflow-engine/workflows/tool-call.ts:21`)
    uses the identical form. If anyone changes the key shape, the
    sim's C3 anchor moves and Wave D needs to re-resolve.
11. **Idempotent registration.** Re-running
    `registerRuntimeToolCallWorkflow` (second composition pass) does
    not break dispatch. Mirrors host-sdk's "compose once at boot,
    re-compose on hot reload" pattern.

## Falsifiers (none triggered)

| Falsifier | Trigger | Verdict drop |
|---|---|---|
| Facade `R` channel needs `RuntimeContextWorkflowRuntime` to invoke `.execute(...)` | Compile-time guard (test #8) | GREEN → YELLOW (keep the wrapper) |
| Facade `R` channel needs `AgentToolHost` / `supportLayer` for context propagation | Body-text + compile-time guards (tests #6, #8) | GREEN → YELLOW (keep the bridge) |
| At-most-once breaks across the restart boundary without a `tables/runtime-tool-result.ts` primitive | Restart memo test (test #4) | GREEN → RED (SDD C3 claim for Shape D tool path is wrong; would need #684-style table) |
| Same `toolUseId` re-invokes the executor on second call | Idempotency test (test #2) | GREEN → RED |

None of these triggered. **Verdict stays GREEN on option A.**

## Exact paired deletions (post-D-A)

In `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`:

| Lines | Surface to delete |
|---|---|
| ~18 | `import { ToolCallWorkflow, ... } from "@firegrid/runtime/tool-executor"` — replace with `import { ToolCallWorkflow } from "@firegrid/runtime/subscribers/tool-dispatch"` (tree-aligned target subpath) |
| ~34 | `import { toolCallWorkflowSupportLayer } from "..."` |
| ~40-41 | `export { ToolCallWorkflow } from "@firegrid/runtime/tool-executor"` + `export { RuntimeToolCallWorkflowLayer as ToolCallWorkflowLayer } from "@firegrid/runtime/tool-executor"` (drop or repoint to the tree-aligned subpath) |
| ~76 | `const execute = ToolCallWorkflow.execute({ contextId, toolUseId, toolName, input })` — keep |
| ~93-100 | `workflowRuntime.run({ context: runtimeContext, workflowName: ToolCallWorkflow.name, supportLayer: toolCallWorkflowSupportLayer(agentToolHost), effect: execute.pipe(provideRuntimeContext(runtimeContext)) })` — **delete the wrapper**; replace with direct `execute` invocation inside the runtime root's `WorkflowEngine` scope provided by `composition/host-live.ts` |

In `packages/host-sdk/src/host/` (whichever files own them):

| Surface |
|---|
| `toolCallWorkflowSupportLayer` definition |
| `RuntimeContextWorkflowRuntime` Tag + Live (if D-A has not already deleted it) |
| `provideRuntimeContext` helper used only by the bridge (if no remaining consumers) |
| Corresponding `semgrep-error-baseline.json` entries that become unreachable |

In `packages/runtime/src/`:

- Nothing to add. The Shape D Layer at
  `packages/runtime/src/agent-event-pipeline/tool-execution/runtime-tool-call-workflow.ts`
  is correct as-is. The Wave A forward-target re-export at
  `packages/runtime/src/subscribers/tool-dispatch/index.ts` already
  points at it. Wave 2 of the tree migration physically moves the body
  to `subscribers/tool-dispatch/` — independent of this D-Tool slice.
- **No `tables/runtime-tool-result.ts`. No `runtimeToolResultAtMostOnce`.
  No #684 salvage.**

In `packages/runtime/src/subscribers/runtime-context/handler.ts`:

- `runToolAndSend` at line 200 STAYS. It is the in-handler Shape C
  path for stdio-jsonl tools (the agent's own ToolUse output, not the
  MCP-entry path). The two paths are independent. The Shape C handler
  comment ("the at-most-once Activity memoization is not needed in
  Shape C — idempotency is event-id-keyed via `eventAlreadyProcessed`")
  remains accurate for the in-handler path.

## Minimal production proof test (post-D-A AND this sim)

Host-sdk integration test at `packages/host-sdk/test/agent-tools/`:

```ts
// pseudocode
describe("MCP-entry tool dispatch (Shape D via WorkflowEngine, no RuntimeContextWorkflowRuntime)", () => {
  it("invokes the executor exactly once per toolUseId across a forced process restart", () => {
    // start a host with FiregridRuntimeHostLive (post-D-A composition)
    // register a tool that increments a counter and returns a value
    // invoke the tool from an MCP client with toolUseId="t1"
    // crash + restart the host process (or simulate via fresh Effect.runPromise on same durable substrate)
    // invoke the tool again with toolUseId="t1"
    // assert: the counter is 1 (executor ran once)
    // assert: both calls returned the same ToolResult
    // assert: no FiregridRuntimeHostLive runtime imports RuntimeContextWorkflowRuntime
  })

  it("ACP-mode tools are observed-only (in-handler path skipped)", () => {
    // existing handler.ts:RunToolUse ACP guard
  })
})
```

~120 lines. Mirrors `packages/host-sdk/test/host/sync-run-integration.test.ts`
patterns. Add a second test for the in-handler stdio-jsonl path to
prove the two paths coexist correctly.

## What this sim does NOT cover

- **Real workflow-engine durability** — the in-memory `Ref`-backed memo
  is a stand-in for `WorkflowEngineTable`. The sim assumes the
  workflow-engine substrate's at-most-once behavior matches the SDD
  claim. Existing production tests (e.g.
  `runtime/test/workflow-engine/path-x.Q-2`) already validate
  `WorkflowEngineTable`-backed Activity replay; this sim does not
  duplicate them.
- **The in-handler ToolUse path** (`runToolAndSend` at
  `subscribers/runtime-context/handler.ts:200`) — that path is Shape C,
  handler-event-idempotent, and orthogonal to D-Tool option (A). It
  needs no shape change.
- **ACP-mode tool execution** — provider-executed; handler skips.
  Unchanged.

## Sources

- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md` §"Shape D"
- `docs/cannon/architecture/runtime-design-constraints.md` C3 + SDD gate
- `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` §Wave D
- `packages/runtime/src/workflow-engine/workflows/tool-call.ts` (`ToolCallWorkflow.idempotencyKey: ({ toolUseId }) => toolUseId`)
- `packages/runtime/src/agent-event-pipeline/tool-execution/runtime-tool-call-workflow.ts` (`RuntimeToolCallWorkflowLayer = ToolCallWorkflow.toLayer(...)`)
- `packages/runtime/src/subscribers/tool-dispatch/{index.ts,README.md}` (Wave A forward-target shim; SHAPE: D — Activity memoization)
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:76-102` (the bridge being deleted)
- `packages/runtime/src/subscribers/runtime-context/handler.ts:200` (`runToolAndSend` in-handler path; stays)

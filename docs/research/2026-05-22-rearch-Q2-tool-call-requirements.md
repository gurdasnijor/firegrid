# Q2 — Tool-call requirements for the runtime re-architecture (CC2, 2026-05-22)

**Question:** What does a host-executed agent tool call actually *require* from the
runtime substrate — durability, at-most-once, observability-to-whom, correlation
under replay+concurrency — and does the current `ToolCallWorkflow` shape meet
those requirements? Derived first-principles, then checked against source.

This brief is read-only. All file:line citations are source-verified against
`origin/main` this session.

## 1. Requirements derivation (first-principles)

A host-executed tool call is: *an MCP `tools/call` request, bound to one agent
turn in one runtime context, that must run a host effect exactly once and return
its result to the synchronous HTTP caller.* From that, four orthogonal
requirements fall out:

- **R1 — Durability (per-tool, not per-call).** A tool call must survive host
  restart *only if the tool itself suspends durably* (a timer or an external
  wait). A tool that is a single synchronous effect (`send`, `call`) needs no
  durable identity — re-issuing the MCP request after a crash is the natural
  recovery. So durability is a property of the *lowering*, not of the request
  envelope.
- **R2 — At-most-once.** The host effect (sending a message, scheduling a
  prompt) must not double-fire if the request, the workflow, or the owning
  context replays. The correlation key is `toolUseId` (provider-minted, stable
  across retries of the same logical call).
- **R3 — Observability-to-whom.** The result is owed to the **synchronous MCP
  HTTP caller** (the toolkit handler that the editor/agent is blocking on),
  keyed by `toolUseId`. It is *not* owed to the agent-output event stream. This
  is the distinction the live triage got wrong twice (§ evidence E5).
- **R4 — Correlation under replay + concurrency.** Many tool calls for one
  context can be in flight; the owning context workflow replays frequently
  (every output chunk resumes it). The result-return path must therefore be
  (a) keyed so concurrent calls don't cross-deliver, and (b) replay-safe so a
  resume neither re-runs the effect nor loses the pending result.

## 2. Evidence (file:line + verbatim)

**E1 — One executor, two lowerings (the asymmetry).** The codec path lowers
`ToolUse` with *no* per-call workflow via the owning body's memoized activity —
`runtime-context.ts:438` `runToolUseActivity` calling
`executor.execute({ contextId: context.contextId }, event)` (`:448`), driven by
the body's own `RunToolUse` transition (`:378`). The MCP path spawns a workflow
*per call*: `toolkit-layer.ts:76` `ToolCallWorkflow.execute({ contextId,
toolUseId, toolName, input })`, whose body (`runtime-tool-call-workflow.ts:14`)
calls **the same** `executor.execute`. Per-call workflow identity is therefore
*not intrinsic to tool execution* — it is the MCP handler's request/response
wrapper.

**E2 — `ToolCallWorkflow` is shaped as a request/response mailbox.**
`tool-call.ts:16-21`:
```
export const ToolCallWorkflow = Workflow.make({
  name: "firegrid.agent-tool-call",
  payload: ToolCallWorkflowPayloadSchema,   // { contextId, toolUseId, toolName, input }
  success: ToolResultEventSchema,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})
```
It owns no durable table and runs no multi-event state machine — request →
`executor.execute` → response. `idempotencyKey = toolUseId` is the *only*
at-most-once mechanism (R2) on the MCP path.

**E3 — The handler blocks synchronously on the result (R3).**
`toolkit-layer.ts:90-108` runs the workflow on the host-scoped engine and then
`return result.part.result as Output` — the result is the **MCP response**, not
an agent-output event.

**E4 — The owning workflow does *not* execute ACP tool calls today.**
`runtime-context.ts:531-532`: `if (context.runtime.config.agentProtocol ===
"acp") { return }`. ACP codecs are observation-only; the only in-body execution
path is skipped for exactly the agents (claude-acp) the live edge uses. The
stdio path that *does* execute (`:534-544`) sends the result back to the **agent**
(`_tag: "AgentInput"`), and `RuntimeContextSessionCommand` (`:85-88`) carries
only `{ _tag: "AgentInput", commandId, event }` — there is **no** tool-request
command and **no** caller-keyed result-return surface.

**E5 — The discriminant a non-workflow seam needs is explicitly deferred.**
`runtime-context.ts:525-530`: a `ToolUseRequest` vs `ToolUseObservation`
event-level discriminant is "a tracked, **deliberately-deferred future option,
not the current contract**." Grep confirms neither type exists outside this
comment.

**E6 — Per-tool durability is sparse (R1).** From the executor
(`runtime-agent-tool-execution.ts`): `sleep`→`DurableClock.sleep` (`:189-197`),
`schedule_me`→`ScheduledPromptWorkflow` fire-and-forget (`:228-233`),
`wait_for`→`WaitForWorkflow` (`:198-209`) are durable; `send` (`:211-215`),
`call` (`:216-219`) are plain effects; `wait_for_any` (`:164-178`) is an
**in-memory** `Effect.raceAll` + `Effect.timeoutTo` — *not durable*, lost on
restart even today. So `ToolCallWorkflow` wraps all 11 tools but adds durable
value to none — durability lives in the lowering, confirming R1.

**E7 — Correlation under replay is already broken in production (R4).** The
live ACP triage (`2026-05-21-live-acp-tool-call-triage.md:178-218`,
source-verified) pins tf-7kq8: the owning body's output read
`completedRuntimeContextEvent`→`events.initial` (`runtime-context.ts:281`,
`:749`) is the *only* loop op **not** wrapped as an Activity, over an in-memory
`Ref` (`:820`) seeded at sequence −1 (`:349`). Each replay re-walks history →
O(resumes × history) (~107 outputs × ~80 resumes ≈ 2500 re-reads), so the turn
never converges and the tool result never returns. This is a *correlation/
observability-under-replay* failure in the very workflow the cutover wants to
route tool calls into.

## 3. Conclusion — does `ToolCallWorkflow` meet the requirements?

| Req | Met by current shape? | Note |
| --- | --- | --- |
| R1 durability | **Over-provisioned** | per-call workflow on every tool; only 3 lowerings actually suspend durably (E6) |
| R2 at-most-once | **Yes, narrowly** | `idempotencyKey = toolUseId` (E2) — but this is the *only* dedup; a replacement must preserve it explicitly |
| R3 observability-to-whom | **Yes** | synchronous result to the MCP caller (E3); correctly *not* via agent stream |
| R4 correlation under replay+concurrency | **Partially / fragile** | per-call key works for concurrency, but the owning workflow it rides on is replay-unsafe (E7) |

`ToolCallWorkflow` *works* but is the wrong shape: it is an **accidental
request/response mailbox** dressed as a durable workflow, violating
`WORKFLOW_ADMISSION.1/.3` (a `Workflow.make` is legitimate only for an owned
durable resource / long-running process). It meets R2/R3 by accident of the
`Workflow.execute` ergonomics, over-pays R1, and inherits R4 fragility from the
owning context body.

**The correct shape** (per the tf-phk7 audit, `2026-05-22-tool-call-workflow-audit.md:50-64`):
the MCP handler delivers the invocation as a `RunToolUse` *input* to the owning
`RuntimeContextWorkflowNative` (the codec path already does this) and awaits the
`ToolResult` via a **durable deferred keyed by `toolUseId`**; the executor is
kept. This satisfies all four requirements *without* a per-call workflow
identity — but only once the **owning-workflow tool-input/result seam exists**
(the Phase-0C input-table + signal/table-write wakeup, tf-b1jm F1/F3). That seam
is absent today (E4/E5), which is precisely why tf-vfq9 is STOP-blocked
(`tf-vfq9-mcp-tool-call-cutover.STOP.md`).

## 4. OPEN QUESTIONS

1. **Result-return primitive.** Is the caller-correlated `ToolResult` a durable
   deferred keyed by `toolUseId`, a row in the workflow-owned output/result
   table the MCP handler point-gets, or a `engine.signal` round-trip? (Ties to
   tf-aseo's durable state table + the DurableOutputCursor work.)
2. **At-most-once without a workflow identity.** Once `idempotencyKey` is gone,
   what carries R2 — input-row identity (`toolUseId` as the input key), or a
   durable idempotency record? Must not silently regress double-fire on
   `send`/`call`.
3. **R4 ordering before cutover.** Must tf-7kq8 (replay-safe O(outputs) output
   observation) land *before* routing tool calls through the owning workflow, or
   can they co-design? Routing tool results through a replay-storming body would
   inherit the hang.
4. **`wait_for_any` durability (R1 gap, tf-0xe4).** In-memory race today
   (E6) — does the re-architecture make it durable, or is it explicitly
   accepted as best-effort? Independent of de-workflowing but in the blast
   radius.
5. **Concurrency bound per context.** How many concurrent host-executed tool
   calls per context must the seam support, and does the owning single-writer
   workflow body serialize them in a way that bounds latency acceptably?

# tf-jt8q — tool/result roundtrip without ToolCallWorkflow or deferred mailbox (2026-05-22)

**Bead:** `tf-jt8q` (P1). Clean-room firelab prototype. Sibling to
`tf-zjuf` (permission rendezvous) and the `tf-aseo` durable-loop-state re-scope.
Simulation only — not production code.

## Question

Can an agent tool roundtrip — **ToolUse output → tool result append →
TurnComplete output** — be modeled over workflow-owned tables with a durable
skip cursor, achieving **exactly-once tool execution across replays** and
**O(distinct outputs/results)** with **no replay amplification**, WITHOUT
`ToolCallWorkflow`, `appendRuntimeInputDeferred`, the
`WorkflowEngineTable.deferreds`-as-mailbox, input intents, or dispatchers?

## What this sim proves

`packages/firelab/src/simulations/tool-result-roundtrip` models the turn
over three durable collections — `loopState` (one row: skip cursor +
`executedToolUses` set + counts), `outputs` (agent emits text / tool_use /
turn_complete), `toolResults` (workflow appends, keyed by `toolUseId`). Every
processing pass reloads `loopState` from the table (no in-memory state survives a
replay), drains outputs by **point `get` at cursor+1** (skip cursor, never
re-walks `<= cursor`), executes each tool **idempotently**
(`toolResults.insertOrGet` on the `toolUseId` key + the durable `executedToolUses`
guard), and persists.

The driver runs a 2-tool turn with a **replay boundary placed after both tools
executed but before TurnComplete**, and only emits TurnComplete after confirming
both results are durably appended (the roundtrip feedback):

```
text(1) · tool_use tool-1(2) · tool_use tool-2(3)
  → replay "mid-turn-after-tools"   (skip cursor at lastOut=3; no re-exec)
  → confirm 2 toolResults durable
text(4, "received: …") · turn_complete(5)
  → replay "post-turn-complete"     (idempotent; no re-exec)
```

## Verdict: GREEN

Native trace evidence (`simulate:run tool-result-roundtrip`, 7 processing passes):

| Invariant | Value | Meaning |
| --- | --- | --- |
| `distinct_outputs` | 5 | text, tool_use ×2, text, turn_complete |
| `output_hit_count` | **5** | each output consumed **exactly once** |
| `amplification` (hit/distinct) | **1.0** | O(distinct), independent of reloads |
| `reload_count` | **7** | loop state reloaded from table 7× |
| `output_read_count` | 12 | 5 hits + 7 tail misses — **linear**, not quadratic |
| `no_rewalk` | **true** | `consumedOutputSequences === [1,2,3,4,5]` |
| `tool_execution_count` | **2** | exactly one execution per ToolUse, **independent of `reload_count=7`** |
| `tool_result_count` / `toolResults` | **2** / **2** | one result per ToolUse, round-tripped |
| `exactly_once_tools` | **true** | each result == `executed <toolUseId> -> ok` |
| `turn_complete` | **true** | terminal reached |

**The clincher (exactly-once side effect):** the `tool_execute` span with
`tool_executed=true` appears **exactly twice** in the whole trace (tool-1,
tool-2) despite 7 passes; `tool_execution_count` plateaus at 2 across the
trailing 6 reloads. Because the skip cursor never re-consumes the tool_use
outputs (seq 2,3) once `lastOutputSequence > 3`, the execution path **runs once**
— the idempotent `toolResults` key + `executedToolUses` guard are
belt-and-suspenders for a crash mid-pass, not the load-bearing mechanism for the
ordinary replay case.

## Verdict for production cutover: this shape SHOULD inform it

The durable-loop-state + skip-cursor shape covers the tool roundtrip with **two
properties production needs and the `tf-7kq8`/`tf-aseo` arc cares about**:

1. **No replay amplification** — output observation and tool execution are
   bounded by distinct events, not resumes × history (the `tf-7kq8` failure
   class), achieved by a durable cursor that resumes rather than re-walks.
2. **Exactly-once tool side effects across replays** — without a memoized
   `Activity` per tool *and* without `ToolCallWorkflow` or a deferred mailbox.
   The `toolUseId`-keyed result row is the idempotency fence; the skip cursor
   means it is rarely even exercised.

Combined with `tf-zjuf` (permission request/response rendezvous on the same
durable-loop-state shape), the two prototypes jointly show a single durable
`RuntimeContextStateTable` loop-state row can carry **cursors + pending
permission sets + executed-tool set** and serve both the permission and the
tool roundtrip — strengthening the `tf-aseo` recommendation to build that table
rather than the `#615` Q5 output-read-only swap.

**Caveat / not proven here:** this clean-room models tool execution as a
deterministic in-line append; production tool execution is a real side effect
(MCP / local process) that must be fenced by the same `toolUseId`-keyed
idempotency before the result append, and the result must be delivered back to
the live agent session (the `sendSessionActivity` seam), which this sim
abstracts as the `toolResults` append + driver feedback. The shape is validated;
the live-session delivery seam is the production integration point to design
next.

## Scope / boundaries

Clean-room: `DurableTable` + `durableStreamUrl` only. **No** `ToolCallWorkflow`,
`appendRuntimeInputDeferred`, `WorkflowEngineTable.deferreds`-mailbox, input
intents, dispatchers, or replay-path scans (the only `query` calls are the
`durableRows` reporting reducers, off the workflow path). Runtime exposed via a
module latch (same pattern as `target-architecture-reference` / `loop-state-table`).

## Running

```bash
pnpm --filter firelab simulate:run tool-result-roundtrip
pnpm --filter firelab simulate:perf <runId>
```

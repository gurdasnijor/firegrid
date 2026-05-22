# tf-zjuf — durable loop-state table derisk for tf-aseo (2026-05-22)

**Bead:** `tf-zjuf` (P1). Clean-room derisk **companion to `tf-aseo`** (the
blocked durable-output-cursor cutover). Simulation only — not production code.

## What `tf-aseo` blocked on

The `RuntimeContextWorkflowNative` merged loop threads `RuntimeContextEventState`
(cursors **plus `pendingPermissionRequests/Responses`**) in-memory and resets it
to `initial` at the top of every replay. A true-O(outputs) **skip** cursor that
resumes past already-delivered outputs skips their transition calls → drops the
pending permission sets → breaks permission request/response matching. So
`tf-aseo` concluded: *true O(outputs) ⟺ durable loop state ⟺ touches
input-coupled permission state ⟺ exceeds the output-read-only slice*, and
recommended a durable `RuntimeContextStateTable` loop-state slice.

## What this sim proves

`packages/tiny-firegrid/src/simulations/loop-state-table` models loop state as
**one workflow-owned `DurableTable` row** (`loopState`) carrying both cursors
**and** the pending permission request/response sets, plus append-only
`inputs`/`outputs`/`sentActions` logs. Every processing pass **reloads the row
from the table** (no in-memory state survives a replay), drains inputs/outputs
by **point `get` at cursor+1** (skip cursor — never re-walks `<= cursor`), and
persists the row.

The driver runs a permission rendezvous in **both** orders with a **replay
boundary placed between the two halves**:

- **perm-A — request_first:** emit `permission_request` (output seq 3) →
  `replayBoundary` → send `permission_response` (input seq 1). The reload after
  the request must still carry `perm-A` in `pendingPermissionRequests`.
- **perm-B — response_first:** send `permission_response` (input seq 2) →
  `replayBoundary` → emit `permission_request` (output seq 4). The reload must
  still carry `perm-B` in `pendingPermissionResponses`.

## Verdict: GREEN

Native trace evidence (`simulate:run loop-state-table`, 10 processing passes):

| Invariant | Value | Meaning |
| --- | --- | --- |
| `distinct_outputs` | 5 | outputs at seq 1–5 |
| `output_hit_count` | **5** | each output consumed **exactly once** |
| `amplification` (`hit/distinct`) | **1.0** | O(distinct events), independent of reloads |
| `reload_count` | **10** | loop state reloaded from table 10× |
| `output_read_count` | 15 | 5 hits + 10 tail misses — **linear** in (outputs + reloads), not quadratic |
| `no_rewalk` | **true** | `consumedOutputSequences === [1,2,3,4,5]` strictly increasing, no repeats |
| `permission_matches` | **2** | perm-A `request_first`, perm-B `response_first` |
| `permission_matching_held` | **true** | both pending sets empty at end; both responses sent exactly once |

**The clincher (skip cursor, no re-walk):** after consuming output seq 3, every
subsequent reload reads **only the frontier** — `output.read_sequence=4,
read_hit=false` appears **5 times** (the 5 reloads where the cursor parks at
`lastOutputSequence=3` awaiting seq 4) and seq 1/2/3 are **never re-read**. A
re-walk model would re-read 1,2,3 on every reload. `output_hit_count` plateaus
at 3 across those 5 reloads, then advances to 5 — monotonic, decoupled from
`reload_count`.

## Conclusion for tf-aseo

A durable `RuntimeContextStateTable` loop-state row (cursors + pending
permission sets), reloaded each replay with a point/skip cursor, **simultaneously
achieves O(distinct events) observation and preserves permission rendezvous
across replays**. The two goals `tf-aseo` found in tension are jointly
satisfiable once the pending permission state is durable rather than rebuilt by
re-walking outputs. This validates the `tf-aseo` re-scope recommendation.

## Scope / boundaries

Clean-room: `DurableTable` + `durableStreamUrl` only. No host/child
orchestration, authority, input intents, deferred mailbox, or broad engine
abstractions (would be stop-and-re-evaluate). The runtime is exposed via a
module latch (same pattern as `target-architecture-reference`); the agent's
output production and the replay boundaries are driver-driven so the rendezvous
orderings and replay placement are deterministic.

## Running

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run loop-state-table
pnpm --filter @firegrid/tiny-firegrid simulate:perf <runId>
```

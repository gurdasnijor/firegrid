# tf-u8w2 — RuntimeContext fact matrix (clean-room proof)

**Verdict: GREEN.** The target RuntimeContext fact matrix routes by stable
identity to a per-key subscriber, advances state from sparse facts only, and
correlates permission/tool waits by id — with no dense raw-output scan and no
cross-event `DurableDeferred` mailbox.

This is a tiny-firegrid simulation only. No production runtime changes (tf-u8w2
non-goal). It de-risks the target shape for tf-tvg1.

## What was proven

Every fact kind in the matrix routes by `contextId` to the same keyed durable
subscriber state, in isolation across contexts:

| Fact kind            | Routing key                          | Drives state? |
| -------------------- | ------------------------------------ | ------------- |
| input                | `contextId`                          | yes (sparse)  |
| output_transition    | `contextId` (+ opens tool/permission wait) | yes (sparse) |
| permission_response  | `permission:<permissionRequestId>`   | yes (sparse)  |
| tool_result          | `tool:<contextId>:<toolUseId>`       | yes (sparse)  |
| terminal             | `contextId`                          | yes (sparse)  |
| **raw TextChunk output** | separate `rawOutput` table       | **NO — UI/telemetry only** |

Invariants asserted by the driver (fail-closed; verdict span only emits on pass):

- **State advances from sparse facts only.** `factHandlerInvocations = 14`
  (CTX-A) equals the distinct sparse fact count and is independent of the
  `rawOutputRows = 48` dense noise rows appended to the separate stream.
  `denseOutputReads = 0`: the subscriber's code path never reads the raw-output
  table. (C2, C6)
- **Output noise does not affect handler work.** Appending raw output never
  invokes the subscriber: 48 `raw_output_append` spans, 0 additional
  `handler.apply_fact` spans (16 total = 14 CTX-A + 2 CTX-B).
- **Permission/tool correlation is by id, not arrival order.** Four waits open
  in order P1,T1,P2,T2 and resolve in order T2,P1,T1,P2. The first tool
  resolution (`tool_result T2`) routes to T2 — its own id — even though the
  older pending tool wait T1 exists; a FIFO/positional matcher would have
  resolved T1. (C4)
- **Out-of-arrival-order rendezvous survives replay.** P3's response and T3's
  result arrive *before* their opening transitions, are stashed durably, and
  match by id when the transition arrives — across two replay boundaries that
  reload state from the durable row with no surviving in-memory waiter.
  (`resolve_first = 2`, `open_first = 4`.) (C4)
- **No `DurableDeferred`.** Correlation is keyed durable state + point-addressed
  cursor reads. The string only appears in doc comments.
- **first-valid-terminal-wins / fact-identity dedupe.** A duplicate terminal
  fact (same `factKey`) converges via `insertOrGet`; `terminalCount = 1`,
  status `complete`, result `all-resolved`.
- **Keyed routing isolation.** CTX-B facts never advance CTX-A; CTX-B opens no
  waits and completes independently. (C1)

## Load-bearing constraint observed

`docs/cannon/architecture/runtime-design-constraints.md`:

- **C1** keyed durable state container (`contextId`).
- **C2** handler is a `(state, fact) -> newState` reducer; no long-lived body —
  state is reloaded from the durable row on every processing entry.
- **C4** async waits are durable completions keyed by domain id, reconstructed
  from durable records, *not* a cross-event mailbox, *not* arrival-order matched.
- **C6** dense raw output is a separate typed source the subscriber never scans;
  the cursor is a point-addressed source coordinate, not a business id.
- **C7** fact/state/identity/result schemas are first-class and versioned.

(`runtime-pipeline-type-boundaries.md` is named as required reading on the bead
but does not exist on `origin/main`; the constraints doc above carries the
load-bearing rules.)

## Shape C (fact routing) does not conflict with CC3 Shape D (execution machinery)

This sim proves the **routing/correlation** layer: a `tool_result` /
`permission_response` fact *arrives* and resolves the matching wait by id. It is
deliberately silent on **how** that result was produced — who executes a
specific tool binding, the claimed-work operator discipline, who writes the
result row. That is the CC3 finding's **Shape D execution machinery for specific
bindings**, and it lives one layer below.

The two layers compose at a clean seam and do not contradict:

- **Shape C (this finding):** result-arrival facts correlate to the keyed
  subscriber's pending waits by domain id (C4 durable completion). Routing is
  agnostic to the producer.
- **Shape D (CC3):** the execution machinery for a specific binding produces and
  durably records the result (C3 durable result identity / claimed-work
  operator). It *writes* the row that Shape C *delivers*.

Concretely: the sim's `tool_result` fact is exactly the point where Shape D's
output plugs in. Nothing here changes `WaitFor.match`'s contract or the
binding-specific execution path; it only models the correlation that sits above
them. The fact matrix and the execution machinery are orthogonal slices of the
same target architecture.

## Evidence

- Sim: `packages/tiny-firegrid/src/simulations/runtime-context-fact-matrix/`
- Run: `pnpm --filter @firegrid/tiny-firegrid exec tsx src/index.ts run runtime-context-fact-matrix`
- Trace: `.simulate/runs/<runId>/trace.jsonl`; verdict span
  `firegrid.tiny_fact_matrix.verdict` carries every invariant attribute.
  Latest GREEN run: `error_spans=0`, `fact_handler_invocations=14`,
  `raw_output_rows=48`, `dense_output_reads=0`, `open_first=4`,
  `resolve_first=2`, all `invariant.*=True`.
- Gates: typecheck OK, eslint `--max-warnings 0` OK, knip baseline OK
  (current=0), jscpd 0 clones, depcruise no violations, vitest 23/23.

## What would falsify the verdict

- `factHandlerInvocations` tracking `rawOutputRows` (or any `denseOutputReads > 0`)
  → the subscriber is scanning dense output; sparse-only is false.
- A resolution whose `correlationId` does not equal both its opening transition's
  id and its resolving fact's id → routing is positional, not by id.
- `resolve_first` matches lost across a replay boundary → state depends on an
  in-memory waiter (C4 reconstruction violated).
- A CTX-B fact advancing CTX-A state → routing is not keyed by `contextId`.
- Any need for a `DurableDeferred` / per-sequence mailbox to make matching work
  → the cross-event mailbox the bead forbids has crept back in.

## Production rewrite dependency

tf-tvg1 (the per-event RuntimeContext workflow subscriber slice) depends on this
finding for its target shape. The production rewrite must:

1. Make RuntimeContext state a keyed durable container reloaded per processing
   entry (replaces the long-lived replaying body's in-memory
   `RuntimeContextEventState`).
2. Drive transitions from a sparse fact/transition log via a point-addressed
   cursor — *not* by scanning the dense `AgentOutputAfter` TextChunk stream
   (the dense-output re-walk this sim shows is unnecessary).
3. Carry pending tool/permission waits as durable sets keyed by domain id, with
   early-arrival stashing — retiring the per-sequence `DurableDeferred` input
   mailbox (constraints doc "Runtime Input Mailbox", gated on tf-5cn1 write+arm
   bridge) without reintroducing a cross-event mailbox.

This sim is the empirical reference for steps 1–3; it is not itself the
production change.

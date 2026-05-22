# tf-64lq Finding: Phase 0C Tiny Input Append + Wakeup Proof

Verdict: GREEN. The tiny-firegrid reference can prove the unresolved #617
input-side primitives without a production cutover:

- `appendRuntimeContextWorkflowInput` is modeled as one atomic table method over
  `contexts`, `inputs`, and `inputIds`.
- `inputIds` is the idempotency index. Duplicate `inputId=duplicate-0`
  returned the original `inputKey=phase0c-context/0`.
- Distinct concurrent producers reserved dense point-addressed keys
  `phase0c-context/1` through `phase0c-context/4`.
- The workflow consumes by durable cursor using `inputs.get(inputKey)` point
  reads only, then advances `contexts.nextInputSequence`.
- The wakeup primitive is the native DurableTable row stream
  (`inputs.rows()`), not polling and not a bridge table.

## Native Evidence

Run:

```bash
pnpm --filter @firegrid/tiny-firegrid typecheck
pnpm --filter @firegrid/tiny-firegrid simulate:run -- tiny-input-append-wakeup
pnpm --filter @firegrid/tiny-firegrid simulate:show -- 2026-05-22T00-49-01-260Z__tiny-input-append-wakeup
pnpm --dir packages/tiny-firegrid exec tsx src/index.ts perf --finding-draft 2026-05-22T00-49-01-260Z__tiny-input-append-wakeup
```

Trace:

```text
packages/tiny-firegrid/.simulate/runs/2026-05-22T00-49-01-260Z__tiny-input-append-wakeup/trace.jsonl
```

Verdict span:

```json
{
  "firegrid.tiny_phase0c.verdict": "GREEN",
  "firegrid.tiny_phase0c.input.unique_count": 5,
  "firegrid.tiny_phase0c.input.append_attempts": 6,
  "firegrid.tiny_phase0c.input.point_reads": 8,
  "firegrid.tiny_phase0c.input.replay_path_queries": 0,
  "firegrid.tiny_phase0c.input.max_existing_allocations": 0,
  "firegrid.tiny_phase0c.input.bridge_rows": 0,
  "firegrid.tiny_phase0c.input.wakeup_signals": 6,
  "firegrid.tiny_phase0c.input.wakeup_awaits": 3
}
```

Atomic append spans:

```text
duplicate-0 -> phase0c-context/0 sequence=0 result=inserted
duplicate-0 -> phase0c-context/0 sequence=0 result=idempotent
input-1     -> phase0c-context/1 sequence=1 result=inserted
input-2     -> phase0c-context/2 sequence=2 result=inserted
input-3     -> phase0c-context/3 sequence=3 result=inserted
input-4     -> phase0c-context/4 sequence=4 result=inserted
```

Native span counts:

```text
8 firegrid.tiny_phase0c.workflow.input_point_read
6 firegrid.tiny_phase0c.input_wakeup.signal
6 firegrid.tiny_phase0c.atomic_input_append
4 firegrid.tiny_phase0c.workflow.transition
3 firegrid.tiny_phase0c.input_wakeup.await
1 firegrid.durable_table.rows
```

Perf:

```text
spans: 147
window: 88.0ms
idle gaps: (none above threshold)
simulate:perf finding draft: no idle gaps exceeded 30000ms
```

Static check over this simulation source:

```bash
rg -n "inputs\\.query|max\\(existing\\)|appendRuntimeInputDeferred|WorkflowEngineTable\\.deferreds|RuntimeInputIntentDispatcherLive|RuntimeControlPlaneTable\\.inputIntents|request/claim/completion" \
  packages/tiny-firegrid/src/simulations/tiny-input-append-wakeup --glob '*.ts'
```

Result: no matches.

## Conclusion

The unresolved primitives from #617 hold cleanly in tiny-firegrid:

- No replay-path `inputs.query` scan is needed; replay-visible workflow reads
  are point-addressed by `contextId/sequence`.
- No `max(existing)+1` allocator is needed; sequence reservation is owned by the
  atomic append method and persisted on the context row.
- No request/claim/completion bridge is needed; the channel writes the
  workflow-owned input table and the workflow consumes that table directly.
- The smallest wakeup proof is DurableTable row observation plus point-read
  cursor processing. A production `engine.signal` can replace the row-stream
  wakeup surface later without changing the table/cursor contract.

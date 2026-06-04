# FINDING - tf-ovzr Phase-1 Lane 6 New-Shape Replay Smoke

## VERDICT

`GREEN-new-shape-replay-after-tf-gyxc`

The exact INV-2 `WaitForWorkflow` body shape now survives a scoped engine
bounce while the `Activity(Stream.runHead(...))` side is suspended:

```text
Activity(Stream.runHead(...))
+ DurableDeferred.raceAll
+ DurableClock.sleep
```

This supersedes the original PR #469 RED trace. The RED failure was caused by
engine recycle persisting pure interrupt exits into activity/race durable rows.
The tf-gyxc engine fix treats scope-close recycle of a non-user-interrupted
execution as replayable suspension and does not persist those pure interrupt
exits. User-requested workflow cancellation remains terminal cancellation.

## Artifact

Run:

```bash
pnpm --filter firelab simulate:run phase1-lane6-new-shape-replay --timeout-ms 120000 --watch
```

Run id:

```text
2026-05-20T09-27-52-547Z__phase1-lane6-new-shape-replay
```

Trace artifact:

```text
docs/research/tf-ovzr-phase1-lane6-new-shape-replay.trace.jsonl
docs/research/tf-gyxc-engine-recycle-suspend-not-cancel.trace.jsonl
```

Runner copy:

```text
packages/firelab/.simulate/runs/2026-05-20T09-27-52-547Z__phase1-lane6-new-shape-replay/trace.jsonl
```

## Evidence

Final probe span:

```text
trace line 302 firegrid.phase1.lane6.new_shape_replay.probe
firegrid.phase1.lane6.already_written.replay_completed = true
firegrid.phase1.lane6.already_written.outcome = "Match"
firegrid.phase1.lane6.already_written.value = "matched-before-gen2"
firegrid.phase1.lane6.live_after_restart.replay_completed = true
firegrid.phase1.lane6.live_after_restart.outcome = "Match"
firegrid.phase1.lane6.live_after_restart.value = "matched-after-gen2"
firegrid.phase1.lane6.timeout_after_restart.replay_completed = true
firegrid.phase1.lane6.timeout_after_restart.outcome = "Timeout"
firegrid.phase1.lane6.timeout_after_restart.deadline_preserved = true
```

The rerun has no `ParseError` / `Expected Cause<never>` spans. Gen-2 reaches
source replay for both match scenarios and reaches the preserved clock deadline
for the timeout scenario.

The simulation now asserts this GREEN shape in `host.ts`: all three
`replay_completed` fields must be true, the two match values must match the
rows written around gen-2, and the timeout clock deadline must remain
preserved. A future regression in the tf-gyxc recycle invariant makes the sim
fail instead of merely recording a RED trace.

## Acceptance Matrix

| Acceptance | Result |
| --- | --- |
| Start WaitForWorkflow while no matching row exists | PASS |
| Bounce while Activity side is suspended | PASS |
| Already-written match replays after restart | PASS - `matched-before-gen2` |
| Match appended after restart completes same execution | PASS - `matched-after-gen2` |
| Timeout deadline preservation | PASS - `Timeout`, `deadline_preserved = true` |

## Interpretation

INV-3 remains old-shape evidence. This finding is the direct proof for the new
shape after the tf-gyxc engine recycle fix: scope-close recycle is suspension,
not activity/race failure; user cancellation is still separated by the
persisted execution `interrupted` flag and the running workflow instance flag.

# tf-yib4 Phase 0 Wave-2B: Stream-Zip Restart-Replay

## Verdict

Restart-replay verdict: **GREEN**.

Phase 1 Lane 1 can claim restart-replay coverage for a runtime-context workflow body shaped as `Stream.zipLatest(inputs, outputs).runForEach(handler)`. The sim restarted the scoped host while the workflow was mid-stream, reattached to the same workflow execution, pushed post-restart input/output rows, and observed continued handling on host generation 2.

Addendum scenario (c) verdict: **HANDLER-NEEDS-SEQ-TRACKING**.

The handler sees replayed earlier `(input, output)` pairs after the scoped bounce. The generation 2 trace includes two replay observations of `(input sequence 0, output sequence 0)` before it handles the new `(input sequence 1, output sequence 1)` pair. Stable workflow Activity names suppressed duplicate `session.send` side effects in this sim, but Phase 1 Lane 1 should keep explicit sequence tracking/checkpointing around handler work that must run exactly once.

## Source-Verified Claims

The SDD asks Wave-2B to combine the INV-1 stream-zip body with the INV-3 scoped-bounce pattern, push pre- and post-restart rows, and assert continued handling by the same context workflow. It defines `GREEN` as the condition where Phase 1 Lane 1 can claim restart-replay coverage (`docs/sdds/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md:125-147`) and makes Wave-2B `GREEN` an acceptance gate for Lane 1 (`docs/sdds/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md:229-230`).

The runtime output journal contract is replay-oriented: `forContext` observes all rows for the context across every activity attempt from the beginning (`packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts:25-37`). The host per-context implementation has the same replay shape: the stream includes every decoded observation for the context, including initial-state replay (`packages/host-sdk/src/host/per-context-runtime-output.ts:197-216`).

The sim registers a workflow named `firegrid.runtime-context` with the stream-zip body, using `Stream.zipLatest(runtimeInputStream(...), runtimeOutputStream(...)).pipe(Stream.runForEach(...))` (`packages/firelab/src/simulations/phase0-wave-2b-stream-zip-restart-replay/host.ts:524-585`). The driver starts generation 1, appends input/output sequence 0, bounces to generation 2, re-executes the same workflow id, appends input/output sequence 1, and waits for generation 2 handling (`packages/firelab/src/simulations/phase0-wave-2b-stream-zip-restart-replay/host.ts:890-933`).

## Trace-Amplified Claims

Clean run:

```text
run: 2026-05-20T08-35-46-802Z__phase0-wave-2b-stream-zip-restart-replay
trace: packages/firelab/.simulate/runs/2026-05-20T08-35-46-802Z__phase0-wave-2b-stream-zip-restart-replay/trace.jsonl
outcome: DriverCompleted
spans: 266
```

The probe span recorded the restart verdict and addendum verdict:

```json
{
  "firegrid.wave2b.verdict": "GREEN",
  "firegrid.wave2b.dedup_verdict": "HANDLER-NEEDS-SEQ-TRACKING",
  "firegrid.wave2b.execution_id": "runtime-context:ctx_phase0_wave_2b_stream_zip_restart_replay",
  "firegrid.wave2b.gen1_pair_count": 1,
  "firegrid.wave2b.gen2_pair_count": 4,
  "firegrid.wave2b.gen2_replayed_pair_count": 2,
  "firegrid.wave2b.gen1_emission_count": 1,
  "firegrid.wave2b.gen2_emission_count": 1,
  "firegrid.wave2b.gen2_duplicate_send_suppressed": true,
  "firegrid.wave2b.execution_rows": 1
}
```

Both host generations attached to the same execution id:

```json
{"name":"firegrid.wave2b.host_generation","attributes":{"firegrid.wave2b.generation":1,"executionId":"runtime-context:ctx_phase0_wave_2b_stream_zip_restart_replay"}}
{"name":"firegrid.wave2b.host_generation","attributes":{"firegrid.wave2b.generation":2,"executionId":"runtime-context:ctx_phase0_wave_2b_stream_zip_restart_replay"}}
```

The stream-zip handler saw one pair before restart and four pairs after restart:

```json
{"firegrid.wave2b.generation":1,"firegrid.input.sequence":0,"firegrid.runtime.output.sequence":0,"firegrid.agent_output.event_tag":"Ready"}
{"firegrid.wave2b.generation":2,"firegrid.input.sequence":0,"firegrid.runtime.output.sequence":0,"firegrid.agent_output.event_tag":"Ready"}
{"firegrid.wave2b.generation":2,"firegrid.input.sequence":0,"firegrid.runtime.output.sequence":0,"firegrid.agent_output.event_tag":"Ready"}
{"firegrid.wave2b.generation":2,"firegrid.input.sequence":1,"firegrid.runtime.output.sequence":0,"firegrid.agent_output.event_tag":"Ready"}
{"firegrid.wave2b.generation":2,"firegrid.input.sequence":1,"firegrid.runtime.output.sequence":1,"firegrid.agent_output.event_tag":"Status"}
```

The generation 1 send was not duplicated after restart. Only the pre-restart input and the post-restart input produced `session.send` spans:

```json
{"firegrid.runtime.command_id":"wave2b-input-ctx_phase0_wave_2b_stream_zip_restart_replay-wave2b-input-0"}
{"firegrid.runtime.command_id":"wave2b-input-ctx_phase0_wave_2b_stream_zip_restart_replay-wave2b-input-1"}
```

## Implementation Notes

The sim lives at `packages/firelab/src/simulations/phase0-wave-2b-stream-zip-restart-replay/` and uses the standard four-field `defineSimulation` contract (`index.ts`, `host.ts`, `driver.ts`). The host code computes and records the addendum verdict directly from generation 2 replay observations (`host.ts:936-978`).

## Validation

- `pnpm --filter firelab typecheck` passed.
- `pnpm --filter firelab simulate:run phase0-wave-2b-stream-zip-restart-replay` passed with `DriverCompleted`.
- `pnpm run verify` passed.

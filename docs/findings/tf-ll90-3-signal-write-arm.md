# tf-ll90.3 Signal Write+Arm

Date: 2026-06-01

Verdict: GREEN for the minimal SignalTable-backed write+arm fix.

## What Changed

- `sendSignal` can now arm with create-or-resume instead of resume-only.
- `session.start()` arms the runtime-context session workflow synchronously; it no longer forks and returns a synthetic offset before the execution exists.
- `session.prompt()` writes the existing `SignalTable` row, then arms the session workflow.
- `FiregridHost` wires `recoverPendingSignals` after runtime-context workflow registration, bounded to SignalTable-owned executions.
- Terminal emission is an internal helper only; public cancel/close proof is deferred to `.4` / `.5`.

## Runtime Proof

`pnpm --filter @firegrid/runtime exec vitest run test/unified/signal-write-arm.test.ts`

- prompt-before-start creates the session workflow execution and reaches the adapter.
- startup recovery replays a persisted signal row whose original arm was lost (`replayed=1`).

## Public RUN Proof

Command: `pnpm --filter firelab simulate run unified-kernel-validation`

The driver used only `@firegrid/client-sdk` + `effect`. No terminal latch or host-side backdoor was added.

| Run | total spans | execution.execute | adapter.start_or_attach | local_process.open_byte_pipe | signal recovery span |
|---|---:|---:|---:|---:|---:|
| `2026-06-01T23-26-55-436Z__unified-kernel-validation` | 427 | 13 | 1 | 1 | 1 |
| `2026-06-01T23-28-00-825Z__unified-kernel-validation` | 409 | 12 | 1 | 1 | 1 |
| `2026-06-01T23-28-37-500Z__unified-kernel-validation` | 421 | 13 | 1 | 1 | 1 |
| `2026-06-01T23-29-13-455Z__unified-kernel-validation` | 421 | 13 | 1 | 1 | 1 |
| `2026-06-01T23-29-49-367Z__unified-kernel-validation` | 420 | 13 | 1 | 1 | 1 |

Span names:

- `firegrid.workflow_engine.execution.execute`
- `firegrid.unified.adapter.start_or_attach`
- `firegrid.agent_event_pipeline.source.local_process.open_byte_pipe`
- `firegrid.unified.signal.recover`

## Note

The tiny RUN proof covers fresh start -> prompt -> real agent output. Restart recovery is proven by the runtime test because the current sim runner has no public-client-only host restart control; adding a driver-reachable terminal or restart latch would violate the simulation airgap.

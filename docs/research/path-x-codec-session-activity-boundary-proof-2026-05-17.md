# Path X Codec Session Activity Boundary Proof

Date: 2026-05-17

Scope: Lane 2 / Q-2 proof for `docs/sdds/SDD_PATH_X_IMPLEMENTATION.md`.
This note is intentionally limited to the local-process codec/session shape.
It does not rewrite the runtime substrate or commit ACP to a final shape.

## Question

`SDD_PATH_X_IMPLEMENTATION.md` asks for the smallest proof of a
`CodecSessionAlive` activity plus external sandbox supervisor, replay behavior
around restart, and byte emission represented as an `Activity.make` side effect
while preserving the current local-process at-most-once invariant
(`docs/sdds/SDD_PATH_X_IMPLEMENTATION.md:154`).

The substrate spike identifies this as the real open Q-2: a long-running ACP
session might live as one `CodecSessionAlive` activity plus supervisor, or replay
might force a thinner host-scoped live session process
(`docs/research/workflow-native-runtime-substrate-spike-2026-05-16.md:768`).

## Current Invariant

Today local-process stdin delivery preserves at-most-once by claiming before
emitting bytes. The production source documents that the durable claim upsert is
awaited before bytes are emitted and that a restart after claim skips the row
(`packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process-stdin-delivery.ts:9`).
The existing test injects a failure after claim and before emit, then proves the
second run emits no chunks
(`packages/runtime/test/sources/sandbox/local-process-stdin-delivery.test.ts:96`,
`:186`).

## Proof Added

The proof test adds a minimal supervisor service:
`CodecSessionAliveSupervisor.emitStdin(...)`
(`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:78`).
The workflow body constructs a deterministic `Activity.make` named
`codec-session-alive.emit-stdin.<inputId>` and calls the supervisor from inside
the activity (`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:530`).

The first execution emits bytes and then suspends on a durable deferred
(`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:537`).
The test then reconstructs the engine with a different worker id, completes the
deferred, re-executes the workflow, and asserts:

- the activity row exists after the first run;
- completion after reconstruction returns the deferred value;
- the supervisor emission array still contains exactly one byte emission;
- the activity row count remains one
  (`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:549`,
  `:565`, `:580`).

This proves the replayable slice: once the byte-emission activity has completed
and its activity result is stored, workflow replay after restart short-circuits
through Durable Streams state instead of calling the sandbox supervisor again.

## Boundary Finding

The proof is a conditional go for the local-process reactive body shape:
completed byte-emission activities replay cleanly across engine reconstruction.
It is not enough, by itself, to make a live codec session fully replayable.

The important boundary is where the durable fence is placed. The workflow
engine checks for an existing activity result, claims the activity, executes the
activity, and only then upserts the activity result
(`packages/runtime/src/workflow-engine/internal/engine-runtime.ts:193`,
`:204`, `:228`, `:232`). That means a plain activity result row alone does not
cover a crash after external byte emission but before the activity result write.
The current stdin invariant is stronger because its delivery claim is written
before emission.

Therefore the implementation shape should keep an external sandbox supervisor
with its own content-addressed emission command/claim, and invoke that
supervisor through `Activity.make`. The activity is the workflow replay boundary;
the supervisor command/claim is the pre-emission at-most-once fence.

## Go / No-Go

Go for Path X PR planning with this constraint:

- local-process byte emission can be modeled as an `Activity.make` side effect
  over a host/sandbox supervisor;
- the supervisor API must be claim/command-shaped, not "write raw bytes and
  hope the activity result commits";
- the workflow body can suspend on durable deferreds and replay after restart
  without duplicate completed byte emissions.

Do not build a generic Firegrid codec-session framework in this lane.

## Fallback

If ACP cannot tolerate the same supervisor model, keep the reactive workflow
body and durable deferred command model, but run the codec process as a thin
host-scoped live session. The workflow would enqueue/claim commands and observe
outputs; the live host process would own protocol liveness. This is the fallback
already allowed by the Path X SDD
(`docs/sdds/SDD_PATH_X_IMPLEMENTATION.md:166`).


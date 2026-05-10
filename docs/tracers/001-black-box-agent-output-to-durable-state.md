# 001: Black-Box Agent Output To Runtime Events

Date: 2026-05-08

Status: planned

Substrate: this tracer is built on `@effect/workflow` for durable workflows,
activities, and attempt tracking, plus Durable Streams for append-only HTTP
streams and offset-based reads. Where this document uses terms like row, offset,
or attempt, the underlying primitive comes from one of those substrates unless
otherwise stated.

## Goal

Prove the smallest end-to-end path from:

```txt
user launches an agent that speaks some transport or wire format
```

to:

```txt
agent output stream lands in durable runtime output data-plane events
```

The first concrete provider target is Claude Code CLI using
`--output-format stream-json`. The architectural target is broader: any launched
agent can be treated as a black-box process whose observable I/O becomes a
durable runtime output data-plane events.

Downstream consumers of that journal are intentionally out of scope for this
bullet. Session-shaped materialization is tracer 002. Permission workflows over
runtime events are tracer 003.

## Non-Goals

- Full Claude Code schema coverage.
- ACP as the only provider interface.
- Direct use of provider SDK internals.
- Remote sandbox deployment.
- Process restart and resume.
- Session-shaped materialization.
- Tool permission loops.
- Choreography between multiple agents.

## Starting Point

A user or app calls `launch(...)`. The public request stays narrow: it chooses
a provider helper and supplies that provider's minimal configuration. It does
not provide a runtime context id, stream names, journal config, bindings, or session
semantics.

Example public shape:

```ts
import { local } from "@firegrid/protocol/launch"

const handle = yield* firegrid.launch({
  runtime: local.jsonl({
    argv: [
      "claude",
      "--bare",
      "-p",
      "Reply with exactly: pong",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
    ],
  }),
})
```

The provider helper owns the provider-specific fixed configuration. In this
case, `local.jsonl(...)` means stdout is JSONL runtime event and stderr is
runtime log text. Other providers can expose different typed helpers without
widening the public `launch(...)` surface.

Internally, Firegrid normalizes the public request into a durable runtime context row.
The internal row describes:

- the runtime target to launch;
- the command and arguments;
- which live process outputs should be journaled durably;
- which live process outputs should become data-plane output events;
- optional environment or secret references needed by the process.

Example internal shape:

```ts
const context = {
  contextId: "ctx_123",
  createdAt: "2026-05-08T00:00:00.000Z",
  runtime: {
    provider: "local-process",
    config: {
      argv: [
        "claude",
        "--bare",
        "-p",
        "Reply with exactly: pong",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "1",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
      ],
    },
    journal: [
      {
        source: "stdout",
        format: "jsonl",
        target: "events",
      },
      {
        source: "stderr",
        format: "text-lines",
        target: "logs",
      },
    ],
  },
}
```

This is not an RPC call. The normalized runtime context row is control-plane
data in Durable Streams State Protocol.

`journal` is internal durable journaling configuration, not public observability
telemetry. It maps live output sources to Durable Streams destinations. The
first tracer uses stdout/stderr, and extra structure should be added only when
another source kind needs it.

## Prerequisite: Thin Client Launch Surface

Before implementing this tracer, the client launch API must be narrowed to a
producer-only surface. The client should append normalized launch intent and
return a handle; it should not expose runtime process authority or ask callers
to thread internal identifiers and stream wiring.

Client launch input should be limited to:

```ts
firegrid.launch({
  runtime: local.jsonl({
    argv: ["claude", "--bare", "-p", "...", "--output-format", "stream-json", "--verbose"],
  }),
})
```

The client must not require:

- caller-provided `contextId`;
- `planes`;
- `bindings`;
- explicit `journal`;
- stream URLs or stream names;
- readiness, rebuild, or restart policy.

Those fields belong to the internal normalized runtime context row or provider helper
defaults. The workflow consumes the normalized row; the client only produces it.

## Prerequisite: Sandbox Streaming Contract

Before implementing this tracer, the sandbox layer must expose the right live
execution boundary. A sandbox provider is responsible for turning a configured
execution environment into non-durable live command events. The workflow
activity is responsible for consuming those events and journaling them durably.

The sandbox interface should align with the data-processing-pipeline shape:

```ts
interface SandboxProvider {
  create(options: SandboxCreateOptions): Effect.Effect<Sandbox, SandboxError>
  getOrCreate(options: SandboxGetOrCreateOptions): Effect.Effect<Sandbox, SandboxError>
  find(labels: Record<string, string>): Effect.Effect<Sandbox | undefined, SandboxError>
  execute(sandbox: Sandbox, command: SandboxCommand): Effect.Effect<ExecutionResult, SandboxError>
  executeMany(
    sandbox: Sandbox,
    commands: ReadonlyArray<SandboxCommand>,
  ): Effect.Effect<ReadonlyArray<ExecutionResult>, SandboxError>
  stream(
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Stream.Stream<ProcessOutputChunk, SandboxError>
  upload(sandbox: Sandbox, localPath: string, remotePath: string): Effect.Effect<void, SandboxError>
  download(sandbox: Sandbox, remotePath: string, localPath: string): Effect.Effect<void, SandboxError>
  destroy(sandbox: Sandbox): Effect.Effect<boolean, SandboxError>
}
```

The launch tracer depends specifically on `stream(...)`:

```ts
type ProcessOutputChunk =
  | {
      type: "output"
      channel: "stdout" | "stderr"
      text: string
    }
  | {
      type: "exit"
      exitCode: number
      signal?: string
    }
```

`stream(...)` is not durable. It exposes live process output from local,
container, or remote execution providers. The launch workflow consumes that
stream and appends durable runtime event, runtime log, and run lifecycle rows
according to the normalized runtime context row.

## End Point

The durable streams contain:

- control-plane runtime context rows;
- control-plane run rows;
- data-plane runtime event rows journaled from stdout chunks;
- data-plane runtime log rows journaled from stderr chunks.

A client or downstream consumer can later read the runtime event rows without
access to the original process.

Example terminal observable journal entry:

```ts
{
  contextId: "ctx_123",
  activityAttempt: 1,
  source: "stdout",
  format: "jsonl",
  receivedAt: "2026-05-08T00:00:00.000Z",
  raw: "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"pong\"}]}}",
}
```

## Minimum Path

### 1. Append Runtime Context

The client calls `launch(...)`. Firegrid assigns the internal runtime context id and
appends the normalized runtime context row to the configured stream.

Durable fact:

```txt
runtime context created
```

### 2. Start Runtime Context Workflow

A launcher calls `RuntimeContextWorkflow.execute({ contextId })` after observing the
runtime context row. Because the workflow's `idempotencyKey` is `contextId`,
concurrent or repeated calls map to the same durable workflow execution.

The workflow's `run-process-attempt` activity crosses into the live world by
consuming `SandboxProvider.stream(...)`. Activity claiming is an internal
workflow-engine mechanism: if two workers race on the same execution and
activity attempt, only the worker that wins the activity claim consumes the
sandbox stream; the other observes the persisted claim and suspends.

Durable facts:

```txt
run attempt started
```

The process handle, PID, stdio pipes, and sandbox stream are live resources
only. They are not source-of-truth state.

### 3. Capture Runtime Output

The `run-process-attempt` activity consumes output chunks from
`SandboxProvider.stream(...)`. For this first bullet, stdout chunks are JSONL
from a black-box sandbox command.

Each observed stdout chunk is appended as a durable runtime event row before
any downstream consumer treats it as visible.

Example runtime event row:

```ts
{
  contextId: "ctx_123",
  activityAttempt: 1,
  source: "stdout",
  format: "jsonl",
  receivedAt: "2026-05-08T00:00:00.000Z",
  raw: "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"pong\"}]}}",
}
```

Malformed lines should also become durable runtime log/runtime event rows. The
tracer should not silently drop provider output.

### 4. Record Run Exit

When the sandbox stream emits an exit chunk, the activity appends a terminal
process row.

Durable facts:

```txt
run attempt exited
runtime context completed or failed
```

The process exit control-plane row does not replace runtime output data-plane
events. The data-plane journal is still the durable evidence of what the agent
emitted.

### 5. Stop At The Durable Journal

This tracer stops once the runtime event and runtime log data-plane events are
durable. It does not project runtime event rows into session resources.

The runtime output data-plane events are the decoupling surface. Later consumers can run
eagerly, lazily, or repeatedly against the retained journal:

```txt
runtime output data-plane events
  -> session materializer
  -> permission workflow
  -> runtime logs projector
  -> replay/debug tooling
```

## Workflow Primitive

This bullet should prove a reusable primitive:

```txt
Workflow = durable runtime execution coordinator
Activity = disposable interaction with the outside world
Data-plane stream events = durable evidence of live output
Process = live implementation detail
```

The runtime context lifecycle should be one workflow instance per context. The workflow
coordinates durable facts. It never stores the child process handle, PID, stdio
pipe, TCP socket, fiber id, or other live resource as authoritative state.

The workflow execution row is the runtime-context idempotency boundary. A separate
product-visible claim row is not required for correctness; repeated
or concurrent launchers should call `execute` and let the workflow engine
converge on the single execution for the context id. The activity claim row is
the worker-race boundary that prevents duplicate child process spawns for the
same execution and activity attempt.

Illustrative workflow shape:

```ts
const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: Schema.Struct({
    contextId: Schema.String,
  }),
  success: RuntimeContextTerminalState,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => contextId,
})

const RuntimeContextWorkflowLayer = RuntimeContextWorkflow.toLayer(
  Effect.fn(function* runRuntimeContext({ contextId }) {
    const controlPlane = yield* RuntimeControlPlane
    const captureJournal = yield* RuntimeCaptureJournal

    const context = yield* Activity.make({
      name: "firegrid.runtime-context.read-context",
      success: RuntimeContext,
      error: RuntimeContextError,
      execute: requireContext(controlPlane, contextId),
    })

    return yield* Activity.make({
      name: "firegrid.runtime-context.run-process-attempt",
      success: ProcessAttemptResult,
      error: RuntimeContextError,
      execute: Effect.gen(function* () {
        const activityAttempt = yield* Activity.CurrentAttempt
        const provider = yield* SandboxProvider
        const output = yield* captureJournal.openAttempt({ contextId, activityAttempt })
        const command = yield* commandForContext(context)
        const sandbox = yield* provider.getOrCreate({ config: context.runtime.config })

        yield* controlPlane.appendRunStarted({
          contextId,
          activityAttempt,
          provider: context.runtime.provider,
        })

        const exit = yield* provider.stream(sandbox, command).pipe(
          Stream.tap((chunk) => {
            if (chunk.type === "output") {
              const row = runtimeOutputRowFromChunk(context, activityAttempt, chunk)
              return output.write(row)
            }
            return Effect.void
          }),
          Stream.filter(
            (chunk): chunk is Extract<ProcessOutputChunk, { type: "exit" }> =>
              chunk.type === "exit",
          ),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => new RuntimeContextError({ reason: "process stream ended without exit chunk" }),
              onSome: (chunk) =>
                output.flush.pipe(
                  Effect.zipRight(controlPlane.appendRunExited({
                    contextId,
                    activityAttempt,
                    provider: context.runtime.provider,
                    exitCode: chunk.exitCode,
                    signal: chunk.signal,
                  })),
                  Effect.as({ exitCode: chunk.exitCode, signal: chunk.signal }),
                ),
            }),
          ),
        )

        return { activityAttempt, exit }
      }),
    })
  }),
)
```

`RuntimeControlPlane` is a thin StreamDB service for context and run state.
`RuntimeCaptureJournal` is a raw Durable Streams writer for stdout/stderr
data-plane events. The workflow depends on both so the control/data boundary is
visible at the call site.

The launcher that observes runtime context rows does not implement its own
claiming protocol. It executes the workflow and lets the workflow engine's
execution idempotency and activity claims provide the concurrency boundary:

```ts
const startRuntime = (contextId: string) =>
  Effect.scoped(
    RuntimeContextWorkflow.execute({ contextId }).pipe(
      Effect.provide(
        RuntimeContextWorkflowLayer.pipe(
          Layer.provide(RuntimeControlPlaneLive),
          Layer.provide(RuntimeCaptureJournalLive),
          Layer.provide(SandboxProviderLive),
          Layer.provide(DurableStreamsWorkflowEngine.layer({
            streamUrl: launchWorkflowStreamUrl,
          })),
        ),
      ),
    ),
  )
```

That activity is the boundary between durable workflow coordination and live
sandbox execution. The sandbox provider owns non-durable process mechanics and
emits `ProcessOutputChunk`s. The activity owns durable journaling. If the worker
dies mid-activity, already appended runtime output data-plane events remain durable; retry and
replacement-attempt behavior is deferred to a later tracer.

The first tracer should use the simpler activity-owned process attempt. The
important constraint is that product-visible facts still land in durable rows
before any downstream consumer treats them as observed.

`Effect.fn` names the workflow implementation, while `Effect.gen` is enough for
the already named activity bodies. Workflow-native primitives become useful
immediately after this tracer:

- `DurableClock.sleep` can model process start timeouts, execution timeouts,
  and restart backoff without adding another scheduler.
- `DurableDeferred` can model permission and human-in-the-loop decisions by
  appending a request row with a token, then waiting for an external resolver.
- `Activity.retry` can model disposable process attempts in a later restart
  tracer, where each attempt writes rows associated with
  `Activity.CurrentAttempt`.

## Invariants

These are the tracer-specific contracts not already guaranteed by
`@effect/workflow` or Durable Streams:

1. **Journal-before-consumption.** A runtime event row is durably appended and
   its Durable Streams offset is acknowledged before any downstream consumer
   observes its content.
2. **Exit-after-output.** `process.exited` is appended only after all prior
   output chunks emitted by the sandbox stream have been durably journaled.
3. **Parser isolation.** The launcher never parses provider-specific schema;
   downstream consumers do. Malformed lines become durable rows with a
   parse-failure marker, not silent drops.

## Data Flow

```txt
client
  calls launch(...)
    |
    v
Durable Streams control-plane stream
    |
    v
Firegrid launcher
  executes RuntimeContextWorkflow
  consumes SandboxProvider.stream(...)
  journals output chunks to data-plane stream
    |
    v
Durable Streams data-plane runtime event and runtime log events
```

Downstream consumers begin from those durable runtime output events in later
tracers.

## First Provider Command

The manually verified command shape is:

```sh
claude --bare -p 'Reply with exactly: pong' \
  --output-format stream-json \
  --verbose \
  --max-turns 1 \
  --no-session-persistence \
  --permission-mode dontAsk
```

`--output-format stream-json` requires `--verbose`. `--bare` keeps the tracer
closer to the process boundary by avoiding local hooks, plugins, memory loads,
and other environment-specific behavior.

## Acceptance Sketch

The tracer is complete when one automated check can prove:

1. `launch(...)` appends a normalized runtime context control-plane row;
2. `RuntimeContextWorkflow` executes `run-process-attempt`;
3. `run-process-attempt` consumes `SandboxProvider.stream(...)` for a real local
   command;
4. stdout JSONL chunks from that stream are appended to durable runtime event
   data-plane events;
5. stderr text chunks from that stream are appended to durable runtime log data-plane events;
6. a late consumer can read the runtime output data-plane events after the process exits.

## Follow-On Bullets

- Downstream materialization from runtime output data-plane events to session-shaped State
  Protocol resources.
- Permission workflows that subscribe to runtime output data-plane events and durably wait
  for human approval.
- Durable stdin delivery from user message rows into a long-lived process.
- Process death and replacement attempt with no lost durable runtime event rows.
- Remote sandbox launch with env/secret handoff.
- ACP stdio provider capture using the same runtime event seam.
- Workflow-backed multi-agent choreography over durable launch/session rows.

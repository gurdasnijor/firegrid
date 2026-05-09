# 001: Black-Box Agent Output To Provider-Wire Journal

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
agent event stream lands in a durable provider-wire journal
```

The first concrete provider target is Claude Code CLI using
`--output-format stream-json`. The architectural target is broader: any launched
agent can be treated as a black-box process whose observable I/O becomes a
durable provider-wire journal.

Downstream consumers of that journal are intentionally out of scope for this
bullet. Session-shaped materialization is tracer 002. Permission workflows over
provider events are tracer 003.

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
not provide a launch id, stream names, journal config, bindings, or session
semantics.

Example public shape:

```ts
import { local } from "@firegrid/runtime/durable-launch/providers"

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
case, `local.jsonl(...)` means stdout is JSONL provider-wire and stderr is
diagnostic text. Other providers can expose different typed helpers without
widening the public `launch(...)` surface.

Internally, Firegrid normalizes the public request into a durable launch row.
The internal row describes:

- the runtime target to launch;
- the command and arguments;
- which live process outputs should be journaled durably;
- which named streams receive those journaled rows;
- optional environment or secret references needed by the process.

Example internal shape:

```ts
const launch = {
  launchId: "launch_123",
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
        stream: "provider-wire",
      },
      {
        source: "stderr",
        format: "text-lines",
        stream: "diagnostics",
      },
    ],
  },
}
```

This is not an RPC call. The normalized launch row is data in Durable Streams.

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

- caller-provided `launchId`;
- `planes`;
- `bindings`;
- explicit `journal`;
- stream URLs or stream names;
- readiness, rebuild, or restart policy.

Those fields belong to the internal normalized launch row or provider helper
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
stream and appends durable provider-wire, diagnostic, and process lifecycle rows
according to the normalized launch row.

## End Point

The durable stream contains:

- launch lifecycle rows;
- process attempt rows;
- provider-wire rows journaled from stdout chunks;
- diagnostic rows journaled from stderr chunks.

A client or downstream consumer can later read the provider-wire journal without
access to the original process.

Example terminal observable journal entry:

```ts
{
  launchId: "launch_123",
  activityAttempt: 1,
  channel: "stdout",
  format: "jsonl",
  receivedAt: "2026-05-08T00:00:00.000Z",
  raw: "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"pong\"}]}}",
}
```

## Minimum Path

### 1. Append Launch Intent

The client calls `launch(...)`. Firegrid assigns the internal launch id and
appends the normalized launch intent row to the launch stream.

Durable fact:

```txt
launch requested
```

### 2. Start Launch Workflow

A launcher calls `LaunchAgentWorkflow.execute({ launchId })` after observing the
launch request row. Because the workflow's `idempotencyKey` is `launchId`,
concurrent or repeated calls map to the same durable workflow execution.

The workflow's `run-process-attempt` activity crosses into the live world by
consuming `SandboxProvider.stream(...)`. Activity claiming is an internal
workflow-engine mechanism: if two workers race on the same execution and
activity attempt, only the worker that wins the activity claim consumes the
sandbox stream; the other observes the persisted claim and suspends.

Durable facts:

```txt
process attempt started
```

The process handle, PID, stdio pipes, and sandbox stream are live resources
only. They are not source-of-truth state.

### 3. Capture Provider Wire Output

The `run-process-attempt` activity consumes output chunks from
`SandboxProvider.stream(...)`. For this first bullet, stdout chunks are JSONL
from a black-box sandbox command.

Each observed stdout chunk is appended as a durable provider-wire row before
any downstream consumer treats it as visible.

Example provider-wire row:

```ts
{
  launchId: "launch_123",
  activityAttempt: 1,
  channel: "stdout",
  format: "jsonl",
  receivedAt: "2026-05-08T00:00:00.000Z",
  raw: "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"pong\"}]}}",
}
```

Malformed lines should also become durable diagnostic/provider-wire rows. The
tracer should not silently drop provider output.

### 4. Record Process Exit

When the sandbox stream emits an exit chunk, the activity appends a terminal
process row.

Durable facts:

```txt
process attempt exited
launch completed or failed
```

The process exit row does not replace provider-wire rows. The provider-wire
journal is still the durable evidence of what the agent emitted.

### 5. Stop At The Durable Journal

This tracer stops once the provider-wire and diagnostic rows are durable. It
does not project provider rows into session resources.

The provider-wire journal is the decoupling surface. Later consumers can run
eagerly, lazily, or repeatedly against the retained journal:

```txt
provider-wire journal
  -> session materializer
  -> permission workflow
  -> diagnostics projector
  -> replay/debug tooling
```

## Workflow Primitive

This bullet should prove a reusable primitive:

```txt
Workflow = durable data-plane execution coordinator
Activity = disposable interaction with the outside world
Stream rows = durable evidence of what happened
Process = live implementation detail
```

The launch lifecycle should be one workflow instance per launch. The workflow
coordinates durable facts. It never stores the child process handle, PID, stdio
pipe, TCP socket, fiber id, or other live resource as authoritative state.

The workflow execution row is the launch-level idempotency boundary. A separate
product-visible `launch.claimed` row is not required for correctness; repeated
or concurrent launchers should call `execute` and let the workflow engine
converge on the single execution for the launch id. The activity claim row is
the worker-race boundary that prevents duplicate child process spawns for the
same execution and activity attempt.

Illustrative workflow definition:

```ts
export class LaunchError extends Schema.TaggedError<LaunchError>()("LaunchError", {
  reason: Schema.String,
  launchId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

class DurableLaunchDb extends Context.Tag("firegrid/DurableLaunchDb")<
  DurableLaunchDb,
  LaunchStreamDb
>() {}

const LaunchAgentWorkflow = Workflow.make({
  name: "firegrid.launch-agent",
  payload: Schema.Struct({
    launchId: Schema.String,
  }),
  success: LaunchTerminalState,
  error: LaunchError,
  idempotencyKey: ({ launchId }) => launchId,
})
```

Workflow implementation shape. This follows the upstream `@effect/workflow`
style: the workflow definition is separate, and the implementation is provided
with `Workflow.toLayer(...)`; durable side effects are expressed as
`Activity.make(...)` at the step where the workflow needs them.

```ts
const LaunchAgentWorkflowLayer = LaunchAgentWorkflow.toLayer(
  Effect.fn(function* runLaunchAgent({ launchId }) {
    const db = yield* DurableLaunchDb

    const launch = yield* Activity.make({
      name: "firegrid.launch-agent.read-launch-request",
      success: RuntimeLaunchRequest,
      error: LaunchError,
      execute: Effect.gen(function* () {
        const launch = db.collections.launchRequests.get(launchId)
        if (launch !== undefined) return launch
        return yield* new LaunchError({
          reason: "launch request not found",
          launchId,
        })
      }),
    })

    const attempt = yield* Activity.make({
      name: "firegrid.launch-agent.run-process-attempt",
      success: ProcessAttemptResult,
      error: LaunchError,
      execute: Effect.gen(function* () {
        const activityAttempt = yield* Activity.CurrentAttempt
        const provider = yield* SandboxProvider

        const sandbox = yield* provider.getOrCreate({
          labels: {
            firegridLaunchId: launch.launchId,
          },
          config: launch.runtime.config,
        })
        const command = yield* commandForLaunch(launch)

        yield* persistAction(
          db.actions.appendProcessEvent({
            type: "process.started",
            launchId: launch.launchId,
            activityAttempt,
            provider: launch.runtime.provider,
          }),
        )

        const exit = yield* provider.stream(sandbox, command).pipe(
          Stream.tap((chunk) => {
            if (chunk.type === "output") {
              return persistAction(db.actions.journalProcessOutput({
                launch,
                activityAttempt,
                chunk,
              }))
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
              onNone: () =>
                new LaunchError({
                  reason: "process stream ended without exit chunk",
                  launchId: launch.launchId,
                }),
              onSome: (chunk) =>
                persistAction(db.actions.appendProcessEvent({
                  type: "process.exited",
                  launchId: launch.launchId,
                  activityAttempt,
                  code: chunk.exitCode,
                  signal: chunk.signal,
                })).pipe(
                  Effect.as({
                    exitCode: chunk.exitCode,
                    signal: chunk.signal,
                  }),
                ),
            }),
          ),
        )

        return {
          activityAttempt,
          exit,
        }
      }),
    })

    return yield* Activity.make({
      name: "firegrid.launch-agent.finalize-launch",
      success: LaunchTerminalState,
      error: LaunchError,
      execute: persistAction(db.actions.finalizeLaunch({
        launchId,
        attempt,
      })),
    })
  }),
)
```

`DurableLaunchDb` is not a handwritten store abstraction. It is the acquired
`createStreamDB(...)` handle for the launch state schema, including its
optimistic local collections and transactional action helpers. `persistAction`
is only the small Effect wrapper around an action's `isPersisted.promise`.

The launcher that observes launch request rows does not implement its own
claiming protocol. It executes the workflow and lets the workflow engine's
execution idempotency and activity claims provide the concurrency boundary:

```ts
const runObservedLaunch = (launchId: string) =>
  Effect.scoped(
    LaunchAgentWorkflow.execute({ launchId }).pipe(
      Effect.provide(
        LaunchAgentWorkflowLayer.pipe(
          Layer.provide(DurableLaunchDbLive),
          Layer.provide(SandboxProviderLive),
          Layer.provide(layerDurableStreams({ streamUrl: launchWorkflowStreamUrl })),
        ),
      ),
    ),
  )
```

That activity is the boundary between durable workflow coordination and live
sandbox execution. The sandbox provider owns non-durable process mechanics and
emits `ProcessOutputChunk`s. The activity owns durable journaling. If the worker
dies mid-activity, already appended provider-wire rows remain durable; retry and
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

1. **Journal-before-consumption.** A provider-wire row is durably appended and
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
Durable Streams launch stream
    |
    v
Firegrid launcher
  executes LaunchAgentWorkflow
  consumes SandboxProvider.stream(...)
  journals output chunks
    |
    v
Durable Streams provider-wire and diagnostics rows
```

Downstream consumers begin from that durable provider-wire journal in later
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

1. `launch(...)` appends a normalized launch intent row;
2. `LaunchAgentWorkflow` executes `RunProcessAttempt`;
3. `RunProcessAttempt` consumes `SandboxProvider.stream(...)` for a real local
   command;
4. stdout JSONL chunks from that stream are appended to durable provider-wire
   rows;
5. stderr text chunks from that stream are appended to durable diagnostic rows;
6. a late consumer can read the provider-wire journal after the process exits.

## Follow-On Bullets

- Downstream materialization from provider-wire journal to session-shaped State
  Protocol resources.
- Permission workflows that subscribe to provider-wire rows and durably wait
  for human approval.
- Durable stdin delivery from user message rows into a long-lived process.
- Process death and replacement attempt with no lost durable provider rows.
- Remote sandbox launch with env/secret handoff.
- ACP stdio provider capture using the same provider-wire journaling seam.
- Workflow-backed multi-agent choreography over durable launch/session rows.

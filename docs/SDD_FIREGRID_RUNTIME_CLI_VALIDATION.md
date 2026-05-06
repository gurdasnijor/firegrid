# SDD: Firegrid Runtime CLI Scenario Validation

Status: Draft
Product: Firegrid
Related: `firegrid-operation-messaging`, `firegrid-runtime-process`, `launchable-substrate-host`, `durable-waits-and-scheduling`, `firegrid-event-streams`

## Summary

Firegrid already has most of the machinery needed for runtime validation:

1. Durable Streams has a CLI for creating, writing, reading, and following JSON
   streams.
2. Firegrid has Effect Schema types and protocol builders for durable rows,
   operation envelopes, EventStream envelopes, runs, completions, and
   projections.
3. Firegrid runtime can attach to an existing stream and run handler/subscriber
   Layers.
4. Firegrid has projection/read-model code that can rebuild or observe durable
   state.

The missing piece is a small set of concrete scenarios that prove these pieces
work together from the durable stream boundary.

This SDD does not propose a new client API, fixture generator, CLI wrapper,
embedded dev server, or runtime control plane. It defines scenario validation:
write schema-valid rows with the Durable Streams CLI, run the Firegrid runtime,
and inspect the resulting durable state.

## Validation Boundary

The scenario boundary is the durable stream itself:

```txt
Durable Streams CLI writes schema-valid Firegrid rows
Firegrid runtime attaches to the existing stream
runtime handlers/subscribers advance durable state
Durable Streams CLI or Firegrid read models inspect the result
```

The CLI writes JSON. Firegrid owns how that JSON is interpreted through Effect
Schema decoding and protocol/read-model code. Scenario input rows are emitted
by TypeScript files under `scenarios/firegrid/src/emitters/`; those files
import the real Effect Schema descriptors and protocol builders and write JSON
rows to stdout through the shared scenario runner.
They are not checked-in JSON fixtures and are not runtime support surfaces.

Input-side emitters use a small emit-only scenario contract. Each emitter
declares descriptors/schemas and composes a declarative stream of substrate
ChangeEvent rows; the shared writer owns newline-delimited JSON formatting for
stdout. The contract is intentionally one-dimensional: it does not read streams,
inspect projections, run runtime graphs, start servers, or act as an app client.
Receiver files remain separate app-owned `run({ connection, runtime })`
entrypoints, and `inspect` remains a read-only projection tool.

`firegrid-runtime-process.SCENARIOS.15` keeps scenario execution behind one
typed registry and CLI runner. Scenario modules define emit-only row streams,
receiver runtime entrypoints, seed rows, and self-test expectations; the runner
owns NDJSON writing, stream URL / environment parsing, receiver dispatch, and
Durable Streams self-test lifecycle.

The expected local shell shape is:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json
pnpm --silent --filter @firegrid/scenarios run <scenario> \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done
durable-stream read firegrid
```

The Firegrid runtime attaches to the same stream:

```sh
DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid \
  pnpm --filter @firegrid/runtime run firegrid
```

Firegrid does not wrap the Durable Streams CLI. Firegrid does not start the
Durable Streams server. Firegrid does not spawn child dev processes.

Scenario emitters prove the CLI-write input side. Terminalizing operation
scenarios still requires an app-owned runtime process with the relevant handler
graph supplied through the typed `run(...)` API described in
`docs/SDD_FIREGRID_TYPED_RUNTIME_RUN_API.md`. The default `firegrid` binary
attaches to the stream without hard-coded scenario-specific handler Layers and
must not discover app graphs through dynamic module-loading flags.

## What Is Missing

The repo is not missing row schemas, protocol decoders, runtime Layers, or
projection machinery. It is missing scenario-level validation that answers:

1. Which exact rows should a developer write to exercise runtime behavior?
2. Which runtime Layer should be running for that scenario?
3. Which projection/read-model result proves success?
4. Which scenario is the next one to run after the basic Echo path?

## Scenario Set

### Scenario 1: Echo Operation

Purpose: prove the smallest operation-message path.

Input:

1. A schema-valid operation-started row for an `Echo` operation.
2. A runtime Layer that installs an `Echo` handler.

Expected result:

1. Runtime decodes the operation input through the operation descriptor schema.
2. Handler receives `CurrentWorkContext`.
3. Runtime appends the terminal run result.
4. Rebuilt projection shows the run completed with `{ message, length }`.

This scenario proves the runtime handler path without using `@firegrid/client`.

Manual CLI input flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run echo \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

durable-stream read firegrid
```

The Echo emitter derives the row from `Operation.define`, the operation input
schema, `OperationEnvelopeSchema`, `RunValue`, and the existing `startRun`
protocol builder. For the default Echo input it writes this single JSON line to
stdout:

```json
{"type":"durable.run","key":"run-echo-cli-1","value":{"runId":"run-echo-cli-1","state":"started","data":{"_envelope":"firegrid/operation@1","operation":"Echo","payload":{"message":"hello firegrid"}}},"headers":{"operation":"insert"}}
```

Once a runtime with the Echo handler graph is attached, the runtime should
append a terminal `durable.run` upsert whose value includes:

```json
{
  "runId": "run-echo-cli-1",
  "state": "completed",
  "result": {
    "message": "hello firegrid",
    "length": 14
  }
}
```

Manual receiver-side flow:

Terminal 1:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run echo \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done
```

Terminal 2:

```sh
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
pnpm --filter @firegrid/scenarios run echo-receiver -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Terminal 1:

```sh
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

The Echo receiver is an app-owned TypeScript entrypoint under
`scenarios/firegrid/`. It imports the same `EchoOperation` descriptor as the
emitter, installs `Firegrid.handler(EchoOperation, ...)`, and starts the graph
with `run({ connection, runtime })`. The receiver process is long-running; stop
it after the inspection report shows `run-echo-cli-1` as `completed` with:

```json
{
  "message": "hello firegrid",
  "length": 14
}
```

Relevant ACIDs:

- `firegrid-operation-messaging.OPERATIONS.1`
- `firegrid-operation-messaging.OPERATIONS.2`
- `firegrid-operation-messaging.OPERATIONS.3`
- `firegrid-operation-messaging.OPERATIONS.4`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.1`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.2`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.3`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.4`
- `firegrid-runtime-process.RUNTIME_RUN_API.1`
- `firegrid-runtime-process.RUNTIME_RUN_API.2`
- `firegrid-runtime-process.RUNTIME_RUN_API.3`
- `firegrid-runtime-process.RUNTIME_RUN_API.4`
- `firegrid-runtime-process.RUNTIME_RUN_API.5`
- `firegrid-runtime-process.RUNTIME_RUN_API.6`
- `firegrid-runtime-process.RUNTIME_RUN_API.7`
- `firegrid-runtime-process.RUNTIME_RUN_API.8`
- `firegrid-runtime-process.RUNTIME_RUN_API.9`
- `firegrid-runtime-process.READY_WORK_OPERATOR.7`
- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.2`
- `firegrid-runtime-process.SCENARIOS.7`
- `firegrid-runtime-process.SCENARIOS.10`

### Scenario 2: waitFor Projection Match

Purpose: prove durable suspension through a caller-owned EventStream and a
projection-match completion.

Input:

1. A schema-valid operation-started row for an operation whose handler calls
   `waitFor`.
2. A schema-valid EventStream row that should satisfy the projection predicate.
3. A runtime Layer with the operation handler and projection-match subscriber.

Expected result:

1. The operation blocks on a durable completion.
2. The EventStream row is not treated as a substrate-native row family.
3. Projection-match subscriber resolves the completion when the predicate
   becomes true.
4. Runtime resumes or terminalizes the run according to existing run/completion
   rules.
5. Rebuilt projection proves the run no longer remains stuck in blocked state.

Relevant ACIDs:

- `durable-waits-and-scheduling.WAIT_FOR.1`
- `durable-waits-and-scheduling.WAIT_FOR.6`
- `durable-waits-and-scheduling.WAIT_FOR.7`
- `durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1`
- `durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.4`
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.2`
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.3`
- `firegrid-event-streams.CLIENT_API.5`
- `firegrid-event-streams.SCHEMA_OWNERSHIP.3`
- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.2`
- `firegrid-runtime-process.SCENARIOS.3`
- `firegrid-runtime-process.SCENARIOS.10`
- `launchable-substrate-host.SCENARIOS.3`

Manual CLI input flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run wait-for \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

durable-stream read firegrid
```

The waitFor emitter derives the operation row from `Operation.define`, the
operation input schema, `ProjectionMatchTriggerSchema`,
`OperationEnvelopeSchema`, `RunValue`, and `startRun`. It derives the matching
caller-owned event row from `EventStream.define`, the EventStream event schema,
and `makeEventStreamStateRow`. For the default input it writes these JSON lines
to stdout:

```json
{"type":"durable.run","key":"run-wait-for-cli-1","value":{"runId":"run-wait-for-cli-1","state":"started","data":{"_envelope":"firegrid/operation@1","operation":"WaitForPermission","payload":{"permissionId":"permission-cli-1","trigger":{"_tag":"ProjectionMatch","label":"permission-approved:permission-cli-1","projectionKey":"PermissionEvents:permission:permission-cli-1","matcherId":"scenario.permission.approved"}}}},"headers":{"operation":"insert"}}
{"type":"firegrid.event","key":"PermissionEvents:event-permission-approved-cli-1","value":{"_envelope":"firegrid/event@1","stream":"PermissionEvents","event":{"permissionId":"permission-cli-1","status":"approved","actor":"scenario"}},"headers":{"operation":"insert"}}
```

These rows prove only the CLI-write input side. The runtime receiver side still
requires a runtime graph that installs a `WaitForPermission` handler and a
projection-match subscriber/evaluator for `scenario.permission.approved`.

Receiver-side validation uses a separate app-owned runtime entrypoint rather
than hard-coding scenario behavior in the Firegrid binary. The receiver runtime
composes `Firegrid.subscribers.projectionMatch(...)` with
`Firegrid.handler(WaitForPermissionOperation, ...)` through
`run({ connection, runtime })`; it does not import `@firegrid/client`, load an
app graph dynamically, or start a Durable Streams dev server.

Manual receiver-side flow:

Terminal 1:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
durable-stream create firegrid --json
```

Terminal 2:

```sh
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
pnpm --filter @firegrid/scenarios run wait-for-receiver -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Terminal 1:

```sh
pnpm --silent --filter @firegrid/scenarios run wait-for \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done
```

Terminal 1:

```sh
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Inspection should show `run-wait-for-cli-1` as `completed`, one
`projection_match` completion as `resolved`, and the caller-owned
`PermissionEvents` EventStream row. The receiver evaluator matches
`scenario.permission.approved` by the trigger's canonical projection key
(`PermissionEvents:permission:<permissionId>`) and the approved EventStream
record.

Focused automated validation is available through:

```sh
pnpm --filter @firegrid/scenarios run wait-for-receiver:self-test
```

That check starts a package-local Durable Streams test server, writes the same
operation and EventStream rows as the CLI emitter while the app-owned receiver
runtime is running, and verifies projection-match completion resolution plus
ready-work terminalization through the same inspection projection.

### Scenario 3: scheduleAt / Scheduled Work

Purpose: prove scheduled operation or scheduled work behavior without adding a
second scheduler.

Input:

1. A schema-valid row that creates scheduled work or an operation lowering to
   scheduled work.
2. Runtime scheduled-work subscriber Layer.

Expected result:

1. The row lowers to the existing scheduled-work completion semantics.
2. Nothing resolves before the due time.
3. Runtime/subscriber resolves the completion after the due time.
4. Rebuilt projection shows ready/completed state according to existing rules.

Relevant ACIDs:

- `firegrid-operation-messaging.SCHEDULED_MESSAGES.1`
- `firegrid-operation-messaging.SCHEDULED_MESSAGES.2`
- `firegrid-operation-messaging.SCHEDULED_MESSAGES.3`
- `durable-waits-and-scheduling.SCHEDULE_WORK.1`
- `durable-waits-and-scheduling.SCHEDULE_WORK.6`
- `durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1`
- `durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4`
- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.2`
- `firegrid-runtime-process.SCENARIOS.4`
- `firegrid-runtime-process.SCENARIOS.10`
- `launchable-substrate-host.SCENARIOS.2`

Manual CLI input flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run scheduled-work \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

durable-stream read firegrid
```

The scheduled-work emitter derives the pending completion row from
`ScheduledWorkCompletionData` and `createPendingCompletion`. It writes a
substrate-generic `scheduled_work` completion because scenario emission proves
the durable stream input side; a higher-level app may map `scheduleAt` onto the
same row shape. For the default input it writes this JSON line to stdout:

```json
{"type":"durable.completion","key":"completion-scheduled-work-cli-1","value":{"completionId":"completion-scheduled-work-cli-1","workId":"run-scheduled-work-cli-1","kind":"scheduled_work","state":"pending","data":{"whenMs":1893456000000,"input":{"reminderId":"reminder-cli-1","message":"follow up from scheduled work"}}},"headers":{"operation":"insert"}}
```

This row proves only the CLI-write input side. The runtime receiver side still
requires a runtime graph that installs the scheduled-work subscriber and any
ready-work or operator loop needed by the application scenario.

Receiver-side validation uses a separate app-owned runtime entrypoint rather
than hard-coding scenario behavior in the Firegrid binary. The receiver seed
rows reuse the scheduled-work completion emitter and add the matching blocked
operation run needed by the existing ready-work projection:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
durable-stream create firegrid --json

export WHEN_MS=$(node -e 'console.log(Date.now() + 3000)')

pnpm --silent --filter @firegrid/scenarios run scheduled-work-receiver -- \
  --seed-rows --when-ms "$WHEN_MS" \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Start the app-owned receiver runtime in another terminal:

```sh
DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid \
  pnpm --filter @firegrid/scenarios run scheduled-work-receiver
```

Inspection before `WHEN_MS` should show `completion-scheduled-work-cli-1` as
`pending` and `run-scheduled-work-cli-1` as `blocked`. Inspection after
`WHEN_MS` should show the scheduled-work completion as `resolved` with
`{ whenMs, input }`, and the same run as `completed` with the
`ScheduledReminder` handler result. The receiver runtime composes
`Firegrid.subscribers.scheduledWork` with `Firegrid.handler(...)` through
`run({ connection, runtime })`; it does not import `@firegrid/client`, load an
app graph dynamically, or start a Durable Streams dev server.

Focused automated validation is available through:

```sh
pnpm --filter @firegrid/scenarios run scheduled-work-receiver:self-test
```

That check starts a package-local Durable Streams test server, seeds the same
receiver rows, verifies the completion remains pending before the due time, and
then verifies completion resolution plus ready-work terminalization through the
same inspection projection.

### Scenario 4: Sleep / Timer RunWait

Purpose: prove pure durable timer suspension through `RunWait.sleep`,
separate from scheduled-work and projection-match waits.

Input:

1. A schema-valid operation-started row for an operation whose handler calls
   `RunWait.sleep`.
2. A runtime Layer with the operation handler and timer subscriber.

Expected result:

1. The operation blocks on a timer-shaped durable completion.
2. Timer subscriber resolves the completion only after the durable due time.
3. Ready-work resumes the blocked run through the same operation handler.
4. Rebuilt projection proves the run terminalized and no ready work remains.

Relevant ACIDs:

- `durable-waits-and-scheduling.SLEEP.1`
- `durable-waits-and-scheduling.SLEEP.2`
- `durable-waits-and-scheduling.SLEEP.6`
- `durable-subscribers.TIMER_SUBSCRIBER.1`
- `durable-subscribers.TIMER_SUBSCRIBER.2`
- `durable-subscribers.TIMER_SUBSCRIBER.3`
- `durable-subscribers.TIMER_SUBSCRIBER.4`
- `firegrid-runtime-process.RUNTIME_RUN_API.1`
- `firegrid-runtime-process.RUNTIME_RUN_API.6`
- `firegrid-runtime-process.READY_WORK_OPERATOR.1`
- `firegrid-runtime-process.READY_WORK_OPERATOR.5`
- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.11`
- `run-wait-primitives.RUN_WAIT_API.3`
- `run-wait-primitives.RUN_WAIT_API.6`
- `run-wait-primitives.RUN_WAIT_API.7`

Manual CLI input flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run sleep \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

durable-stream read firegrid
```

The sleep emitter derives an operation-started row from `Operation.define`, the
operation input schema, `OperationEnvelopeSchema`, `RunValue`, and `startRun`.
It is emit-only: it writes rows to stdout and does not create streams, wrap the
Durable Streams CLI, or run a receiver process. For the default input it writes
this JSON line to stdout:

```json
{"type":"durable.run","key":"run-sleep-cli-1","value":{"runId":"run-sleep-cli-1","state":"started","data":{"_envelope":"firegrid/operation@1","operation":"Sleep","payload":{"durationMs":500,"label":"timer-cli-1"}}},"headers":{"operation":"insert"}}
```

Receiver-side validation uses a separate app-owned runtime entrypoint. The
receiver runtime composes `Firegrid.subscribers.timer` with
`Firegrid.handler(SleepOperation, ...)` through `run({ connection, runtime })`;
the handler obtains `RunWait` from the Effect environment and calls
`RunWait.sleep(input.durationMs)`. `RunWait.layer({ streamUrl })` supplies the
production durable-wait machinery without app code importing
`@firegrid/substrate/kernel`. The handler returns only after the timer
completion resolves and ready-work re-enters the handler. It does not import
`@firegrid/client`, load an app graph dynamically, start a Durable Streams dev
server, or include a row writer/mini-runner.

Manual receiver-side flow:

Terminal 1:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
durable-stream create firegrid --json
```

Terminal 2:

```sh
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
pnpm --filter @firegrid/scenarios run sleep-receiver -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Terminal 1:

```sh
pnpm --silent --filter @firegrid/scenarios run sleep \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done
```

Terminal 1:

```sh
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Inspection should first show `run-sleep-cli-1` as `blocked` on a pending
`timer` completion. After the due time, it should show the timer completion as
`resolved`, the same run as `completed`, and `readyWork` as empty.

Focused automated validation is available through:

```sh
pnpm --filter @firegrid/scenarios run sleep-receiver:self-test
```

That check starts a package-local Durable Streams test server, writes the same
operation row as the CLI emitter while the app-owned receiver runtime is
running, observes the pending timer before its due time, and verifies timer
resolution plus ready-work terminalization through the same inspection
projection.

### Scenario 5: Projection Surface / Read Model Inspection

Purpose: prove that users can inspect scenario progress through read models
rather than by understanding every raw durable row.

Input:

1. Any of the earlier scenario streams.
2. Firegrid read-model/projection APIs.
3. Optional lab read-only view pointed at the same stream.

Expected result:

1. Rebuild/read-model APIs expose run/completion/projection state needed to
   understand scenario progress.
2. Lab remains read-only in this wave.
3. No privileged host/runtime writer API is introduced for scenario execution.

Manual inspection flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run echo \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

The inspection command is read-only. It calls Firegrid substrate projection APIs
against the explicit stream URL and prints a compact JSON report containing:

```json
{
  "foldVersion": 1,
  "counts": {
    "runs": 1,
    "completions": 0,
    "claimAttempts": 0,
    "eventStreams": 0,
    "readyWork": 0
  },
  "runs": [
    {
      "runId": "run-echo-cli-1",
      "state": "started",
      "operation": "Echo"
    }
  ]
}
```

If a runtime graph later terminalizes Echo, the same inspection command should
show the `run-echo-cli-1` state as `completed` and include the terminal result.
For waitFor streams, it should show the `WaitForPermission` run plus the
caller-owned `PermissionEvents` EventStream row:

```json
{
  "runs": [
    {
      "runId": "run-wait-for-cli-1",
      "operation": "WaitForPermission"
    }
  ],
  "eventStreams": [
    {
      "key": "PermissionEvents:event-permission-approved-cli-1",
      "stream": "PermissionEvents",
      "event": {
        "permissionId": "permission-cli-1",
        "status": "approved",
        "actor": "scenario"
      }
    }
  ]
}
```

For scheduled-work streams, the report should expose the relevant
`scheduled_work` completion state and `whenMs` field before resolution; after
subscriber resolution, the same report should expose the resolved completion and
any derived ready work from the existing read-model rules. The command does not
start subscribers, install runtime graphs, or mutate rows.

For sleep/timer streams, the report should expose the `Sleep` run's blocked
state and pending `timer` completion before the durable due time, then the
resolved timer completion and completed run after the app-owned receiver
runtime processes ready work.

Relevant ACIDs:

- `launchable-substrate-host.LAB_INSPECTOR.1`
- `launchable-substrate-host.LAB_INSPECTOR.2`
- `launchable-substrate-host.LAB_INSPECTOR.4`
- `launchable-substrate-host.LAB_INSPECTOR.7`
- `launchable-substrate-host.NO_CONTROL_PLANE.4`
- `launchable-substrate-host.NO_CONTROL_PLANE.5`
- `firegrid-runtime-process.SCENARIOS.5`

### Scenario 6: Claim-Before-Side-Effect

Purpose: prove once-only side-effect behavior under competing runtime workers.

Input:

1. Schema-valid run and completion rows that derive one ready-work item for a
   side-effect-shaped operation.
2. Two runtime/operator participants competing for the same work.

Expected result:

1. Competing claim attempts are recorded.
2. Only the first valid claim wins.
3. Only the winning owner terminalizes the run.
4. Rebuilt projection proves a single terminal outcome.

Relevant ACIDs:

- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.6`
- `firegrid-runtime-process.SCENARIOS.10`
- `claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1`
- `claim-and-operator-authority.CLAIM_AUTHORITY.1`
- `claim-and-operator-authority.TERMINAL_AUTHORITY.1`
- `launchable-substrate-host.SCENARIOS.4`

Manual CLI input flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run claim-before-side-effect \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done

durable-stream read firegrid
```

The claim-before-side-effect emitter derives a `ChargeCard` operation row from
`Operation.define`, the operation input schema, `OperationEnvelopeSchema`,
`RunValue`, and `startRun`. It then derives a pending completion, a blocked run,
and a resolved completion through `createPendingCompletion`, `blockRun`, and
`resolveCompletion`. For the default input it writes these JSON lines to
stdout:

```json
{"type":"durable.run","key":"run-claim-side-effect-cli-1","value":{"runId":"run-claim-side-effect-cli-1","state":"started","data":{"_envelope":"firegrid/operation@1","operation":"ChargeCard","payload":{"sideEffectId":"side-effect-charge-cli-1","target":"card-token-cli-1","amountCents":4200}}},"headers":{"operation":"insert"}}
{"type":"durable.completion","key":"completion-claim-side-effect-cli-1","value":{"completionId":"completion-claim-side-effect-cli-1","workId":"run-claim-side-effect-cli-1","kind":"externally_resolved_awakeable","state":"pending","data":{"source":"scenario","reason":"ready-for-claim-before-side-effect"}},"headers":{"operation":"insert"}}
{"type":"durable.run","key":"run-claim-side-effect-cli-1","value":{"runId":"run-claim-side-effect-cli-1","state":"blocked","data":{"_envelope":"firegrid/operation@1","operation":"ChargeCard","payload":{"sideEffectId":"side-effect-charge-cli-1","target":"card-token-cli-1","amountCents":4200}},"blockedOnCompletionId":"completion-claim-side-effect-cli-1"},"headers":{"operation":"upsert"}}
{"type":"durable.completion","key":"completion-claim-side-effect-cli-1","value":{"completionId":"completion-claim-side-effect-cli-1","workId":"run-claim-side-effect-cli-1","kind":"externally_resolved_awakeable","state":"resolved","data":{"source":"scenario","reason":"ready-for-claim-before-side-effect"},"result":{"sideEffectId":"side-effect-charge-cli-1","target":"card-token-cli-1","amountCents":4200}},"headers":{"operation":"upsert"}}
```

These rows prove only the CLI-write input side. The runtime receiver side still
requires two app-owned operator participants to derive the ready work, append
competing `durable.claim.attempt` rows, invoke the side-effect handler only from
the winning claim, and terminalize the run once.

#### Receiver-side runtime flow

After the four input rows are on the stream, attach two app-owned operator
participants through the typed `@firegrid/runtime` `run({connection, runtime})`
API and let substrate's `processReadyWorkItem` arbitrate. The receiver lives at
`scenarios/firegrid/src/receivers/claim-before-side-effect-receiver.ts`; it forks two
participants in one Effect program, polls the projection until the run is
terminal, then prints a JSON report to stdout and exits non-zero on assertion
failure.

```sh
pnpm --silent --filter @firegrid/scenarios run claim-before-side-effect-receiver \
  --stream-url "$STREAM_URL/firegrid"
```

Expected behavior:

1. Each participant attaches with its own auto-generated `processId` via the
   attached boot Layer.
2. Both observe the same ready-work item for `run-claim-side-effect-cli-1` on
   their first scan after attach.
3. Both call `processReadyWorkItem`, which writes a `durable.claim.attempt` row
   per participant and arbitrates first-valid-terminal-wins.
4. Only the winning claim owner's handler runs the side-effect (the receiver's
   handler closures tag invocations with `participantId` for evidence).
5. The substrate authors the terminal `durable.run` upsert; the runtime never
   calls `completeRun` / `failRun` directly for ready-work resumes.
6. The losing participant logs `claim-lost` at debug and continues without a
   second handler invocation.

The receiver asserts:

- Exactly **one** handler invocation across both participants.
- The terminal run reaches `state: "completed"` with the encoded
  `{ sideEffectId, status: "charged" }` result.

Automated coverage for the competing-participants invariant lives in
`scenarios/firegrid/src/receivers/claim-before-side-effect-receiver.test.ts`, which spins up
its own `DurableStreamTestServer`, seeds the F1E rows directly, forks two
participants through `run({ connection, runtime })`, and asserts both invariants
above. The packaged `@firegrid/runtime` test suite intentionally does **not**
host this case — adding it there would have bumped Effect-quality baselines
that the dispatch forbids. Any dedicated runtime-package coverage is deferred
to a separate quality / test-strategy slice.

### Scenario 6: Handler Failure Terminalization

Purpose: prove that a typed app handler failure is durably terminalized as a
failed run and remains inspectable through the same projection surface.

Input:

1. A schema-valid operation-started row for a `FailingOperation` operation.
2. An app-owned runtime Layer that installs a handler returning the operation's
   typed error schema.

Expected result:

1. Runtime decodes the operation input through the operation descriptor schema.
2. Handler failure is encoded through the operation error schema.
3. Runtime appends a failed terminal run row.
4. Rebuilt projection shows the run failed with the typed scenario error.

Manual CLI input flow:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid
durable-stream create firegrid --json

pnpm --silent --filter @firegrid/scenarios run failing-operation \
  | while IFS= read -r row; do durable-stream write firegrid "$row" --json; done
```

Start the app-owned receiver runtime in another terminal:

```sh
DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid \
  pnpm --filter @firegrid/scenarios run failing-operation-receiver
```

Then inspect:

```sh
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

The inspection report should show `run-failing-operation-cli-1` as `failed`
with:

```json
{
  "_tag": "ScenarioFailure",
  "requestId": "request-failing-operation-cli-1",
  "reason": "scenario handler failed intentionally"
}
```

Relevant ACIDs:

- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.2`
- `firegrid-runtime-process.SCENARIOS.12`
- `firegrid-runtime-process.RUNTIME_RUN_API.1`
- `firegrid-runtime-process.RUNTIME_RUN_API.2`
- `firegrid-runtime-process.RUNTIME_RUN_API.3`
- `firegrid-runtime-process.RUNTIME_RUN_API.5`
- `firegrid-runtime-process.RUNTIME_RUN_API.6`
- `firegrid-runtime-process.RUNTIME_RUN_API.8`
- `firegrid-runtime-process.RUNTIME_RUN_API.9`
- `firegrid-operation-messaging.OPERATIONS.1`
- `firegrid-operation-messaging.OPERATIONS.2`
- `firegrid-operation-messaging.OPERATIONS.4`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.1`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.3`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.4`

### Deferred Edge: Projection-Match Timeout Receiver

Projection-match timeout/cancellation is already expressible at the substrate
subscriber level: a pending `projection_match` completion with `deadlineAtMs`
in the past is cancelled with a timeout terminal reason by the projection-match
subscriber. The missing receiver-side capability is run resumption from a
cancelled completion. Current ready-work derivation only derives runnable work
from resolved completions; rejected/cancelled completions intentionally do not
produce a ready-work item. As a result, a timed-out `waitFor` completion can be
cancelled durably, but the blocked operation run will not yet resume to a
terminal run through the runtime ready-work operator. A follow-up slice should
decide whether timeout resumes should fail/cancel the blocked run, then extend
the ready-work/operator path and add the receiver scenario.

## Implementation Shape

The work is not to build fixture infrastructure. The work is to add scenario
validation around existing APIs.

Each scenario should include:

1. A short Markdown section with the Durable Streams CLI commands and the JSON
   row shape for manual execution.
2. A test that constructs or decodes the same row through existing Effect Schema
   and protocol builders.
3. A typed app-owned runtime `run(...)` entrypoint when the scenario needs a
   handler/subscriber graph.
4. Assertions over read models/projections, not over incidental raw row ordering
   unless row ordering is the behavior under test.

If a scenario needs helper code, keep it package-local and scenario-specific.
Input-side emitters should use the shared emit-only row contract rather than
hand-rolling stdout loops or JSON row formatting in each scenario file.
Do not create a shared `test-support` folder and do not create a new Firegrid
CLI wrapper.

## Non-Goals

1. Do not prioritize app-facing client ergonomics in this wave.
2. Do not build a fixture generator or a Firegrid CLI wrapper.
3. Do not reintroduce `firegrid dev -- ...`, embedded dev-server launchers, or
   child process environment injection.
4. Do not add HTTP command endpoints or a mutable runtime control plane.
5. Do not create product-specific durable row families for Fireline, Firepixel,
   ACP, MCP, sessions, prompts, tools, models, or transports.
6. Do not create shared `test-support` folders.

## Acceptance Criteria

The wave is done when a developer can run at least the Echo and waitFor
scenarios from the Durable Streams CLI against an attached Firegrid runtime and
can verify the result through Firegrid read models or the read-only lab.

CI should include programmatic equivalents for each scenario using the same
schema/protocol boundary as the documented JSON examples.

## Dispatch Order

1. F1A: Echo operation scenario validation.
2. F1B: waitFor projection-match scenario validation.
3. F1C: scheduled work / scheduleAt scenario validation.
4. F1D: projection surface and read-only lab observation.
5. F1E: claim-before-side-effect scenario validation.

The first two scenarios are the critical path. They prove runtime handling and
durable suspension before client SDK work resumes.

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
by TypeScript files under `scenarios/firegrid/`; those files import the real
Effect Schema descriptors and protocol builders and write JSON rows to stdout.
They are not checked-in JSON fixtures and are not runtime support surfaces.

The expected local shell shape is:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json
pnpm --filter @firegrid/scenarios run <scenario> \
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
scenarios still requires a runtime process with the relevant handler graph
supplied through intentional runtime graph-loading or host wiring. The current
default `firegrid` binary attaches to the stream without hard-coded
scenario-specific handler Layers.

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

pnpm --filter @firegrid/scenarios run echo \
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

Relevant ACIDs:

- `firegrid-operation-messaging.OPERATIONS.1`
- `firegrid-operation-messaging.OPERATIONS.2`
- `firegrid-operation-messaging.OPERATIONS.3`
- `firegrid-operation-messaging.OPERATIONS.4`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.1`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.2`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.3`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.4`
- `firegrid-runtime-process.SCENARIOS.1`
- `firegrid-runtime-process.SCENARIOS.2`

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
- `firegrid-event-streams.SCHEMA_OWNERSHIP.3`
- `launchable-substrate-host.SCENARIOS.3`

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
- `launchable-substrate-host.SCENARIOS.2`

### Scenario 4: Projection Surface / Read Model Inspection

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

Relevant ACIDs:

- `launchable-substrate-host.LAB_INSPECTOR.1`
- `launchable-substrate-host.LAB_INSPECTOR.2`
- `launchable-substrate-host.LAB_INSPECTOR.4`
- `launchable-substrate-host.LAB_INSPECTOR.7`
- `launchable-substrate-host.NO_CONTROL_PLANE.4`
- `launchable-substrate-host.NO_CONTROL_PLANE.5`

### Scenario 5: Claim-Before-Side-Effect

Purpose: prove once-only side-effect behavior under competing runtime workers.

Input:

1. A schema-valid started run for a side-effect-shaped operation.
2. Two runtime/operator participants competing for the same work.

Expected result:

1. Competing claim attempts are recorded.
2. Only the first valid claim wins.
3. Only the winning owner terminalizes the run.
4. Rebuilt projection proves a single terminal outcome.

Relevant ACIDs:

- `claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1`
- `claim-and-operator-authority.CLAIM_AUTHORITY.1`
- `claim-and-operator-authority.TERMINAL_AUTHORITY.1`
- `launchable-substrate-host.SCENARIOS.4`

## Implementation Shape

The work is not to build fixture infrastructure. The work is to add scenario
validation around existing APIs.

Each scenario should include:

1. A short Markdown section with the Durable Streams CLI commands and the JSON
   row shape for manual execution.
2. A test that constructs or decodes the same row through existing Effect Schema
   and protocol builders.
3. A runtime-side scenario Layer when the scenario needs a handler/subscriber
   graph.
4. Assertions over read models/projections, not over incidental raw row ordering
   unless row ordering is the behavior under test.

If a scenario needs helper code, keep it package-local and scenario-specific.
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

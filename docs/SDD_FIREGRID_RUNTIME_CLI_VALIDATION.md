# SDD: Firegrid Runtime CLI Validation

Status: Draft
Product: Firegrid
Related: `firegrid-operation-messaging`, `firegrid-runtime-process`, `launchable-substrate-host`, `durable-waits-and-scheduling`

## Summary

Before investing more in the app-facing client, Firegrid should prove runtime
behavior at the durable stream boundary.

The near-term validation path is:

```txt
Durable Streams CLI creates/writes a JSON stream
Firegrid runtime attaches to that existing stream
runtime handlers/subscribers advance durable rows
Durable Streams CLI reads the resulting stream
```

This keeps the next feature wave focused on runtime semantics rather than SDK
ergonomics. The Firegrid client remains useful later, but it is not required to
prove that the runtime can consume durable operation rows and append the correct
execution facts.

## External CLI Boundary

The Durable Streams CLI is the external tool for local stream setup and raw row
inspection. It can create JSON streams, write JSON values, and follow streams
from an existing Durable Streams server.

The expected local shape is:

```sh
durable-streams-server dev

export STREAM_URL=http://localhost:4437/v1/stream
durable-stream create firegrid --json
durable-stream write firegrid '<canonical Firegrid row JSON>' --json
durable-stream read firegrid
```

The Firegrid runtime attaches to the concrete stream URL:

```sh
DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid \
  pnpm --filter @firegrid/runtime run firegrid
```

Firegrid does not wrap or replace this CLI. Firegrid also does not restart a
Durable Streams server or spawn child processes.

## What We Are Building

### 1. Runtime Scenario Entrypoints

Add a small runtime-side scenario process or package-local example that installs
known operation handlers through normal `@firegrid/runtime` Layer APIs.

The first scenario should be intentionally boring:

```txt
Operation: Echo
Input:  { message: string }
Output: { message: string, length: number }
```

It should prove:

1. The runtime attaches to an existing stream URL.
2. The runtime handler receives decoded operation input.
3. The handler runs with `CurrentWorkContext`.
4. The handler appends the terminal run result through existing substrate
   authority.

This scenario is runtime code, not client code. It must not import
`@firegrid/client`.

### 2. Canonical CLI Fixture Generator

Raw CLI use still needs canonical Firegrid row JSON. We should not ask humans
or agents to hand-type internal row envelopes.

Add a small fixture generator that prints canonical JSON rows to stdout, for
example:

```sh
pnpm firegrid:fixture operation-started \
  --operation Echo \
  --run-id run-echo-1 \
  --input '{"message":"hello"}'
```

The output can be piped into the Durable Streams CLI:

```sh
pnpm firegrid:fixture operation-started \
  --operation Echo \
  --run-id run-echo-1 \
  --input '{"message":"hello"}' |
  durable-stream write firegrid --json
```

The generator should call Firegrid/substrate protocol builders rather than
duplicating row shapes. It is a developer fixture boundary, not a public client
API.

### 3. Runtime CLI-Equivalent Integration Tests

Add tests that exercise the same path programmatically:

1. Start a real Durable Streams test server inside the relevant package test.
2. Create a JSON stream.
3. Append the canonical operation-started row that the fixture generator would
   print.
4. Start the runtime with the scenario handler Layer.
5. Read/rebuild until the operation run terminalizes.
6. Assert the terminal row result.

These tests must not use `@firegrid/client`. They should target runtime behavior
at the stream boundary.

### 4. Scheduled Operation Row Validation

Once the basic operation path is green, add delayed and absolute scheduled
operation fixtures that lower to existing scheduled-work primitives.

This proves `firegrid-operation-messaging.SCHEDULED_MESSAGES.1-.3` without
adding a second scheduler or requiring the client SDK.

### 5. Read-Only Lab Observation

The lab may observe the stream and projected result after the runtime advances
the row. It should not start the operation in this wave.

Lab involvement is limited to proving that attached, read-only observation can
inspect the same stream that the CLI and runtime use.

## Non-Goals

1. Do not prioritize `@firegrid/client` `send`, `call`, `result`, or `observe`
   ergonomics in this wave.
2. Do not add a Firegrid wrapper around the Durable Streams CLI.
3. Do not reintroduce `firegrid dev -- ...`, embedded dev-server launchers, or
   child process environment injection.
4. Do not add HTTP command endpoints or a mutable runtime control plane.
5. Do not create product-specific durable row families for Fireline, Firepixel,
   ACP, MCP, sessions, prompts, tools, models, or transports.
6. Do not create shared `test-support` folders.

## Acceptance Criteria

The wave is done when a developer can:

1. Start Durable Streams externally.
2. Create a JSON stream with the Durable Streams CLI.
3. Generate a canonical Firegrid operation row with a Firegrid fixture command.
4. Write that row with the Durable Streams CLI.
5. Run a Firegrid runtime scenario against the existing stream.
6. Read the stream or rebuild projections and see the operation terminalized
   with the expected result.

The CI test equivalent must prove the same behavior without using the Firegrid
client package.

## Implementation Slices

### F1A Runtime Scenario Entrypoint

Owns:

- A minimal runtime scenario entrypoint or example process.
- Echo operation descriptor and handler Layer.
- Runtime docs for attached execution against an existing stream.

Relevant ACIDs:

- `firegrid-operation-messaging.OPERATIONS.1`
- `firegrid-operation-messaging.OPERATIONS.2`
- `firegrid-operation-messaging.OPERATIONS.3`
- `firegrid-operation-messaging.OPERATIONS.4`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.1`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.2`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.3`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.4`
- `firegrid-runtime-process.BINARIES.3`
- `firegrid-runtime-process.BINARIES.7`
- `firegrid-runtime-process.BINARIES.8`

### F1B CLI Fixture Generator

Owns:

- A developer fixture command that emits canonical Firegrid row JSON.
- Fixture docs showing `durable-stream create`, `durable-stream write`, and
  `durable-stream read`.
- Guardrails proving fixture generation uses protocol builders rather than
  copied row literals.

Relevant ACIDs:

- `durable-records-and-projections.SCHEMA_LAYOUT.1`
- `durable-records-and-projections.SCHEMA_LAYOUT.2`
- `durable-records-and-projections.SUBSTRATE_SCOPE.6`
- `durable-records-and-projections.SUBSTRATE_SCOPE.7`
- `firegrid-operation-messaging.CLIENT_MESSAGING.1`
- `firegrid-operation-messaging.APP_BOUNDARY.1`
- `firegrid-operation-messaging.APP_BOUNDARY.2`

### F1C Runtime CLI-Equivalent Integration

Owns:

- End-to-end runtime tests that append fixture-equivalent rows directly to a
  real Durable Streams stream.
- Assertions over terminalized run state/result.
- No dependency on `@firegrid/client`.

Relevant ACIDs:

- `firegrid-operation-messaging.RUNTIME_HANDLERS.1`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.2`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.3`
- `firegrid-operation-messaging.RUNTIME_HANDLERS.4`
- `claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1`
- `claim-and-operator-authority.TERMINAL_AUTHORITY.1`
- `awakeables-and-runs.RUN_TRANSITIONS.1`
- `awakeables-and-runs.RUN_TRANSITIONS.7`

### F1D Scheduled Operation Fixtures

Owns:

- Delayed and absolute scheduled operation fixture rows.
- Runtime/subscriber proof that scheduled operation messages lower to existing
  scheduled-work primitives.

Relevant ACIDs:

- `firegrid-operation-messaging.SCHEDULED_MESSAGES.1`
- `firegrid-operation-messaging.SCHEDULED_MESSAGES.2`
- `firegrid-operation-messaging.SCHEDULED_MESSAGES.3`
- `durable-waits-and-scheduling.SCHEDULE_WORK.1`
- `durable-waits-and-scheduling.SCHEDULE_WORK.6`
- `durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.1`
- `durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4`

### F1E Read-Only Lab Observation

Owns:

- Lab docs or small UI polish showing how to point the lab at the same attached
  stream.
- No operation-starting controls in this wave.

Relevant ACIDs:

- `launchable-substrate-host.LAB_INSPECTOR.1`
- `launchable-substrate-host.LAB_INSPECTOR.2`
- `launchable-substrate-host.LAB_INSPECTOR.4`
- `launchable-substrate-host.LAB_INSPECTOR.7`
- `launchable-substrate-host.NO_CONTROL_PLANE.4`
- `launchable-substrate-host.NO_CONTROL_PLANE.5`

## Handoff Notes

The first dispatch should be F1A + F1B in parallel after W4D lands. F1C should
start once F1A exposes the runtime scenario Layer and F1B exposes the canonical
fixture row generator. F1D and F1E can follow after the basic Echo path is
working.

The client SDK should stay out of the critical path until the runtime and
durable-row behavior is proven with the external CLI.

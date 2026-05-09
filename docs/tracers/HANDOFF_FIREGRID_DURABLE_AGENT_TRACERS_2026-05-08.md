# Handoff: Firegrid Durable Agent Tracers

Date: 2026-05-08

Status: tracer 001 runtime-context naming and implementation are in progress.

## Purpose

This handoff captures the current tracer-bullet direction for Firegrid's
durable agent runtime work. The next agent should use this as the entry point
before changing `packages/client`, `packages/protocol`, or
`packages/runtime/src/control-plane`, `packages/runtime/src/data-plane`, or
`packages/runtime/src/launch.ts`.

The important architectural invariant is:

```txt
live agent process output
  -> durable runtime output data-plane events
  -> independent downstream consumers
```

Do not couple launch execution to session materialization, permission handling,
or provider-specific SDK internals.

## High-Level Architecture Context

Firegrid is the durable agent data plane and execution substrate. It is
responsible for stream-native launch intent, durable workflow execution,
sandbox/process execution, and durable journaling of application-visible agent
facts.

Firegrid core is still not a product-specific agent-session implementation. It
should not bake in Flamecast, prompt, chat message, ACP, Claude Code, tool
approval, or session-transcript semantics. Those belong to provider helpers,
downstream materializers, or product-owned workflows over durable journals.

The launch system is intentionally split into three lanes:

1. Launch lane:
   `launch(...) -> runtime context control-plane row -> workflow -> sandbox stream -> runtime output data-plane events`
2. Materialization lane:
   `runtime output data-plane events -> replayable materializer -> State Protocol session-state`
3. Coordination lane:
   `runtime output data-plane events -> workflow/deferred consumer -> permission/input rows`

The runtime context workflow should only coordinate durable execution and journaling. It
must not interpret provider/session semantics beyond applying the provider
helper's fixed journaling configuration.

The public client should stay narrow. It launches configured runtime helpers
and returns handles. Runtime details like context ids, planes, bindings, stream
URLs, journal rules, readiness, rebuild, and restart policies are internal or
provider owned.

The sandbox provider boundary is live and non-durable. `stream(...)` emits live
chunks. Durable truth begins only when workflow activities append control-plane
rows or data-plane events to Durable Streams.

Use `createStreamDB` for sparse runtime context control-plane state. Use
`RuntimeCaptureJournal` backed by `IdempotentProducer` for stdout/stderr
data-plane event and log rows.

## Execution Order

The next session should implement the tracer docs in numeric order. Start with
`docs/tracers/001-black-box-agent-output-to-durable-state.md`.

Do not begin tracer 002 or tracer 003 implementation until tracer 001 has a
passing end-to-end test proving:

```txt
launch(...)
  -> runtime context row
  -> RuntimeContextWorkflow
  -> SandboxProvider.stream(...)
  -> durable runtime output event / log data-plane events
```

The prerequisites listed in tracer 001 are part of implementing tracer 001, not
separate future work:

1. Thin the client launch surface.
2. Add the sandbox `stream(...)` contract.
3. Make `launcher.ts` workflow-native.
4. Journal live output chunks through the runtime capture journal.

After tracer 001 is passing, implement tracer 002:

```txt
runtime output data-plane events
  -> downstream materializer
  -> State Protocol session-state stream
```

After tracer 002 is passing, implement tracer 003:

```txt
runtime output data-plane events
  -> downstream permission workflow
  -> durable approval wait / response input row
```

Tracer 002 and tracer 003 are not fully scoped implementation specs yet. That
is intentional. The result of firing tracer 001 should inform the exact shape of
tracer 002, and tracer 002 should inform the exact shape of tracer 003. Treat
their current docs as directional constraints, not code-ready plans.

## Current Docs

- `docs/tracers/README.md`
- `docs/tracers/001-black-box-agent-output-to-durable-state.md`
- `docs/tracers/002-runtime-events-to-session-state.md`
- `docs/tracers/003-runtime-events-to-permission-workflow.md`

The tracer index now defines this sequence:

```txt
Prerequisite
  thin client launch surface

Prerequisite
  sandbox provider stream(command) contract

001
  launch(...)
    -> durable workflow
    -> sandbox command stream
    -> durable runtime output data-plane events

002
  runtime output data-plane events
    -> downstream materializer
    -> State Protocol session-state stream

003
  runtime output data-plane events
    -> downstream permission workflow
    -> durable permission request / approval wait / input response
```

## Architecture Pivots Captured

### 1. Tracer 001 Stops At The Journal

Tracer 001 no longer materializes session state. It only proves that a real
black-box command can be launched and its live output can be durably journaled.

This prevents the runtime context workflow from becoming a session pipeline.

### 2. Materialization Is Downstream And Replayable

Tracer 002 starts from retained runtime output data-plane events and emits State Protocol
changes to session-shaped resources. It can run eagerly, lazily, or after the
agent process has exited.

This gives downstream products a clean replay story.

### 3. Permission Handling Is Another Downstream Consumer

Tracer 003 starts from runtime output data-plane events that represent permission/tool
requests. It uses `@effect/workflow` and `DurableDeferred` to model a durable
human-in-the-loop wait.

The runtime context workflow must not know which runtime events require approval.

### 4. The Client Launch Surface Must Be Thin

The public client should not expose `contextId`, planes, bindings, stream URLs,
journal rules, readiness policy, rebuild policy, or restart policy.

The desired public shape is:

```ts
firegrid.launch({
  runtime: local.jsonl({
    argv: ["claude", "--bare", "-p", "...", "--output-format", "stream-json", "--verbose"],
  }),
})
```

The client library may generate an internal context id and append a normalized
runtime context row. The caller should not provide that id.

### 5. Provider Helpers Collapse Fixed Provider Configuration

Provider helpers should provide typed, ergonomic config surfaces. Common
journal rules should be implied by the helper.

Example intent:

```ts
local.jsonl({ argv })
```

means local process execution with stdout JSONL journaled to runtime event and
stderr text journaled to runtime logs.

Avoid introducing a durable `RuntimeTarget` registry for now. It is premature.

### 6. Sandbox Providers Own Non-Durable Live Execution

The sandbox/provider layer should expose a data-processing-pipeline style
interface:

```ts
create
getOrCreate
find
execute
executeMany
stream
upload
download
destroy
```

The tracer depends on:

```ts
stream(
  sandbox: Sandbox,
  command: SandboxCommand,
): Stream.Stream<ProcessOutputChunk, SandboxError>
```

`stream(...)` is live and non-durable. The workflow activity consumes it and
persists durable rows.

### 7. `launcher.ts` Is Workflow-Native

`packages/runtime/src/control-plane/runtime-context/launcher.ts` executes the runtime context
workflow rather than directly owning the process side effect.

Target shape:

```txt
launcher
  observes runtime context rows
  calls RuntimeContextWorkflow.execute({ contextId })

RuntimeContextWorkflow
  read runtime context activity
  run process attempt activity
    SandboxProvider.stream(...)
    journal output chunks via RuntimeCaptureJournal
```

### 8. Split Sparse State From High-Volume Output

The runtime context store mirrors the existing client pattern:

```ts
const db = createStreamDB({
  streamOptions,
  state: runtimeContextStateSchema,
  actions: ...
})
```

The workflow should receive the acquired StreamDB handle through an Effect
service for scoping, but durable operations should remain normal StreamDB
collections/actions.

Runtime output event/log data-plane rows use `RuntimeCaptureJournal` and `IdempotentProducer` so the
process-output path can batch and flush without awaiting StreamDB
materialization for every chunk.

## Current Code State

### Client

Current file: `packages/client/src/firegrid.ts`

The client uses `createStreamDB` directly, accepts narrow public launch input,
generates the internal runtime context id, appends a runtime context row, and
returns a `RuntimeContextHandle`.

### Protocol

Current file: `packages/protocol/src/launch/schema.ts`

Current protocol shape has `RuntimeContext`, `RuntimeRunEvent`, `RuntimeEvent`,
and `RuntimeLogLine`. `runtimeContextStateSchema` exposes only contexts and
runs; stdout/stderr rows are raw `RuntimeJournalEventSchema` data-plane events.

### Runtime Context And Data Plane

Current files:

- `packages/runtime/src/control-plane/runtime-context/launcher.ts`
- `packages/runtime/src/control-plane/runtime-context/service.ts`
- `packages/runtime/src/control-plane/runtime-context/workflow.ts`
- `packages/runtime/src/data-plane/runtime-output/writer.ts`
- `packages/runtime/src/data-plane/execution/sandbox/sandbox.ts`
- `packages/runtime/src/data-plane/execution/sandbox/providers/local-process.ts`

Current runtime launch path uses `SandboxProvider.stream(...)`, local process
streaming, `RuntimeContextWorkflow`, `RuntimeControlPlane`, and
`RuntimeCaptureJournal`.

### Existing Tests

Current launch tests verify that a child process prints JSONL to stdout, the
runtime journals stdout as runtime events, stderr as runtime logs, and late
reads observe retained rows after process exit.

## Implementation Order

Follow Acai discipline: update or add feature specs before code changes.

Tracer 001 is the immediate implementation target and must stay green before
starting tracer 002 or tracer 003. Next implementation work should proceed to
`002-runtime-events-to-session-state.md`, then
`003-runtime-events-to-permission-workflow.md`.

## Open Design Questions

### Physical Destination For Runtime Events

The current model intentionally separates the runtime control-plane stream from
the runtime output data-plane stream. The client may accept one legacy
`runtimeStreamUrl` for ergonomic defaults, but implementation code should treat
control and data streams as separate configured topics.

### Provider Helper Package Boundary

The docs use:

```ts
import { local } from "@firegrid/protocol/launch"
```

Provider helpers must stay browser-safe and must not pull process/sandbox
implementation code into browser bundles.

### `executeCommand(...)` Compatibility

Existing code and tests use `executeCommand(...)`. Keep it temporarily if that
minimizes churn, but tracer 001 should use `stream(...)` as the primitive.

`executeCommand(...)` can eventually be implemented by collecting
`stream(...)`.

### Restart Semantics

Process restart/resume is a non-goal for tracer 001. Do not add retry policy to
the first tracer. `Activity.retry`, `DurableClock.sleep`, and replacement
attempt behavior belong in a later tracer.

## Source References

Local references:

- `packages/client/src/firegrid.ts`
- `packages/protocol/src/launch/schema.ts`
- `packages/protocol/src/launch/state.ts`
- `packages/runtime/src/control-plane/runtime-context/launcher.ts`
- `packages/runtime/src/control-plane/runtime-context/service.ts`
- `packages/runtime/src/control-plane/runtime-context/workflow.ts`
- `packages/runtime/src/control-plane/runtime-context/launcher.test.ts`
- `packages/runtime/src/data-plane/runtime-output/writer.ts`
- `packages/runtime/src/data-plane/execution/sandbox/sandbox.ts`
- `packages/runtime/src/data-plane/execution/sandbox/providers/local-process.ts`
- `packages/runtime/src/control-plane/workflow-engine/workflows.ts`
- `packages/runtime/src/control-plane/workflow-engine/engine-runtime.ts`
- `packages/runtime/src/control-plane/workflow-engine/workflow-engine.test.ts`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/core-principle.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/session-prompt-adapters.md`
- `docs/proposals/SDD_FIREGRID_DURABLE_LAUNCH_RUNTIME_OPERATOR.md`
- `docs/proposals/SDD_FIREGRID_PROJECTION_QUERY.md`

External references:

- Effect workflow package:
  https://github.com/Effect-TS/effect/tree/main/packages/workflow
- Durable Streams StreamDB guide:
  https://github.com/durable-streams/durable-streams/blob/main/docs/stream-db.md
- Cased sandboxes base interface:
  https://github.com/cased/sandboxes/blob/main/sandboxes/base.py
- Cased sandboxes README:
  https://github.com/cased/sandboxes
- Claude Code CLI was locally verified with:

```sh
claude --bare -p 'Reply with exactly: pong' \
  --output-format stream-json \
  --verbose \
  --max-turns 1 \
  --no-session-persistence \
  --permission-mode dontAsk
```

Important CLI finding: `--output-format stream-json` requires `--verbose`.

## Guardrails For The Next Agent

- Do not copy legacy Flamecast implementation decisions.
- Do not import provider SDKs into Firegrid runtime for this tracer.
- Treat the agent as a black-box process/sandbox command.
- Do not add an HTTP launch surface; the stream remains the invocation boundary.
- Do not expose planes, bindings, journal rules, stream URLs, or context ids in
  the public client launch input.
- Do not build session materialization into the runtime context workflow.
- Do not build permission handling into the runtime context workflow.
- Use `createStreamDB` for sparse runtime context control-plane state.
- Use `RuntimeCaptureJournal`/`IdempotentProducer` for stdout/stderr data-plane event and log rows.
- Keep `SandboxProvider.stream(...)` non-durable; durability begins only after
  the workflow activity appends runtime event/log rows.
- Keep Acai specs and ACID references aligned before implementation.

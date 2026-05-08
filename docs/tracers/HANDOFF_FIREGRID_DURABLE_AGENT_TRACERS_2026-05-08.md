# Handoff: Firegrid Durable Agent Tracers

Date: 2026-05-08

Status: docs aligned; implementation not started for the new tracer sequence.

## Purpose

This handoff captures the current tracer-bullet direction for Firegrid's
durable agent runtime work. The next agent should use this as the entry point
before changing `packages/client`, `packages/protocol`, or
`packages/runtime/src/durable-launch`.

The important architectural invariant is:

```txt
live agent process output
  -> durable provider-wire journal
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
   `launch(...) -> normalized launch row -> workflow -> sandbox stream -> provider-wire journal`
2. Materialization lane:
   `provider-wire journal -> replayable materializer -> State Protocol session-state`
3. Coordination lane:
   `provider-wire journal -> workflow/deferred consumer -> permission/input rows`

The launch workflow should only coordinate durable execution and journaling. It
must not interpret provider/session semantics beyond applying the provider
helper's fixed journaling configuration.

The public client should stay narrow. It launches configured runtime helpers
and returns handles. Runtime details like launch ids, planes, bindings, stream
URLs, journal rules, readiness, rebuild, and restart policies are internal or
provider owned.

The sandbox provider boundary is live and non-durable. `stream(...)` emits live
chunks. Durable truth begins only when workflow activities append rows through
StreamDB actions.

Use `createStreamDB` as the persistence abstraction. Do not create parallel
store/journal abstractions over it unless there is a proven missing capability.

## Execution Order

The next session should implement the tracer docs in numeric order. Start with
`docs/tracers/001-black-box-agent-output-to-durable-state.md`.

Do not begin tracer 002 or tracer 003 implementation until tracer 001 has a
passing end-to-end test proving:

```txt
launch(...)
  -> normalized launch row
  -> LaunchAgentWorkflow
  -> SandboxProvider.stream(...)
  -> durable provider-wire / diagnostics journal rows
```

The prerequisites listed in tracer 001 are part of implementing tracer 001, not
separate future work:

1. Thin the client launch surface.
2. Add the sandbox `stream(...)` contract.
3. Make `launcher.ts` workflow-native.
4. Journal live output chunks through `createStreamDB` actions.

After tracer 001 is passing, implement tracer 002:

```txt
provider-wire journal
  -> downstream materializer
  -> State Protocol session-state stream
```

After tracer 002 is passing, implement tracer 003:

```txt
provider-wire journal
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
- `docs/tracers/002-provider-wire-journal-to-session-state.md`
- `docs/tracers/003-provider-wire-journal-to-permission-workflow.md`

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
    -> durable provider-wire journal

002
  provider-wire journal
    -> downstream materializer
    -> State Protocol session-state stream

003
  provider-wire journal
    -> downstream permission workflow
    -> durable permission request / approval wait / input response
```

## Architecture Pivots Captured

### 1. Tracer 001 Stops At The Journal

Tracer 001 no longer materializes session state. It only proves that a real
black-box command can be launched and its live output can be durably journaled.

This prevents the launch workflow from becoming a session pipeline.

### 2. Materialization Is Downstream And Replayable

Tracer 002 starts from retained provider-wire rows and emits State Protocol
changes to session-shaped resources. It can run eagerly, lazily, or after the
agent process has exited.

This gives downstream products a clean replay story.

### 3. Permission Handling Is Another Downstream Consumer

Tracer 003 starts from provider-wire rows that represent permission/tool
requests. It uses `@effect/workflow` and `DurableDeferred` to model a durable
human-in-the-loop wait.

The launch workflow must not know which provider events require approval.

### 4. The Client Launch Surface Must Be Thin

The public client should not expose `launchId`, planes, bindings, stream URLs,
journal rules, readiness policy, rebuild policy, or restart policy.

The desired public shape is:

```ts
firegrid.launch({
  runtime: local.jsonl({
    argv: ["claude", "--bare", "-p", "...", "--output-format", "stream-json", "--verbose"],
  }),
})
```

The client library may generate an internal launch id and append a normalized
launch row. The caller should not provide that id.

### 5. Provider Helpers Collapse Fixed Provider Configuration

Provider helpers should provide typed, ergonomic config surfaces. Common
journal rules should be implied by the helper.

Example intent:

```ts
local.jsonl({ argv })
```

means local process execution with stdout JSONL journaled to provider-wire and
stderr text journaled to diagnostics.

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

### 7. `launcher.ts` Should Become Workflow-Native

`packages/runtime/src/durable-launch/launcher.ts` is currently a prototype
runner. It should be redesigned so it executes a launch workflow rather than
directly owning the launch side effect.

Target shape:

```txt
launcher
  observes normalized launch rows
  calls LaunchAgentWorkflow.execute({ launchId })

LaunchAgentWorkflow
  read launch request activity
  run process attempt activity
    SandboxProvider.stream(...)
    journal output chunks via StreamDB actions
  finalize launch activity
```

### 8. Use `createStreamDB` Actions, Not A Handwritten Store Facade

The runtime should mirror the existing client pattern:

```ts
const db = createStreamDB({
  streamOptions,
  state: runtimeLaunchStateSchema,
  actions: ...
})
```

The workflow should receive the acquired StreamDB handle through an Effect
service for scoping, but durable operations should remain normal StreamDB
collections/actions.

Do not reintroduce a bespoke `LaunchJournal`/store abstraction that wraps every
action. That was explicitly rejected as unnecessary ceremony.

## Current Code State

### Client

Current file: `packages/client/src/firegrid.ts`

The client already uses `createStreamDB` directly and appends launch rows with
an `appendLaunchRequest` action.

Current gaps:

- `FiregridService.launch` still takes `RuntimeLaunchRequest` directly.
- Caller still supplies `launchId`, planes, bindings, and current wide launch
  shape.
- `LaunchHandle.diagnosticStream(...)` still reflects the older planes model.

Needed:

- Add a narrow public launch input.
- Generate internal launch id inside the client/library.
- Normalize provider helper output into the internal launch row.
- Keep client as launch-intent producer plus read handle.

### Protocol

Current file: `packages/protocol/src/launch/schema.ts`

Current shape still has:

- `target.spec.argv`
- `planes`
- `bindings`
- `readiness`
- `rebuild`
- `restartPolicy`

Needed:

- Decide whether to replace or add a new internal normalized launch schema.
- Add runtime helper output shape: `{ provider, config, journal }`.
- Add provider-wire/diagnostic journal row schemas or collections.
- Keep public launch input out of protocol if it is TypeScript-helper derived
  and not a durable row.

### Runtime Launch

Current files:

- `packages/runtime/src/durable-launch/launcher.ts`
- `packages/runtime/src/durable-launch/store.ts`
- `packages/runtime/src/durable-launch/execution/sandbox.ts`
- `packages/runtime/src/durable-launch/execution/providers/local-process.ts`
- `packages/runtime/src/durable-launch/execution/providers/val-town.ts`

Current gaps:

- `SandboxProviderService` has `executeCommand(...)`, not `stream(...)`.
- local provider uses `Command.exitCode(...)` and returns empty stdout/stderr.
- `runLaunchOnce(...)` manually handles attempts and process events.
- launch execution is not an `@effect/workflow` workflow/activity.
- no StreamDB action exists for journaling stdout/stderr chunks.

Needed:

- Add `ProcessOutputChunk`.
- Add `SandboxProvider.stream(...)`.
- Implement local process streaming first.
- Keep `executeCommand(...)` as a helper or compatibility method if needed,
  but build tracer 001 on `stream(...)`.
- Add runtime StreamDB actions for process events and journal rows.
- Replace or wrap `runLaunchOnce(...)` with `LaunchAgentWorkflow.execute(...)`.

### Existing Tests

Current launch tests in `packages/runtime/src/durable-launch/launcher.test.ts`
validate the older tracer where the child process directly appends to
provider-wire.

Needed:

- Update tracer 001 test so the child process prints JSONL to stdout.
- Firegrid runtime must journal stdout to provider-wire.
- Firegrid runtime must journal stderr to diagnostics.
- A late read must observe provider-wire rows after process exit.

## Implementation Order

Follow Acai discipline: update or add feature specs before code changes.

Immediate implementation target: tracer 001 only. Complete every item below and
land a passing tracer 001 test before starting tracer 002 or tracer 003.

Tracer 001 implementation order:

1. Update `features/firegrid/firegrid-durable-launch-runtime-operator.feature.yaml`
   or add a focused tracer feature spec for:
   - thin client launch surface;
   - provider helper normalization;
   - sandbox streaming contract;
   - workflow-backed launch execution;
   - provider-wire journal rows;
   - no session materialization in tracer 001.
2. Add or revise protocol schemas for the normalized internal launch row and
   journal rows.
3. Thin `@firegrid/client` launch input so callers use provider helpers and do
   not pass internal identifiers or stream wiring.
4. Add provider helper for the first local JSONL case.
5. Add `SandboxProvider.stream(...)` and implement it for local process.
6. Add StreamDB actions for runtime process events and journal output rows.
7. Convert `launcher.ts` into the workflow-native launcher path.
8. Update the tracer test to run a real local command that prints Claude
   stream-json-compatible JSONL, then verify durable provider-wire rows.
9. Run:
   - `pnpm effect:diagnostics`
   - `pnpm run check`

Only after that should the next agent move to `002-provider-wire-journal-to-session-state.md`,
then `003-provider-wire-journal-to-permission-workflow.md`.

## Open Design Questions

### Physical Destination For Provider-Wire Rows

The docs intentionally talk about a provider-wire journal. For tracer 001, the
implementation can keep this as a collection in the launch StreamDB state or as
a derived/internal stream destination.

Given the client should not pass stream URLs, prefer the simplest internal
choice first: one launch stream with state collections/actions for launch rows,
process events, provider-wire rows, and diagnostics rows. Split physical streams
later only if needed.

### Provider Helper Package Boundary

The docs use:

```ts
import { local } from "@firegrid/runtime/durable-launch/providers"
```

Before implementation, decide whether provider helpers are browser-safe enough
to live under `@firegrid/client` or `@firegrid/protocol`, or whether
`@firegrid/runtime/durable-launch/providers` can expose a browser-safe subpath
with no Node-only imports.

The helper must not pull process/sandbox implementation code into browser
bundles.

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
- `packages/runtime/src/durable-launch/launcher.ts`
- `packages/runtime/src/durable-launch/store.ts`
- `packages/runtime/src/durable-launch/execution/sandbox.ts`
- `packages/runtime/src/durable-launch/execution/providers/local-process.ts`
- `packages/runtime/src/durable-launch/launcher.test.ts`
- `packages/runtime/src/durable-workflow/workflows.ts`
- `packages/runtime/src/durable-workflow/engine-runtime.ts`
- `packages/runtime/src/durable-workflow/workflow-engine.test.ts`
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
- Do not expose planes, bindings, journal rules, stream URLs, or launch ids in
  the public client launch input.
- Do not build session materialization into the launch workflow.
- Do not build permission handling into the launch workflow.
- Use `createStreamDB` state/actions directly instead of a custom wrapper store.
- Keep `SandboxProvider.stream(...)` non-durable; durability begins only after
  the workflow activity appends journal rows.
- Keep Acai specs and ACID references aligned before implementation.

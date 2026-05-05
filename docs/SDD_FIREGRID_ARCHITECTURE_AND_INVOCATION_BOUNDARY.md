# SDD: Firegrid Architecture And Operation Messaging Boundary

Status: Draft
Product: Firegrid
Related: launchable substrate host/client/lab, runtime lab inspector, operation messaging boundary

## Summary

Firegrid is the durable execution grid.

Fireline and application clients send typed operation messages and observe
durable state. Firepixel and other runtimes execute programs over the grid. The
Firegrid substrate owns durable records, projections, and authority.

The core boundary:

```txt
clients append operation messages
runtimes advance execution
substrate validates durable authority
Durable Streams + Durable State remain the source of truth
```

This SDD reframes the current `client` / `host` / `substrate` split. The current
implementation names are transitional. The intended architecture should reduce
surface area, not add more names:

```txt
client  -> app-facing operation messaging/read SDK
runtime -> server-side participant that runs programs
substrate -> durable kernel and authority
lab -> read-only or typed-operation inspector
```

## Why Firegrid

Firegrid names the durable execution fabric under Fireline and Firepixel.

```txt
Fireline
  user/session/client interaction line

Firepixel
  agent/runtime participant overlaid on the grid

Firegrid
  durable execution grid shared by clients, runtimes, and inspectors
```

Multiple Firepixel runtimes can be overlaid on the same Firegrid. They do not
own the source of truth. They participate by appending valid execution facts
through substrate authority.

## Current Confusion

The current package names and APIs blur several concerns:

1. `client` currently behaves partly like an app SDK and partly like a low-level
   substrate access SDK.
2. `host` currently means boot layer, runtime participant, embedded dev server,
   host program runner, and local process helper.
3. `client.work.declare(...)` exposes kernel vocabulary to application code.
4. `packages/host` imports `@durable-agent-substrate/client` for `withHost`,
   creating a backwards dependency from server/runtime infrastructure to the
   app-facing client package.
5. Dev convenience around the lab has drifted between fixed ports, Turbo
   orchestration, and host process management.

The target design removes this confusion by assigning each package one role.

## Naming Model

Preferred conceptual names:

| Current Term | Target Term | Meaning |
| --- | --- | --- |
| durable-agent-substrate | Firegrid | Product/fabric name |
| substrate | Firegrid substrate | Durable kernel |
| client | Firegrid client | App-facing operation messaging/read SDK |
| host | Firegrid runtime | Server-side participant |
| operation | Operation | Typed runtime capability |
| invocation/message | Message | Durable request to run an operation |
| invocation id | Handle | Durable identity for a message |
| event plane | EventStream | Typed caller-owned event stream descriptor |
| projection/read model | View | Materialized durable read model |
| HostProgramGraph | Runtime Layer | Ordinary Effect Layer run by a runtime |
| HostPrograms | Firegrid Layer constructors | Runtime helper Layers |
| HostProgramRuntime | RuntimeContext | Narrow runtime context injected by the runtime |
| work | run / message internals | Kernel execution record, not app vocabulary |

The API should stay precise rather than over-themed. Firegrid is the fabric
name; the API vocabulary is:

```txt
Runtime
  server-side participant that advances execution

Operation
  typed capability exposed by a runtime

Message
  durable request sent to an operation

Handle
  durable identity for a message

EventStream
  typed caller-owned event stream descriptor

View
  materialized read model over durable state
```

This yields the intended sentence:

```txt
A client sends an operation message onto Firegrid. A runtime advances that
message by running the operation handler. Firegrid records internal runs and
completions, validates authority, and exposes views over durable state.
```

The repository has been renamed to Firegrid. Package migration can still be
gradual, but the target package names should use the Firegrid scope:

```txt
@firegrid/substrate
@firegrid/client
@firegrid/runtime
@firegrid/lab
```

## Design Constraints

### Client Constraints

The app-facing client is intentionally narrow.

It may:

1. Send typed operation messages.
2. Make request-response calls as sugar over send/result.
3. Attach to and observe operation handles.
4. Read curated views suitable for apps and labs.
5. Emit caller-owned event rows through registered EventStream APIs.
6. Use Effect-native APIs: `Effect` for actions and `Stream` for live
   observation.
7. Run in browser, Node, and long-lived app environments without host/runtime
   imports.

It must not:

1. Expose `work`, `run`, `completion`, `claim`, or row-builder vocabulary at the
   app root.
2. Expose `client.work.declare(...)` as the primary way to start durable
   execution.
3. Claim work, terminalize runs, resolve completions, or execute handler side
   effects.
4. Import or bundle runtime handler implementation code.
5. Start or manage a runtime process.
6. Depend on hidden runtime writer APIs.
7. Treat process-local state as durable authority.

### Runtime Constraints

The runtime is a server-side participant.

It may:

1. Attach to a Firegrid stream.
2. Run a caller-supplied Effect Layer.
3. Execute operation handlers under `CurrentWorkContext`.
4. Run durable subscriber programs: timer, scheduled-work, projection-match,
   materializer, operator, and future runtime-specific programs.
5. Append execution facts through substrate authority.
6. Own embedded Durable Streams only in local development mode.

It must not:

1. Import the app-facing client package as part of its core runtime library.
2. Provide a special app client as a runtime capability.
3. Add HTTP or out-of-band command surfaces for invoking operations.
4. Fetch program definitions from durable state.
5. Store durable progress authority in process-local caches.
6. Make runtime-specific protocols substrate-native row families.

### Substrate Constraints

The substrate is the durable kernel.

It may:

1. Own row schemas, folds, projections, and transition validation.
2. Lower typed client operation messages into internal durable records.
3. Define claim-before-side-effect and first-valid-terminal authority.
4. Provide choreography primitives and durable subscriber primitives.
5. Expose low-level APIs for runtime internals, diagnostics, and tests.

It must not:

1. Know Fireline, Firepixel, ACP, MCP, session, prompt, provider, sandbox, or
   model-specific schemas as native row families.
2. Require app clients to construct kernel row shapes.
3. Depend on client, runtime, lab, or product-specific packages.

### Lab Constraints

The lab is an inspector first.

It may:

1. Read durable streams and curated projections.
2. Live-follow durable state.
3. Later send or call typed operations through the same app-facing client API
   used by real applications.

It must not:

1. Import runtime or substrate internals into browser code.
2. Call `blockRun`, `DurableWaits`, row builders, or terminalization helpers.
3. Use lab-only writer paths to make examples pass.
4. Own a runtime process from browser code.

## Target Dependency Graph

The target package graph is:

```txt
substrate
  -> @durable-streams/client
  -> @durable-streams/state

client
  -> substrate

runtime
  -> substrate
  -> @durable-streams/server in embedded-dev mode

lab
  -> client
  -> @durable-streams/client for raw inspection

runtime bin/process entry
  -> runtime
```

The graph should not contain:

```txt
runtime -> client
substrate -> client
substrate -> runtime
client -> runtime
lab browser -> runtime
lab browser -> substrate
```

The current `packages/host` dependency on `@durable-agent-substrate/client` is a
design defect caused by `withHost` trying to provide an app client from the
runtime package. That convenience should be demoted, moved to tests/dev tooling,
or replaced by process-level environment injection.

## Operation And Message Model

The app-facing API should use typed operation messages. At the durable transport
level every operation starts by appending an intent and returning control. The
client SDK exposes different waiting semantics on top of that durable append.

```ts
export const Sleep = Operation.define({
  name: "sleep",
  input: SleepInput,
  output: SleepOutput,
})

// One-way durable message: append intent and return a handle.
const handle = yield* client.send(Sleep, { durationMs: 250 })

// Request-response convenience: send, then wait for the result.
const output = yield* client.call(Sleep, { durationMs: 250 })

// Delayed durable message: lower to the existing scheduled-work primitives.
const delayed = yield* client.send(Sleep, { durationMs: 250 }, {
  delay: Duration.seconds(5),
})

// Attach/observe later.
const laterOutput = yield* client.result(handle)
yield* client.observe(handle).pipe(Stream.runForEach(render))
```

An `Operation` is a browser-safe contract value: name, input schema, and output
schema. It contains no handler implementation, runtime dependencies, Durable
Streams URL, substrate writer, or mutable registration state.

Runtime behavior is installed separately as a Layer:

```ts
export const SleepLive = Firegrid.handler(Sleep, (input) =>
  Effect.gen(function* () {
    yield* Choreography.sleep(input.durationMs)
    return { slept: true }
  }),
)
```

This split is deliberate. Clients need the operation contract value at runtime
to encode input and route messages. Bundling handler code into the same value
would make browser safety depend on tree-shaking and lint rules. The v1 design
uses separate artifacts instead: `Operation.define(...)` is client-safe;
`Firegrid.handler(...)` is runtime-only.

Runtime composition is ordinary Effect Layer composition. Firegrid should
provide Layer constructors, not a parallel graph DSL:

```ts
export const FirepixelRuntimeLive = Layer.mergeAll(
  Firegrid.runtimeLayer({ name: "firepixel" }),
  SleepLive,
  Firegrid.subscribers.timer,
  Firegrid.subscribers.scheduledWork,
)
```

The client does not declare work. It sends typed operation messages and may wait
for their results. Work/runs are substrate internals.

## Event Streams

Use `EventStream` as the client/runtime-facing name for caller-owned event
streams. The older `EventPlane` vocabulary can remain as an internal substrate
or migration term, but it should not be the ergonomic app API name.

An EventStream is a typed descriptor value:

```ts
const AcpEvents = EventStream.define({
  name: "acp.events",
  schema: AcpEvent,
})
```

Conceptual type:

```ts
interface EventStreamDefinition<Name extends string, Event, Encoded> {
  readonly _tag: "EventStreamDefinition"
  readonly name: Name
  readonly schema: Schema.Schema<Event, Encoded>
}
```

So `AcpEvents` has a type like:

```ts
EventStreamDefinition<"acp.events", AcpEvent, AcpEventEncoded>
```

The descriptor is safe for browser and runtime imports. It contains no client
instance, runtime handler, Durable Streams URL, materializer, substrate writer,
or mutable registry.

Client usage is verb-first and Stream-first:

```ts
yield* client.emit(AcpEvents, event)
yield* client.events(AcpEvents).pipe(Stream.runForEach(render))
```

Runtime usage:

```ts
const AcpEventsLive = Firegrid.eventStream(AcpEvents, {
  materialize: (event, state) => ...,
})
```

`Firegrid.eventStream(...)` returns a Layer. It installs runtime behavior for
the EventStream descriptor; it is not a side-effecting global registration call.
The important locked decision is that the shared typed event descriptor is an
`EventStream`.

## API Type Shape

The public API should pin concrete operation and handle types. A sketch:

```ts
interface OperationDefinition<Name extends string, Input, Output, EncodedInput, EncodedOutput> {
  readonly _tag: "OperationDefinition"
  readonly name: Name
  readonly input: Schema.Schema<Input, EncodedInput>
  readonly output: Schema.Schema<Output, EncodedOutput>
}

interface OperationHandle<Op extends OperationDefinition.Any> {
  readonly _tag: "OperationHandle"
  readonly id: OperationHandleId
  readonly operation: Op
}
```

Client methods are single-form data-first APIs in v1. They are not dual
data-first/data-last APIs unless a concrete call site proves the extra surface
is useful:

```ts
send: <Op extends OperationDefinition.Any>(
  operation: Op,
  input: OperationDefinition.Input<Op>,
  options?: SendOptions,
) => Effect.Effect<OperationHandle<Op>, SendError, FiregridClient>

call: <Op extends OperationDefinition.Any>(
  operation: Op,
  input: OperationDefinition.Input<Op>,
  options?: SendOptions,
) => Effect.Effect<OperationDefinition.Output<Op>, SendError | ResultError, FiregridClient>

result: <Op extends OperationDefinition.Any>(
  handle: OperationHandle<Op>,
) => Effect.Effect<OperationDefinition.Output<Op>, ResultError, FiregridClient>

observe: <Op extends OperationDefinition.Any>(
  handle: OperationHandle<Op>,
) => Stream.Stream<OperationState<Op>, ObserveError, FiregridClient>
```

Expected failures should use tagged error values in the typed error channel.
Expected SDK failures must not be represented as defects.

## Effect Type Conventions

Use Effect primitives according to what each concept is:

1. `Operation` contracts are descriptor values with schema identity. They may use
   a custom `Operation.Tag`-style helper, but they are not `Effect.Service`
   classes because they do not have a default live implementation.
2. `EventStream` contracts are descriptor values. They are not services.
3. `FiregridClient` and runtime context services may use `Effect.Service` or
   explicit `Context.Tag` + `Live` Layers, but each package should pick one
   convention consistently.
4. Runtime handlers, subscribers, and EventStream materializers are ordinary
   Layers. Long-running programs should use `Layer.scopedDiscard` /
   `Effect.forkScoped`.

## Contract Sharing

The default should be implementation-free contract modules:

```txt
runtime-contracts
  Sleep
  GenerateText
  AcpSessionStart
```

Both clients and runtimes can import those contracts.

Type-only imports from runtime packages can be acceptable if lint guarantees
that browser/client code imports only types/contracts and never handler values.
They should not be the v1 default because the client still needs operation
contract values at runtime for schema encoding and routing. The dedicated
contract module remains easier to reason about and should be the first
implementation target.

## Lowering

Conceptual lowering:

```txt
client.send(OperationContract, input, options?)
  -> validate and encode input with Effect Schema
  -> append substrate-internal operation message intent
  -> if options include delay/at, lower through scheduled-work primitives
  -> runtime operation runner observes durable state when due
  -> runtime claims execution authority
  -> runtime decodes input using registered contract
  -> runtime invokes the handler with decoded input while providing
     CurrentWorkContext
  -> handler may call Choreography primitives
  -> suspension or terminalization writes substrate records
  -> client observes handle state/result through curated projections
```

Durable Streams stores events. The substrate defines which events are valid.
Runtimes execute. Clients request and observe.

## Process And Environment Model

The runtime package may expose a process runner binary. This is not a separate
client CLI; it is the runtime process entrypoint.

Example shape:

```sh
firegrid
fg --stream-url https://streams.example.com/team/grid
firegrid dev -- pnpm --filter @durable-agent-substrate/lab dev
```

`firegrid dev -- <command...>` should:

1. Boot embedded Durable Streams.
2. Create the configured substrate stream.
3. Resolve the actual stream URL, including `port: 0` cases.
4. Spawn the child command.
5. Inject environment variables:

   ```txt
   SUBSTRATE_STREAM_URL=<resolved-url>
   VITE_SUBSTRATE_STREAM_URL=<resolved-url>
   ```

6. Forward stdout/stderr and process signals.
7. Tear down embedded resources when the child exits.

The process runner should be wrapper-thin and defer to Effect Platform APIs:

1. The binary entrypoint should do little more than import the program and call
   `NodeRuntime.runMain(program)`.
2. Process execution should use `@effect/platform/Command`, not direct
   `node:child_process` orchestration.
3. Child environment injection should use `Command.env(...)`.
4. Stdout/stderr and inherited terminal behavior should use Command/Terminal
   platform services rather than custom stream prefixers when possible.
5. User-visible CLI output should use `@effect/platform/Terminal`.
6. Runtime and child-process lifetime should be `Effect.scoped`: embedded
   stream server and child process resources are acquired, linked, and finalized
   through the same scope.
7. The platform dependencies should be provided by `@effect/platform-node`
   layers at the process edge.

Conceptual entrypoint:

```ts
#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { program } from "../src/bin/firegrid.ts"

NodeRuntime.runMain(program)
```

Conceptual child command:

```ts
const command = Command.make(childCommand, ...childArgs).pipe(
  Command.env({
    SUBSTRATE_STREAM_URL: streamUrl,
    VITE_SUBSTRATE_STREAM_URL: streamUrl,
  }),
)
```

The binary should not grow its own process manager. Signal handling, exit-code
handling, resource finalization, environment injection, and terminal IO should
come from Effect Platform unless a concrete gap is identified.

This removes the need for:

1. Runtime package importing the app client.
2. Fixed dev ports as the main coupling mechanism.
3. Lab-specific runtime code.
4. Turbo as the semantic process orchestration layer.

Turbo can still be useful repo tooling for build caching. It should not define
the Firegrid runtime/client boundary.

## Environment Concerns

### Browser Client

Browser code must:

1. Import only the app-facing client and safe contract modules.
2. Avoid Node APIs.
3. Use `Stream`-first observation with explicit bridges for UI rendering.
4. Receive stream configuration through environment, query string, or a future
   application configuration layer.

### Backend Client

Backend client code may:

1. Use the same app-facing client API.
2. Use `ManagedRuntime` for long-lived processes.
3. Invoke operations at higher throughput.
4. Emit EventStream rows when registered.

It still must not execute handlers or append terminal execution facts.

### Runtime Process

Runtime processes may:

1. Run long-lived scoped Effect programs.
2. Use `Layer.scopedDiscard` and `Effect.forkScoped` for durable subscribers.
3. Use subscription/deadline-driven wakes rather than fixed polling.
4. Recover from restart by replaying durable state.
5. Run duplicate/concurrent participants safely through substrate authority.

`RuntimeContext` and `CurrentWorkContext` are distinct:

1. `RuntimeContext` is process/runtime-level context: stream URL, process
   identity, content type, and runtime metadata.
2. `CurrentWorkContext` is per-message execution context provided while an
   operation handler is running.

Handlers receive decoded input as an argument and run with `CurrentWorkContext`
available in the Effect environment.

### Tests

Tests may use lower-level APIs, but those APIs should live under explicit
kernel/testing imports. Test convenience should not define app-facing package
shape.

## Performance Constraints

Client:

1. Avoid broad replay for normal observation.
2. Prefer targeted handles and projections.
3. Use `Stream` for live observation and interruption.
4. Encode/decode schemas at the boundary.
5. Support idempotent send/call.

Runtime:

1. No fixed-cadence polling for durable subscriber programs.
2. Use stream-edge and deadline-derived wakes.
3. Coalesce wake bursts.
4. Bound operator concurrency.
5. Avoid full projection rebuild per wake when a live durable-state handle can
   be reused safely.
6. Treat local memory as coordination only, never durable authority.

Substrate:

1. Keep folding and transition validation deterministic.
2. Preserve first-valid-terminal semantics.
3. Keep schemas owned by their row family package.
4. Do not add product-specific schemas to the kernel.

## Surface Area Reduction Plan

Immediate design cleanup:

1. Treat Firegrid as the product/fabric name in SDDs.
2. Treat `host` as the current implementation name for the future runtime
   package; the target package name is `@firegrid/runtime`.
3. Document `runtime -> client` as an architecture defect.
4. Stop adding app-client conveniences to the runtime package.
5. Keep lab read-only until typed operation messaging exists.

Next implementation cleanup:

1. Move `client.work.declare` out of the app root or mark it as low-level
   kernel/testing API.
2. Replace public `withHost` semantics that provide a `SubstrateClient`.
3. Add a runtime process runner that injects `SUBSTRATE_STREAM_URL` into child
   processes.
4. Remove fixed-port coupling from the lab default when process injection is
   available.
5. Keep Turbo for build caching only, not as the architectural runtime/lab
   composition contract.

Typed operation messaging slice:

1. Add `Operation.define({ name, input, output })` as the browser-safe contract
   API.
2. Add `Firegrid.handler(Operation, run)` as the runtime-only handler Layer
   constructor.
3. Add `client.send(Operation, input, options?)` as the primitive one-way
   durable message API.
4. Add `client.call(Operation, input, options?)` as request-response sugar over
   `send` + `result`.
5. Add delayed/scheduled send options on top of the existing scheduled-work
   primitives:

   ```ts
   client.send(Operation, input, { delay })
   client.send(Operation, input, { at })
   ```

6. Add `client.result(handle)` and `client.observe(handle)`.
7. Add runtime Layer constructors for subscribers and EventStreams.
8. Add the first end-to-end typed operation messaging example.
9. Only then add lab write controls.

Naming migration:

1. Rename docs from Host Program Graph to ordinary runtime Layer composition.
2. Rename code in a focused compatibility slice:
   - `SubstrateHost` -> `FiregridRuntime`
   - `SubstrateHostBoot` -> `FiregridRuntimeBoot`
   - `HostPrograms` -> Firegrid runtime Layer constructors
   - `HostProgramRuntime` -> `RuntimeContext`
3. Rename the package from `@durable-agent-substrate/host` to
   `@firegrid/runtime`.
4. Expose runtime process binaries named `firegrid` and `fg`.
5. Keep compatibility exports temporarily if needed.

## Decisions

1. Firegrid is the canonical product/fabric name.
2. The runtime package should cut over to `@firegrid/runtime`.
3. The runtime process binary should be `firegrid`, with `fg` as a short alias.
4. Typed operation messaging v1 should distinguish `send` from `call`:
   `send` durably appends intent and returns a handle; `call` is sugar for
   `send` followed by `result`.
5. Delayed/scheduled operation messages belong in v1 as `send` options. They
   should lower to the existing scheduled-work primitives rather than introduce
   a new scheduling mechanism.
6. Low-level kernel APIs live in `@firegrid/substrate`, not under the
   app-facing client package. `@firegrid/client` should not gain a `kernel`
   subpath unless a concrete external diagnostic use case proves it is needed.
7. Public `withHost` does not survive. Runtime process injection replaces it.
   Tests may keep local helpers, but the runtime package should not publicly
   provide an app client.
8. Operation contracts and runtime handlers are separate artifacts.
   Browser/client code imports `Operation.define(...)` values. Runtime code
   installs handlers with `Firegrid.handler(...)` Layers.
9. EventStream client APIs are verb-first: `client.emit(EventStream, event)` for
   writes and `client.events(EventStream)` returning `Stream` for observation.

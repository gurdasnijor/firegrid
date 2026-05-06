# SDD: Firegrid Agent Runtime Substrate

Date: 2026-05-06

Status: Proposal, docs-only

Future spec:
`features/firegrid/firegrid-agent-runtime-substrate.feature.yaml`

## Purpose

Firegrid already has the primitives needed to host long-running runtime-style
work: operations, EventStreams, EventPlanes, RunWait, projection-match
subscribers, and `Firegrid.composeRuntime`.

Agent runtime products such as Flamecast need a profile that says how those
existing primitives compose into a durable runtime substrate without Firegrid
becoming an agent product. This proposal defines that profile.

The goal is not to add Flamecast sessions, prompts, providers, capabilities, or
permissions to Firegrid. The goal is to make it clear that Firegrid can host
product-owned runtime work that:

- stays Pending across multiple wait/resume cycles;
- emits app-owned rows before suspending;
- resumes from durable projection/completion state;
- terminalizes only through typed handler return values or `Effect.fail`;
- is observable through public client surfaces;
- runs runtime code in a Node tier while browser/edge code uses only
  `@firegrid/client`.

## Prior Art: Electric Durable Transports and Durable Sessions

The Electric `transport` repository and Durable Sessions pattern are useful
design references, not target architecture.

Relevant references:

- `electric-sql/transport` describes Durable Streams based durable transport
  and session implementations.
- `packages/transport` provides a fetch-compatible durable transport that
  proxies SDK requests, subscribes to a Durable Stream, persists active
  generation offsets, and resumes streams.
- `packages/durable-session` provides a framework-agnostic durable chat client
  backed by `@durable-streams/state`, TanStack DB, and typed collections.
- `packages/react-durable-session` layers React hooks over the framework-neutral
  durable chat client.
- Electric's Durable Sessions writeup frames durable sessions as persistent,
  addressable, subscribable state that supports multi-tab, multi-device,
  multi-user, and multi-agent collaboration.

Useful design lessons:

- Durable streams are a good substrate for persistence, addressability,
  replay, and reactive collaboration.
- Sync-first session state lets clients join, reconnect, and materialize state
  without coupling the UI to a one-shot request/response stream.
- Framework adapters should sit above a framework-neutral client.
- Optimistic UI writes still need backend/product authority for authentication
  and business rules.
- Transport adapters can preserve existing AI SDK ergonomics while moving
  persistence and replay into durable streams.
- Session state benefits from typed collections and derived materialized views
  such as messages, tool calls, pending approvals, active generations,
  statistics, presence, and agents.

Key differences from Firegrid:

- Firegrid is not trying to be a chat/session product package.
- Firegrid runtime execution is Effect/Node-tier and composed through
  `Firegrid.composeRuntime`, not a direct SDK fetch replacement.
- Firegrid separates durable operation lifecycle, EventStream history,
  EventPlane rows, RunWait, and runtime subscribers instead of collapsing them
  into one chat session abstraction.
- Firegrid should not adopt TanStack AI message parts, `AgentSpec`, tool call,
  approval, or provider vocabulary as substrate semantics.
- Firegrid's public client must preserve the existing authority boundary:
  browser/edge code can observe and send through public descriptors, but it
  does not gain kernel, runtime, claim, completion, or terminal authority.

## Problem Statement

The current public Firegrid primitives are individually useful, but a downstream
integrator still has to infer the combined shape for agent-runtime use cases.
That creates ambiguity around:

- whether one operation may remain Pending across multiple durable waits;
- whether `Pending` can be interpreted as a product-specific blocked reason;
- how app-owned control rows should model cancel, steer, interrupt, or continue;
- how a handler should reenter after durable resume;
- what a browser client may observe or import;
- whether runtime code can run in Cloudflare Workers or must run in Node.

The Electric references sharpen the product-facing need: users expect durable
agent sessions to feel reactive, collaborative, reconnectable, and compatible
with existing AI SDK ergonomics. Firegrid should enable that experience by
providing durable substrate guarantees and public read/observe surfaces, while
leaving chat/session and SDK adapter semantics downstream.

This SDD makes those answers explicit before a Flamecast smoke or production
integration starts.

## Design Principle

Firegrid owns the durable execution mechanics. Products own the meaning of the
runtime work.

```txt
Firegrid says: this operation is pending, waiting, resumed, completed, failed,
or cancelled through durable mechanics.

Flamecast says: this session is waiting for a provider callback, permission,
tool result, promptability decision, or runtime-specific control.
```

`Pending` remains an operation lifecycle state. It must not become a product
state enum.

## Ownership Boundary

Firegrid owns:

- operation lifecycle;
- handler registration and runtime composition;
- durable waits and wakeups;
- projection-match subscription mechanics;
- app-owned row emission through public producers;
- typed terminalization through handler return and `Effect.fail`;
- reconnect/replay posture for client observation;
- package/runtime locality boundaries.

Products own:

- session, prompt, turn, provider, permission, capability, and tool semantics;
- product state machines;
- provider lifecycle and reattach behavior;
- provider credentials and runtime adapter layers;
- user-facing cancel, steer, delete, retry, and permission policy;
- UI interpretation of app-owned EventPlane/EventStream rows.

## Runtime Topology

The first profile is split-tier:

- `@firegrid/client` is the browser/edge-safe product client surface.
- `@firegrid/runtime` is a Node-tier runtime process surface.
- Cloudflare Worker code, browser code, or other edge code must not import
  `@firegrid/runtime`.
- Runtime handlers and subscribers are composed with
  `Firegrid.composeRuntime`.

For Flamecast, this means:

- Worker/API code may send operations and observe state through
  `@firegrid/client`.
- A Node-side test harness or sidecar runs the Firegrid runtime.
- Provider adapters run below the product runtime layer, not inside Firegrid
  packages.

Compared to Electric's durable transport adapter model, Firegrid should not
start by replacing AI SDK fetch/transport directly. The first Firegrid profile
is a substrate-runtime profile: product code sends durable operations and
observes app-owned rows; a Node runtime executes handlers and subscribers.
Downstream products may later build SDK-specific adapters on top of those
public Firegrid surfaces.

## Long-Lived Operation Profile

A runtime-style operation may remain Pending while work is still legitimate.
Pending can cover:

- handler startup;
- durable row emission;
- waiting for an app-owned projection match;
- waiting for external callback rows;
- waiting for scheduled work;
- waiting for app-owned control rows;
- replay/recovery before live side effects resume.

The public client does not need to know which of those is happening unless the
product exposes app-owned projection rows that explain it.

## Multi-Wait Resume

A handler may perform more than one durable wait before terminalization.

The safe shape is:

1. Decode operation input.
2. Emit app-owned request/progress row.
3. Suspend with RunWait or equivalent public wait primitive.
4. Resume from durable completion/projection state.
5. Emit more app-owned rows or wait again.
6. Return typed output or fail with typed operation error.

The handler must not author raw terminal run rows. The durable wait and resume
mechanics are substrate concerns; product state remains app-owned rows and
events.

## App-Owned Control Rows

V1 cancel, steer, interrupt, and continue semantics should be modeled as
app-owned EventPlane rows.

Firegrid may later add ergonomic helpers, but any helper must lower to the same
durable control-row semantics. It must not expose kernel/control-plane
authority or product-specific cancel meanings.

Examples of product-owned control rows:

- `flamecast.session.cancel.requested`;
- `flamecast.session.steer.requested`;
- `flamecast.permission.resolved`;
- `flamecast.provider.callback.received`.

Those names belong to the product, not Firegrid.

## Reconnect and Replay

A client must be able to recover by reading durable operation state and
product-owned projections/events. The profile assumes:

- terminal operation state resolves from durable snapshot before live follow;
- app-owned event/projection replay catches up before live tail;
- replay gaps are typed read failures, not silent best-effort state;
- product UIs interpret app-owned rows rather than relying on private runtime
  state.

Detailed query handle semantics belong to
`firegrid-projection-query.feature.yaml` and its companion SDD.

Electric's Durable Session pattern reinforces one additional point: reactive
client state should be built from durable data, not from process-local callback
memory. Firegrid's answer should be descriptor-scoped projection/query handles,
EventStream replay, and app-owned materialized state. Framework-specific hooks
or AI SDK adapters can be downstream wrappers over that foundation.

## Reactive Session Shape

This substrate profile should allow products to build a durable session shape
similar in user experience to Electric Durable Sessions:

- multiple clients can observe the same durable work;
- multiple agents can append or react to app-owned rows;
- UI state can be derived from materialized durable projections;
- active work can be represented as app-owned progress rows, not hidden local
  state;
- reconnect can replay retained state before following live changes;
- product backends retain authority over writes and side effects.

Firegrid should provide the generic mechanisms for that shape:

- operation lifecycle and typed terminalization;
- EventStream history;
- EventPlane state rows;
- projection/query handles;
- RunWait and projection-match wakeups;
- runtime subscribers;
- trace/correlation metadata.

Products define the session model:

- message schemas;
- tool call and approval schemas;
- presence semantics;
- registered agent semantics;
- optimistic mutation policy;
- SDK-specific transport adapters.

This separation keeps Firegrid useful for collaborative agent applications
without baking a chat protocol into the substrate.

## Illustrative Use Cases

These examples use neutral names. A product can map them to sessions, turns,
provider callbacks, approvals, or prompts downstream.

### Use Case 1: One Runtime Operation With External Result

A browser or edge API sends a durable operation. A Node runtime handler emits an
app-owned request row, suspends, and later resumes when an external result row
arrives.

```txt
browser/edge client
  -> client.send(Operation, input)
  -> client.observe(handle) sees Pending

Node runtime
  -> handler emits app.requested row
  -> handler RunWait.for(app.result row)
  -> projection-match wakes handler
  -> handler returns typed output

browser/edge client
  -> client.result(handle) returns typed output
  -> client.events(AppEvents) replays normalized history
```

This proves Firegrid can carry the durable execution loop without defining the
meaning of the request or result.

### Use Case 2: Multi-Wait Runtime Work

A long-lived runtime operation may need multiple durable handshakes:

```txt
1. emit work-requested
2. wait for work-result
3. emit review-requested
4. wait for review-result
5. emit final-event
6. return typed operation output
```

Firegrid owns the durable wait/resume mechanics. The product owns the row
schemas and whether the two waits mean provider callback, permission decision,
human review, tool result, or any other domain action.

### Use Case 3: Reactive Client State

A UI should not rely on a live in-memory callback from the runtime process. It
should rebuild state from durable facts:

```txt
1. read operation lifecycle
2. replay app EventStream entries
3. read projection snapshot
4. follow from snapshot cursor
5. render product state from decoded rows
```

This is the Firegrid version of the useful Durable Sessions idea: clients join
durable state, catch up, then follow live changes.

### Use Case 4: App-Owned Control

Cancel, steer, interrupt, and continue are modeled as product control rows in
v1. A handler may wait for or poll those rows, then decide how to terminalize.

```txt
client emits app.control.cancel_requested
handler observes control row
handler fails with typed OperationCancelled or product-owned error
client.result(handle) returns typed Left
```

Firegrid may later add ergonomic helpers, but they should lower to this same
row pattern.

## Illustrative Implementation Shape

These sketches are not final APIs. They show the intended composition using
current Firegrid concepts.

### 1. Product-Owned Descriptors

The product defines operation, event, and state schemas. Firegrid only carries
and validates the public descriptor boundary.

```ts
import { Effect, Schema } from "effect"
import { EventStream, Operation } from "@firegrid/client"
import { EventPlane } from "@firegrid/substrate/event-plane"

const StartWorkInput = Schema.Struct({
  workId: Schema.String,
  initialText: Schema.String,
})

const StartWorkOutput = Schema.Struct({
  workId: Schema.String,
  finalText: Schema.String,
})

const StartWorkError = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("OperationCancelled"),
    workId: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ExternalResultFailed"),
    workId: Schema.String,
    reason: Schema.String,
  }),
)

export const StartWork = Operation.define({
  name: "example.work.start",
  input: StartWorkInput,
  output: StartWorkOutput,
  error: StartWorkError,
})

export const WorkEvents = EventStream.define({
  name: "example.work.events",
  event: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("Requested"),
      workId: Schema.String,
    }),
    Schema.Struct({
      _tag: Schema.Literal("Completed"),
      workId: Schema.String,
      finalText: Schema.String,
    }),
  ),
})
```

### 2. App-Owned EventPlane Rows

Rows model the external handshake and control facts. Firegrid does not own their
domain meaning.

```ts
const WorkPlane = EventPlane.define({
  name: "example.work.plane",
  rows: {
    request: Schema.Struct({
      requestId: Schema.String,
      workId: Schema.String,
      prompt: Schema.String,
    }),
    result: Schema.Union(
      Schema.Struct({
        _tag: Schema.Literal("Succeeded"),
        requestId: Schema.String,
        workId: Schema.String,
        text: Schema.String,
      }),
      Schema.Struct({
        _tag: Schema.Literal("Failed"),
        requestId: Schema.String,
        workId: Schema.String,
        reason: Schema.String,
      }),
    ),
    control: Schema.Struct({
      controlId: Schema.String,
      workId: Schema.String,
      action: Schema.Literal("cancel", "continue"),
    }),
  },
})
```

Implementation may need exact `EventPlane.define` syntax adjusted to current
package APIs. The important part is that rows are app-owned and typed.

### 3. Runtime Handler With Durable Wait

The handler emits a request row before suspending. It resumes from durable
projection state, then returns or fails through the operation schema.

```ts
const StartWorkHandler = Firegrid.handler(StartWork, (input) =>
  Effect.gen(function*() {
    const producer = yield* WorkPlane.producer
    const requestId = `request:${input.workId}`

    yield* producer.emit("request", {
      requestId,
      workId: input.workId,
      prompt: input.initialText,
    })

    const result = yield* RunWait.for(
      WorkPlane.triggers.resultByRequestId(requestId),
      { resultSchema: WorkPlane.rows.result },
    )

    if (result._tag === "Failed") {
      return yield* Effect.fail({
        _tag: "ExternalResultFailed" as const,
        workId: input.workId,
        reason: result.reason,
      })
    }

    yield* client.emit(WorkEvents, {
      _tag: "Completed",
      workId: input.workId,
      finalText: result.text,
    })

    return {
      workId: input.workId,
      finalText: result.text,
    }
  }),
)
```

The final implementation should use the repo's actual producer/event emit
services. The sketch intentionally avoids terminal-row authoring and kernel
imports.

### 4. Runtime Composition

Runtime code runs in a Node tier and composes handlers/subscribers explicitly.

```ts
const runtime = Firegrid.composeRuntime({
  handlers: [StartWorkHandler],
  subscribers: [
    Firegrid.subscribers.projectionMatch({
      evaluate: WorkPlane.projections.resultByRequestId.evaluate,
    }),
  ],
  provide: [
    WorkPlane.layer({ streamUrl }),
    RunWait.layer({ streamUrl }),
  ],
})

yield* run({
  connection,
  runtime,
})
```

No browser or Worker entrypoint should import this runtime code.

### 5. Browser or Edge Client

The client sends the operation and observes lifecycle state. Product state comes
from app-owned events/projections, not from private runtime state.

```ts
const handle = yield* client.send(StartWork, {
  workId: "work-001",
  initialText: "Summarize this input",
})

yield* client.observe(handle).pipe(
  Stream.filter((state) => state._tag === "Pending"),
  Stream.take(1),
  Stream.runDrain,
)

// Only after the request is durably visible should a test append the external
// result row. Production code would receive that result through an app-owned
// callback/ingress path.
```

For UI state:

```ts
const events = client.events(WorkEvents, {
  // Exact cursor shape belongs to firegrid-projection-query.
  since: lastSeenCursor,
})
```

The browser should never import `@firegrid/runtime`,
`@firegrid/substrate/kernel`, raw Durable Streams State writers, or completion
authority.

### 6. App-Owned Control Row

V1 cancellation can be proven without a new Firegrid cancel API:

```ts
yield* controlProducer.emit("control", {
  controlId: `cancel:${workId}`,
  workId,
  action: "cancel",
})
```

A handler that supports control rows can race or poll for that row at safe
durable points and terminalize through typed `Effect.fail`:

```ts
return yield* Effect.fail({
  _tag: "OperationCancelled" as const,
  workId,
})
```

This gives products a cancellation story now while leaving a future
`client.cancel` helper as an ergonomic lowering, not a new authority model.

### 7. Package-Consumption Smoke

The first smoke should prove the profile from outside the Firegrid repo:

```txt
1. pin a 40-character Firegrid SHA
2. checkout and assert HEAD equals the pin
3. build and pack @firegrid/substrate, @firegrid/client, @firegrid/runtime
4. install packed artifacts into a temp NodeNext consumer
5. typecheck descriptors, runtime, and client code
6. run one operation that emits request -> waits -> resumes -> returns
7. assert client.observe sees Pending before external result append
8. assert client.result returns typed success and typed failure paths
9. assert no workspace:, sibling path, kernel, or forbidden-source tokens
```

The smoke can use neutral fixture names in Firegrid. A Flamecast-hosted version
can use Flamecast-owned names because it lives in the Flamecast repo.

## Implementation Sketch

This profile should first be captured as Acai ACIDs. Implementation should
mostly reference existing primitives, not create new ones.

Likely implementation needs:

1. Documentation and tests proving one operation can perform multiple waits.
2. A package-consumption smoke with a Node runtime and browser-safe client.
3. A deterministic app-owned control row example.
4. A replay/reconnect smoke that proves terminal state and event/projection
   state are recoverable after restart.
5. Package-boundary tests proving browser code does not import runtime/kernel.
6. A reactive-state smoke that derives UI-facing state from EventStream or
   projection query handles instead of process-local callbacks.
7. Optional adapter experiments that wrap Firegrid public surfaces in AI SDK
   ergonomics without changing Firegrid substrate APIs.

Any new helper should be justified by repeated boilerplate in these smokes.

## Flamecast Fit

The first Flamecast smoke can use current Flamecast-shaped schemas without
claiming full PRD compatibility:

- one operation stands in for current session/turn work;
- normalized events are Flamecast-owned EventStream entries;
- provider callback/result is a Flamecast-owned EventPlane row;
- the handler waits on a projection-match trigger;
- a Node-side runtime handles the operation;
- the client observes Pending before the result row is written;
- terminalization uses handler return or `Effect.fail`.

PRD-level ProviderManifest, ProviderCheck, CapabilitySpec, providerAuth, and
callback signing remain Flamecast work and are not required for this substrate
profile.

## Non-Goals

This proposal does not define:

- sessions, prompts, turns, providers, capabilities, permissions, tools, MCP,
  ACP, sandboxes, browser UI, or product SDKs;
- TanStack AI, Vercel AI SDK, React, or framework-specific adapter APIs;
- chat message, tool call, approval, presence, or agent registration schemas;
- provider lifecycle, credentials, reattach profiles, or model catalogs;
- a new public cancel API;
- operation state variants beyond the existing public lifecycle shape;
- runtime module loaders or dynamic adapter loading;
- edge-hosted `@firegrid/runtime`;
- raw durable run row authoring.

## Review Checklist

Future specs and implementation PRs should prove:

- all behavior cites Acai ACIDs;
- product vocabulary appears only as non-scope examples;
- browser/client code imports only public browser-safe surfaces;
- runtime examples use `Firegrid.composeRuntime`;
- waits emit app-owned durable facts before suspension;
- external decisions/results are written only after deterministic request or
  Pending observation;
- terminalization is by handler return or `Effect.fail`;
- no kernel/control-plane imports appear in app code.

## Open Decisions

1. Smoke location:
   The first package-consumption smoke likely belongs in `flamecast-agents` on
   a dedicated branch, but only after W-01, W-02, and projection-query ACIDs are
   accepted.

2. Cancellation helper:
   V1 uses app-owned control rows. A future helper is ergonomic only if it
   lowers to the same durable facts.

3. Reconnect granularity:
   Operation state observation and projection/event replay can be specified
   separately, but the first smoke should exercise both.

4. Adapter posture:
   Decide when to add examples or downstream packages that make Firegrid feel
   like a durable transport/session layer for specific AI SDKs. That work
   should follow the substrate profile, not precede it.

# SDD: Firegrid Session And Fact Client Surfaces

Status: draft

Related specs:

- `firegrid-session-fact-client-surfaces`
- `firegrid-schema-projection-contract`
- `firegrid-client-api`
- `firegrid-client-projection-api`
- `firegrid-dark-factory-app`
- `firegrid-platform-invariants`

## Problem

The dark-factory app proved that Firegrid's core primitives are sufficient to
run an autonomous planner, observe durable runtime output, wait for permission
requests, and resume through durable ingress. It also exposed two API seams
that are still too low-level for consuming apps:

1. The app-facing client still leaks `contextId` vocabulary in places where the
   product mental model is "session".
2. The app had to invent a generic-looking `DarkFactoryFact` table to represent
   accepted external triggers, human decisions, provider evidence, and durable
   wait targets.

The first is mostly naming and typing. The second is a stronger design signal:
the app is not trying to make Firegrid know Linear, GitHub, Slack, or factory
phases. It is trying to use a generic pattern:

```txt
external or human event
  -> idempotent durable row
  -> wait_for can match scalar fields
  -> planner observes row and continues
  -> provider side effects write evidence rows
```

That pattern deserves a paved Firegrid surface, while product-specific
providers, prompts, side effects, and UI joins remain app-owned.

## Goals

1. Make public client session identity clear without introducing a second
   durable identity table.
2. Let app code work with `sessionId` while preserving the implementation fact
   that `sessionId` is encoded exactly as `RuntimeContext.contextId` for v1.
3. Provide a schema-first pattern for app-owned fact/evidence sources so apps do
   not have to rediscover the same DurableTable + SourceCollections + wait_for
   shape.
4. Provide ergonomic paved roads for provider webhook/action evidence without
   turning provider semantics into Firegrid-native vocabulary.
5. Keep `@firegrid/client` browser-safe and runtime-source-free.

## Current State

The useful session facade already exists in `@firegrid/client`:

- `firegrid.sessions.createOrLoad(...)` creates or loads a durable
  RuntimeContext-backed session from an external key;
- the returned handle has `prompt(...)`, `start()`, `snapshot()`,
  `wait.forPermissionRequest(...)`, and `permissions.respond(...)`;
- `wait.forPermissionRequest(...)` already reads the host-owned
  `RuntimeOutputTable.events` stream for the scoped context and waits for the
  first normalized permission request after an optional sequence;
- `permissions.respond(...)` already appends a host-owned `RuntimeIngress`
  control row with `_tag: "PermissionResponse"`;
- the client package remains runtime-source-free and receives active start
  authority through `RuntimeStartCapability`.

What does not exist yet:

- a public `sessionId` schema alias that documents
  `sessionId === RuntimeContext.contextId`;
- `firegrid.sessions.attach({ sessionId })` for creating the same scoped handle
  when the app already knows the durable session id and does not want to restate
  runtime config;
- protocol-owned runtime agent-output projection helpers shared by runtime,
  client, and apps;
- top-level `options` on permission request observations;
- a fact-source descriptor/helper for app-owned durable facts and provider
  evidence.

## Non-Goals

- Do not add Linear, GitHub, Slack, provider registry, OAuth, or model/provider
  semantics to Firegrid.
- Do not move `DarkFactoryTable`, factory run statuses, planner prompt wording,
  or factory UI read-model joins into Firegrid.
- Do not make ACP's wire-level `sessionId` the public Firegrid durable identity.
- Do not introduce a Firegrid-owned provider webhook endpoint.
- Do not add a platform parent/child session hierarchy.

## Session Identity

Firegrid's durable execution identity is still the `RuntimeContext` row. The
public app-facing name should be `sessionId`.

For v1:

```txt
Firegrid public sessionId === RuntimeContext.contextId
```

This is an alias, not a new id space. There is no session-placement table and no
translation lookup. The encoded string is identical.

This should be captured in the Effect Schema type system:

```ts
export const FiregridSessionIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("FiregridSessionId"),
).annotations({
  identifier: "firegrid.sessionId",
  title: "Firegrid session id",
  description:
    "Public Firegrid session id. In v1 this is encoded exactly as RuntimeContext.contextId.",
})

export const RuntimeContextIdSchema = FiregridSessionIdSchema.annotations({
  identifier: "firegrid.runtimeContext.contextId",
  title: "Runtime context id",
  description:
    "Durable RuntimeContext id. Public client APIs expose the same encoded value as sessionId.",
})
```

The exact code can choose one canonical schema plus a named export alias. The
important property is that Schema decoding, docs, JSON Schema, CLI help, and
client/tool projections all explain the identity relationship.

When ACP is in scope, code should use distinct names:

- `sessionId`: public Firegrid durable session id; encoded as contextId.
- `contextId`: table/runtime-host implementation field.
- `acpSessionId`: ACP wire-level session id returned by ACP `session/new`.

## Client Session API Additions

The current client has the durable session handle shape through
`firegrid.sessions.createOrLoad(...)`. The missing ergonomic surface is
attaching to a known durable session id without restating runtime config.

Target shape:

```ts
const session = firegrid.sessions.attach({ sessionId })

yield* session.prompt({
  payload,
  idempotencyKey,
})

const snapshot = yield* session.snapshot()

const permission = yield* session.wait.forPermissionRequest({
  afterSequence,
  timeoutMs,
})

yield* session.permissions.respond({
  permissionRequestId,
  decision,
})
```

`attach` does not start a runtime, load ACP history, replay transcript, or
resume a wire protocol session. It creates a scoped client handle over the
known Firegrid durable session id.

ACP terms remain reserved for codec/runtime protocol lifecycle:

- ACP `session/new`: starts a wire-level agent session.
- ACP `session/load`: attaches and replays history.
- ACP `session/resume`: attaches without replay.
- Firegrid `sessions.attach`: returns a durable client handle for an existing
  Firegrid session id.

`createOrLoad` should return the same handle shape and include `sessionId` as
the primary public field. `contextId` may remain as a compatibility alias while
existing code migrates.

### How `wait.forPermissionRequest` Works Today

The method is intentionally small. Conceptually:

```ts
const waitForPermissionRequest = (sessionId, input) =>
  Effect.gen(function*() {
    const context = yield* resolveContext(sessionId)
    const output = yield* RuntimeOutputTable

    const row = yield* Stream.runHead(
      output.events.rows().pipe(
        Stream.filterMap(parsePermissionRequestObservation),
        Stream.filter((observation) =>
          observation.contextId === sessionId &&
          (input.afterSequence === undefined ||
            observation.sequence > input.afterSequence),
        ),
      ),
    )

    return row === undefined
      ? { matched: false, timedOut: true }
      : { matched: true, request: row }
  }).pipe(
    Effect.provide(outputLayerForContext(config, context)),
    Effect.scoped,
  )
```

The real implementation resolves the `RuntimeContext` first because
`RuntimeOutputTable` is host-owned. The context row contains the host stream
prefix, so the client can open the correct output table without requiring the
caller to know host topology. A timeout races the stream wait against
`Clock.sleep`.

This shape is the model for other literate session APIs: each method should
name the user-level intent, hide stream/table routing, and remain a thin
projection over durable Firegrid primitives.

Examples of likely future methods:

```ts
session.wait.forAgentOutput({ tag: "ToolUse", afterSequence, timeoutMs })
session.wait.forTurnComplete({ afterSequence, timeoutMs })
session.outputs.snapshot()
session.ingress.inputs()
session.runs.latest()
```

Those names are illustrative, not accepted API. The design rule is accepted:
literate APIs should be schema-backed client projections, while low-level
tables remain available for advanced callers.

## Runtime Observation Projection

Factory currently decodes runtime output rows by parsing
`RuntimeOutput.events.raw` for wrappers shaped as:

```json
{ "type": "firegrid.agent-output", "event": { "_tag": "PermissionRequest" } }
```

The same decoding exists in runtime observation sources and in the client. That
is Firegrid observation contract logic, not factory logic.

Firegrid should move the generic wrapper and projection helpers into protocol:

```txt
RuntimeAgentOutputEnvelopeSchema
RuntimeAgentOutputObservationSchema
RuntimePermissionRequestObservationSchema
parseRuntimeAgentOutputObservation(row)
parseRuntimePermissionRequestObservation(row)
```

The protocol projection should stay lightweight and browser-safe. It should not
import runtime-only codec implementations. Runtime remains responsible for
writing the output rows, and `@firegrid/client` remains responsible for
browser-safe reads.

The permission observation should expose the values apps need without decoding
runtime agent event internals:

- `sessionId`;
- compatibility `contextId`;
- `activityAttempt`;
- `sequence`;
- `permissionRequestId`;
- `toolUseId`;
- `options`;
- raw protocol-safe `event` payload for inspection.

## App-Owned Fact Sources

`DarkFactoryFact` is generic-looking because it is carrying a generic pattern:
accepted inputs and external decisions must become durable, idempotent,
waitable rows.

The product-specific table should stay app-owned, but Firegrid should provide a
small paved road for this shape.

Target concept:

```ts
const FactoryFacts = FactSource.define({
  name: "darkFactory.facts",
  schema: DarkFactoryFactSchema,
  key: ["source", "externalEventKey"],
  scalarFields: [
    "source",
    "externalEventKey",
    "externalEntityKey",
    "eventType",
    "sessionId",
    "contextId",
    "correlationId",
  ],
})
```

The names can change. The required semantics are:

- app owns the row schema and payload;
- app owns the physical DurableTable/layer configuration;
- Firegrid validates that a registered source has a stable name and rows with
  scalar fields that `wait_for` can match;
- runtime `SourceCollections` can register the collection without custom
  adapter code;
- `@firegrid/client` can expose helpers or examples for app reads without
  gaining provider write authority.

This is not a Firegrid-native provider fact table. It is a schema-first
descriptor/helper over app-owned DurableTable collections.

## Provider Evidence Paved Road

Firegrid should not encode Linear/GitHub/Slack semantics. But it should make the
safe implementation pattern obvious:

```txt
provider webhook/action/callback
  -> app verifies provider-specific auth
  -> app derives idempotency key
  -> app writes app-owned fact/evidence row
  -> wait_for observes scalar fields
  -> planner continues or asks for a permission
```

For outbound side effects:

```txt
planner requests execute capability
  -> app/runtime capability checks authority
  -> provider adapter performs fenced/idempotent side effect
  -> provider adapter writes app-owned evidence fact
  -> planner observes fact through wait_for
```

Firegrid can pave this with:

- examples and recipes;
- schema helpers for fact keys and scalar wait fields;
- optional opaque capability descriptors with `name`, `description`, and input
  schema references;
- client/tool projections that operate on generic facts and waits.

Firegrid should not own:

- provider clients;
- webhook endpoints;
- OAuth tokens;
- provider-specific retry policy;
- GitHub comment marker syntax;
- Linear assignment/comment semantics;
- Slack routing.

## Recommended Work Items

### P0: Session Id Alias And Attach Handle

Add protocol schemas for Firegrid session id and attach input. Add
`firegrid.sessions.attach({ sessionId })`, returning the same scoped handle as
`createOrLoad`.

Acceptance:

- `sessionId` decodes as the same encoded value currently stored in
  `RuntimeContext.contextId`.
- no lookup table or new row family is introduced;
- handle methods scope prompt, snapshot, wait, permission response, and start;
- `@firegrid/client` remains runtime-source-free.

### P0: Protocol Agent-Output Observation Projection

Move generic output-envelope parsing and permission observation projection into
protocol/client surfaces.

Acceptance:

- runtime, client, and factory no longer duplicate JSON wrapper parsing;
- permission observations expose top-level `options`;
- factory can derive permission read models without importing
  `@firegrid/runtime/agent-io`;
- `wait_for` over runtime agent-output observations keeps working.

### P1: App-Owned Fact Source Descriptor

Add a descriptor/helper for app-owned fact sources over DurableTable
collections.

Acceptance:

- apps can declare a fact source with stable name, schema, key, and scalar wait
  fields;
- runtime `SourceCollections` registration is one line or generated helper;
- docs show provider webhook and human decision facts without provider-specific
  Firegrid APIs.

### P1: Provider Evidence Recipe

Document the provider side-effect/evidence pattern using app-owned fact sources,
idempotency keys, wait_for, and optional execute capabilities.

Acceptance:

- examples use generic provider-shaped payloads without secrets;
- no Firegrid-owned webhook route;
- no provider-specific registry;
- planner prompt examples reference fact source names and capability names, not
  hidden callbacks.

### P2: Opaque Capability Descriptor

If repeated apps need it, add a protocol-neutral descriptor for advertised
capabilities:

```ts
{
  name: string
  description: string
  inputSchema?: Schema
  evidenceSource?: string
}
```

This is for prompt/tool/client consistency only. Execution authority remains in
runtime/app composition.

## Impact On `apps/factory`

After the P0 work:

- `PermissionResponseInput` can accept `factoryRunKey`, `permissionRequestId`,
  and `decision`; it can derive the session id from the run row.
- `readFactoryRunStatus` can use client-projected permission observations
  instead of parsing raw runtime output.
- `waitForPermissionRequest` can use `sessions.attach({ sessionId }).wait`
  instead of manually mixing snapshots and top-level `wait.for`.
- factory facts and runs stay app-owned, but their shape can align with the
  generic fact-source paved road.

## Boundary Summary

Move into Firegrid:

- session id schema aliasing and attach handle;
- generic runtime agent-output observation projection;
- generic fact-source declaration/registration ergonomics;
- provider evidence recipes and opaque capability metadata if repeated.

Keep in app:

- DarkFactory row payloads and statuses;
- Linear/GitHub/Slack/provider clients and auth;
- planner prompt wording and policy;
- provider idempotency implementation details;
- UI read-model joins and display labels.

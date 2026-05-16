# SDD: Firegrid Factory Platform Fit

Status: draft design note

Related specs:

- `firegrid-host-sdk`
- `firegrid-dark-factory-app`
- `firegrid-factory-run-process`
- `firegrid-schema-projection-contract`

## Purpose

This document holds the factory-specific findings that should not live in
`SDD_FIREGRID_HOST_SDK.md`.

The goal is for this document to shrink. As `@firegrid/client-sdk`,
`@firegrid/host-sdk`, `@firegrid/cli`, `effect-durable-operators`, and reusable
integration packages expose the right substrate, factory should delete bespoke
host glue and this SDD should lose corresponding sections.

This is not a request for a Firegrid-owned factory workflow SDK. Factory is a
consumer proving whether the generic SDKs expose enough substrate for product
apps.

## Factory Fit

Factory should be able to replace current `DarkFactoryHostLive` glue with
host-plane and session-plane SDK imports:

```ts
const FactoryHostLive = FiregridHostLive({
  name: "dark-factory",
  runtime: {
    durableStreamsBaseUrl: config.durableStreamsBaseUrl,
    namespace: config.namespace,
    headers: config.headers,
    input: true,
  },
  envPolicy: envPolicyFromFactoryConfig(config),
  localProcessEnv: config.localProcessEnv,
}).pipe(
  Layer.provideMerge(DarkFactoryTableLive),
  Layer.provideMerge(
    FiregridIntegrations.layer({
      linear: { token: config.linearToken, workspaceId: config.linearWorkspaceId },
      github: { token: config.githubToken, owner: config.githubOwner },
      slack: { token: config.slackToken, channelId: config.slackChannelId },
    }),
  ),
)
```

Factory-specific code remains:

- accepted trigger fact;
- factory run row;
- planner prompt;
- provider capabilities;
- app projection waits;
- provider policy and factory-specific side-effect decisions;
- UI projections.

Reusable integration code may live outside `apps/factory` when it is generic:

- a Linear adapter package can own Linear request/response schemas, signature
  verification, issue/comment/activity clients, and typed capability services;
- a GitHub adapter package can own GitHub client setup, PR/comment/status
  helpers, and typed capability services;
- a Slack adapter package can own Slack message APIs and typed capability
  services.

The consuming app still owns configuration and policy:

- which Linear workspace/token to use;
- which GitHub owner/repo policies are allowed;
- which Slack channel receives notifications;
- which provider actions are exposed to agents;
- how provider evidence maps into factory facts/projections.

Firegrid Host SDK code becomes:

- host-plane Layer;
- runtime launch substrate;
- session-plane service provision;
- explicit installation of reusable integration Layers.

## Factory Table Reverse Engineering

`apps/factory/src/tables.ts` is useful because it shows what the app is trying
to build without a platform primitive.

`DarkFactoryFactSchema` is not really a factory-specific fact. It is an
app-owned event/fact row:

```ts
export const DarkFactoryFactSchema = Schema.Struct({
  factKey: DarkFactoryFactKeyEncoded.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  factoryRunKey: Schema.optional(Schema.String),
  contextId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  payload: Schema.Unknown,
})
```

The generic field names are the signal. This row is carrying:

- provider trigger identity (`source`, `externalEventKey`,
  `externalEntityKey`);
- idempotency (`factKey`);
- correlation (`correlationId`);
- the app run/process link (`factoryRunKey`);
- the Firegrid runtime session link (`contextId`);
- an event taxonomy (`eventType`);
- provider-specific payload data (`payload`).

This does not imply a missing Firegrid runtime event pipeline. The existing
platform pieces already cover most of it: `effect-durable-operators`
`DurableTable` gives app-owned durable rows and streams, and
`agent-event-pipeline` gives runtime session observations. The missing piece is
SDK guidance and examples that show product apps how to combine those pieces
without copying factory host glue or inventing runtime registries.

`DarkFactoryRunSchema` is also more generic than the name suggests:

```ts
export const DarkFactoryRunSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema.pipe(DurableTable.primaryKey),
  subscriberId: Schema.String,
  source: Schema.String,
  externalEntityKey: Schema.String,
  plannerContextId: Schema.String,
  acceptedFactKey: DarkFactoryFactKeySchema,
  status: DarkFactoryRunStatusSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  correlationId: Schema.optional(Schema.String),
  repoHint: Schema.optional(Schema.String),
  linearIssueId: Schema.optional(Schema.String),
  linearIdentifier: Schema.optional(Schema.String),
  linearUrl: Schema.optional(Schema.String),
  lastPermissionRequestId: Schema.optional(Schema.String),
  lastRuntimeSequence: Schema.optional(Schema.Number),
})
```

This is an app-owned run projection:

- deterministic run identity from a provider/entity key;
- subscriber identity for app/UI consumers;
- link to the accepted trigger fact;
- link to the planner runtime session;
- current status;
- provider-specific display handles;
- latest permission/runtime cursor fields.

This is not the same as Firegrid `RuntimeRun`. `RuntimeRun` is one execution
attempt inside a runtime context. A factory run, Flamecast toy run, or future
product run is caller-owned state that may span multiple runtime sessions,
provider callbacks, permissions, and side effects. It can be modeled today as
an app-owned `DurableTable` read model linked to session-plane handles.

The current projection helpers reinforce the same point:

```ts
export const factoryPermissionProjectionFromFact = (fact: DarkFactoryFact) =>
  fact.eventType === "permission.resolved"
    ? decodePermissionResolution(fact.payload)
    : Option.none()

export const waitForFactoryProviderEffect = (options) =>
  DarkFactoryTable.facts.rows().pipe(
    Stream.filterMap(factoryProviderEffectProjectionFromFact),
    Stream.filter(/* factoryRunKey/effect/status */),
    Stream.runHead,
  )
```

These are app-local combinations of existing platform capabilities:

1. `DurableTable` rows/streams for app facts and run records;
2. pure schema-backed projections into typed read models;
3. session-plane runtime observations from `@firegrid/client-sdk`;
4. waits over app-owned projections, distinct from runtime typed waits.

Flamecast shows the read-side half of this through `DurableTableProvider`,
`useDurableTable`, and `useDurableLiveQuery`. Factory shows the process-side
half: durable trigger intake, idempotent run creation, session launch,
permission evidence, provider-effect evidence, and projection waits.

## Concrete Semantics

The platform gap is not "make Dark Factory generic" and not "invent a second
event pipeline." The gap is packaging and guidance: product apps need a clear
way to combine existing runtime session observations with app-owned durable
rows, while retaining ownership of their vocabulary and policy.

Avoid leading with the term "app event plane." The more concrete semantics are:

| Factory artifact | Concrete semantic role | Comparable systems |
| --- | --- | --- |
| `DarkFactoryTriggerSchema` | Work intake payload: a verified external event that may start or update work. | Inngest event trigger; Restate handler request; Temporal signal payload. |
| `DarkFactoryFactSchema` | Intake/evidence ledger row: durable evidence that something happened, keyed for idempotency and correlation. | Inngest event/audit record; Temporal workflow history event or signal; EventStore event. |
| `DarkFactoryRunSchema` | Work-run record: one product run for one external work item, linked to one or more Firegrid runtime sessions. | Restate workflow ID; Temporal workflow execution/read model; Inngest function run keyed by event data. |
| `factoryPermissionProjectionFromFact` | Gate record: human or policy decision evidence associated with a run. | Restate durable promise/awakeable resolution; Temporal signal; Inngest event that resumes `waitForEvent`. |
| `factoryProviderEffectProjectionFromFact` | Provider action receipt: evidence that a Linear/GitHub/Slack/provider side effect was requested, completed, failed, or deduplicated. | Temporal Activity result; Restate `ctx.run` result; Inngest `step.run` output. |
| `FactoryTimelineProjection` from the factory SDD | Timeline/read model: user-facing ordered view assembled from evidence rows plus runtime observations. | CQRS projection; EventStore read model; Temporal query result over workflow state. |

That gives us clearer primitive names:

- **work intake**: verify external input and derive the stable work identity;
- **evidence ledger**: append or insert-or-get durable evidence rows;
- **work-run record**: current state for one product run;
- **provider action receipt**: typed record of an external side effect;
- **gate record**: permission/human/policy decision state;
- **timeline/read model**: product UI projection;
- **read-model wait**: wait for one of those app-owned projections to satisfy a
  predicate.

These names are intentionally not Firegrid runtime names. They describe product
state that may use Firegrid runtime sessions, but they do not become
`RuntimeContext`, `RuntimeRun`, or runtime `wait_for` state.

## Comparable Systems

Inngest has events that trigger functions and `step.waitForEvent(...)` for
pausing a function until a later event arrives. That maps closely to
`DarkFactoryFactSchema` plus projection waits: an accepted Linear ticket is a
trigger event, and a later permission/provider/phase row is the event that
unblocks work. The difference is that Firegrid should not force the factory
into an Inngest-style hard-coded phase chain; the evidence rows should also be
visible to the planner agent and UI.

Restate distinguishes services, virtual objects, and workflows. Its workflow
ID maps to the factory work-run identity, and durable promises/awakeables map
to factory gates: one handler waits, another handler resolves the external
event. The Firegrid version should keep the same durable resume semantics, but
the product run record remains app-owned and the agent runtime session remains
a separate Firegrid runtime concept.

Temporal's equivalent vocabulary is workflow execution, signals, queries, and
activities. The factory run resembles a workflow execution/read model; provider
webhooks and human decisions resemble signals; provider side effects resemble
activities; UI status resembles a query/read model. Firegrid should learn the
separation without importing Temporal's full deterministic workflow model into
the product app. The planner is allowed to choreograph using durable evidence,
not only follow a TypeScript phase graph.

### Intake And Evidence Ledger

```ts
export const FactoryEvidenceTable = DurableTable("factory", {
  facts: FactoryFactSchema,
})
```

This can be app code. The SDK does not need a new event-plane primitive just to
express it. The useful platform affordance is a recipe and helper types around
existing DurableTable services:

```ts
const table = yield* FactoryEvidenceTable
yield* table.facts.insertOrGet(triggerAcceptedFact)
const rows = table.facts.rows()
```

### Work-Run Record

```ts
export const FactoryRunSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema.pipe(DurableTable.primaryKey),
  plannerContextId: SessionIdSchema,
  status: FactoryRunStatusSchema,
  updatedAt: Schema.String,
})
```

This also stays app-owned. The session-plane link is the important platform
boundary:

```ts
const sessions = yield* FiregridSessions
const session = yield* sessions.attach({ sessionId: run.plannerContextId })
const snapshot = yield* session.snapshot()
```

This is intentionally app-owned. Firegrid should not define `planner_started`,
`waiting_permission`, `resumed`, or `done` as runtime statuses. The app supplies
the status schema.

### Provider Action Receipts

Reusable Linear/GitHub/Slack/provider packages should expose capabilities, not
factory workflow policy:

```ts
export interface ProviderActionReceiptRecorder<Receipt> {
  readonly record: (
    receipt: Receipt,
  ) => Effect.Effect<Receipt, ProviderActionError>
}
```

An adapter can verify a webhook, call a provider API, and return typed evidence.
The consuming app decides whether that evidence means "phase completed",
"permission requested", "PR opened", or "terminal".

### Read-Model Waits

Runtime typed waits observe runtime-owned streams. App projection waits observe
app-owned rows:

```ts
const waitForReadModel = <Projection, Error, Requirements>(
  stream: Stream.Stream<Projection, Error, Requirements>,
  predicate: (projection: Projection) => boolean,
  options: { readonly timeoutMs: number },
): Effect.Effect<Projection, Error | TimeoutException, Requirements>
```

This is just a generic stream helper if it graduates at all. It belongs in
`effect-durable-operators` only if it remains generic over a provided stream
and does not know Firegrid, factory, runtime sessions, or provider names.

## Where The Primitives Belong

The likely split is:

| Need | Owner |
| --- | --- |
| Runtime session create/prompt/start/snapshot/wait/permission response | `@firegrid/client-sdk` |
| Host composition, launch substrate, start/ingress authority | `@firegrid/host-sdk` |
| Runtime output/ingress/tool routing implementation | `@firegrid/runtime/src/agent-event-pipeline` |
| Durable table declaration and live query | `effect-durable-operators` |
| Work intake and evidence rows | app-owned `DurableTable` schemas |
| Work-run records | app-owned `DurableTable` schemas linked to session-plane handles |
| Generic wait over an explicit stream | maybe `effect-durable-operators`, only if it stays Firegrid-free |
| Linear/GitHub/Slack adapters | reusable integration packages, configured by the app |
| Factory planner prompts, policy, statuses, and phase vocabulary | `apps/factory` |

The suspicious generic names in `DarkFactoryFactSchema` and
`DarkFactoryRunSchema` should therefore not be normalized by simply renaming
them. They are evidence that `apps/factory` is carrying product-app state in
`host.ts` because the SDK package boundaries and recipes are not clear enough
yet, not evidence that runtime needs another event pipeline.

## Shrink Criteria

This document should shrink as the platform improves:

- When `@firegrid/host-sdk` provides host launch substrate, remove factory
  notes about copied launch/start glue.
- When `@firegrid/client-sdk` provides the full session-plane API, remove
  factory notes about raw runtime/session observation parsing.
- When reusable integration packages exist for Linear, GitHub, Slack, or agent
  providers, remove factory notes about generic provider adapter mechanics.
- When `effect-durable-operators` exposes any generic app-owned projection wait
  helper, remove factory notes about hand-written projection wait mechanics.
- Keep only factory-owned policy, prompts, UI vocabulary, provider decisions,
  and product-specific read models.

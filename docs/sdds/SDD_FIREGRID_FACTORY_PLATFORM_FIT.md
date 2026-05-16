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
host-plane and session-plane SDK imports. The public API should make it obvious
that the host installs provider/runtime/tool capabilities, the client/session
plane launches or attaches agent sessions, and the planner agent decides the
sequence through tools.

Factory-specific code remains:

- accepted trigger fact;
- factory run row;
- planner prompt;
- provider capabilities;
- app-owned wait/read bindings installed into the Firegrid tool surface;
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
- provider implementation installation;
- environment and MCP policy;
- host authority programs that execute durable agent-session intents;
- explicit installation of reusable integration Layers and app-owned tool
  bindings.

## Factory After Host SDK

If `SDD_FIREGRID_HOST_SDK.md` lands in the target shape, factory no longer needs
to make `apps/factory/src/host.ts` the platform boundary. Factory should be a
product composition over public SDK surfaces:

1. app-owned durable rows for trigger intake, evidence, run state, and UI
   projections;
2. reusable integration packages for Linear, GitHub, Slack, and provider
   clients;
3. `@firegrid/client-sdk` for agent-session launch, prompt, snapshot, wait, and
   permission response;
4. `@firegrid/host-sdk` for provider implementations, local-process env policy,
   Firegrid MCP exposure, app-owned wait/read bindings, and execution of durable
   agent-session intents.

Factory host process:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import {
  FiregridHostLive,
  LocalProcessProviderLive,
} from "@firegrid/host-sdk"
import { DarkFactoryTableLive } from "./tables.ts"
import {
  GitHubIntegrationLive,
  LinearIntegrationLive,
  SlackIntegrationLive,
} from "@firegrid/integrations"
import { FactoryToolBindingsLive } from "./tool-bindings.ts"

const FactoryHostLive = FiregridHostLive({
  name: "dark-factory",
  durableStreams: {
    baseUrl: config.durableStreamsBaseUrl,
    namespace: config.namespace,
    headers: config.headers,
  },
  providers: {
    localProcess: LocalProcessProviderLive({
      environment: {
        source: config.environment,
        expose: {
          ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
        },
      },
    }),
  },
  mcp: { enabled: true },
}).pipe(
  Layer.provideMerge(DarkFactoryTableLive(config)),
  Layer.provideMerge(LinearIntegrationLive(config.linear)),
  Layer.provideMerge(GitHubIntegrationLive(config.github)),
  Layer.provideMerge(SlackIntegrationLive(config.slack)),
  Layer.provideMerge(FactoryToolBindingsLive),
)

NodeRuntime.runMain(Layer.launch(FactoryHostLive))
```

The host provider configuration does not name the planner agent. It only
installs provider implementations and policy. A product bootstrap or operator
action may create the durable planner session, but trigger intake does not.

Factory planner bootstrap is not per trigger. The product should have a durable
planner session identity, created by deploy/bootstrap or by an operator action,
with a prompt that tells it to wait for accepted work facts and drive the run
through tools. This is the only place the product chooses the planner agent:

```ts
import { Effect } from "effect"
import {
  Agent,
  FiregridSessions,
} from "@firegrid/client-sdk"
import { envBinding } from "@firegrid/protocol/launch"

const factoryPlanner = Agent.localProcess({
  command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
  protocol: "acp",
  cwd: config.workspaceDir,
  env: [envBinding("ANTHROPIC_API_KEY")],
})

export const ensureFactoryPlanner = Effect.gen(function* () {
  const sessions = yield* FiregridSessions
  return yield* sessions.launch({
    idempotencyKey: "dark-factory:planner",
    agent: factoryPlanner,
    prompt: factoryPlannerPrompt(),
  })
})
```

The planner prompt, not a TypeScript function chain, tells the agent to use the
Firegrid tool surface. `wait_for` is the important capability here: factory
does not create a bespoke trigger coordinator when the planner can wait on
app-projected facts and runtime observations through the same agent-facing
tool:

```text
You are the factory planner.

Use wait_for to wait for accepted work facts. When one arrives:
1. call execute/factory.run.ensure to insert or load the durable run identity;
2. read the accepted fact and run history;
3. decide the next action;
4. call session_new/session_prompt for delegated agent work when useful;
5. call wait_for for child output, permission requests, CI/provider facts, or
   runtime run state;
6. call execute for installed provider capabilities only when the current
   evidence justifies the side effect;
7. call schedule_me for future rechecks.

There is no hidden TypeScript planner -> implementer -> review -> deploy chain.
```

External trigger intake stays intentionally small:

```ts
export const ingestLinearIssue = (trigger: LinearIssueTrigger) =>
  Effect.gen(function* () {
    return yield* insertOrGetAcceptedTriggerFact({
      source: "linear",
      externalEventKey: trigger.deliveryId,
      externalEntityKey: trigger.issueId,
      eventType: "linear.issue.accepted",
      payload: trigger,
    })
  })
```

This code verifies provider input and records durable evidence. It does not
create the run, launch an implementer, wait for CI, or call GitHub. Those are
planner decisions made through the agent tool surface after `wait_for` observes
the accepted fact.

The `idempotencyKey` remains useful, but on the long-lived planner session and
on tool-authored child sessions. Duplicate provider deliveries converge through
the accepted fact key and the planner's `execute/factory.run.ensure` tool, not
through a bespoke server-side trigger workflow.

Per-work prompt context can be generated by the planner itself after
`wait_for` observes an accepted fact and `execute/factory.run.ensure` returns
the durable run identity:

```text
You are the factory planner for <factoryRunKey>.

You own sequencing. There is no hidden TypeScript workflow chain.

Durable context:
- accepted trigger fact: <factKey>
- factory run key: <factoryRunKey>
- planner session: <sessionId>
- product facts/projections: available through factory read tools
- runtime/session observations: available through Firegrid tools

Available Firegrid tools:
- session_new: create child implementer/reviewer/QA sessions when useful
- session_prompt: continue or redirect an existing child session
- wait_for: wait on runtime-owned observations such as agent output,
  permission requests, child session output, or runtime run state
- schedule_me: ask your future self to re-check provider or CI state
- execute: call app-installed provider capabilities such as GitHub PR open,
  GitHub CI read, Linear comment, Linear status update, or Slack notify

Rules:
- Do not assume a fixed planner -> implementer -> review -> QA -> deploy DAG.
- Read durable facts and session history before deciding the next action.
- Emit permission requests for human gates.
- Record provider side effects through the available execution capabilities.
- Treat terminal/waiting status as derived from durable observations.
```

Factory read side:

```ts
export const readFactoryRun = (factoryRunKey: FactoryRunKey) =>
  Effect.gen(function* () {
    const run = yield* getFactoryRun(factoryRunKey)
    const sessions = yield* FiregridSessions
    const planner = yield* sessions.attach({ sessionId: run.plannerSessionId })
    const snapshot = yield* planner.snapshot()
    const timeline = yield* buildFactoryTimeline(factoryRunKey, snapshot)
    return { run, planner: snapshot, timeline }
  })
```

Factory provider capabilities are installed as tools/capabilities for the
planner, not called by an app-authored phase chain. A provider adapter owns the
side effect and receipt recording; the planner decides when to call it:

```ts
export const FactoryProviderToolsLive = makeFactoryTools({
  githubOpenPullRequest: Effect.fn("github.openPullRequest")(function* (input) {
    const github = yield* GitHubIntegration
    const receipt = yield* github.pullRequests.open(input)
    yield* recordProviderActionReceipt({
      factoryRunKey: input.factoryRunKey,
      provider: "github",
      action: "pull_request.open",
      receipt,
    })
    return receipt
  }),
  githubReadCi: Effect.fn("github.readCi")(function* (input) {
    const github = yield* GitHubIntegration
    const receipt = yield* github.checks.read(input)
    yield* recordProviderActionReceipt({
      factoryRunKey: input.factoryRunKey,
      provider: "github",
      action: "checks.read",
      receipt,
    })
    return receipt
  }),
  linearComment: Effect.fn("linear.comment")(function* (input) {
    const linear = yield* LinearIntegration
    const receipt = yield* linear.comments.create(input)
    yield* recordProviderActionReceipt({
      factoryRunKey: input.factoryRunKey,
      provider: "linear",
      action: "comment.create",
      receipt,
    })
    return receipt
  }),
})
```

Those tools are mounted into the planner through the host-sdk agent-tool/MCP
surface. The app does not call `githubOpenPullRequest` after a hard-coded
`implementAgent` function returns. The planner calls the capability when its
current durable context supports that next step.

Factory waits are also planner-owned choreography decisions. The app contributes
wait/read bindings over app-owned rows; it does not run a shadow coordinator
that watches those rows on behalf of the planner:

```text
Planner examples:
- call session_new for an implementer;
- wait_for that child session's output or terminal runtime state;
- ask for human approval through ACP PermissionRequest;
- after approval, call execute/github.openPullRequest;
- schedule_me in 10 minutes if CI is still pending;
- wait_for the next relevant runtime observation or app-owned fact projection;
- call an app fact/read tool when it needs current state without suspending;
- schedule_me for a future recheck when the provider has not emitted new
  evidence yet.
```

The app may still provide server/UI helpers over app-owned projections:

```ts
export const readLatestProviderEffect = (query: ProviderEffectQuery) =>
  readFactoryTimeline(query.factoryRunKey).pipe(
    Effect.map(timeline => timeline.providerEffects.find(matchesProviderEffect(query))),
  )
```

That helper is a read model. It is not the factory sequencer.

Choreography ownership:

| Decision | Owner |
| --- | --- |
| Accept this provider webhook as work? | Product adapter / app policy. |
| Deduplicate provider redelivery? | Product adapter fact idempotency. |
| Keep the durable planner session alive? | Product bootstrap/operator action. Trigger intake does not launch it. |
| Insert or load the durable run identity for an accepted fact? | Planner agent through `execute/factory.run.ensure`; the app-installed capability enforces idempotency and records the run row. |
| What should happen after the planner observes accepted work? | Planner agent. |
| Should implementation, review, QA, or CI wait happen? | Planner agent. |
| Which provider side effect is allowed and how is it executed? | Planner chooses; app-installed capability enforces credentials/policy and records receipt. |
| Is the run waiting or terminal? | Derived read model over durable facts and runtime/session observations. |

Runtime waits stay on runtime-owned session observations. Factory/product fact
observation is exposed to the planner through app-installed wait/read tool
surfaces. It must not become a centralized app coordinator loop, a duplicate
server-side `wait_for`, or a runtime SourceCollections revival.

This target is materially smaller than current `DarkFactoryHostLive`:

- no direct `@firegrid/runtime/runtime-host` imports in factory product code;
- no app-owned source registration into runtime wait plumbing;
- no raw runtime event parsing for planner output;
- no duplicated local-process env resolver policy;
- no factory-specific launch/start helper;
- no requirement that the host process know which planner agent a product run
  will choose;
- no app-authored planner -> implementer -> council -> QA -> deploy function
  chain.

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

The current projection helpers reinforce the same point. They are pure
read-model helpers over durable evidence. In the target, those projections are
bound into the existing Firegrid tool surface for the planner and into
server/UI read APIs for humans; they are not the driver for a product workflow
chain:

```ts
export const factoryPermissionProjectionFromFact = (fact: DarkFactoryFact) =>
  fact.eventType === "permission.resolved"
    ? decodePermissionResolution(fact.payload)
    : Option.none()

export const providerEffectProjectionStream = (options) =>
  DarkFactoryTable.facts.rows().pipe(
    Stream.filterMap(factoryProviderEffectProjectionFromFact),
    Stream.filter(/* factoryRunKey/effect/status */),
  )
```

These are app-local combinations of existing platform capabilities:

1. `DurableTable` rows/streams for app facts and run records;
2. pure schema-backed projections into typed read models;
3. session-plane runtime observations from `@firegrid/client-sdk`;
4. tool bindings over app-owned projections, mounted beside runtime typed
   waits in the planner's agent-facing surface.

Flamecast shows the read-side half of this through `DurableTableProvider`,
`useDurableTable`, and `useDurableLiveQuery`. Factory shows the process-side
half: durable trigger intake, idempotent run creation, session launch,
permission evidence, provider-effect evidence, and projection bindings.

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
- **tool-bound projection**: expose app-owned projections as planner tools for
  waiting, reading, or executing app policy.

These names are intentionally not Firegrid runtime names. They describe product
state that may use Firegrid runtime sessions. They should be projected into the
agent tool surface when the planner needs them; they should not become
`RuntimeContext`, `RuntimeRun`, runtime-owned rows, or a second hand-wired wait
loop.

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

### Tool-Bound Projections

Runtime typed waits observe runtime-owned streams. App projection waits observe
app-owned rows, but the planner should experience both through the tool
surface. The target is a binding, not a copied waiting loop:

```ts
const FactoryToolBindingsLive = FiregridToolBindings.fromAppProjections({
  waitTargets: {
    "factory.acceptedWork": acceptedWorkProjection,
    "factory.providerEffect": providerEffectProjection,
    "factory.permission": permissionProjection,
  },
  reads: {
    "factory.timeline.read": readFactoryTimeline,
  },
  executes: {
    "factory.run.ensure": ensureFactoryRun,
    "github.openPullRequest": openPullRequestAndRecordReceipt,
  },
})
```

The exact host-sdk API can differ, but the constraint is not negotiable:
factory should install projection and execution bindings into the existing
agent-facing tool surface. It should not hand-write an app coordinator that
observes tables and then calls client-sdk methods in a fixed order. If any
generic stream waiting helper graduates, it belongs in `effect-durable-operators`
only if it remains generic over a provided stream and does not know Firegrid,
factory, runtime sessions, or provider names.

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
| Generic wait over an explicit stream | maybe `effect-durable-operators`, only if it stays Firegrid-free and is surfaced to agents through host-sdk bindings |
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
- When `@firegrid/host-sdk` exposes app projection bindings for the existing
  tool surface, remove factory notes about hand-written projection tool
  mechanics.
- When `effect-durable-operators` exposes any generic app-owned projection wait
  helper, remove factory notes about the underlying stream wait mechanics.
- Keep only factory-owned policy, prompts, UI vocabulary, provider decisions,
  and product-specific read models.

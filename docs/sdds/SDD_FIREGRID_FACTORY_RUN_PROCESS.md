# SDD: Firegrid Factory Run Process

Status: draft implementation spec.

Related specs:

- `firegrid-factory-run-process`
- `firegrid-dark-factory-app`
- `firegrid-runtime-process`
- `client-event-plane-registration`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-schema-projection-contract`

Source material:

- [smithery-ai/internal-workflows#24](https://github.com/smithery-ai/internal-workflows/pull/24)
- `apps/dark-factory-runner/SDD.md` from that PR
- `apps/dark-factory-runner/src/index.ts` from that PR
- `apps/dark-factory-runner/src/factory-function.ts` from that PR
- `apps/dark-factory-runner/src/gates.ts` from that PR
- `apps/dark-factory-runner/src/types.ts` from that PR
- `/Users/gnijor/gurdasnijor/fireline/vault/canon/concepts/choreography-vs-orchestration.md`

This SDD reverse-engineers the working dark-factory runner PoC into a
Firegrid `apps/factory` run-process implementation spec. It does not add
product code.

## Why This Spec Exists

The PoC in `smithery-ai/internal-workflows#24` proves a useful factory slice:

```txt
Linear ticket webhook
  -> deterministic factory run
  -> planner agent dispatch
  -> planner completion wait
  -> Linear plan approval gate
  -> human gate resolution wait
  -> implementer agent dispatch
  -> implementer completion wait
  -> PR URL posted to Linear and optionally Slack
```

The PoC uses Inngest as the durable run-process engine, Flamecast as the agent
execution backend, Linear AgentSession as the user control surface, and provider
callbacks as phase-completion input. That is a good product proof, but it is
not the Firegrid target architecture. The target is an `apps/factory`
run-process built from shipped Firegrid session/runtime primitives, app-owned
facts/projections, and future caller-owned EventPlane surfaces where they fit.

The central translation is:

```txt
PoC Inngest event + step wait
  -> app-owned fact/projection + wait_for today, or EventPlane + RunWait later

PoC Flamecast callback or Linear reply route
  -> app adapter verifies provider input and emits durable row

PoC Linear hidden gate marker
  -> provider routing/idempotency detail, not canonical durable resume state

PoC factory-function phase chain
  -> app-owned factory run process, not Firegrid runtime semantics
```

## Observed PoC Contract

The PoC adds a Cloudflare Worker app named `dark-factory-runner`. Its public
surface is:

- `POST /webhooks/linear`;
- `POST /callbacks/flamecast/:runId/:phase`;
- `GET /health`;
- Inngest serve path `/api/inngest`.

The PoC's durable event names are:

| PoC event | Purpose |
| --- | --- |
| `factory/ticket.accepted` | Starts one factory run for a filtered Linear ticket. |
| `factory/planner.completed` | Resumes the planner completion wait. |
| `factory/human.gate_resolved` | Resumes a human gate wait, initially `plan_approval`. |
| `factory/implementer.completed` | Resumes the implementer completion wait. |

The PoC's run id is deterministic from the Linear issue id:

```txt
linear_<sanitized issue id>
```

The PoC limits Inngest concurrency by `event.data.runId`, creates one Linear
AgentSession, dispatches a Flamecast planner, waits up to 24 hours for planner
completion, posts a Linear elicitation gate, waits up to seven days for gate
resolution, dispatches a Flamecast implementer, waits up to 24 hours for
implementation completion, and posts a PR URL to Linear and Slack.

The PoC already has a strong boundary split:

| System | Durable owner in the PoC | Firegrid factory interpretation |
| --- | --- | --- |
| Inngest | Factory phase steps, waits, retry state, event correlation. | App-owned run process and durable wait/resume state. |
| Flamecast | Agent session state, runtime workspace, callback attempt, session URL. | App-owned or runtime-backed provider session adapter. |
| Linear | Issue state, AgentSession thread, elicitation activity, human reply webhook. | App-owned provider surface and UI side-effect source. |

Firegrid should keep that split, but replace Inngest-specific state with
Firegrid durable run/wait primitives plus app-owned facts or caller-owned
EventPlane rows where appropriate.

## Factory Target Model

The target model has four layers:

1. Provider adapters verify and normalize external input.
2. App-owned facts/projections record prompts, output, permissions, and
   provider side-effect evidence. A future EventPlane declaration can formalize
   those row families when the shipped surface is ready.
3. An app-owned run process consumes projections and uses Firegrid wait/runtime
   primitives to suspend, resume, and dispatch work.
4. UI and smoke tests read projections and runtime observations, not process
   memory.

Firegrid owns product-neutral durable execution. `apps/factory` owns factory
semantics.

```txt
Linear/GitHub/Slack/Flamecast adapters
  -> app-owned factory facts or future FactoryEventPlane rows
  -> FactoryRunProjection / PermissionProjection / ProviderEffectProjection
  -> app-owned run process
  -> Firegrid runtime session, RunWait, wait_for, or RuntimeIngress/Output
  -> caller-owned durable evidence rows
```

The app can be deterministic in its first port of the PoC only as a porting
escape hatch. A deterministic ticket -> plan -> approval -> implementer ->
PR-opened run process is acceptable for bootstrap, provider-adapter
normalization, compliance/debug use cases, and direct parity testing against
the PoC. It is not the preferred Firegrid agent-product shape and must not be
promoted into `@firegrid/runtime`, `@firegrid/client`, `@firegrid/protocol`, or
`effect-durable-operators`.

Firepixel is useful only as an analogy for caller-owned event planes and run
processes. It is a separate system and should not be the primary name, owner, or
package target for this spec.

## PoC Phase Chain Versus Target Choreography

The Fireline canon note on choreography versus orchestration is load-bearing
for this factory work. The runner in `smithery-ai/internal-workflows#24` is a
working phase chain:

```txt
ticket accepted
  -> dispatch planner
  -> wait for planner completed
  -> post approval gate
  -> wait for human gate resolved
  -> dispatch implementer
  -> wait for implementer completed
  -> post PR opened
```

That sequence is worth preserving as an implementation reference because it
proves provider boundaries, idempotent run identity, useful user feedback, and
the first business outcome. It should not become the long-term Firegrid product
surface. A `createFunction`-style factory SDK would make the developer's phase
chain the ceiling for the agent.

The preferred Firegrid shape is choreography:

1. The app writes accepted triggers, provider observations, prompts,
   permissions, side-effect evidence, and runtime observations into durable
   rows.
2. The planner agent reads those durable observations and decides the next step.
3. The planner uses durable primitives such as `wait_for`, `schedule_me`,
   `execute`, `session_new`, `session_prompt`, and `sleep` where those tools are
   available and advertised.
4. Child planner/implementer/reviewer/QA sessions are created as agent-chosen
   delegations, not as required TypeScript phases.
5. Humans and operators inspect the same durable facts, runtime output,
   permission rows, waits, and provider-effect rows the agent can inspect.

Code-authored phase chains are still allowed, but only as app-owned escape
hatches:

- PoC parity while moving from Inngest to Firegrid-backed durable rows;
- compliance-critical flows where order is externally mandated;
- high-volume deterministic flows where an LLM adds no sequencing value;
- debugging or bootstrap while tools and prompts are still unstable;
- provider-adapter normalization before a durable row reaches the planner.

Those escape hatches must stay outside Firegrid-owned packages. Firegrid should
ship product-neutral primitives and observations, not a factory orchestration
SDK, DAG framework, or hard-coded planner/gate/implementer/review/QA/merge
workflow.

## Shipped Firegrid Alignment

This section names what the PoC can use today and what still needs new work.

| PoC behavior | Shipped Firegrid primitive today | Fit |
| --- | --- | --- |
| Create or load one planner identity for an external Linear issue | `@firegrid/client/firegrid` session facade `sessions.createOrLoad(...)` with an external key, as used by `apps/factory/src/host.ts`. | Implementable today for Firegrid-hosted planner sessions. |
| Send the initial planner prompt | `FiregridSessionHandle.prompt(...)` writes host-owned runtime ingress with an idempotency key. | Implementable today. |
| Start the planner runtime | `FiregridSessionHandle.start()` or `RuntimeStartCapabilityLive` / `startRuntime` from `@firegrid/runtime/runtime-host`. | Implementable today for local-process runtime configs. |
| Read planner progress | `FiregridSessionHandle.snapshot()` returns runtime runs, output events, logs, ingress inputs, and normalized `agentOutputs`. | Implementable today. |
| Wait for agent output or permission request | Session facade `session.wait.forAgentOutput(...)` and `session.wait.forPermissionRequest(...)`, backed by runtime observation rows. | Implementable today for runtime-hosted sessions. |
| Resume ACP permission requests | Session facade `session.permissions.respond(...)` / `permissions.respond(...)` writes a `PermissionResponse` through runtime ingress. | Implementable today. |
| Compose a host for the factory app | `@firegrid/runtime/runtime-host` `FiregridLocalHostLive`, env resolver policy, `RuntimeStartCapabilityLive`, and `localProcessSpawnEnvFromHostEnv`. | Implementable today. |
| Wait over app fact projections | `apps/factory` app-local projection wait helpers observe `DarkFactoryTable` rows directly. | Implementable today without runtime source registration. |
| Observe normalized agent output | Runtime agent-event-pipeline output journal plus client `agentOutputs`; protocol session-facade schemas decode permission requests and output payloads. | Implementable today. |
| Wait over runtime observations | Session facade waits and typed runtime `wait_for` sources cover agent output, permission requests, and runtime run state. | Implementable today for runtime-owned observations. |
| Store accepted triggers and permission decisions | `apps/factory` `DarkFactoryTable` facts/runs and schemas. | Implementable today as app-owned facts/projections. |

The following pieces are not shipped as Firegrid primitives today:

- Linear, GitHub, Slack, and Flamecast provider adapters for `apps/factory`;
- hosted provider routes for Linear webhooks and Flamecast-style callbacks;
- provider side-effect capability implementations for planner `execute`;
- EventPlane declaration/projection migration for factory facts;
- a generic app-owned run-process helper that ports Inngest step semantics;
- full council, QA, CI, merge gate, and merge side-effect slices;
- a hosted smoke harness that drives the full ticket-to-PR-opened path.

The first implementation should therefore start with shipped session/runtime
facades and app facts, then introduce EventPlane or run-process helpers only
where they remove concrete app-local duplication.

## App Rows And Projections

The first implementation should define app-owned factory facts/projections.
When caller-owned EventPlane registration is ready, these row families can move
behind an EventPlane declaration without changing ownership. The row vocabulary
below is product-owned and should not appear as Firegrid-native substrate
vocabulary.

### Rows

| Row kind | Required role |
| --- | --- |
| `factory.trigger.accepted` | Normalized accepted provider trigger. |
| `factory.run.created` | Factory run identity and first planner link. |
| `factory.provider.effect` | Evidence for provider side effects such as Linear AgentSession creation, activity posting, delegate assignment, Flamecast dispatch/abort, GitHub/PR updates, and Slack notification. |
| `factory.session.requested` | Planner or implementer session requested by the run process. |
| `factory.session.dispatched` | Provider/runtime session id, model/machine, callback route, and provider URL after dispatch. |
| `factory.prompt` | Durable prompt text or prompt reference sent to planner or implementer. |
| `factory.output` | Normalized planner/implementer output or callback envelope summary. |
| `factory.permission.requested` | App-visible human gate or ACP permission request. |
| `factory.permission.resolved` | Human approval, modification, rejection, QA request, stop, timeout, or cancellation. |
| `factory.phase.completed` | Phase completion evidence for planner and implementer. |
| `factory.pull_request.opened` | PR URL and non-secret PR metadata. |
| `factory.run.terminal` | Terminal run result or failure. |

Every row should carry:

- `eventId` or other stable idempotency key;
- `factoryRunKey`;
- provider/source;
- external entity key, such as Linear issue id;
- causation id and correlation id where available;
- created timestamp;
- non-secret provider identifiers and URLs where useful.

Provider-specific payloads may be retained as raw payload fields only under the
app-owned schema. They are not Firegrid protocol contracts.

### Projections

The first implementation needs these projections:

| Projection | Purpose |
| --- | --- |
| `FactoryRunProjection` | One row per factory run with current status, accepted trigger, planner session, implementer session, active phase, active gate, PR URL, and terminal state. |
| `FactoryPhaseProjection` | Phase-specific status keyed by `factoryRunKey` plus phase. |
| `FactoryPermissionProjection` | Active and resolved permission/gate state keyed by permission id or gate id. |
| `FactoryProviderEffectProjection` | Idempotency and evidence lookup for provider side effects. |
| `FactoryTimelineProjection` | Ordered user-visible facts, prompts, outputs, provider links, errors, and terminal evidence. |

These projections align with `client-event-plane-registration`: app code should
consume typed producer/projection services and should not read raw Durable
Streams envelopes as the normal API. Until EventPlane is the shipped app
surface, `apps/factory` can continue using `DarkFactoryTable` facts/runs.

## Run Identity

The PoC uses `linear_<issueId>` as its callback and Inngest concurrency key.
`apps/factory` should preserve a deterministic provider-facing id, but also
keep a canonical Firegrid-compatible factory key.

Recommended shape:

```txt
providerRunId = "linear_" + sanitize(linearIssueId)
factoryRunKey = encode(["linear.issue", linearIssueId])
triggerFactKey = encode([source, externalEventKey])
```

The provider run id is useful in callback paths and provider UI. The
`factoryRunKey` is the durable app identity used by projections, waits, prompts,
session metadata, and status reads. Redelivery of any of these inputs must
converge on the same projected run:

- Linear issue webhook for the same issue;
- Flamecast-style planner callback for the same session or callback id;
- Flamecast-style implementer callback for the same session or callback id;
- Linear AgentSession reply for the same gate;
- stop/cancel signal for the same AgentSession;
- GitHub/PR evidence for the same PR.

## Trigger Intake

The Linear adapter remains app-owned. It should:

1. Verify the Linear webhook signature.
2. Filter issue events using product rules such as assignee, label, state, and
   changed fields.
3. Emit `factory.trigger.accepted` with deterministic idempotency.
4. Upsert or derive `FactoryRunProjection` for the external work key.
5. Start or wake the app-owned factory run process.

The adapter may still accept Linear AgentSession events through the same route,
but those events should emit permission/gate resolution rows rather than
walking comments or markers as the canonical workflow state.

## Planner Session And Run

The PoC dispatches a Flamecast planner and waits for a callback. The factory
target can use either Firegrid runtime sessions or an app-owned provider session
adapter, depending on the implementation slice. In both cases the app must
persist the same logical evidence:

1. planner session requested;
2. planner prompt authored;
3. planner side effect dispatched;
4. planner provider/runtime session id observed;
5. planner output or callback envelope received;
6. planner phase completed or failed.

If using current `apps/factory` primitives, the planner context can be created
or loaded through `@firegrid/client/firegrid` and run by
`@firegrid/runtime/runtime-host`. The prompt should include the factory run key,
app-owned projection names, typed runtime wait sources, Linear issue fields,
repo hint, advertised provider capabilities, and the durable rows that can
resume the run.

If using a Flamecast adapter first, the Flamecast session id is app-owned
provider evidence. It should not become Firegrid RuntimeContext schema.

## Prompt, Output, And Permission Rows

Factory prompt/output/permission state is app-owned fact/projection state.
Firegrid may supply runtime observations, but it should not own factory prompt
or provider UI vocabulary.

Recommended split:

| Concept | Owner |
| --- | --- |
| Planner/implementer prompt content and prompt policy | App fact/EventPlane row. |
| Runtime ingress row used to deliver a prompt to a Firegrid session | Firegrid runtime authority. |
| Planner/implementer output display rows | App projection or runtime output projection. |
| Raw runtime output journal | Firegrid runtime authority. |
| Human gate request and resolution | App permission facts or EventPlane rows. |
| ACP PermissionRequest and PermissionResponse transport | Firegrid runtime observation/ingress when using ACP runtime sessions. |
| Linear elicitation activity | App-owned provider side effect. |

The PoC uses a hidden marker in the Linear elicitation body to recover
`runId`, `gateId`, and `kind`. In the factory target, this marker is allowed only as a
provider reply-routing aid. The canonical pending gate is the durable
`factory.permission.requested` row or projection. The canonical resolution is
`factory.permission.resolved`.

## Wait And Resume

Each PoC `step.waitForEvent(...)` becomes a durable row/projection wait:

| PoC wait | Factory wait |
| --- | --- |
| `factory/planner.completed` by `runId` | Wait for `FactoryPhaseProjection(run, "planner").status == "completed"` or matching `factory.phase.completed`. |
| `factory/human.gate_resolved` by `runId` and gate kind | Wait for `FactoryPermissionProjection(gateId).status in ["approved", "rejected", "modified", "cancelled"]`. |
| `factory/implementer.completed` by `runId` | Wait for `FactoryPhaseProjection(run, "implementer").status == "completed"` or matching `factory.phase.completed`. |

When using future EventPlane support, the preferred shape is projection-match
`RunWait` because the wait target is caller-owned projection state. With
current `apps/factory` primitives, app-owned projection wait helpers observe
`DarkFactoryTable` rows directly, while runtime waits stay on session-scoped or
typed runtime observation APIs. The important boundary is that the app wait is
over durable app rows, not runtime source registration, an in-memory promise,
hidden callback URL, or comment-walking router.

Timeouts should also write durable evidence rows before terminalizing or moving
to an operator fallback path:

- planner timeout;
- plan approval timeout;
- implementer timeout;
- provider callback validation failure;
- stop/cancel;
- provider abort attempted.

## Provider Side Effects

Provider effects remain app-owned. Firegrid must not import or encode Linear,
GitHub, Slack, Flamecast, PR, issue, model, or gate semantics.

The PoC side effects to preserve as durable evidence are:

- Linear AgentSession creation;
- Linear delegate assignment;
- Linear AgentActivity posts for thought, action, response, error, and
  elicitation;
- Linear external URL updates;
- Flamecast planner dispatch;
- Flamecast implementer dispatch;
- Flamecast abort request on stop;
- PR URL extraction from implementer output;
- optional Slack notification.

Each side effect should be guarded by an app idempotency key and should emit a
provider-effect row before or after the external call according to the retry
semantics:

- intent/request rows before side effects when retries need a durable intent;
- completion/evidence rows after side effects when the provider supplies an id;
- failure rows when a provider rejects the call.

Do not persist bearer tokens, webhook secrets, Flamecast API keys, GitHub PATs,
callback tokens, or Linear OAuth tokens. Provider rows may persist non-secret
ids, URLs, status codes, and provider request ids.

## Hosted Smoke Acceptance

The first implementation is not accepted by local fixture tests alone. It must
document an env-gated or manual hosted smoke against Electric/Durable Streams.

Minimum hosted smoke:

1. Configure hosted Durable Streams/Electric URL and token through environment
   or deployment secrets.
2. Deliver a Linear-provider-shaped accepted ticket trigger or a live Linear
   webhook when available.
3. Observe `factory.trigger.accepted` and one factory run projection.
4. Dispatch a planner session or write a provider-shaped planner dispatch row.
5. Deliver a planner completion callback or runtime output row.
6. Observe a pending plan approval permission/gate row.
7. Resolve the gate through a provider-shaped Linear AgentSession reply or
   manual provider adapter route.
8. Dispatch an implementer session or write provider-shaped implementer
   dispatch evidence.
9. Deliver an implementer completion with PR URL.
10. Observe PR-opened evidence and a terminal or waiting-next-slice run state.

If full provider access is unavailable, manual provider-shaped callback
delivery is acceptable only if durable fact or EventPlane writes, projections,
wait/resume, and runtime/session observation are exercised. An in-memory fake
planner or fixture-only event writer is not sufficient acceptance.

## App-Owned Versus Firegrid-Owned

| Concern | Owner |
| --- | --- |
| Linear webhook verification and filtering | `apps/factory` provider adapter. |
| GitHub, Slack, Flamecast, model-provider credentials | App deployment secrets. |
| Provider API clients and side-effect retry/idempotency | App provider adapters. |
| Factory run key, provider run id, gates, phase names, PR evidence | App facts or EventPlane rows. |
| Planner and implementer prompt policy | App. |
| UI projections for factory timeline and active waits | App projections. |
| RuntimeContext, RuntimeIngress, RuntimeOutput, runtime runs | Firegrid runtime. |
| Runtime host composition | `@firegrid/runtime`. |
| Browser-safe session facade and runtime observation waits | `@firegrid/client`. |
| Schema projection discipline | `@firegrid/protocol` plus projection files. |
| Durable execution, RunWait, and projection-match mechanics | Firegrid product-neutral runtime/substrate layers. |

## Relationship To Current `apps/factory`

Current `apps/factory` already has several compatible pieces:

- `DarkFactoryTable` stores facts and runs.
- `factoryRunIdentityFor(...)` creates a canonical app-owned factory run key.
- `acceptFactoryTrigger(...)` creates or loads a planner session and writes an
  accepted fact.
- `buildPlannerPrompt(...)` names app fact sources, runtime observation
  sources, provider capabilities, and choreography rules.
- `respondToFactoryPermission(...)` writes a permission resolution fact and a
  RuntimeIngress PermissionResponse.
- `readFactoryRunStatus(...)` projects runtime and app rows into a status view.

The factory run-process target does not require deleting this work. It suggests
the next implementation direction:

1. keep the app-owned factory semantics in `apps/factory`;
2. promote the fact/run row family to an EventPlane declaration only when
   the client-event-plane registration surface is ready;
3. model the PoC's fixed phase chain only as an app-owned bootstrap/debug
   escape hatch;
4. move toward planner-led choreography where the planner decides delegation,
   waits, retries, and next actions from durable observation;
5. keep provider adapters separate from runtime host configuration;
6. use Firegrid runtime/client primitives only for product-neutral session,
   ingress, output, permission, and wait mechanics.

## Implementation Sequencing

1. **Spec and schema sketch.** Land this SDD and
   `firegrid-factory-run-process`. Do not move implementation code in the same
   PR.
2. **App rows and projections.** Define caller-owned factory row schemas,
   idempotency keys, and projections. Prove duplicate trigger/callback/gate
   delivery converges.
3. **Provider intake.** Port Linear trigger intake to emit durable rows and
   start or wake the app-owned run process without dispatching agents.
4. **Planner choreography prompt.** Start the planner with app-owned projection
   names, typed runtime wait sources, provider capabilities, and explicit
   instructions that the planner owns sequencing through durable primitives and
   observation.
5. **PoC parity escape hatch.** If needed, keep a deterministic
   ticket/planner/gate/implementer/PR chain in app-owned code for smoke parity
   and debugging only. Do not expose it as a Firegrid SDK.
6. **Human gate.** Emit durable gate request, post provider UI side effect,
   ingest provider reply, emit durable resolution, and resume through the same
   wait path.
7. **Delegation and implementation.** Let the planner use `session_new`,
   `session_prompt`, `wait_for`, `schedule_me`, and `execute` where supported;
   normalize implementer or provider PR evidence into app rows.
8. **Hosted smoke.** Run the env-gated hosted smoke and record the result
   without committing secrets.
9. **Later slices.** Add council/review, QA, CI readiness, merge gate, and merge
   side effects as planner-owned choreography where possible, with deterministic
   app code reserved for documented escape hatches.

## Non-Goals

- Do not implement product code in this PR.
- Do not add Linear, GitHub, Slack, Flamecast, Inngest, PR, issue, planner, or
  implementer semantics to Firegrid-owned packages.
- Do not create a generic Firegrid factory workflow product.
- Do not create a Firegrid orchestration SDK, `createFunction` equivalent, DAG
  product, or hard-coded factory planner/gate/implementer/review/QA/merge
  workflow.
- Do not treat the PoC phase chain as the preferred Firegrid agent-product
  shape; it is a parity and bootstrap aid until planner-led choreography is
  practical.
- Do not require Flamecast as the only runtime backend.
- Do not replace `apps/factory` wholesale before EventPlane registration is
  ready.
- Do not rename this work to Firepixel or make Firepixel the target system;
  Firepixel remains only an analogy for caller-owned event planes and run
  processes.
- Do not treat hidden provider markers or callback URLs as canonical durable
  resume state.
- Do not commit, log, or document secret values.

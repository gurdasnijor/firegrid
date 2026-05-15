# SDD: Firegrid Dark Factory App

Status: Draft implementation contract

Related specs:

- `firegrid-dark-factory-app`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-workflow-driven-runtime`
- `firegrid-durable-tools`

Related source inputs:

- `/Users/gnijor/smithery/internal-workflows/hooks/factory`
- `/Users/gnijor/smithery/flamecast-agents/DARK_FACTORY_PROCESS_PRD.md`
- `/Users/gnijor/gurdasnijor/fireline/vault/canon/concepts/choreography-vs-orchestration.md`
- `docs/sdds/SDD_FIREGRID_FACTORY_ALIGNED_AGENT_TOOL_WORKSTREAM.md`
- `packages/runtime/src/agent-tools/tools.ts`
- `packages/runtime/src/runtime-host/observation-sources.ts`
- `packages/runtime/src/verified-webhook-ingest/README.md`

The recipes `docs/recipes/runtime-permission-resume.md` and
`docs/recipes/durable-webhook-facts-and-wait-for.md` were requested as inputs
but are not present on `origin/main` at the time of this draft. This SDD uses
the merged runtime observation sources from #232 and the existing verified
webhook ingest README instead.

## Purpose

`apps/dark-factory` is the Firegrid-powered replacement path for
`/Users/gnijor/smithery/internal-workflows/hooks/factory`.

The current hook turns Linear issue transitions into a factory run, launches
planning and implementation agents through Flamecast, uses Linear
AgentSession activities for status and approval, runs a GitHub PR review/CI
merge path, and relies on parked RPC callbacks plus hidden markers to resume
human gates. The Firegrid app should preserve the product loop while replacing
the hook.new orchestration chain with Firegrid primitives:

- product-owned Linear, GitHub, Slack, and webhook adapters capture inputs and
  perform provider side effects with configured credentials;
- DurableTable facts hold external events, provider observations, decisions,
  and side-effect evidence;
- one parent planner `RuntimeContext` is created or loaded per external work
  item, such as a Linear issue id;
- the planner agent owns sequencing by reading durable history and calling
  Firegrid tools such as `session_new`, `session_prompt`, `wait_for`,
  `schedule_me`, and `execute`;
- ACP permission requests and runtime output are durable observations, and
  human decisions resume through runtime ingress or facts.

This is choreography, not a Firegrid-authored orchestration DAG. The app may
provide inputs, credentials, fact tables, provider adapters, and observation
surfaces. It must not encode a deterministic planner -> implementer -> council
-> QA -> deploy TypeScript workflow engine. The planner decides the next step
from ticket state, repository state, prior facts, runtime output, and human
decisions.

## Current `hooks/factory` Behavior To Replace

The existing hook has useful product behavior but the wrong substrate shape
for Firegrid:

- Trigger handling:
  - Linear OAuth-app webhooks are HMAC verified with `Linear-Signature`.
  - Issue `update` events trigger only when the ticket is assigned to the bot
    or has the `factory` label, is in `state.type === "started"`, and the
    update changed assignee, state, or labels.
  - `create` and internal chatter are dropped to avoid double firing.
- Idempotency and retries:
  - Duplicate delivery is guarded by deterministic branch names,
    existing-PR lookup, active Linear AgentSession lookup, and a post-create
    race resolver.
  - PR comments are upserted through hidden `factory-marker` comments.
- Human gates:
  - Linear AgentSession `elicitation` activities embed hidden
    `factory-callback:<url>` markers.
  - `AgentSessionEvent action=prompted` looks up the latest elicitation,
    parses the marker, classifies approve/reject/modify/QA replies, and POSTs
    back to the parked RPC URL.
  - Stop signals reject the parked gate and abort an in-flight Flamecast
    session by recovering an encoded Flamecast session id from an action
    activity.
- Agent work:
  - Planning, implementation, and QA are dispatched as Claude ACP sessions on
    Flamecast.
  - A three-model council runs over the PR diff and posts a verdict.
- Provider side effects:
  - Linear AgentSession activities are used for thoughts, actions,
    responses, elicitations, external links, delegate assignment, and fallback
    comments.
  - GitHub is used for PR lookup, diff fetch, comment upsert, CI status, PR
    close, and squash merge.
  - Slack is advisory only.

The Firegrid replacement keeps the product loop and provider integrations, but
replaces hidden callbacks and hand-authored cross-phase RPC sequencing with
durable facts, runtime contexts, runtime ingress/output, and agent-chosen tool
calls.

## Target Package

Target location: `apps/dark-factory`.

The app should follow existing workspace conventions: private package, local
`tsconfig.json`, `src/` modules, focused tests, and root workspace inclusion
through the existing `apps/*` pattern.

The first app surface should be production-shaped even if tests use fixtures:

- a product-owned adapter boundary for Linear/GitHub/webhook events;
- a Firegrid local host scope using `FiregridLocalHostLive`;
- app-owned DurableTable facts and SourceCollections registration;
- provider adapter modules for Linear/GitHub/Slack side effects that read
  configured credentials from the app environment;
- a parent planner `RuntimeContext` launch path through Firegrid runtime host
  primitives;
- an observation surface built from app facts plus
  `RuntimeObservationSourceNames`.

It must not depend on `pnpm firegrid -- run`; #229 is sync CLI UX and is not a
factory app dependency.

## Choreography Contract

The planner is the sequencer. Firegrid and the app provide durable primitives.

The app should not contain a `startSession -> implementAgent ->
councilAndApproval -> deploy` function chain. Instead:

1. Product adapters write facts and side-effect evidence.
2. A parent planner context is inserted or loaded by external source key.
3. The planner receives a prompt that describes available fact sources,
   provider capabilities, credentials boundaries, and Firegrid tools.
4. The planner reads durable history and decides what to do next.
5. The planner delegates work with `session_new` / `session_prompt`, waits
   with `wait_for`, schedules future self-prompts with `schedule_me`, and uses
   app-provided execution/provider capabilities where available.
6. Human gates are represented as ACP `PermissionRequest` output or app facts;
   resolution resumes by `RuntimeIngress` `PermissionResponse` or by inserting
   a matching fact.
7. Terminal or waiting status is derived from durable observations, not from a
   centralized in-memory coordinator loop.

This makes the system inspectable and adaptive: the agent can choose a shorter
or longer path, retry differently, spawn additional review work, skip QA, or
wait for CI based on observable state.

## Durable Fact Surface

External inputs are app-owned facts. Examples:

- `linear.issue.accepted`
- `linear.agent-session.prompted`
- `linear.agent-session.stop`
- `github.pr.opened`
- `github.pr.review_posted`
- `github.ci.status`
- `github.pr.closed`
- `github.pr.merged`
- `human.plan.approved`
- `human.plan.rejected`
- `human.merge.approved`
- `human.merge.rejected`

The first implementation should define an app-owned `DurableTable` collection,
for example `DarkFactoryFactTable.facts`, with a row shape:

- deterministic key: `{ source, externalEventKey }`;
- `source`: short producer/source id, such as `linear.oauth`,
  `github.rest`, `human.linear-agent-session`, or `fixture`;
- `externalEventKey`: provider delivery id, Linear event id, GitHub event id,
  permission id, PR marker key, or deterministic fixture event id;
- `externalEntityKey`: Linear issue id, GitHub PR id, context id, or parent
  session id;
- `eventType`: source-specific but stable event kind;
- `contextId` and `correlationId` when known;
- `payload`: source-specific detail for inspection.

Duplicates use `DurableTable.insertOrGet` or deterministic primary keys. Same
source and external event key resolves to the existing row. Conflict handling
is app policy, but must not silently overwrite a different fact payload for
the same external key.

The fact collection should be registered with `SourceCollections` under a
short source name such as `darkFactory.facts`. Agents can then call `wait_for`
with top-level scalar fields:

```json
{
  "eventQuery": {
    "stream": "darkFactory.facts",
    "whereFields": {
      "contextId": "ctx_...",
      "eventType": "human.plan.approved",
      "correlationId": "linear-issue-123-plan"
    }
  }
}
```

## Provider Side Effects

Provider credentials and taxonomy are app-owned. Firegrid does not mint
callback URLs, own Linear/GitHub webhook products, or define a provider event
registry.

The app should provide narrow adapter modules for the side effects the
factory needs:

- Linear: verify/capture events, create or update native agent-facing
  surfaces where appropriate, post comments or activities, record prompted or
  stop events as facts, and set issue delegate when configured.
- GitHub: find existing PRs by deterministic branch, fetch PR metadata and
  diff, upsert review/QA comments, read CI status, close rejected PRs, and
  squash merge approved PRs.
- Slack: advisory notification only.

Each provider call should write durable evidence as a fact before or after the
side effect as appropriate for idempotency. For example, a GitHub council
comment upsert can use a deterministic marker key as `externalEventKey`, but
the hidden marker itself is only a provider-side idempotency mechanism; it is
not the Firegrid resume protocol.

The planner chooses when to request these side effects through the Firegrid
tool/capability surface available to the app. The first implementation may use
fixture provider adapters in tests, but the production contract is configured
credentials and real Linear/GitHub/Slack modules.

## Runtime Observation

The app should consume the merged runtime observation sources from #232:

- `RuntimeObservationSourceNames.runtimeRuns`
  (`firegrid.runtime.runs`);
- `RuntimeObservationSourceNames.runtimeOutputEvents`
  (`firegrid.runtime.output.events`);
- `RuntimeObservationSourceNames.runtimeOutputLogs`
  (`firegrid.runtime.output.logs`);
- `RuntimeObservationSourceNames.runtimeIngressInputs`
  (`firegrid.runtime.ingress.inputs`);
- `RuntimeObservationSourceNames.runtimeIngressDeliveries`
  (`firegrid.runtime.ingress.deliveries`);
- `RuntimeObservationSourceNames.agentOutputEvents`
  (`firegrid.runtime.agent-output-events`).

For permission waits, the app should observe ACP permission requests through
`RuntimeObservationSourceNames.agentOutputEvents`, matching scalar fields such
as:

```json
{
  "eventQuery": {
    "stream": "firegrid.runtime.agent-output-events",
    "whereFields": {
      "contextId": "ctx_...",
      "_tag": "PermissionRequest",
      "permissionRequestId": "permission-1"
    }
  }
}
```

Permission resume writes ordinary runtime ingress:

```ts
appendRuntimeIngress({
  contextId,
  kind: "control",
  authoredBy: "client",
  payload: {
    _tag: "PermissionResponse",
    permissionRequestId,
    decision: { _tag: "Allow", optionId: "allow" },
  },
  idempotencyKey: `dark-factory:permission:${contextId}:${permissionRequestId}`,
})
```

No permission table is required for the first app slice. If the product wants a
human-facing queue, it can project permission requests from runtime output into
app facts, but runtime resume remains `RuntimeIngress` to the context.

## End-To-End Control Flow

The production-shaped flow is:

1. A product-owned Linear/GitHub/webhook adapter receives and verifies input.
2. The app writes or loads an external fact with deterministic source and
   external event key.
3. The app creates or loads one parent planner `RuntimeContext` for the
   external entity key, such as Linear issue id.
4. The parent context is launched by the host/control-plane path:
   `insertLocalRuntimeContext` or `Firegrid.launch`, optional initial
   `appendRuntimeIngress`, and `startRuntime`.
5. The planner receives the canonical Firegrid tools and app-specific
   capability instructions. It may call `session_new`, `session_prompt`,
   `wait_for`, `schedule_me`, and `execute` where supported by the current
   runtime.
6. The planner asks for a human gate either by emitting an ACP
   `PermissionRequest` or by waiting on an app fact such as
   `human.plan.approved`.
7. The app or user writes the decision:
   - as `RuntimeIngress` `PermissionResponse` for ACP permission requests; or
   - as an app-owned fact for generic human/external decisions.
8. The planner resumes, delegates implementation/review/QA with Firegrid tools
   as needed, and requests provider side effects through configured app
   capabilities.
9. GitHub/Linear/Slack side effects emit durable facts so retries and future
   planner turns can inspect what already happened.
10. The app derives status from durable observations, not from in-memory
    process handles.

## Minimal Replacement Slice

The smallest useful implementation slice should prove the replacement shape,
not the full factory product:

1. A fixture or product-owned Linear-shaped event accepts ticket `DF-1`.
2. The app writes `linear.issue.accepted` as a durable fact.
3. The app creates or loads parent planner context for the Linear issue id.
4. The planner starts and emits a plan-ready or permission-needed observation.
5. The app/test observes the wait through
   `RuntimeObservationSourceNames.agentOutputEvents` or `darkFactory.facts`.
6. A fixture human approves or rejects the plan.
7. The app resumes the planner by writing `PermissionResponse` ingress or a
   `human.plan.approved` fact.
8. The planner emits a `session_new`, `session_prompt`, `wait_for`, or
   side-effect intent through Firegrid tools.
9. Runtime output/facts show durable evidence for parent context id, Linear
   issue id, decision, delegated work or provider action, and waiting or
   terminal status.

Later slices can make the provider adapters live against real Linear/GitHub
credentials, add the implementation/review/QA loop, and perform CI-gated merge.
Those slices must keep the same choreography rule: the planner decides the
sequence, and code provides durable capabilities.

## Live Versus Mocked

Live in the first implementation:

- Durable Streams or `DurableStreamTestServer`;
- app-owned DurableTable facts;
- `FiregridLocalHostLive`;
- `RuntimeContext` creation and `startRuntime`;
- runtime observation sources from #232;
- `wait_for` over runtime observation and app fact sources;
- `RuntimeIngress` permission response delivery.

Allowed fixtures/mocks:

- fixture Linear/GitHub event input instead of a live webhook;
- fixture human decision writer instead of a real product UI;
- fixture provider adapters for tests, if real Linear/GitHub side effects are
  unsafe in CI;
- deterministic stdio-jsonl or ACP planner process instead of a real model;
- child-session proof may use a fixture child agent command if real repository
  mutation is not needed in the first PR.

Production-facing, not mocked:

- the app boundary for configured Linear/GitHub/Slack credentials;
- idempotent fact insert/load behavior;
- parent `RuntimeContext` identity;
- host-owned ingress/output routing;
- `wait_for` source registration and matching;
- permission resume through runtime ingress when ACP `PermissionRequest` is
  used.

## Acceptance Criteria

The implementation should satisfy the ACIDs in
`features/firegrid/firegrid-dark-factory-app.feature.yaml`.

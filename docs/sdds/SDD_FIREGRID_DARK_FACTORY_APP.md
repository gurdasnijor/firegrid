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
- `docs/recipes/runtime-permission-resume.md`
- `docs/recipes/durable-webhook-facts-and-wait-for.md`

## Purpose

`apps/factory` is the Firegrid-powered replacement path for
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

Target location: `apps/factory`, using the UI scaffold from PR #236 only when
it is available and green. Earlier drafts used `apps/dark-factory`;
implementation should avoid creating a second app shell if the scaffold is
available. If the scaffold is absent, the first slice should still prove the
app substrate through hosted durable row writes/reads and runtime
ingress/output, not by inventing a Firegrid-owned app HTTP API.

The app should follow existing workspace conventions: private package, local
`tsconfig.json`, `src/` modules, focused tests, and root workspace inclusion
through the existing `apps/*` pattern.

The first app surface must be production-shaped:

- a product-owned adapter boundary for Linear/GitHub/webhook events;
- a Firegrid host scope using existing runtime host primitives;
- configured hosted Electric/Durable Streams endpoint and auth headers;
- app-owned DurableTable facts and SourceCollections registration;
- provider adapter modules for Linear/GitHub/Slack side effects that read
  configured credentials from the app environment or deployment secret store;
- a parent planner `RuntimeContext` launch path through Firegrid runtime host
  primitives;
- a live observation UI or read-model projection built from app facts plus
  `RuntimeObservationSourceNames`.

The PR #236 scaffold is useful for visual structure: active agents, progress,
message feed, graph, run summary, live indicator, and prompt entry. Its
simulation hook and mock data are placeholders only. Acceptance must replace
simulation with hosted DurableTable/Electric reads and real runtime/fact rows.

It must not depend on `pnpm firegrid -- run`; #229 is sync CLI UX and is not a
factory app dependency.

## Product Boundary

The factory app must expose Firegrid's durable substrate, not hide it behind a
bespoke product HTTP server.

The primary contract is:

```txt
provider/product adapter
  -> durable fact / run row
  -> planner RuntimeContext
  -> RuntimeIngress / RuntimeOutput / runtime observation
  -> app-owned fact or PermissionResponse
```

It is not:

```txt
custom /factory/triggers HTTP route
custom /factory/runs HTTP route
custom /factory/permissions/respond HTTP route
  -> private server-side orchestration
```

Product-owned provider adapters may receive Linear, GitHub, Slack, or webhook
HTTP requests at an outer product boundary. Their job is to verify provider
input, map it into durable facts, and perform real provider side effects when
configured. The Firegrid factory substrate itself should be expressed through
DurableTable rows, runtime ingress, runtime output, runtime observation
sources, and schema-projected tool/client/CLI surfaces.

This distinction is load-bearing:

- accepted work enters as durable facts, not as an app-private request queue;
- run progress is read from durable facts and runtime observation, not from a
  server-owned in-memory status model;
- human decisions resume through app facts or `RuntimeIngress`
  `PermissionResponse`, not a custom permission endpoint as the source of
  truth;
- a hosted smoke should prove durable writes/reads plus runtime
  ingress/output directly;
- app-specific HTTP routes can be added later as thin product adapters, but
  they must not become the primary factory contract or a hidden orchestrator.

## Firegrid Platform Primitives Used

The factory should be built from these Firegrid primitives, with each primitive
serving one clear role:

| Primitive | Factory role |
| --- | --- |
| `RuntimeContext` | Durable runtime identity for the parent planner and delegated implementer, reviewer, or QA sessions. External source keys and correlations are stored in app facts, prompts, runtime output, subscriber rows, and tool results unless the existing context row already has a suitable field. |
| `RuntimeIngress` | Durable input path into a running context. The app uses it for the initial planner prompt when needed, follow-up prompts, and ACP `PermissionResponse` messages that resume permission gates. |
| `RuntimeOutput` | Durable output journal for planner and child-agent status, text, tool calls, permission requests, tool results, and terminal evidence. This replaces hidden callback markers as the source of truth for what the run is waiting on. |
| `RuntimeObservationSourceNames` | Named wait/query surfaces for runtime runs, output events/logs, ingress inputs/deliveries, and normalized agent output events. The planner and app use these names with `wait_for` and status views. |
| DurableTable facts | App-owned durable table for Linear/GitHub/Slack/provider events, decisions, and side-effect evidence. Facts provide idempotency by source and external event key. |
| `SourceCollections` / `wait_for` | Registration and matching path that lets agents wait on app facts and runtime observation rows without polling provider APIs directly. |
| `FiregridAgentToolkit` tools | The agent-facing choreography surface. The planner decides sequence by calling `session_new`, `session_prompt`, `wait_for`, `schedule_me`, `execute`, `sleep`, `session_cancel`, and `session_close` where applicable. |
| Provider adapters | App-owned Linear/GitHub/Slack modules that verify provider input, perform side effects with configured credentials, and write durable facts before or after those effects. |
| Hosted Electric/Durable Streams | Production storage and live observation substrate for the app. The app acceptance path uses configured hosted stream URLs and auth headers, not local `DurableStreamTestServer`. |
| React DurableTable live query hooks | Client observation shape for the app UI. Reuse the `DurableTableProvider`, `useDurableTable`, and `useDurableLiveQuery` pattern visible in `apps/flamecast/src/client/main.tsx`; do not copy Flamecast runtime host/process-launch infrastructure. |

## Choreography Contract

The planner is the sequencer. Firegrid and the app provide durable primitives.

The app should not contain a `startSession -> implementAgent ->
councilAndApproval -> deploy` function chain. Instead:

1. Product adapters write facts and side-effect evidence.
2. One durable run/subscriber identity is inserted or loaded by external work
   key, and that identity points at the planner `RuntimeContext`.
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

## Autonomous Planner Run

### Factory Run Identity And Planner Context Creation

When a Linear/GitHub/webhook adapter accepts a factory trigger, the app must:

1. Verify the provider input at the product-owned adapter boundary.
2. Insert or load the external fact, such as `linear.issue.accepted`, using
   `{ source, externalEventKey }`.
3. Create or load one durable factory-run subscriber row keyed by
   `factoryRunKey = <source>:<externalEntityKey>`, for example
   `linear.oauth:<issueId>`. That row stores the planner `contextId` once it
   exists.
4. Create or load the planner `RuntimeContext` referenced by that subscriber
   row.
5. Store the following correlation data in app facts, the subscriber row,
   runtime output rows, prompts, and tool-result payloads. Only copy it into a
   `RuntimeContext` row if the current schema already supports that field:
   - `factoryRunKey`;
   - `source`;
   - `externalEntityKey`;
   - `linearIssueId`;
   - `linearIdentifier`;
   - `linearUrl`;
   - `repoHint`;
   - `factSourceName` (`darkFactory.facts`);
   - `runtimeObservationSources`;
   - provider capability names available through `execute`;
   - hosted stream namespace/name, without auth token values.
6. Start the parent context through normal runtime-host execution. The app may
   use an initial context prompt or append the prompt through `RuntimeIngress`,
   but the prompt must be durable and tied to the parent context id.

The guarantee is external work key convergence: Linear/GitHub/provider
redelivery for the same external work key must resolve to the same durable
factory-run subscriber identity and planner `contextId`. It must not create
competing factory runs. This is not a platform parent/child hierarchy; it is an
app-owned idempotency and lookup contract over durable records.

### Initial Planner Prompt Shape

The planner prompt is load-bearing. It is the product policy boundary that
tells the model how to choreograph with Firegrid tools. The first
implementation should generate a prompt with this shape:

```text
You are the Smithery dark-factory planner running on Firegrid.

Goal:
Turn the Linear issue below into a reviewed, permissioned engineering result.
You own sequencing. There is no hidden workflow DAG. Decide the next action
from durable facts, runtime history, repository state, and human decisions.

Factory run:
- parentContextId: <contextId>
- factoryRunKey: <source>:<externalEntityKey>
- factSource: darkFactory.facts
- runtime sources:
  - firegrid.runtime.runs
  - firegrid.runtime.output.events
  - firegrid.runtime.output.logs
  - firegrid.runtime.ingress.inputs
  - firegrid.runtime.ingress.deliveries
  - firegrid.runtime.agent-output-events

Linear issue:
- issueId: <linearIssueId>
- identifier: <linearIdentifier>
- title: <title>
- url: <linearUrl>
- description:
<description>

Repository:
- repoHint: <owner/repo or unknown>
- deterministicBranch: factory/<linearIdentifier lowercased>

Provider capabilities available through execute, if advertised:
- linear.postActivity
- linear.postComment
- linear.setDelegate
- github.findPrByHead
- github.fetchPr
- github.fetchPrDiff
- github.upsertPrComment
- github.fetchCiStatus
- github.closePr
- github.squashMergePr
- slack.postMessage

Required operating rules:
1. Use wait_for over darkFactory.facts or Firegrid runtime observation sources
   for human gates, CI/provider facts, child session status, and external
   events. Do not rely on callback URLs or hidden comments for resume.
2. Ask for human approval before implementation and before merge. Prefer ACP
   PermissionRequest when available; otherwise wait for a durable
   human.* fact.
3. Use session_new to create implementer, reviewer, and QA child sessions when
   those phases are needed. Include the parent context id and Linear/GitHub
   correlation ids in the prompt/tool input fields that exist today.
4. Use session_prompt for follow-up work on an existing child session.
5. Use schedule_me for future self rechecks, such as CI still pending.
6. Use execute only for advertised provider/sandbox capabilities. Record or
   wait for durable facts that confirm side effects.
7. Use bounded sleep only as local backoff when no durable event source exists.
8. If blocked, emit a clear permission request or wait_for target describing
   exactly what fact/input will resume the run.

Start by:
1. Inspecting the ticket and repository hint.
2. Producing a concise implementation plan.
3. Requesting plan approval, or waiting on a human.plan.approved /
   human.plan.rejected fact if permission requests are unavailable.
```

The exact wording can evolve, but implementers should preserve the data
sections and the operating rules. The prompt must include durable source names
and enough provider/entity metadata for the planner to wait on facts without
inventing source names.

### Tool Calls The App Tries To Elicit

The initial prompt should steer the planner toward these first calls:

- `wait_for` or ACP permission request for plan approval;
- `session_new` for implementation after plan approval;
- `wait_for` on child runtime status or output after delegation;
- `session_new` for reviewer/council and QA work when warranted;
- `execute` for provider side effects only when the app has advertised a
  matching capability;
- `schedule_me` for CI/provider rechecks when an external fact has not arrived;
- `wait_for` for merge approval and CI status before merge.

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
  `github.rest`, `human.linear-agent-session`, or `provider.worker`;
- `externalEventKey`: provider delivery id, Linear event id, GitHub event id,
  permission id, PR marker key, or deterministic provider action key;
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
tool/capability surface available to the app. The implementation acceptance
must use configured credentials and real Linear/GitHub/Slack/provider modules;
tests may avoid printing or asserting secret values, but they must not replace
the app acceptance path with fake provider clients.

Live planner-driven provider side effects through `execute` are a prerequisite
for any first-slice acceptance that claims Linear/GitHub/Slack action support.
If those capability-backed `execute` handlers are not implemented yet, the
first slice must keep provider side effects out of the acceptance proof and
limit itself to ingest, durable facts, planner output or permission request,
decision resume, and observable next planner action.

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

### Permission Display And Resolution

ACP `PermissionRequest` output is already durable as
`firegrid.runtime.agent-output-events`. The normalized runtime event is the
resume anchor, not necessarily the complete product display payload. Today the
runtime event is expected to carry the permission id, related tool id, and
available options; richer display context may be supplied by app-owned facts
or projection rows joined by `contextId` plus `permissionRequestId`.

The app must not mutate the runtime permission event contract just to render
product UI. If the product needs a provider-facing approval queue, it should
project the runtime permission event into an app-owned fact that copies or
adds the display fields.

The display payload must include:

- `permissionRequestId`;
- `contextId`;
- `factoryRunKey`;
- `correlationId`, if provided by the planner or app fact;
- prompt/body text only when the planner or app has persisted it in an
  app-owned fact;
- choices/options with stable ids and labels;
- requestedBy/source, such as planner context id or tool call id;
- status (`requested`, `resolved`, `expired`, or `cancelled`) when projected
  into app facts.

`PermissionResponse` correlates by `contextId` plus `permissionRequestId` and
is delivered through `RuntimeIngress` to the same context. If the app also
writes a `human.*` fact for provider/operator visibility, that fact should use
`externalEventKey = permissionRequestId` and `externalEntityKey =
factoryRunKey` or the provider entity id. The fact is display/audit evidence
and may carry product-specific prompt, correlation, requestedBy, or status
fields; the runtime resume path remains `RuntimeIngress`.

No permission table is required for the first app slice. If the product wants a
human-facing queue, it can project permission requests from runtime output into
app facts, but runtime resume remains `RuntimeIngress` to the context.

## Firegrid Tool Mapping

The planner receives the canonical `FiregridAgentToolkit` surface from
`packages/runtime/src/agent-tools/tools.ts`. The app should describe the tool
semantics in the planner prompt and status docs as follows:

| Tool | Factory use |
| --- | --- |
| `session_new` | Primary delegation primitive. Use for implementer, reviewer, council member, QA, or repository-investigation child sessions. Inputs should include role, parent context/session id, Linear issue id, repo, branch, PR URL when known, and correlation ids in fields supported by the current session tool schema. |
| `session_prompt` | Follow-up prompt to an existing child session, such as asking the implementer to address review feedback, asking QA to rerun with a specific preview URL, or asking a reviewer to re-check after a new commit. |
| `wait_for` | Primary suspension primitive. Use for human approval facts, ACP permission output observations, GitHub PR/CI facts, Linear prompted/stop facts, child runtime status, provider side-effect facts, and runtime terminal evidence. |
| `schedule_me` | Future self-prompt for bounded rechecks where an external event may not arrive, especially CI still pending, provider eventual consistency, or a reminder to inspect a stale child session. |
| `execute` | Only for configured capability-backed provider or sandbox actions. Examples, once implemented and advertised: GitHub PR lookup/comment/merge, Linear activity/comment/delegate update, Slack advisory post, or repository command execution when a sandbox capability exists. The planner must not assume arbitrary provider access unless the prompt advertises the capability. |
| `sleep` | Last-resort bounded backoff inside a running turn when no durable observation source exists. Prefer `wait_for` or `schedule_me` for long waits. |
| `session_cancel` | Stop a child session when a human rejects the run, a duplicate child was created, the planner changes strategy, or a provider stop signal arrives. |
| `session_close` | Close a child session after its result has been captured in durable output/facts or when the planner intentionally abandons that branch. |
| `spawn` | Not used as an app-facing factory primitive. The session-plane tools are the intended factory surface; lower-level spawn compatibility should not appear in planner prompts. |
| `spawn_all` | Not used as an app-facing factory primitive. Parallel review/QA work should be expressed as multiple `session_new` calls so each child has a stable session identity and observable status. |

This mapping is intentionally not a workflow. It tells the planner what tools
mean; it does not prescribe an implementation/review/QA/deploy sequence in
code.

## End-To-End Control Flow

The production-shaped flow is:

1. A product-owned Linear/GitHub/webhook adapter receives and verifies input.
2. The app writes or loads an external fact with deterministic source and
   external event key.
3. The app creates or loads one durable factory-run subscriber identity for
   the external work key and resolves its planner `contextId`.
4. The planner context is launched by the host/control-plane path:
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
   as needed, and requests provider side effects only through configured app
   capabilities that are actually implemented and advertised.
9. GitHub/Linear/Slack side effects emit durable facts so retries and future
   planner turns can inspect what already happened.
10. The app derives status from durable observations, not from in-memory
    process handles.

## Provider Side Effects Feed Back Through Facts

Provider adapters must not be hidden resume channels. Every provider side
effect the planner might need to reason about should produce a durable fact
that can be queried and waited on.

Examples:

- `linear.agent-session.prompted`: Linear user replied to the agent surface.
  The app records the reply body, classified intent if available, session id,
  issue id, and correlation id. If it resolves an ACP permission request, the
  app also writes `RuntimeIngress` `PermissionResponse`.
- `linear.agent-session.stop`: Linear stop signal was received. The app records
  the stop fact, cancels/closes relevant runtime contexts when instructed, and
  records cancellation output.
- `github.pr.opened`: Implementer or provider action created/found a PR. The
  fact includes repo, PR number, URL, head SHA, branch, and parent context id.
- `github.pr.review_posted`: A reviewer/council comment was created or
  updated. The fact key should be deterministic by repo, PR number, and marker
  kind.
- `github.ci.status`: CI was observed. The fact includes repo, PR number, SHA,
  status, and source timestamp.
- `github.pr.merged` / `github.pr.closed`: Merge or close happened. The fact
  includes final PR status, SHA if merged, reviewer/decision correlation, and
  provider response metadata.
- `slack.notification.posted`: Advisory notification was sent. This is
  observation-only and should not control resume.

The planner waits on these facts through `darkFactory.facts`. Hidden callback
URLs, hidden Linear comments, and comment-walking routers are not Firegrid
control flow.

## Progress Tracking Surface

The first implementation should use the PR #236 `apps/factory` UI scaffold as
the operator progress surface when that scaffold is available. If it is absent,
the first slice should expose a read-model/programmer projection over durable
rows and prove it through hosted smoke evidence. A standalone CLI simulation or
custom Firegrid-owned `/factory/*` HTTP API is not sufficient app evidence.

Minimum UI or read-model views:

- run lookup by `contextId` and by external work key;
- run summary;
- active/delegated agent list;
- progress tracker;
- runtime/fact message feed;
- agent/session graph;
- current waits and permission requests;
- provider links to Linear/GitHub/Slack evidence.

The UI should be derived from hosted Durable Streams materialized rows and
include:

- subscriber identity, planner context id, factory run key, source, external
  entity key, Linear identifier/url, repo, branch, and PR link when known;
- active and terminal runtime contexts from `firegrid.runtime.runs`, joined to
  child role/correlation facts or tool results when present;
- latest app facts from `darkFactory.facts`, grouped by provider/entity;
- latest runtime output text/log excerpts from `firegrid.runtime.output.logs`;
- structured agent output from `firegrid.runtime.agent-output-events`,
  including tool calls, tool results, permission requests, status, turn
  completion, and termination;
- current waits inferred from permission requests, scheduled self-prompts, and
  planner/tool output;
- current human-action items, including permission request id, prompt, choices,
  context id, and resume path;
- provider links to Linear issue, GitHub PR, GitHub comments/checks, and
  advisory Slack message metadata when available;
- last error or blocked reason, if any.

The client should use DurableTable live subscriptions for current state. The
Flamecast UI is a useful reference for `DurableTableProvider`,
`useDurableTable`, and `useDurableLiveQuery` over runtime tables. Do not copy
Flamecast host infra, local launch process management, or browser-originated
runtime authority; the factory app should read hosted durable rows and call
product-owned app routes for provider/operator actions.

The UI must read durable rows/facts/output; it must not report state from
in-memory timers, local process handles, the PR #236 simulation hook, or mock
data.

## Minimal Replacement Slice

The smallest useful implementation slice should prove the replacement shape,
not the full factory product:

1. A product-owned Linear webhook/ingest path accepts a real provider-shaped
   ticket event, with live verification where the provider can deliver to the
   app route.
2. The app writes `linear.issue.accepted` as a durable fact.
3. The app creates or loads one durable factory-run subscriber identity and
   planner context for the Linear issue id.
4. A real planner/agent backend supported by Firegrid starts and emits a
   plan-ready or permission-needed observation.
5. The app/test observes the wait through
   `RuntimeObservationSourceNames.agentOutputEvents` or `darkFactory.facts`.
6. A real human/provider decision path approves or rejects the plan through
   runtime ingress or a provider-backed fact.
7. The app resumes the planner by writing `PermissionResponse` ingress or a
   `human.plan.approved` fact.
8. The planner emits an observable next action, such as `session_new`,
   `session_prompt`, `wait_for`, `schedule_me`, or an `execute` call only if
   the required provider capability exists.
9. Runtime output/facts show durable evidence for the subscriber identity,
   planner context id, Linear issue id, decision, next planner action, and
   waiting or terminal status.

Later slices can add the full implementation/review/QA loop and perform
CI-gated merge. Those slices must keep the same choreography rule: the planner
decides the sequence, and code provides durable capabilities.

## Production Acceptance Substrate

The app acceptance path must be live against the production-shaped substrate:

- configured hosted Electric/Durable Streams endpoint and auth headers only;
- app-owned DurableTable facts;
- `RuntimeContext` creation and `startRuntime`;
- runtime observation sources from #232;
- `wait_for` over runtime observation and app fact sources;
- `RuntimeIngress` permission response delivery.

`DurableStreamTestServer` and local durable-stream substrates are valid for
runtime package unit tests. They are not sufficient acceptance evidence for
`apps/factory`, because this app is intended to supersede the hosted
`hooks/factory` product path.

## Live Provider And Agent Requirements

The implementation acceptance must use:

- live Linear/GitHub/Slack/provider credentials supplied by env or secret
  config;
- a live provider webhook/ingest path where provider delivery is feasible;
- real GitHub/Linear side-effect modules for the side effects the slice
  exercises;
- a real planner/agent backend selected from what Firegrid supports at
  implementation time.

The acceptance proof must not use:

- fixture Linear/GitHub event payloads as simulated product progress; a
  fixture-shaped payload may exercise a live provider-shaped route when real
  webhook delivery is unsafe;
- deterministic fake planners as the planner acceptance proof;
- local Durable Streams as the app acceptance substrate;
- committed bearer tokens, webhook secrets, OAuth tokens, PATs, or generated
  secret values.

Still required:

- idempotent fact insert/load behavior;
- parent `RuntimeContext` identity;
- host-owned ingress/output routing;
- `wait_for` source registration and matching;
- permission resume through runtime ingress when ACP `PermissionRequest` is
  used.

## Acceptance Criteria

The implementation should satisfy the ACIDs in
`features/firegrid/firegrid-dark-factory-app.feature.yaml`.

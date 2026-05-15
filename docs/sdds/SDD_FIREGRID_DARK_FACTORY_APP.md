# SDD: Firegrid Dark Factory App

Status: Draft implementation contract

Related specs:

- `firegrid-dark-factory-app`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-workflow-driven-runtime`
- `firegrid-durable-tools`

Related source inputs:

- `docs/sdds/SDD_FIREGRID_FACTORY_ALIGNED_AGENT_TOOL_WORKSTREAM.md`
- `/Users/gnijor/smithery/flamecast-agents/DARK_FACTORY_PROCESS_PRD.md`
- `packages/runtime/src/runtime-host/observation-sources.ts`
- `packages/runtime/src/agent-tools/tools.ts`
- `packages/runtime/src/verified-webhook-ingest/README.md`

The recipes `docs/recipes/runtime-permission-resume.md` and
`docs/recipes/durable-webhook-facts-and-wait-for.md` were requested as inputs
but are not present on `origin/main` at the time of this draft. The design below
uses the merged runtime observation sources from #232 and the existing verified
webhook ingest README instead.

## Purpose

The dark factory app is the first production-shaped app demonstration for the
factory workstream. It should show a ticket-like external trigger becoming one
durable parent planner run, the planner using Firegrid tools to delegate or
wait, human gates being explicit durable state, and progress being inspectable
through DurableTable/runtime observation.

This app is not a workflow product. The sequence is planner policy over
Firegrid primitives, not a new platform DAG or hidden callback protocol.

## Target Package

Target location: `apps/dark-factory`.

The app should follow the existing workspace app conventions used by
`apps/flamecast`: private package, local `tsconfig.json`, `src/` modules,
targeted tests, and root workspace inclusion through the existing `apps/*`
pattern.

The first app surface should be host-plane/local-demo oriented:

- a local/demo entrypoint that starts or attaches to Durable Streams;
- a Firegrid local host scope using `FiregridLocalHostLive`;
- app-owned fact table composition;
- a fixture route/function that simulates a product-owned external trigger;
- a targeted test or scenario for the minimal sequence.

It must not depend on `pnpm firegrid -- run`; #229 is sync CLI UX and is not a
factory app dependency.

## Durable Fact Surface

External inputs are app-owned facts, not Firegrid-owned provider callbacks.
Examples:

- ticket accepted;
- plan decision resolved;
- PR opened;
- review completed;
- CI status observed;
- merge decision resolved.

The first implementation should define an app-owned `DurableTable` collection,
for example `DarkFactoryFactTable.facts`, with a source-neutral row shape:

- deterministic key: `{ source, externalEventKey }`;
- `source`: short producer/source id, such as `demo.ticket` or
  `demo.human`;
- `externalEventKey`: provider event id, delivery id, permission id, or
  deterministic demo event id;
- `externalEntityKey`: ticket id, PR id, context id, or parent session id;
- `eventType`: product-neutral event kind, such as `ticket.accepted`,
  `plan.approved`, `plan.rejected`, `ci.passed`;
- `contextId` and `correlationId` when known;
- `payload`: unknown/source-specific detail for inspection.

Duplicates use `DurableTable.insertOrGet` or deterministic primary keys. Same
source and external event key resolves to the existing row. Conflict handling is
app policy, but must not silently overwrite a different fact payload for the
same external key.

The fact collection should be registered with `SourceCollections` under a short
source name such as `darkFactory.facts`. Agents can then call `wait_for` with
top-level scalar fields:

```json
{
  "eventQuery": {
    "stream": "darkFactory.facts",
    "whereFields": {
      "contextId": "ctx_...",
      "eventType": "plan.approved",
      "correlationId": "ticket-123-plan"
    }
  }
}
```

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

The first production-shaped flow should be:

1. A product-owned trigger function receives a ticket-like input.
2. The app writes or loads a `ticket.accepted` fact using a deterministic
   `{ source, externalEventKey }`.
3. The app creates or loads one parent planner `RuntimeContext` for the ticket
   external source key.
4. The parent context is launched by the host/control-plane path:
   `insertLocalRuntimeContext` or `Firegrid.launch`, optional initial
   `appendRuntimeIngress`, and `startRuntime`.
5. The planner receives the canonical Firegrid tools and can call:
   `session_new`, `session_prompt`, `wait_for`, `schedule_me`, and `execute`
   where supported by the current runtime.
6. The planner asks for a human gate either by emitting an ACP
   `PermissionRequest` or by waiting on an app fact such as `plan.approved`.
7. The app or test fixture writes the decision:
   - as `RuntimeIngress` `PermissionResponse` for ACP permission requests; or
   - as an app-owned `DarkFactoryFactTable` fact for generic human/external
     decisions.
8. The planner resumes, optionally creates a child session with
   `session_new`, and records or observes progress through runtime output,
   runtime runs, ingress rows, and app facts.
9. The app derives demo status from durable observations, not from in-memory
   process handles.

## Minimal Demo Sequence

The smallest useful demo sequence is:

1. Fixture ticket `DF-1` is accepted.
2. App creates or loads parent planner context for `demo.ticket:DF-1`.
3. Planner starts and emits a plan-ready or permission-needed observation.
4. App/test observes the wait through
   `RuntimeObservationSourceNames.agentOutputEvents` or `darkFactory.facts`.
5. Fixture human approves the plan.
6. App resumes the planner by writing `PermissionResponse` ingress or a
   `plan.approved` fact.
7. Planner emits a `session_new` tool call or a demo child-session intent.
8. Runtime output/facts show enough durable evidence to inspect:
   parent context id, ticket id, decision, child session/context id or mocked
   child action, and terminal/waiting status.

This is intentionally smaller than the full PRD path. It proves the shape:
external input -> durable fact -> parent planner RuntimeContext -> tool/wait or
permission gate -> durable resume -> durable observation.

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

- demo ticket input instead of real Linear;
- fixture human decision writer instead of a real product UI;
- fixture PR/CI facts instead of GitHub/CI API calls;
- deterministic stdio-jsonl or ACP planner process instead of a real model;
- child-session proof may be a fixture child agent command if real repository
  mutation is not needed in the first PR.

Not mocked:

- durable fact insert/load behavior;
- parent `RuntimeContext` identity;
- host-owned ingress/output routing;
- `wait_for` source registration and matching;
- permission resume through runtime ingress when the demo uses ACP
  `PermissionRequest`.

## Acceptance Criteria

The implementation should satisfy these ACIDs:

- `firegrid-dark-factory-app.APP_SURFACE.1`
- `firegrid-dark-factory-app.APP_SURFACE.2`
- `firegrid-dark-factory-app.EXTERNAL_FACTS.1`
- `firegrid-dark-factory-app.EXTERNAL_FACTS.2`
- `firegrid-dark-factory-app.EXTERNAL_FACTS.3`
- `firegrid-dark-factory-app.PARENT_RUN.1`
- `firegrid-dark-factory-app.PARENT_RUN.2`
- `firegrid-dark-factory-app.PLANNER_RUNTIME.1`
- `firegrid-dark-factory-app.PLANNER_RUNTIME.2`
- `firegrid-dark-factory-app.PLANNER_RUNTIME.3`
- `firegrid-dark-factory-app.SESSION_TOOLS.1`
- `firegrid-dark-factory-app.SESSION_TOOLS.2`
- `firegrid-dark-factory-app.WAIT_AND_PERMISSION.1`
- `firegrid-dark-factory-app.WAIT_AND_PERMISSION.2`
- `firegrid-dark-factory-app.WAIT_AND_PERMISSION.3`
- `firegrid-dark-factory-app.OBSERVATION.1`
- `firegrid-dark-factory-app.OBSERVATION.2`
- `firegrid-dark-factory-app.BOUNDARIES.1`
- `firegrid-dark-factory-app.BOUNDARIES.2`
- `firegrid-dark-factory-app.BOUNDARIES.3`
- `firegrid-dark-factory-app.VALIDATION.1`
- `firegrid-dark-factory-app.VALIDATION.2`

The first implementation PR should include a focused app test or scenario that
references the relevant ACIDs in test names.

## Non-Goals

- No custom workflow engine.
- No platform-authored factory DAG.
- No parent/child platform hierarchy beyond metadata and correlation.
- No hidden callback markers.
- No Firegrid-owned Linear/GitHub/webhook product.
- No Firegrid-owned provider HTTP endpoint or callback URL minting.
- No dependence on #229 sync CLI UX.
- No Flamecast implementation imports.
- No product-specific transport or sidecar process.
- No DurableConsumer/Projection/Source abstraction revival.
- No real repo mutation, PR creation, CI polling, or merge in the first slice.

## First Implementation Write Set

Expected first code PR after this spec:

- `apps/dark-factory/package.json`
- `apps/dark-factory/tsconfig.json`
- `apps/dark-factory/src/facts.ts`
- `apps/dark-factory/src/demo.ts` or `src/main.ts`
- `apps/dark-factory/src/dark-factory.test.ts`
- optional `apps/dark-factory/README.md`

The test should use the public/runtime primitives directly and should not shell
out through `pnpm firegrid -- run`.

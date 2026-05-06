# Review: Durable Permission / Wait Surfaces

Date: 2026-05-06
Slice: FP0A-DURABLE-WAIT-PERMISSION-SURFACE-CATALOG
Scope: docs/audit/spec-planning only

Related ACIDs:

- `client-event-plane-registration.EVENT_PLANE_DEFINITION.1`: A client event plane is declared as a typed value containing a stable plane name, event schemas, projection schemas, primary keys, and reducer/materializer rules.
- `client-event-plane-registration.PRODUCER_API.1`: A client event plane exposes a typed producer that emits validated domain events without exposing raw Durable Streams append calls as the normal API.
- `client-event-plane-registration.PROJECTION_API.1`: A client event plane exposes typed projection queries that can be consumed by the substrate Projection facade.
- `client-event-plane-registration.ACP_AGENT_PROFILE.4`: ACP permission handling can map an observed permission-request event into a domain permission row, then use Projection until or an awaitable only at the higher-layer policy boundary.
- `firegrid-runtime-process.SCENARIOS.9`: WaitFor projection-match receiver validation uses an app-owned runtime entrypoint that composes the projection-match subscriber with a typed operation handler and verifies caller-owned EventStream matching plus ready-work terminalization through projection inspection.
- `firegrid-runtime-process.SCENARIOS.13`: Fireline-shaped happy-path receiver validation composes app-owned operation descriptors, EventStream descriptors, projection-match evaluation, stock subscribers, `RunWait`, and typed handlers through `run(...)` without Firegrid-owned product row families.
- `firegrid-runtime-process.SCENARIOS.14`: Fireline-shaped rejection receiver validation resumes a typed handler from a resolved projection-match completion carrying app-level rejection data and terminalizes the run as a typed operation failure chosen by the app handler.
- `firegrid-runtime-process.SCENARIOS.16`: Scenario receivers and app-owned runtime entrypoints that compose typed Firegrid handlers do not import from `@firegrid/substrate/kernel`; durable wait, schedule, and awakeable primitives reach app handler code only through the `RunWait` service surface (run-wait-primitives.RUN_WAIT_API).
- `run-wait-primitives.RUN_WAIT_API.2`: `RunWait.for(trigger)` waits for a projection-match trigger and suspends the current durable run through Firegrid-owned completion and ready-work machinery.

## Executive Summary

The repo already has enough behavior to express a durable permission or approval
wait. The missing piece is naming discipline, not another scenario.

The canonical permission-wait shape is:

1. caller-owned event/projection state records the domain fact, such as
   `PermissionEvents`, `FirelineApprovalEvents`, a client `EventStream`, or an
   `EventPlane` row;
2. the handler calls `RunWait.for(ProjectionMatchTrigger)`;
3. the app-owned runtime composes
   `Firegrid.subscribers.projectionMatch({ evaluate })`;
4. the evaluator resolves a `projection_match` completion from the caller-owned
   observation state;
5. ready-work resumes the same `Firegrid.handler(...)` through runtime claim and
   terminal authority.

That shape is already proven by:

- `scenarios/firegrid/src/emitters/wait-for.ts`
- `scenarios/firegrid/src/receivers/wait-for-receiver.ts`
- `scenarios/firegrid/src/emitters/fireline-shaped.ts`
- `scenarios/firegrid/src/receivers/fireline-shaped-receiver.ts`
- `scenarios/firegrid/src/emitters/fireline-rejection.ts`
- `scenarios/firegrid/src/receivers/fireline-rejection-receiver.ts`
- `packages/substrate/src/__tests__/choreography-examples.test.ts`

FP3 should not add another permission-wait scenario until this decision table
lands and the next layer chooses which observation surface it wants to
standardize on.

## OCA Concern: Do Not Add A Third Permission Scenario

OCA's concern is correct: `wait-for.ts` / `wait-for-receiver.ts` already prove
an EventStream-based durable permission wait, and the Fireline rejection
scenario already proves an EventStream-based decision/rejection wait that
terminalizes as typed operation failure. The useful next distinction is not
"can Firegrid wait for permission?" It can. The useful distinction is:

- **EventStream** for descriptor-scoped event replay: one appendable stream of
  typed facts such as `PermissionEvents`, `FirelineApprovalEvents`, or
  `FirelineDecisionEvents`. This is the right default for scenario emitters,
  client event emit/observe, and app runtime materializers when a replayed fact
  stream is enough.
- **EventPlane** for stateful row families and projection-by-key reads: a
  caller-owned `StateSchema` with typed Producer and Projection services. This
  is the right fit when the domain needs materialized state such as
  "permission by id", "tool call by id", or "prompt by id" rather than just a
  replayed descriptor event.
- **RunWait.for** for suspending a running handler. It is the durable wait API;
  neither EventStream nor EventPlane suspends work by itself.
- **Firegrid.subscribers.projectionMatch** only in app-owned runtime
  composition. It is the resolver for pending projection-match completions, not
  a handler API and not a permission abstraction.

The existing proof points are therefore:

- EventStream permission approval:
  `scenarios/firegrid/src/emitters/wait-for.ts` and
  `scenarios/firegrid/src/receivers/wait-for-receiver.ts`.
- EventStream Fireline approval:
  `scenarios/firegrid/src/emitters/fireline-shaped.ts` and
  `scenarios/firegrid/src/receivers/fireline-shaped-receiver.ts`.
- EventStream Fireline rejection / decision:
  `scenarios/firegrid/src/emitters/fireline-rejection.ts` and
  `scenarios/firegrid/src/receivers/fireline-rejection-receiver.ts`.
- EventPlane stateful permission projection:
  `packages/substrate/src/__tests__/choreography-examples.test.ts`.

## Surface Catalog

| Surface | Owner | Intended caller | Authority level | Writes rows? | Blocks/resumes a run? | App-facing? |
| --- | --- | --- | --- | --- | --- | --- |
| `EventStream.define` descriptor | Substrate descriptor boundary, app supplies schema/name | App/scenario/client/runtime modules that need a typed caller-owned event stream | Domain observation only | No by itself | No | Yes, as a descriptor |
| Scenario `makeEventStreamScenarioRow(...)` + wait-for emitters | `@firegrid/scenarios` | Manual/CI scenario row emission | Domain observation row injection for validation | Yes, caller-owned `firegrid.event` rows | No by itself | Scenario-only |
| Client `EventStreamClient.emit/events` | `@firegrid/client` | Browser/client code | Domain observation; caller-owned EventStream rows | Yes, `firegrid.event` rows | No | Yes, client-facing |
| Runtime `Firegrid.eventStream(...)` | `@firegrid/runtime` | App-owned runtime composition | Materialization of caller-owned EventStream rows | No substrate authority writes | No | Yes, runtime-facing |
| `RunWait.for(trigger)` | `@firegrid/substrate` RunWait facade | Running operation handlers | Durable wait authority through completion + block-row lowering | Yes, `durable.completion` and blocked `durable.run` rows | Yes, blocks current run; resumes after resolved completion and ready work | Yes, app handler-facing |
| `ProjectionMatchTrigger` | RunWait/descriptors boundary | App handler input schemas and scenario emitters | Addressing metadata for a projection-match wait | No | No | Yes |
| `triggerMatchersLayer(...)` | RunWait facade support | App runtime composition that provides named trigger matcher presence/result decoding | Create-time matcher dispatch / result contract, not subscriber evaluation | No | No by itself | Yes, supporting Layer |
| `Firegrid.subscribers.projectionMatch({ evaluate })` | `@firegrid/runtime` | App-owned runtime entrypoints | Runtime subscriber authority to resolve/cancel pending projection-match completions | Yes, resolves/cancels `durable.completion` rows through substrate subscriber code | No by itself; enables ready-work resume after resolution | Yes, low-level runtime composition |
| `EventPlane.define/layer/Producer/Projection` | Substrate event-plane module; higher layer supplies state schema | Runtime/lab/adapters that need typed domain event planes and projections | Domain observation and plane-local projection state | Producer writes plane rows; Projection reads plane rows | No by itself | Yes, but naming is transitional |
| `Projection.snapshot/stream/until` facade | Substrate coordination/read-model facade | App/runtime/lab code that observes substrate projections | Read-only substrate observation | No | No durable block/resume; `until` is only an in-process wait | Yes, read-model-facing |
| Work/claim/operator facades | Substrate/runtime authority boundary | Runtime operator and app-owned side-effect workers | Claim/terminal authority for ready work | Yes in producer/operator paths | Resumes already-ready work, not permission observation by itself | Runtime/advanced, not the normal permission API |
| Raw kernel subscribers/waits/completion producers | Substrate kernel/internal | Substrate/runtime internals | Low-level durable authority | Yes | Yes, but only as internals | No for app receivers |

## Current Permission-Like Implementations

### Scenario WaitFor Permission

`scenarios/firegrid/src/emitters/wait-for.ts` defines:

- `PermissionEvents` with `EventStream.define`;
- `WaitForPermissionOperation` with an input `ProjectionMatchTriggerSchema`;
- one operation-started row plus one matching caller-owned EventStream row.

`scenarios/firegrid/src/receivers/wait-for-receiver.ts` composes:

- `Firegrid.subscribers.projectionMatch({ evaluate })`;
- `Firegrid.handler(WaitForPermissionOperation, ...)`;
- `RunWait.layer({ streamUrl })`;
- `triggerMatchersLayer({ "scenario.permission.approved": ... })`.

This is the smallest current proof of a durable permission/approval wait. It is
already enough for the generic Firegrid behavior.

### Fireline-Shaped Happy Path

`scenarios/firegrid/src/emitters/fireline-shaped.ts` uses the same pattern with
Fireline-shaped names:

- `FirelineApprovalEvents`;
- `FirelineShapedOperation`;
- `ProjectionMatchTrigger` with matcher id `scenario.fireline.approved`.

`scenarios/firegrid/src/receivers/fireline-shaped-receiver.ts` resolves the
projection match from the caller-owned approval event and completes the run.
This validates that Fireline can own product vocabulary without adding
Fireline-native substrate row families.

### Fireline-Shaped Rejection Path

`scenarios/firegrid/src/emitters/fireline-rejection.ts` and
`scenarios/firegrid/src/receivers/fireline-rejection-receiver.ts` prove the
negative path: a rejection event still resolves the projection-match
completion, then the handler maps the matched rejection data to its typed
operation error schema. This is app-level rejection, not timeout/cancellation.

### Firepixel-Shaped EventPlane Permission Example

`packages/substrate/src/__tests__/choreography-examples.test.ts` defines a fake
Firepixel-shaped required-action plane with `EventPlane.define`. It emits a
`requested` row, calls `RunWait.for`, emits a `resolved` plane row, and uses a
projection-match subscriber evaluator to resolve the completion.

This proves a second observation source for the same durable wait concept:
caller-owned EventPlane rows can drive the projection-match evaluator. It also
shows why another permission scenario would be duplicative unless it chooses a
different API boundary to standardize.

## Duplicated Or Vague Concepts

1. `EventStream` and `EventPlane` both model caller-owned durable observation
   state. `EventStream` is a lightweight descriptor/envelope used by client and
   scenario rows. `EventPlane` is a broader state-schema + Producer/Projection
   abstraction. The old `event-plane/` module name remains even though newer
   scenario code often uses EventStream vocabulary. Examples:
   - EventStream descriptor rows:
     `scenarios/firegrid/src/emitters/wait-for.ts`.
   - EventPlane state schema rows:
     `packages/substrate/src/event-plane/define.ts` and
     `packages/substrate/src/__tests__/choreography-examples.test.ts`.

2. `Projection` is overloaded:
   - substrate `Projection` facade means read-only substrate snapshot/stream/until;
   - `ProjectionMatchTrigger` means a durable wait condition address;
   - `Firegrid.subscribers.projectionMatch` means runtime completion resolution;
   - `EventPlane.Projection` means a plane-local projection service.
   Concrete paths:
   - `packages/substrate/src/coordination/projection.ts`
   - `packages/substrate/src/coordination/run-wait/triggers.ts`
   - `packages/runtime/src/runtime-api.ts`
   - `packages/substrate/src/event-plane/projection.ts`

3. `permission`, `approval`, `decision`, and `required action` are product
   words, not substrate row families. The scenarios intentionally use those
   words in caller-owned descriptors and events; substrate rows remain
   `durable.run`, `durable.completion`, `firegrid.event`, or event-plane state
   rows. Examples:
   - `PermissionEvents` in `scenarios/firegrid/src/emitters/wait-for.ts`;
   - `FirelineDecisionEvents` in
     `scenarios/firegrid/src/emitters/fireline-rejection.ts`;
   - `example.required_action.permission` in
     `packages/substrate/src/__tests__/choreography-examples.test.ts`.

4. `triggerMatchersLayer` and `Firegrid.subscribers.projectionMatch` sound like
   they do the same thing but they operate at different phases. The matcher
   layer is a handler-side `RunWait.for` dependency, as in
   `scenarios/firegrid/src/receivers/wait-for-receiver.ts`. The subscriber
   evaluator is runtime-side durable completion resolution, as exposed by
   `Firegrid.subscribers.projectionMatch({ evaluate })` in
   `packages/runtime/src/runtime-api.ts`.

5. `Projection.until` can wait for a condition, but it is not a durable wait.
   It is an in-process observer over read models. Use it for UI/lab/policy
   observation, not for suspending a durable operation run.

6. `RunWait.for` is app-facing; `DurableWaitsLive`, raw wait kernel modules,
   and direct completion producers are not app-facing. Scenario receivers should
   continue to avoid raw kernel imports.

## Canonical Decision Table

| Need | Use | Do not use |
| --- | --- | --- |
| Define a simple caller-owned event row that client/scenario/runtime code can share | `EventStream.define` | A substrate-native permission/session/tool row family |
| Replay descriptor-scoped events such as approval, rejection, or permission facts | `EventStream.define` plus `EventStreamClient.emit/events`, scenario emitters, or `Firegrid.eventStream(...)` | `EventPlane` unless the domain needs keyed materialized state |
| Model stateful row families with projection-by-key reads | `EventPlane.define` + `EventPlane.layer` | One-off EventStream descriptors when the caller needs durable state rows and typed Projection queries |
| Emit browser/client-owned permission/approval events | `EventStreamClient.emit` | `RunWait.for`, raw Durable Streams append helpers, runtime subscriber APIs |
| Emit scenario rows for manual validation | `@firegrid/scenarios` emitter via the shared runner | Per-scenario stdout writers or copied JSON fixtures |
| Suspend a running durable operation until a permission/approval condition is met | `RunWait.for(ProjectionMatchTrigger)` inside `Firegrid.handler(...)` | `Projection.until`, EventStream emitters, EventPlane projection alone |
| Resolve pending projection-match completions in an app-owned runtime process | `Firegrid.subscribers.projectionMatch({ evaluate })` | Handler-side `triggerMatchersLayer` alone |
| Provide matcher/result decoding dependencies to `RunWait.for` | `triggerMatchersLayer(...)` near `RunWait.layer(...)` | Runtime subscriber evaluator as a replacement for handler dependencies |
| Observe substrate run/completion/claim/EventStream state | `Projection.snapshot/stream/until` or scenario `inspect` | Runtime mutation endpoints or privileged control plane APIs |
| Execute side effects after a wait resolves | Runtime `Firegrid.handler(...)` ready-work path and claim/operator authority | EventPlane materializer or projection rows as hidden terminal authority |
| Compose app receiver scenarios | `run({ connection, runtime })` with explicit `Firegrid.*` Layers and `RunWait.layer(...)` | `@firegrid/substrate/kernel`, `DurableWaitsLive`, raw subscribers, dynamic graph loading |

## Recommended Naming Discipline

Use these terms consistently in docs and future scenario names:

- **EventStream**: simple caller-owned event facts carried in the Firegrid
  EventStream envelope.
- **EventPlane**: caller-owned state-schema plane with Producer and Projection
  services.
- **RunWait**: app-handler durable wait primitive that may block the current run.
- **Projection-match subscriber**: runtime Layer that turns observed state into
  resolved/cancelled projection-match completions.
- **Projection facade**: read-only substrate projection observer.
- **Permission / approval / decision**: product-layer vocabulary only.

Avoid names that imply permission is a substrate primitive, such as
`PermissionSubscriber`, `PermissionWaits`, `Firegrid.permissions`, or
`permission` row families.

## FP2 / FP3 Sequencing

FP2 prompt-chunk remains valid if it is framed as an observation/read-model or
app-owned EventStream/EventPlane scenario. Prompt chunks are not the same
concept as durable permission waits. The implementation should still avoid
substrate-native prompt row families and should not add runtime/substrate
capability unless a concrete gap appears.

FP3 permission wait should be deferred until this catalog and decision table are
accepted. The current repo already proves permission-like waits through
scenario `wait-for`, Fireline happy/rejection scenarios, and the Firepixel-shaped
EventPlane example. A future FP3 should be allowed only if it chooses one
explicit canonical boundary, such as:

- "Firepixel permission over EventPlane state";
- "Firepixel permission over EventStream facts";
- "client EventStream emits permission result, runtime RunWait resumes";
- "Projection.until policy observation without durable run suspension".

Without that boundary choice, FP3 would duplicate existing behavior and deepen
the API ambiguity this catalog is meant to remove.

## Follow-Up Slice Suggestions

1. Decide whether `EventPlane` is a long-term public surface or transitional
   naming to be migrated behind EventStream/EventState vocabulary.
2. Add a short "permission wait decision table" section to the Firepixel
   foundation SDD once that SDD lands on `main`.
3. If FP3 proceeds, make its PR title include the chosen boundary, for example
   `FP3: Firepixel permission wait over EventPlane state`.
4. Keep scenario receivers under `RunWait` and explicit runtime Layers; reject
   new app-facing imports from substrate kernel or lower-level wait Layers.

# tf-0r95 Dark-Factory Channel Target Shape

Status: prep note, blocked on `tf-kddg` first draft or ping-back for the generic Tag/Layer API.

## Source Of Truth

- `docs/architecture/host-sdk-runtime-boundary.md`
- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
- `br show tf-kddg`
- `packages/firelab/src/simulations/dark-factory/host.ts`

## Relevant ACIDs

- `firegrid-agent-body-plan.CHANNEL_REGISTRY.2`: Host SDK exposes a ChannelRegistry service that registers channel targets with ingress, egress, or call direction metadata.
- `firegrid-agent-body-plan.CHANNEL_REGISTRY.3`: Channel registry metadata exposes the channel schema shape needed by downstream tool metadata without exposing substrate bindings.
- `firegrid-agent-body-plan.CHANNEL_REGISTRY.4`: Channel registrations bind ingress channels to typed streams, egress channels to append targets, and call channels to request-response handlers.
- `firegrid-agent-body-plan.CHANNEL_REGISTRY.5`: The factory.events channel can be registered through host composition as an ingress channel without exposing CallerFact or stream names to agent-visible metadata.
- `firegrid-agent-body-plan.EVENT_CHANNEL.2`: An `event(name)` channel exposes both ingress and egress bindings for the same channel target.
- `firegrid-agent-body-plan.APPROVAL_CALL.3`: The host approval adapter waits for a matching PermissionRequest on the current runtime context and responds by appending a PermissionResponse intent.
- `firegrid-agent-body-plan.SLICE_BOUNDARY.4`: Phase 2 Slice C.2 adds event channel bindings without implementing the agent-facing send, call, wait_for, or wait_for_any verbs.

## Placement Decision

`host-sdk` should keep generic channel kinds and session-tier channels:

- `event(name)` generic constructor and target helper
- `state.changes(collection)` generic constructor
- human `dm(handle)` and `notification(handle)` generic constructors
- approval generic call-channel constructor or adapter
- `SessionLogChannelTag`
- `SessionSelfLifecycleChannel`
- `SessionSelfCheckpointChannel`

Dark-factory should own app-specific channel instances:

- `FactoryEventsChannel`
- `PlanReadyEventChannel`
- `DmOperatorIngressChannel`
- `NotificationOperatorEgressChannel`
- `ApprovalOperatorChannel`

The difference is ownership of the name and schema. `event` is a host-sdk kind;
`event.plan.ready` is dark-factory host-author inventory. `dm(handle)` is a
generic human-channel kind; `dm.operator` is dark-factory's selected handle.

## Current Host Shape

`dark-factory/host.ts` currently composes:

- `DarkFactoryFactTable.layer(...)`
- `CallerOwnedFactStreams`, mapping `darkFactory.facts` to `table.facts.rows()`
- the seed trigger fact layer
- `FiregridRuntimeHostLive(...).pipe(Layer.provideMerge(appFacts))`
- `FiregridMcpServerLayer(...).pipe(Layer.provideMerge(host), Layer.provideMerge(appFacts))`

That is still substrate-shaped. It wires the fact stream, but it does not declare
the body-plan channels in dark-factory host composition.

## Target Shape After `tf-kddg`

Prefer a sibling module to keep `host.ts` readable:

```ts
// packages/firelab/src/simulations/dark-factory/channels.ts
import { Context, Effect, Layer, Schema } from "effect"
import {
  approvalChannel,
  dmChannel,
  eventChannelFromCollection,
  notificationChannel,
  type CallableChannel,
  type EgressChannel,
  type IngressChannel,
  type BidirectionalChannel,
} from "@firegrid/host-sdk"

export class FactoryEventsChannel extends Context.Tag(
  "firelab/dark-factory/FactoryEventsChannel",
)<FactoryEventsChannel, IngressChannel<typeof DarkFactoryFactRowSchema>>() {}

export class PlanReadyEventChannel extends Context.Tag(
  "firelab/dark-factory/PlanReadyEventChannel",
)<PlanReadyEventChannel, BidirectionalChannel<typeof PlanReadyEventSchema>>() {}

export class DmOperatorIngressChannel extends Context.Tag(
  "firelab/dark-factory/DmOperatorIngressChannel",
)<DmOperatorIngressChannel, IngressChannel<typeof OperatorMessageSchema>>() {}

export class NotificationOperatorEgressChannel extends Context.Tag(
  "firelab/dark-factory/NotificationOperatorEgressChannel",
)<NotificationOperatorEgressChannel, EgressChannel<typeof OperatorMessageSchema>>() {}

export class ApprovalOperatorChannel extends Context.Tag(
  "firelab/dark-factory/ApprovalOperatorChannel",
)<ApprovalOperatorChannel, CallableChannel<typeof ApprovalRequestSchema, typeof ApprovalResponseSchema>>() {}

export const DarkFactoryChannelsLive = (options: {
  readonly facts: Layer.Layer<DarkFactoryFactTable, DurableTableError>
  readonly operatorMessages: OperatorMessageBindings
  readonly approval: ApprovalOperatorBindings
}) =>
  Layer.mergeAll(
    FactoryEventsLive(options.facts),
    PlanReadyEventLive(options.facts),
    DmOperatorIngressLive(options.operatorMessages),
    NotificationOperatorEgressLive(options.operatorMessages),
    ApprovalOperatorLive(options.approval),
  )
```

The exact type names above should adapt to `tf-kddg`. The invariant is that each
app-specific channel is a `Context.Tag` provided by a Layer, and the dark-factory
host composes those Layers. No app-specific channel names should be exported
from `packages/host-sdk/src/host/`.

`host.ts` should then compose the channel layer next to its existing app facts:

```ts
const appFacts = Layer.mergeAll(facts, callerFacts, seedTriggerFact)
const ChannelsLive = DarkFactoryChannelsLive({
  facts,
  operatorMessages,
  approval,
})

const host = FiregridRuntimeHostLive(options, envPolicy).pipe(
  Layer.provideMerge(appFacts),
  Layer.provideMerge(ChannelsLive),
)

return Layer.discard(FiregridMcpServerLayer(mcpOptions)).pipe(
  Layer.provideMerge(host),
  Layer.provideMerge(appFacts),
  Layer.provideMerge(ChannelsLive),
)
```

This matches the architecture doc's consumer story: channels are ordinary Effect
services provided into the host/MCP/toolkit layers that need them.

## Channel Instance Notes

`FactoryEventsChannel` should wrap `DarkFactoryFactTable.facts.rows()` under the
opaque target `factory.events`. It is app-specific because the row schema and
target name are dark-factory inventory, even though the generic ingress-channel
constructor remains in host-sdk.

`PlanReadyEventChannel` should use the generic `event(name)` kind with
`name = "plan.ready"`. The target should remain `event.plan.ready`, but the
schema and registration belong to dark-factory or a dark-factory test fixture,
not host-sdk.

`DmOperatorIngressChannel` and `NotificationOperatorEgressChannel` should use
the generic human-channel constructors with `handle = "operator"`. The operator
handle is app-specific host-author configuration.

`ApprovalOperatorChannel` should use the generic approval call-channel binding
with `handle = "operator"`. The permission request/response substrate remains
behind host-sdk/runtime seams; dark-factory only chooses that this host exposes
the `approval.operator` capability.

## Blockers And Open Points

1. `tf-kddg` has no draft PR at the time of this note. Do not implement the
   migration until the generic Tag/Layer API and MCP-edge inventory mechanism
   are visible.
2. The current main branch still has `ChannelRegistry` and
   `makeFactoryEventsChannel` in host-sdk. Removing or moving those belongs to
   `tf-kddg`; this bead should consume the resulting generic constructors.
3. Approval still has fallback dispatch paths for `approval.*`. The migration
   should not remove those unless `tf-kddg` or the Slice D lane replaces them
   with typed call-channel dispatch.
4. `PlanReadyEventChannel` is app-specific when used as a named dark-factory
   event. The generic `event(name)` constructor remains host-sdk-owned.
5. The dark-factory host currently has no durable operator for operator DM or
   notification rows. If `tf-kddg` does not provide test/fake bindings for
   human channels, this bead should add the smallest dark-factory-local binding
   surface rather than moving generic human-channel code into firelab.

## Implementation Checklist After `tf-kddg`

1. Rebase this worktree onto Lane 3's branch or merged main.
2. Remove app-specific channel exports from host-sdk if Lane 3 has not already
   done so.
3. Add `dark-factory/channels.ts` with the five app-specific Tags and Layers.
4. Update `dark-factory/host.ts` to provide `ChannelsLive` into the runtime host
   and MCP server layers.
5. Keep session-tier channel Tags in host-sdk.
6. Add or update tests proving dark-factory exposes `factory.events`,
   `event.plan.ready`, `dm.operator`, `notification.operator`, and
   `approval.operator` through host-author composition, without host-sdk owning
   those instance names.
7. Run `pnpm run verify`.

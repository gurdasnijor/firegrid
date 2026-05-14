# PRD Alignment Roadmap Audit

Status: coordinator review memo

This memo captures roadmap work from the Flamecast PRD alignment audit that can
move forward without interfering with host-context authority Slice 2. It is
happy-path focused: no operator-visibility lane, no migration system, no
provider catalog, no host mesh, and no new Firegrid-native product vocabulary.

Authoritative requirements remain in the Acai feature specs under
`features/firegrid/*.feature.yaml`. This document is planning guidance and cites
existing ACIDs for review alignment.

## Scope Boundary

Host-context Slice 2 owns runtime context authority primitives and host-owned
stream topology. Roadmap work here should not modify `RuntimeContext.host`,
prompt append routing, MCP route authority, or host-local provider delivery.
Work that needs those surfaces should wait until Slice 2 lands and then rebase.

The safe lanes are provider substrate validation, app-owned EventPlane examples,
secret resolution at provider/runtime boundaries, projection ordering
contracts, and reconciliation examples over caller-owned rows.

## Recommended Direction

For Flamecast product alignment, prioritize the app-control loop before remote
substrate breadth:

1. Add a PermissionWait worked example using EventPlane plus durable waits.
2. Extend the existing secret-resolution pattern only as far as env-backed MCP
   header materialization.
3. Audit and document cross-source ordering plus raw-to-normalized provenance.
4. Add a reconciliation harness after the PermissionWait example exists.

The remote/non-local `SandboxProvider` substrate litmus is still valuable, but
it is a parallel infrastructure lane. Dispatch it after or alongside the Effect
AI in-process provider work when provider breadth is the active goal, not as the
blocking next step for the Flamecast product loop.

Defer pre-activity launch hooks and native-session terminal schema changes until
host-context Slice 2 has landed, because those are more likely to touch runtime
context and run-state shapes.

## C2: First Remote Provider Substrate Litmus

### Why It Matters

Flamecast needs first-party runtimes to run on substrates such as Daytona,
Modal, Firebox, Sprites, and future remote MCP-shaped execution. The existing
`SandboxProvider` abstraction is the intended boundary. `local-process` and the
Effect AI in-process provider lane cover local and in-process execution; this
lane is specifically about the first remote or otherwise non-local substrate.

This is the highest-value next provider lane because it tests whether the
provider interface holds across a real non-local lifecycle without pulling
provider semantics into Firegrid's durable row vocabulary.

### Smallest Slice

Implement one remote/non-local provider adapter behind `SandboxProvider`,
preferably Daytona or Modal, after or in parallel with the Effect AI in-process
provider PR. The slice should prove one useful happy path:

- create or find a sandbox by labels;
- stream process output or open a byte pipe;
- destroy or mark unsupported lifecycle operations explicitly;
- expose accurate capability flags;
- keep credentials and provider policy outside durable rows.

Do not dispatch this as a generic provider-slot task. The Effect AI in-process
provider validates in-process agent/toolkit behavior. A Daytona or Modal
provider validates remote execution-plane materialization and lifecycle
assumptions.

### Likely Files And Specs

- `packages/runtime/src/providers/sandboxes/SandboxProvider.ts`
- `packages/runtime/src/providers/sandboxes/local-process.ts`
- `packages/runtime/src/providers/sandboxes/process-stream.ts`
- `packages/protocol/src/launch/schema.ts`, only if launch needs to select the
  provider through the public runtime intent
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.3`
- `firegrid-agent-runtime-substrate.INVARIANTS.1`
- `firegrid-agent-runtime-substrate.NON_SCOPE.3`
- `firegrid-execution-plane-resources.RESOURCE_IDENTITY.1`
- `firegrid-execution-plane-resources.SECRET_REFERENCES.1`
- `firegrid-execution-plane-resources.MATERIALIZER_SUBSCRIBER.1`
- `firegrid-execution-plane-resources.NON_SCOPE.2`

### Conflicts And Dependencies

This should not depend on Slice 2 if it remains under provider interfaces and
does not hand-wire host-owned stream URLs. Avoid changing runtime-host prompt
routing or context ownership. Avoid adding product provider catalogs or
Flamecast adapter packages under `@firegrid/*`.

### Validation

- Provider contract tests mirroring `local-process.test.ts`.
- Byte-pipe or stream test if the provider supports interactive I/O.
- Negative tests for unsupported lifecycle operations.
- `pnpm --filter @firegrid/runtime typecheck`.

## C5: PermissionWait Worked Example

### Why It Matters

The PRD's permission handshake is a high-value durability story: a runtime asks
for permission, an app or user resolves it, the runtime is notified, and
reconciliation can repair notification gaps. Firegrid has the pieces today, but
the two-sided pattern is not documented as a reusable worked example.

The right starting point is an example, not a new primitive. If several product
flows converge on the same shape later, then a `TwoSidedWait` abstraction can be
considered.

### Smallest Slice

Add a scenario or docs-backed test that proves:

1. A handler emits a caller-owned `permission_requested` row.
2. The handler suspends through `RunWait` or `WaitFor.match` on a
   caller-owned permission projection.
3. An external app path emits `permission_resolved`.
4. The wait resolves from the projection.
5. The handler records the provider/runtime notification outcome and
   terminalizes normally.

Keep rows app-owned. Do not add Firegrid-native permission, session, prompt, or
tool row families.

### Likely Files And Specs

- `packages/runtime/src/durable-tools/**`
- `packages/runtime/src/durable-tools/README.md`
- runtime scenario tests under the existing runtime/process validation pattern
- `client-event-plane-registration.PRODUCER_API.5`
- `client-event-plane-registration.PRODUCER_API.6`
- `client-event-plane-registration.PROJECTION_API.5`
- `client-event-plane-registration.FIREPIXEL_PROFILE.3`
- `firegrid-runtime-process.SCENARIOS.19`
- `firegrid-runtime-process.SCENARIOS.20`
- `durable-waits-and-scheduling.WAIT_FOR.1`
- `durable-waits-and-scheduling.WAIT_FOR.2`
- `durable-waits-and-scheduling.WAIT_FOR.6`
- `firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.1`
- `firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.4`

### Conflicts And Dependencies

This does not need Slice 2 if it stays in app-owned EventPlane and runtime
scenario space. It should not use host-owned prompt append or MCP context
routing. Do not build operator visibility or repair dashboards into this slice.

### Validation

- Scenario proves emit-then-wait ordering.
- Scenario proves approved and denied outcomes, with timeout as a follow-up if
  it stays small.
- Tests assert no raw stream writer or substrate-kernel import is needed in app
  handler code.

## C8: Secret Resolution At Activity Start

### Why It Matters

Flamecast credentials must reach runtime processes and MCP clients without
persisting secret values into durable rows. The current env-binding path already
does the right thing for process environment materialization.

The MCP header case should start by reusing that channel rather than adding a
general credential transport.

### Smallest Slice

Document and test a v1 convention:

- durable rows store only binding refs, not values;
- the runtime host authorizes exact `(target, source)` pairs;
- provider startup resolves env values at spawn time;
- MCP/header values are represented by synthetic env names consumed by the
  runtime adapter;
- raw header values never become durable metadata or span attributes.

### Likely Files And Specs

- `packages/protocol/src/launch/schema.ts`
- `packages/runtime/src/providers/sandboxes/secrets.ts`
- `packages/runtime/src/providers/sandboxes/runtime-command.ts`
- `packages/runtime/src/runtime-host/env-bindings.test.ts`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5-1`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8`
- `firegrid-execution-plane-resources.SECRET_REFERENCES.1`
- `firegrid-execution-plane-resources.SECRET_REFERENCES.2`
- `firegrid-execution-plane-resources.SECRET_REFERENCES.3`
- `firegrid-platform-invariants.SECURITY.1`
- `firegrid-platform-invariants.SECURITY.4`

### Conflicts And Dependencies

Low Slice 2 conflict if the work remains at provider/runtime-command boundaries.
Do not place secret refs on host-context authority records. Do not add a
Firegrid credential directory, MCP header registry, OAuth policy, or BYOK
surface.

### Validation

- Existing env-binding tests extended for synthetic MCP/header names.
- Assertions prove durable context/output rows do not contain secret values.
- Resolver rejects unknown ref shapes and unauthorized binding pairs.

## C3 And C9: Ordering And Provenance Pattern

### Why It Matters

The PRD requires canonical session history ordered by a Flamecast-assigned
durable sequence after persistence, while retaining raw provider payloads for
privileged provenance. Current runtime output rows sequence within an
`activityAttempt`; retries and app/system-authored rows require a broader
cross-source ordering story.

This should start as an ordering-contract audit and pattern proof, not a
runtime-host rewrite.

### Smallest Slice

First, confirm the durable ordering guarantee available from
Durable Streams/DurableTable reads:

- whether accepted stream order is exposed to callers;
- whether replay-then-live preserves that order across a cursor boundary;
- whether table rows can carry an opaque accepted-order cursor without exposing
  raw Durable Streams State envelopes.

Then document and test a two-store pattern:

- raw provider/runtime payloads are stored in a private provenance table;
- normalized session events are caller-owned product rows;
- a product-owned subscriber or handler maps raw to normalized;
- public reads use normalized rows only.

### Likely Files And Specs

- `packages/protocol/src/launch/schema.ts`
- `packages/protocol/src/launch/table.ts`
- `packages/protocol/src/runtime-ingress/schema.ts`
- `packages/effect-durable-operators/src/DurableTable.ts`
- `firegrid-agent-ingress.INGRESS.4`
- `firegrid-agent-ingress.INGRESS.9`
- `durable-records-and-projections.AUTHORITY.4`
- `durable-records-and-projections.PROJECTIONS.3`
- `durable-records-and-projections.PROJECTIONS.8`
- `firegrid-projection-query.QUERY_HANDLES.3`
- `firegrid-projection-query.QUERY_HANDLES.4`
- `firegrid-projection-query.CURSOR_AND_REPLAY.3`
- `firegrid-projection-query.AUTHORITY_BOUNDARY.1`
- `firegrid-projection-query.AUTHORITY_BOUNDARY.2`
- `firegrid-durable-subscriber-webhooks.DELIVERY_PROJECTION.4`

### Conflicts And Dependencies

Avoid runtime-host output rewrites while Slice 2 is active. If the audit shows
that accepted order is already available, expose or document that read boundary
instead of adding a per-context sequencer. If no such guarantee exists, the
sequence primitive should be product-neutral and descriptor-scoped, not a
Flamecast session-log service.

### Validation

- Replay-then-live test proves no dropped or duplicated entries across the
  cursor boundary.
- Ordering test covers rows from at least two logical sources.
- Provenance test proves normalized reads do not expose raw provider payloads.

## C10: Reconciliation Harness

### Why It Matters

The PRD calls out stuck-state recovery: permission resolved but runtime not
notified, callback delivered but ack lost, activity exited but status not
updated. Firegrid already has durable subscriber, retry, wait, and projection
building blocks. The missing item is a small happy-path reconciliation example.

### Smallest Slice

After the PermissionWait example exists, add one reconciler harness:

- projection rebuild finds `permission_resolved` without
  `permission_runtime_notified`;
- subscriber reaches live boundary before side effects;
- subscriber re-delivers the resolution to the runtime adapter;
- ack writes the notification row;
- first-valid-terminal-wins keeps duplicates harmless.

### Likely Files And Specs

- `firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.1`
- `firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.2`
- `firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.4`
- `firegrid-durable-subscriber-webhooks.SUBSCRIBER_RUNTIME.5`
- `firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.1`
- `firegrid-durable-subscriber-webhooks.WAIT_INTEGRATION.4`
- `firegrid-durable-subscriber-webhooks.DELIVERY_SEMANTICS.1`
- `firegrid-durable-subscriber-webhooks.DELIVERY_SEMANTICS.2`
- `firegrid-durable-subscriber-webhooks.DELIVERY_SEMANTICS.6`
- `firegrid-runtime-process.HOT_PATHS.1`
- `firegrid-runtime-process.HOT_PATHS.4`

### Conflicts And Dependencies

Depends on the PermissionWait worked example and durable subscriber mechanics.
Do not add repair UI, operator visibility, migration tooling, or a Firegrid
repair row family. Repair behavior should remain app-owned projection logic.

### Validation

- Crash/restart-style test starts with existing rows, rebuilds projection, and
  performs one logical re-drive.
- Duplicate ack or duplicate delivery becomes duplicate evidence, not a changed
  terminal outcome.

## Deferred Until Host-Context Slice 2 Lands

### C6: Pre-Activity App Event Hook

The PRD wants `session_created` persisted before runtime start. This may need a
launch-time app-authored row hook or a documented two-write plus reconciliation
pattern. Because launch/runtime context shape is active in host-context work,
defer implementation until Slice 2 lands.

The current safe fallback is to use app-owned EventPlane producers before a
handler suspends or starts provider work:

- `client-event-plane-registration.PRODUCER_API.5`
- `client-event-plane-registration.PRODUCER_API.6`
- `firegrid-runtime-process.SCENARIOS.20`

### C7: Native Session Id And Non-Resumable Terminal

Native provider session carry and `session_not_resumable` style terminals touch
runtime adapter state and run status semantics. Treat native session id as
runtime-adapter-owned opaque state, not host ownership state. Revisit after
Slice 2 because `RuntimeContext` and local context authority are active areas.

Relevant specs:

- `firegrid-runtime-ownership-transfer.REATTACH_PROFILES.1`
- `firegrid-runtime-ownership-transfer.REATTACH_PROFILES.3`
- `firegrid-runtime-ownership-transfer.REATTACH_PROFILES.5`
- `firegrid-runtime-ownership-transfer.CLIENT_CONTINUITY.1`
- `firegrid-runtime-ownership-transfer.NON_SCOPE.1`
- `firegrid-runtime-ownership-transfer.NON_SCOPE.2`

## Review Checklist

- Does the item avoid modifying host-context Slice 2 authority surfaces?
- Are product rows caller-owned EventPlane/EventStream content?
- Are credentials resolved at runtime boundaries without durable secret values?
- Does validation prove a happy path before adding generalized framework code?
- Does the work cite existing ACIDs instead of inventing new IDs?
- Does the slice avoid operator visibility, migration, provider catalogs, host
  directories, and repair dashboards?

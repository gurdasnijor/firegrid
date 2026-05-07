# Firegrid Descriptor Package Boundary Spike

Date: 2026-05-06

Lane: Browser-safe descriptor/package boundary

Verdict: **viable with caveats**

## Scope

This spike asks whether Firegrid can introduce a browser-safe
`@firegrid/descriptors` package so app shared modules can define operation,
event, and projection descriptors without importing:

- `@firegrid/substrate`;
- `@firegrid/runtime`;
- Durable Streams server/client packages;
- `node:*`, `crypto`, `fs`, or process-local runtime machinery.

This is a research artifact only. It proposes no production code change.

## Sources Read

- `HANDOFF.md`
- `docs/replatforming/README.md`
- `/private/tmp/firegrid-runtime-ergonomics-sdd/docs/proposals/SDD_FIREGRID_RUNTIME_ERGONOMICS.md`
- `packages/client/README.md`
- `packages/runtime/README.md`
- `packages/substrate/README.md`
- `packages/client/package.json`
- `packages/runtime/package.json`
- `packages/substrate/package.json`
- `packages/client/src/index.ts`
- `packages/client/src/event-streams-public.ts`
- `packages/client/src/event-streams.ts`
- `packages/client/src/operations.ts`
- `packages/client/src/projection-query.ts`
- `packages/substrate/src/index.ts`
- `packages/substrate/src/descriptors/index.ts`
- `packages/substrate/src/protocol/descriptors/operation.ts`
- `packages/substrate/src/protocol/descriptors/event-stream.ts`
- `packages/substrate/src/protocol/descriptors/append.ts`
- `packages/substrate/src/protocol/descriptors/codec.ts`
- `packages/substrate/src/event-plane/index.ts`
- `packages/substrate/src/event-plane/define.ts`
- `packages/substrate/src/event-plane/layer.ts`
- `packages/substrate/src/id-gen.ts`
- `features/firegrid/firegrid-platform-invariants.feature.yaml`
- `features/firegrid/firegrid-client-api.feature.yaml`
- `features/firegrid/firegrid-operation-messaging.feature.yaml`
- `features/firegrid/firegrid-event-streams.feature.yaml`
- `features/firegrid/firegrid-client-projection-api.feature.yaml`
- `features/firegrid/firegrid-projection-query.feature.yaml`
- `features/firegrid/client-event-plane-registration.feature.yaml`
- `docs/replatforming/DECISIONS.md`
- `docs/replatforming/OWNERSHIP.md`
- `docs/replatforming/GUARDRAILS.md`

## ACID Anchors

- `firegrid-platform-invariants.LOCALITY.1`: browser, edge, and Cloudflare Worker code does not import `@firegrid/runtime`.
- `firegrid-platform-invariants.LOCALITY.2`: `@firegrid/client` is browser- and edge-safe and does not pull Node-only modules through client exports.
- `firegrid-platform-invariants.LOCALITY.3`: no `@firegrid/client` to `@firegrid/runtime` package edge.
- `firegrid-platform-invariants.LOCALITY.4`: no `@firegrid/runtime` to `@firegrid/client` package edge.
- `firegrid-platform-invariants.LOCALITY.5`: `@firegrid/substrate` exposes curated root plus approved subpaths only; kernel is not app-facing.
- `firegrid-platform-invariants.AUTHORITY.7`: browser/app code does not expose claim, completion, terminal, RunWait authoring, subscriber registration, runtime handler registration, or pending-completion authority.
- `firegrid-client-api.CLIENT_SURFACE.3`: operation and EventStream descriptors are browser-safe contract values with schemas and stable names only.
- `firegrid-client-api.AUTHORITY_BOUNDARY.5`: browser-safe client subpaths do not import runtime, kernel, Node-only runtime modules, or lab-only modules.
- `firegrid-operation-messaging.OPERATIONS.1`: operation contracts are browser-safe descriptor values with name/input/output schema.
- `firegrid-operation-messaging.OPERATIONS.2`: operation contracts contain no runtime handler, runtime dependency, Durable Streams URL, substrate writer, or mutable registration state.
- `firegrid-operation-messaging.OPERATIONS.4`: operation contract modules are the preferred v1 sharing mechanism between clients and runtimes.
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.2`: EventStream definitions are descriptor values containing name and event schema.
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.3`: EventStream definitions contain no client instance, runtime handler, Durable Streams URL, materializer, substrate writer, or mutable registry.
- `firegrid-event-streams.SCHEMA_OWNERSHIP.3`: EventStream descriptors are safe for client and runtime imports.
- `firegrid-projection-query.QUERY_HANDLES.1`: projection query handles are constructed from caller-owned descriptors plus explicit stream config, not raw StreamDB collections.
- `firegrid-projection-query.AUTHORITY_BOUNDARY.2`: projection query APIs do not expose raw StreamDB collections, Durable Streams State envelopes, kernel imports, or writer handles.
- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`: EventPlane is available through a documented non-kernel substrate import path for runtime composition.

## Current Descriptor Inventory

| Symbol / concept | Current package/file | Browser-safe today? | Notes |
| --- | --- | --- | --- |
| `Operation.define` | `packages/substrate/src/protocol/descriptors/operation.ts`; re-exported from `@firegrid/substrate`, `@firegrid/substrate/descriptors`, `@firegrid/client` | Yes by implementation; awkward by package | The core descriptor depends only on `effect` plus substrate row envelope constants from `rows.ts`. It carries no runtime handler, URL, writer, or registry. |
| `OperationDescriptor`, `OperationDefinition`, `Operation.Input/Output/Error` | same as `Operation.define` | Yes by implementation; awkward by package | These are exactly the shared app contract types that belong in a descriptor package. |
| `OperationHandle`, `OperationHandleId` | `packages/substrate/src/protocol/descriptors/operation.ts`; re-exported by substrate/client | Yes by implementation; should not be required for descriptor definition | This is a client/result handle, not a descriptor definition. It can remain in `@firegrid/client` or be re-exported from descriptors only if handle typing needs same package identity. |
| `OPERATION_ENVELOPE_TAG`, `OperationEnvelope`, `isOperationEnvelope` | `packages/substrate/src/protocol/descriptors/operation.ts` | Browser-safe by implementation; not app descriptor surface | Wire envelope helpers are substrate/client/runtime interop, not app-authored descriptors. |
| `EventStream.define` | `packages/substrate/src/protocol/descriptors/event-stream.ts`; re-exported from substrate/client | Conceptually yes; current module imports Durable Streams State | The descriptor itself is pure, but the file also exports envelope/state-row helpers and imports `@durable-streams/state`. Split required before moving. |
| `EventStreamDescriptor`, `EventStreamDefinition`, `EventStream.Event/EncodedEvent` | same as `EventStream.define` | Conceptually yes; current module imports Durable Streams State | These should move with pure EventStream definition after splitting helpers. |
| `EVENT_STREAM_ENVELOPE_TAG`, `EVENT_STREAM_ROW_TYPE`, `makeEventStreamEnvelope`, `makeEventStreamStateRow`, `eventStreamEnvelopeFromStateRow` | `packages/substrate/src/protocol/descriptors/event-stream.ts` | Browser-compatible, but imports Durable Streams State | These are wire/append helpers. They should stay in client/substrate internals or a separate non-primary wire subpath, not in the descriptor package root. |
| `decodeAtBoundary`, `encodeAtBoundary` | `packages/substrate/src/protocol/descriptors/codec.ts` | Yes | Schema encode/decode helpers are useful to client/runtime internals. They need not be public descriptor root exports. |
| `appendChange` | `packages/substrate/src/protocol/descriptors/append.ts` | Depends on target; imports Durable Streams State type | Writer helper, not descriptor surface. Keep out of descriptors root. |
| `EventPlane.define` | `packages/substrate/src/event-plane/define.ts`; exported from `@firegrid/substrate/event-plane` | Browser-compatible in narrow sense, but not pure descriptor | Imports `@durable-streams/state` types and `effect/Context`; returns Producer/Projection service tags. Good runtime composition surface, poor pure shared descriptor. |
| `EventPlane.layer` | `packages/substrate/src/event-plane/layer.ts` | No for browser/shared descriptor modules | Runtime/substrate layer; imports producer/projection machinery and config. Keep in `@firegrid/substrate/event-plane`. |
| `PlaneProducer`, `PlaneProjection`, `PlaneProjectionQuery`, errors | `packages/substrate/src/event-plane/*` | No for descriptor package root | Runtime/read-model services and query internals. Browser projection facade already wraps this from `@firegrid/client/projection-query`. |
| `defineDurableChannel`, `DurableChannel` | `packages/substrate/src/event-plane/durable-channel.ts` | No for descriptor package | Durable subscriber/channel primitives, out of scope for browser-safe shared descriptors and this spike. |
| `ProjectionCursor`, `ProjectionQueryReadError`, `ProjectionQueryClientLive`, `liveQuery`, `observe`, `until` | `packages/client/src/projection-query.ts` | Intended browser-safe | Query/read facade, not descriptor definition. It imports `@firegrid/substrate/event-plane` and `@durable-streams/state` types. Can stay in client unless a future descriptor package owns cursor identity. |
| `RunWait`, `ProjectionMatchTrigger`, `TriggerMatchers`, `Work`, `WorkClaim`, `Projection` | `packages/substrate/src/coordination/index.ts`; re-exported from substrate root | No for browser/shared descriptor modules | Server-side coordination and authority. Must not move to descriptors. |
| `Firegrid.handler`, `Firegrid.eventStream`, `Firegrid.composeRuntime` | `packages/runtime/src/runtime-api.ts` | No | Runtime-only registration/composition. Must stay runtime. |
| `FiregridClient`, `FiregridClientLive`, `EventStreamClientLive` | `packages/client/src/*` | Browser-safe client services, not pure descriptors | Client config includes stream URL and durable transport. Good browser app seam, not shared descriptor package. |
| `IdGen`, `IdGenLive` | `packages/substrate/src/id-gen.ts` | Browser-safe but not descriptor | Uses `globalThis.crypto.randomUUID`; fine for client internals, not needed for descriptor definition. |

## Import Boundary Table

| Symbol / concept | Current public import | Current package/file | Browser-safe? | Proposed package | Blockers / action |
| --- | --- | --- | --- | --- | --- |
| Operation descriptor definition | `@firegrid/client` or `@firegrid/substrate/descriptors` | `substrate/src/protocol/descriptors/operation.ts` | Yes | `@firegrid/descriptors` | Move pure `Operation` and types; avoid exporting operation envelope helpers from descriptor root. |
| EventStream descriptor definition | `@firegrid/client`, `@firegrid/client/event-streams`, or `@firegrid/substrate/descriptors` | `substrate/src/protocol/descriptors/event-stream.ts` | Conceptually yes; current file mixed | `@firegrid/descriptors` | Split pure `EventStream` from envelope/State Protocol helpers that import `@durable-streams/state`. |
| Operation handle type | `@firegrid/client` / `@firegrid/substrate/descriptors` | `substrate/src/protocol/descriptors/operation.ts` | Yes | probably `@firegrid/client`; optional re-export from descriptors | It is a client result handle, not needed to define descriptors. If moved, ensure no client authority leaks. |
| Operation/EventStream encode/decode helpers | not currently on client root; exported by substrate descriptors | `substrate/src/protocol/descriptors/codec.ts` | Yes | package-private or `@firegrid/descriptors/wire` | Keep root descriptor package schema-only; wire helpers can be internal or explicit advanced subpath. |
| Operation envelope constants | substrate descriptors | `substrate/src/protocol/descriptors/operation.ts` + `protocol/schema/rows.ts` | Yes | package-private or `@firegrid/descriptors/wire` | Needed by client/runtime interop, not by app shared modules. |
| EventStream envelope/state-row helpers | substrate descriptors | `substrate/src/protocol/descriptors/event-stream.ts` | Imports Durable Streams State | package-private or `@firegrid/descriptors/wire` | Do not expose from descriptor root; avoid dragging State Protocol helpers into shared app modules. |
| EventPlane app state descriptor | `@firegrid/substrate/event-plane` | `substrate/src/event-plane/define.ts` | Not pure | new pure `@firegrid/descriptors` plane/projection descriptor | Current `EventPlane.define` creates service tags; define smaller `PlaneDescriptor` / `ProjectionDescriptor` without producer/projection services. |
| EventPlane runtime layer | `@firegrid/substrate/event-plane` | `substrate/src/event-plane/layer.ts` | No | stay `@firegrid/substrate/event-plane` | Runtime/server composition surface. |
| Projection query cursor/errors | `@firegrid/client/projection-query` | `client/src/projection-query.ts` | Yes | stay client for now | Query-handle surface, not descriptor definition. May later re-export descriptor identity types if package split requires. |
| Projection query builder types | `@firegrid/client/projection-query` | `client/src/projection-query.ts` | Yes, but tied to EventPlane state types | stay client | Depends on EventPlane/query implementation; not minimal descriptor layer. |
| Runtime handler/materializer registration | `@firegrid/runtime` | `runtime/src/runtime-api.ts` | No | stay runtime | Runtime-only authority. |
| RunWait / Work / Claim / Projection services | `@firegrid/substrate` | `substrate/src/coordination/index.ts` | No | stay substrate | Server-side coordination/authority; forbidden for browser/shared descriptor modules. |
| Id generation | `@firegrid/substrate/id-gen` | `substrate/src/id-gen.ts` | Browser-safe | stay substrate/client internal | Not descriptor definition. |

## Exact Symbols To Move

Minimal `@firegrid/descriptors` root:

```ts
export {
  Operation,
  type OperationDescriptor,
  type OperationDefinition,
} from "./operation"

export {
  EventStream,
  type EventStreamDescriptor,
  type EventStreamDefinition,
} from "./event-stream"
```

The `Operation` and `EventStream` namespaces should keep their type helpers:

```ts
Operation.Input<Op>
Operation.Output<Op>
Operation.Error<Op>
Operation.EncodedInput<Op>
Operation.EncodedOutput<Op>
Operation.EncodedError<Op>

EventStream.Event<S>
EventStream.EncodedEvent<S>
```

For projection descriptors, do **not** move current `EventPlane.define` as-is.
Add a pure descriptor shape first:

```ts
export interface ProjectionDescriptor<Name extends string, State> {
  readonly _tag: "Projection"
  readonly name: Name
  readonly state: State
}

export const Projection = {
  define: <Name extends string, State>(spec: {
    readonly name: Name
    readonly state: State
  }): ProjectionDescriptor<Name, State> => Object.freeze({
    _tag: "Projection" as const,
    name: spec.name,
    state: spec.state,
  }),
}
```

If the product wants to model row-family state, the open decision is whether
`State` may be a `@durable-streams/state` `StateSchema` value in descriptor
modules or whether Firegrid needs its own Standard Schema-only collection
descriptor. To satisfy this spike's narrow boundary, the safer minimum is:

- descriptor package root depends only on `effect`;
- no direct dependency on `@durable-streams/client`;
- no direct dependency on `@durable-streams/server`;
- avoid `@durable-streams/state` in the descriptor root until the package
  decision explicitly allows State Protocol schemas as app descriptor input.

## Symbols That Should Stay Package-Private Or Out Of Descriptor Root

Keep out of `@firegrid/descriptors` root:

- `FiregridClient`, `FiregridClientLive`, `EventStreamClientLive`;
- `Firegrid.handler`, `Firegrid.eventStream`, `Firegrid.composeRuntime`, `run`;
- `EventPlane.layer`;
- `PlaneProducer`, `PlaneProjection`, `PlaneProjectionQuery`, projection service tags;
- `RunWait`, `RunWait.layer`, `RunWaitTools`, `ProjectionMatchTrigger`, `TriggerMatchers`;
- `Work`, `WorkClaim`, `WorkClaimLive`, `CurrentWorkContext`;
- `DurableChannel`, `defineDurableChannel`, durable delivery/terminal record types;
- `OPERATION_ENVELOPE_TAG`, `EVENT_STREAM_ENVELOPE_TAG`, `EVENT_STREAM_ROW_TYPE`;
- `makeEventStreamEnvelope`, `makeEventStreamStateRow`, `eventStreamEnvelopeFromStateRow`;
- `appendChange`;
- `substrateState`, `RunValue`, `CompletionValue`, `ClaimAttemptValue`;
- raw StreamDB, Durable Streams State envelopes, or Durable Streams writer handles.

Potential explicit non-root subpath, if needed:

```txt
@firegrid/descriptors/wire
```

That subpath could carry operation/EventStream envelope codecs used by
`@firegrid/client`, `@firegrid/runtime`, and `@firegrid/substrate`, but app
shared modules should import only `@firegrid/descriptors`.

## Current Public Imports That Force Too Much Into Shared App Code

1. `@firegrid/client` root is convenient for app code but not a pure descriptor
   package. Its root exports `Operation` and `EventStream`, but the source root
   imports `operations.ts`, which imports:
   - `@firegrid/substrate/descriptors`;
   - `@firegrid/substrate/id-gen`;
   - `@firegrid/substrate`;
   - `@durable-streams/client`;
   - `@durable-streams/state` types.

   This is acceptable for browser client modules per existing specs, but it is
   heavier than necessary for shared schema-only modules.

2. `@firegrid/substrate/descriptors` sounds descriptor-only, but its barrel
   exports:
   - pure operation definitions;
   - mixed EventStream descriptor/wire helpers;
   - append helper;
   - codec helper;
   - observability constants.

   Because `event-stream.ts` imports `@durable-streams/state`, this subpath is
   not the cleanest answer for "shared descriptors only."

3. `@firegrid/substrate/event-plane` is an approved app-facing subpath, but it
   is not a pure descriptor package. `EventPlane.define` returns Effect service
   tags and the same subpath exports runtime producer/projection and durable
   channel surfaces. Shared browser modules that only need projection descriptor
   identity should not need this package.

4. Current `apps/flamecast/src/shared/protocol.ts` imports descriptors from
   `@firegrid/client`. That is browser-safe, but it couples shared protocol
   modules to client transport package dependencies.

5. Current `apps/flamecast/src/shared/protocol.ts` also calls
   `crypto.randomUUID()` for ID helpers. Those helpers are not descriptor
   definitions and should live outside shared descriptor modules if the target
   is a zero-runtime descriptor package.

## Minimal Package Boundary

Package:

```json
{
  "name": "@firegrid/descriptors",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "dependencies": {
    "effect": "^3.18.0"
  }
}
```

Root surface:

```ts
import { EventStream, Operation, Projection } from "@firegrid/descriptors"
```

Permitted dependencies:

- `effect` for `Schema`, `Brand`, and typed schema extraction.

Forbidden dependencies for descriptor root:

- `@firegrid/substrate`;
- `@firegrid/runtime`;
- `@firegrid/client`;
- `@durable-streams/client`;
- `@durable-streams/server`;
- `node:*`;
- direct `crypto`, `fs`, path/url/process APIs;
- raw StreamDB / State Protocol row builders.

Optional later subpaths:

- `@firegrid/descriptors/wire`: envelope codecs/constants for package internals.
- `@firegrid/descriptors/state`: only if the team decides State Protocol
  collection schemas are descriptor-layer inputs.

## Migration Shape

1. Create `packages/descriptors` with pure `Operation` and `EventStream` modules
   copied from the current substrate definitions after removing envelope/wire
   coupling from the EventStream file.
2. Re-export those definitions from:
   - `@firegrid/client`;
   - `@firegrid/client/event-streams`;
   - `@firegrid/substrate`;
   - `@firegrid/substrate/descriptors`;
   - `@firegrid/runtime` examples as imports from descriptors where needed.
3. Move operation/EventStream envelope helpers to package-private substrate or
   explicit wire modules.
4. Add package export and pack smoke checks proving:
   - descriptor package imports do not include runtime/substrate/client;
   - descriptor package source has no Durable Streams client/server imports;
   - app shared module can define operation/event descriptors from packed
     `@firegrid/descriptors`;
   - client/runtime consumers can still use the same descriptor values.
5. Decide projection descriptor shape separately from existing
   `EventPlane.define`. Do not move EventPlane producer/projection service tags
   into `@firegrid/descriptors`.

## Caveats

1. Projection descriptors are the only non-trivial part. Current EventPlane
   definitions combine schema identity with Effect service tags. A clean
   descriptor package needs a smaller projection descriptor or a deliberate
   decision that State Protocol schemas are allowed in descriptor modules.
2. The current `@firegrid/client/projection-query` facade is browser-safe but
   not descriptor-only. It should remain a client read facade until the
   descriptor package decision lands.
3. `OperationHandle` can be moved or left in client. It is browser-safe, but
   not needed to define shared descriptors.
4. Existing package docs teach `Operation`/`EventStream` from `@firegrid/client`
   and `@firegrid/substrate`; those examples would need updating after a new
   descriptor package lands.

## Next Package Decision Unlocked

The smallest viable decision is:

> Add `@firegrid/descriptors` with pure `Operation` and `EventStream`
> definitions now; defer projection descriptors until the team chooses between
> a pure Firegrid projection descriptor and a State Protocol-backed descriptor
> shape.

This unlocks stream-first apps to put shared protocol modules on:

```ts
import { EventStream, Operation } from "@firegrid/descriptors"
```

without dragging client transport, substrate coordination, runtime registration,
Durable Streams client/server, or Node/process-local machinery into shared app
code.

## Commands Run

```sh
sed -n '1,240p' .agents/skills/acai/SKILL.md
sed -n '1,260p' HANDOFF.md
sed -n '1,240p' docs/replatforming/README.md
sed -n '1,300p' /private/tmp/firegrid-runtime-ergonomics-sdd/docs/proposals/SDD_FIREGRID_RUNTIME_ERGONOMICS.md
sed -n '300,760p' /private/tmp/firegrid-runtime-ergonomics-sdd/docs/proposals/SDD_FIREGRID_RUNTIME_ERGONOMICS.md
sed -n '1,260p' packages/client/README.md
sed -n '1,260p' packages/runtime/README.md
sed -n '1,260p' packages/substrate/README.md
sed -n '1,220p' packages/client/src/index.ts
sed -n '1,240p' packages/substrate/src/index.ts
sed -n '1,220p' packages/substrate/src/descriptors/index.ts
sed -n '1,220p' packages/runtime/src/index.ts
sed -n '1,220p' packages/client/package.json
sed -n '1,220p' packages/substrate/package.json
sed -n '1,220p' packages/runtime/package.json
sed -n '1,260p' packages/substrate/src/protocol/descriptors/operation.ts
sed -n '1,260p' packages/substrate/src/protocol/descriptors/event-stream.ts
sed -n '1,240p' packages/substrate/src/protocol/descriptors/append.ts
sed -n '1,220p' packages/substrate/src/protocol/descriptors/codec.ts
sed -n '1,300p' packages/substrate/src/event-plane/index.ts
sed -n '1,260p' packages/client/src/projection-query.ts
sed -n '1,240p' packages/client/src/event-streams-public.ts
sed -n '1,180p' packages/client/src/operations.ts
sed -n '1,220p' features/firegrid/firegrid-platform-invariants.feature.yaml
sed -n '1,220p' features/firegrid/firegrid-client-api.feature.yaml
sed -n '1,220p' features/firegrid/firegrid-operation-messaging.feature.yaml
sed -n '1,220p' features/firegrid/firegrid-event-streams.feature.yaml
sed -n '1,240p' features/firegrid/firegrid-client-projection-api.feature.yaml
sed -n '1,260p' features/firegrid/firegrid-projection-query.feature.yaml
sed -n '1,220p' features/firegrid/client-event-plane-registration.feature.yaml
rg --files features/firegrid features/flamecast docs/replatforming docs/proposals apps/flamecast
rg -n "Operation\\.define|EventStream\\.define|EventPlane\\.define|defineDurableChannel|ProjectionCursor|createStateSchema|OperationHandle|ProjectionMatchTrigger|RunWait|Firegrid\\.handler|Firegrid\\.eventStream" packages apps features docs/replatforming docs/proposals -g'*.ts' -g'*.tsx' -g'*.mts' -g'*.md' -g'*.yaml'
rg -n "@firegrid/substrate|@firegrid/runtime|@durable-streams|node:|crypto|fs|process" packages/client/src packages/substrate/src packages/runtime/src apps -g'*.ts' -g'*.tsx' -g'*.mts'
git status -sb
git rev-parse HEAD
git branch --show-current
git fetch origin
git worktree add -b agent1/firegrid-descriptor-boundary-spike .worktrees/firegrid-descriptor-boundary-spike origin/main
```

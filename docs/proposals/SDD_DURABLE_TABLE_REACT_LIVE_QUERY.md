# SDD: DurableTable React Live Query Bindings

**Status:** implementation-directed proposal.
**Baseline:** `DurableTable` is the single table/state primitive in
`effect-durable-operators`; runtime, client, protocol, and apps share
DurableTable declarations for cross-boundary durable state.

## Thesis

React applications should bind to durable Firegrid state through the same
DurableTable declarations used by the host and client packages. The UI should
not recreate control-plane APIs, shadow services, or polling facades just to
observe table state.

The clean shape is:

- server and browser share the DurableTable class declaration;
- each process acquires its own scoped table layer against the same durable
  stream URL;
- generated DurableTable writes remain the only mutation path;
- TanStack live query consumes read-only table collection views;
- React owns only the UI binding and Effect scope lifetime.

## Contract

`effect-durable-operators` exposes a read-only TanStack collection view on each
collection facade:

```ts
const table = yield* RuntimeOutputTable
table.events.collection
```

The collection view is intended for query engines and UI bindings:

```tsx
const output = useDurableTable(RuntimeOutputTable)

const events = useLiveQuery((q) =>
  q.from({ events: output.events.collection })
    .where(({ events }) => eq(events.contextId, contextId)),
  [contextId],
)
```

Mutations through the collection view fail loudly. Applications write through
DurableTable generated actions:

```ts
yield* table.events.upsert(row)
yield* table.events.delete(key)
```

## React Subpath

React bindings live under `effect-durable-operators/react`, not the root
package export. The root package remains framework-free.

The React provider accepts a caller-composed Effect Layer and the table tags
that should be made available to descendants:

```tsx
<DurableTableProvider
  layer={Layer.mergeAll(
    RuntimeControlPlaneTable.layer(controlOptions),
    RuntimeOutputTable.layer(outputOptions),
  )}
  tables={[RuntimeControlPlaneTable, RuntimeOutputTable]}
  fallback={null}
>
  <App />
</DurableTableProvider>
```

The provider:

- builds the layer once for the provider lifetime;
- keeps the Effect Scope open while mounted;
- closes the scope on unmount;
- exposes acquisition status;
- never acquires layers per component render or per row operation.

Consumers use:

```ts
const control = useDurableTable(RuntimeControlPlaneTable)
const { status, error } = useDurableTableProviderStatus()
```

## Firegrid Usage

Firegrid UI packages should prefer product-level hooks over ad hoc API routes,
but those hooks should remain thin wrappers around shared table declarations
and `@firegrid/client` intent APIs.

For Flamecast, the intended path is:

- use copied web assets/components for UI only;
- use `@firegrid/client` for launch/prompt/open intent APIs;
- use shared DurableTable declarations plus TanStack live queries for state
  observation;
- do not preserve the historical Flamecast session/control-plane HTTP API.

## Boundaries

- Do not expose React from `effect-durable-operators` root.
- Do not duplicate DurableTable declarations between client and runtime.
- Do not expose raw `createStreamDB` or `createStateSchema` to UI apps.
- Do not add app-local wrappers that only rename DurableTable
  `insert/upsert/get/query/subscribe`.
- Do not mutate TanStack collections directly; write through DurableTable
  generated actions so txid coordination and schema-owned primary-key encoding
  remain intact.

## ACIDs

Implements:

- `effect-durable-operators.TABLE.21`
- `effect-durable-operators.TABLE.22`
- `effect-durable-operators.REACT.1`
- `effect-durable-operators.REACT.2`
- `effect-durable-operators.REACT.3`
- `effect-durable-operators.REACT.4`
- `effect-durable-operators.BOUNDARIES.14`

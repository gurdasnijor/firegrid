# 004: Runtime Output To Materialize Session Queries

Date: 2026-05-09

Status: planned; follows tracer 002 and the Materialize smoke.

## Goal

Prove that the same runtime-output journal facts can feed a SQL-queryable
derived system:

```txt
runtime-output Durable Streams journal
  -> RuntimeOutputEventSourceLive
  -> IdentityEventProjectorLive
  -> MaterializeEventSinkLive
  -> Materialize views queried through Effect SQL
```

Durable Streams remains the source of truth. Materialize is a rebuildable
derived query surface.

## Ground Truth APIs

ACP stdio agents can provide the live process boundary. For the first pass,
`@agentclientprotocol/claude-agent-acp` is a practical target because it speaks
stdio NDJSON and keeps provider-specific machinery behind the process boundary.

Materialize is accessed through PostgreSQL wire protocol with `@effect/sql` and
`@effect/sql-pg`.

Firegrid's runtime package exposes:

```ts
import {
  MaterializeProvider,
  MaterializeProviderPgLive,
  MaterializeEventSinkLive,
  materializeRuntimeEventsQuery,
  runMaterializeRuntimeOutputProjection,
} from "@firegrid/runtime/data-plane/materialization"
```

## Shape

Provisioning and querying are provider responsibilities:

```ts
const materialize = yield* MaterializeProvider
const target = yield* materialize.provisionRuntimeOutputProjection({
  sourceName: "runtime_output",
  webhookBaseUrl: "http://localhost:6874",
})
```

Ingestion is expressed through the common event pipeline:

```ts
const summary = yield* runMaterializeRuntimeOutputProjection({
  runtimeOutputStreamUrl,
  contextId,
  target,
})
```

Queries stay on the Materialize provider/query side:

```ts
const rows = yield* materialize.query(
  materializeRuntimeEventsQuery(target, { contextId }),
)
```

## Non-Goals

- Materialize does not own runtime lifecycle.
- Materialize does not replace the runtime-output Durable Streams journal.
- The Materialize sink does not provision SQL objects; it only ingests into a
  pre-provisioned target.
- ACP parsing does not move into the runtime-output writer.

# 004: Runtime Output To Materialize Session Queries

Date: 2026-05-09

Status: planned; follows tracer 008 and tracer 011.

## Goal

Prove that the same runtime-output journal facts can feed a SQL-queryable
derived system through the common materialization strategy interface:

```txt
runtime-output Durable Streams journal
  -> ProjectionDefinition
  -> MaterializationStrategy
  -> Materialize-backed projection target
  -> Materialize views queried through Effect SQL
```

Durable Streams remains the source of truth. Materialize is a rebuildable
derived query surface.

## Ground Truth APIs

ACP stdio agents can provide the live process boundary. For the first pass,
`@agentclientprotocol/claude-agent-acp` is a practical target because it speaks
stdio NDJSON and keeps provider-specific machinery behind the process boundary.

Materialize is accessed through PostgreSQL wire protocol with `@effect/sql` and
`@effect/sql-pg`. Firegrid already has a provider/sink spike under
`packages/runtime/src/materialization/materialize/**` and
`packages/runtime/src/materialization/sinks/materialize/**`.

Firegrid's runtime package exposes:

```ts
import {
  createSessionProjectionDefinition,
  MaterializeProvider,
  makeMaterializeStrategy,
  type MaterializationStrategyService,
} from "@firegrid/runtime/materialization"
```

`makeMaterializeStrategy` is the target API shape. If implementation discovers
that a different name fits the current strategy surface better, prefer the
existing `MaterializationStrategyService` vocabulary over restoring legacy
`MaterializationEngine` or `materializeRuntimeOutputToSession` names.

## Shape

Provisioning and querying are provider responsibilities:

```ts
const materialize = yield* MaterializeProvider
const target = yield* materialize.provisionRuntimeOutputProjection({
  sourceName: "runtime_output",
  webhookBaseUrl: "http://localhost:6874",
})
```

Ingestion should be expressed through the common strategy API, not a bespoke
Materialize pipeline wrapper:

```ts
const projection = createSessionProjectionDefinition({
  runtimeOutputStreamUrl,
  contextId,
})

const strategy = yield* MaterializationStrategyService
const summary = yield* strategy.run(projection)
```

Queries stay on the Materialize provider/query side:

```ts
const rows = yield* materialize.query(
  materializeRuntimeEventsQuery(target, { contextId }),
)
```

The public query path for projections should also work through the common
strategy query API when the query is a projection query:

```ts
const messages = yield* strategy.query(
  projection.queries.messages({ contextId }),
)
```

## Write Scope

Primary:

```txt
packages/runtime/src/materialization/materialize/**
packages/runtime/src/materialization/sinks/materialize/**
packages/runtime/src/materialization/materialize-pipeline.ts
packages/runtime/src/materialization/index.ts
scenarios/firegrid/src/tracer-004*.test.ts
docs/tracers/004-claude-code-runtime-output-to-materialize-session.md
```

Avoid:

```txt
packages/runtime/src/runtime-host/**
packages/runtime/src/runtime-ingress/**
packages/runtime/src/runtime-operators/**
packages/runtime/src/required-action/**
docs/dependency-graph*.mmd
docs/architecture/current-architecture-alignment-review.md
```

Generated architecture graphs are intentionally out of scope for this tracer.

## Non-Goals

- Materialize does not own runtime lifecycle.
- Materialize does not replace the runtime-output Durable Streams journal.
- The Materialize sink does not provision SQL objects; it only ingests into a
  pre-provisioned target.
- ACP parsing does not move into the runtime-output writer.
- Do not reintroduce `MaterializationEngine`, `MaterializerSummary`, or legacy
  compatibility wrappers.

## Minimal Proof

The first scenario may assume a locally running Materialize instance and skip
when required connection configuration is absent. It should prove:

```txt
runtime-output Durable Streams facts
  -> session ProjectionDefinition
  -> Materialize strategy run
  -> common strategy query returns derived session/message rows
```

If a live Materialize scenario is too expensive for the first pass, add a
package-level integration test around the strategy adapter and document the
exact missing live scenario gate in this tracer file. Do not call the tracer
complete without a scenario or an explicit skipped-live scenario file.

Local emulator command for the live path:

```sh
docker run -d \
  -p 127.0.0.1:6874:6874 \
  -p 127.0.0.1:6875:6875 \
  -p 127.0.0.1:6876:6876 \
  -p 127.0.0.1:6877:6877 \
  materialize/materialized:v26.23.0
```

## References

- Materialize emulator install guide: <https://materialize.com/docs/get-started/install-materialize-emulator/>
- Materialize `CREATE SOURCE`: <https://materialize.com/docs/sql/create-source/>
- Materialize sources concept: <https://materialize.com/docs/concepts/sources/>
- Materialize `CREATE MATERIALIZED VIEW`: <https://materialize.com/docs/sql/create-materialized-view/>
- Materialize `SUBSCRIBE`: <https://materialize.com/docs/sql/subscribe/>
- Effect SQL package: <https://github.com/Effect-TS/effect/tree/main/packages/sql>
- Effect PostgreSQL package: <https://github.com/Effect-TS/effect/tree/main/packages/sql-pg>
- ACP Claude stdio agent candidate: <https://github.com/agentclientprotocol/claude-agent-acp>
- ACP TypeScript stream reference: <https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/stream.ts>

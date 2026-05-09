# 004: ACP Stdio Runtime Output To Materialize Session

Date: 2026-05-08

Status: planned; parallel spike after the Materialize provider smoke.

Substrate:

- runtime: real ACP stdio agent launched through the local process sandbox,
  starting with `claude-acp`;
- source of truth: Durable Streams runtime-output data-plane journal;
- query engine: Materialize as a pluggable derived materialization engine;
- query surface: PostgreSQL wire protocol through `@effect/sql` and
  `@effect/sql-pg`.

This tracer runs in parallel with
[003: Runtime Events To Permission Workflow](./003-runtime-events-to-permission-workflow.md).
It is not a replacement for tracer 002's State Protocol materializer. It proves
that Firegrid can also project the same raw runtime-output facts into a SQL
engine for declarative endpoint queries.

## Goal

Prove the smallest real-agent path from:

```txt
launch an ACP stdio agent process from Firegrid
```

to:

```txt
raw ACP stdout NDJSON in Durable Streams
  -> ingested into Materialize
  -> session materialized view queryable with SELECT/SUBSCRIBE
```

The source stream remains the durable authority. Materialize is a derived,
rebuildable, provider-selected query engine.

## Spec Anchors

- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10`: the path starts
  with public Firegrid launch, runs the runtime workflow, and observes retained
  data-plane rows.
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.1`: stdout chunks are
  appended as raw durable runtime output events before downstream consumers
  observe provider content.
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5`: late consumers can
  read retained runtime-output events after the process exits.
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.2`: runtime
  output producers append raw Durable Streams journal facts, not State Protocol
  changes.
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.3`: downstream
  projections consume data-plane facts and may emit into their own projection
  systems.
- `firegrid-materialization-engines.ENGINE.1`: a materialization engine consumes
  accepted runtime-output facts and creates queryable derived projections.
- `firegrid-materialization-engines.MATERIALIZE.1`: the Materialize engine
  provisions SQL objects through the PostgreSQL wire protocol using Effect SQL.
- `firegrid-materialization-engines.MATERIALIZE.2`: the Materialize engine
  queries projection results through Effect SQL `SELECT`.
- `firegrid-materialization-engines.MATERIALIZE.3`: the Materialize engine
  exposes live result streams through Effect SQL `SUBSCRIBE`.
- `firegrid-materialization-engines.MATERIALIZE.4`: the first Materialize
  runtime-output projection uses a webhook JSON source for ingested runtime
  journal events.

## Ground Truth APIs

ACP registry entry:

```txt
id: claude-acp
package: @agentclientprotocol/claude-agent-acp@0.33.1
distribution: npx
```

`claude-agent-acp` runs as a stdio ACP server by default. Its entrypoint
redirects logs to stderr so stdout can carry ACP messages, keeps stdin open
while the ACP connection is active, and exits when the connection closes.

ACP TypeScript SDK stream boundary:

```ts
export type Stream = {
  writable: WritableStream
  readable: ReadableStream
}

export function ndJsonStream(
  output: WritableStream,
  input: ReadableStream,
): Stream
```

That is the preferred process boundary for this tracer: stdin/stdout NDJSON
messages, not provider-specific Claude Code `--print` stream-json.

Materialize local endpoints validated by psql:

```txt
SQL:      postgres://materialize@localhost:6875/materialize
Webhook:  http://localhost:6874/api/webhook/materialize/public/<source>
```

Runtime package exports available to the tracer:

```ts
import {
  MaterializationEngine,
  MaterializeMaterializationEnginePgLive,
  materializeRuntimeEventsQuery,
} from "@firegrid/runtime/data-plane/materialization/engines"
```

## Plane Boundary

```txt
Firegrid launch/control plane
  runtime context + workflow state

Firegrid data plane
  runtime-output Durable Streams journal
  RuntimeJournalEventSchema rows containing opaque ACP NDJSON lines

Materialize data-plane projection
  webhook source over copied runtime-output facts
  runtime_events SQL view
  session materialized view
```

The Materialize webhook receives copies of accepted runtime-output rows. It
does not replace Durable Streams as runtime truth and does not own process
lifecycle, workflow state, prompt delivery, or permission decisions. ACP parsing
belongs to downstream materializers or scenario-owned adapter code.

## Materialize Shape

Provision through Effect SQL PG:

```sql
CREATE SOURCE <source>
FROM WEBHOOK
BODY FORMAT JSON;

CREATE VIEW <source>_runtime_events AS
SELECT
  body->>'type' AS event_type,
  body->>'id' AS journal_id,
  body->'event'->>'contextId' AS context_id,
  (body->'event'->>'activityAttempt')::int AS activity_attempt,
  (body->'event'->>'sequence')::int AS sequence,
  body->'event'->>'receivedAt' AS received_at,
  body->'event'->>'raw' AS raw
FROM <source>
WHERE body->>'type' = 'firegrid.runtime.output.stdout';

CREATE MATERIALIZED VIEW <source>_sessions AS
SELECT
  ('session_' || context_id) AS session_id,
  context_id,
  activity_attempt,
  sequence,
  raw,
  received_at
FROM <source>_runtime_events;
```

The first session view may keep `raw` intact. If parsing ACP messages is cheap
and reliable, add derived columns for JSON-RPC method/id or a minimal session
message. Do not move ACP or Claude-specific parsing into the runtime-output
writer.

## Minimum Path

1. Use public `Firegrid.launch(...)` with a `local.jsonl(...)` command that
   starts `npx @agentclientprotocol/claude-agent-acp@0.33.1`.
2. Run `startRuntime(...)` with `LocalProcessSandboxProviderLive`.
3. Assert retained Durable Streams runtime-output contains ACP stdout rows.
4. Provision Materialize source, runtime-events view, and session materialized
   view through the Materialize materialization engine.
5. Copy retained runtime-output journal rows to the Materialize webhook source.
6. Query the session materialized view through Effect SQL `SELECT`.
7. Optionally open a `SUBSCRIBE` stream to prove the endpoint can become live.

## Parallel Risk Lane: Prompt Requests

The tracer should also explore prompt delivery through the same stdio boundary.
This is now in-scope as a small sandbox/provider extension if needed, because
ACP's normal transport is bidirectional NDJSON over stdin/stdout.

Target shape:

```txt
durable prompt request row
  -> ACP JSON-RPC request written to process stdin
  -> ACP stdout runtime-output journal rows
```

Acceptable first spike:

- add a generic stdin input path to the local process sandbox provider, using
  bytes/text/lines and no ACP vocabulary;
- scenario-owned ACP adapter code converts the durable prompt request into ACP
  NDJSON messages and passes those lines through the generic stdin field.

If full ACP session choreography is not feasible quickly, prove one JSON-RPC
round trip or document the exact missing ACP handshake/session request shape.

## Acceptance

1. The opt-in scenario is skipped by default unless local Claude and Materialize
   env flags are present.
2. The scenario launches real `claude-acp` through Firegrid's local process
   sandbox, not a mocked provider process.
3. Durable Streams receives raw runtime-output rows before Materialize sees
   them.
4. Materialize receives copied raw journal rows through a webhook source.
5. A Materialize materialized view exposes session-shaped rows queryable by
   `context_id`.
6. Query and subscribe helpers use Effect SQL / `@effect/sql-pg`.
7. Prompt-input delivery is either proven narrowly through ACP stdin or
   documented as the next ACP choreography gap.

## Non-Goals

- No broad Claude or ACP provider adapter.
- No Firegrid-native Claude/session taxonomy.
- No replacement of State Protocol materialization.
- No Materialize as source of truth.
- No default CI dependency on Claude auth or local Materialize ports.

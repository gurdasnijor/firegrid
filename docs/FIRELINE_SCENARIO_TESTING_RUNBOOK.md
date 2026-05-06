# Fireline Scenario Testing Runbook

Status: Draft
Product: Firegrid
Related: `docs/SDD_FIREGRID_FIRELINE_READINESS.md`, `docs/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md`, `firegrid-runtime-process.SCENARIOS.13`, `firegrid-runtime-process.SCENARIOS.14`, `firegrid-runtime-process.SCENARIOS.15`, `firegrid-runtime-process.SCENARIOS.16`, `firegrid-runtime-process.SCENARIOS.17`

This runbook is the manual smoke path for Fireline-shaped scenario validation.
It uses the `@firegrid/scenarios` runner that landed in FW0 and keeps Durable
Streams lifecycle outside Firegrid. Firegrid does not start a server, wrap the
Durable Streams CLI, dynamically load an app graph, or import `@firegrid/client`
for these checks.

The Fireline-shaped scenario commands are forward-compatible with the pending
scenario PRs:

- PR #67 adds `fireline-shaped`, `fireline-shaped-receiver`, and
  `fireline-shaped-receiver:self-test`.
- PR #69 adds `fireline-rejection`, `fireline-rejection-receiver`, and
  `fireline-rejection-receiver:self-test`.

Until those PRs land and are rebased onto the FW0 runner architecture, the
commands below document the intended operator flow but are not expected to be
available on `main`.

## Shared Setup

Start Durable Streams yourself in one terminal:

```sh
durable-streams-server dev
```

In every shell that writes, receives, or inspects the scenario stream:

```sh
export STREAM_BASE=http://localhost:4437/v1/stream
export STREAM_NAME=firegrid
export DURABLE_STREAMS_URL="$STREAM_BASE/$STREAM_NAME"
```

Create the stream once before emitting rows:

```sh
durable-stream create "$STREAM_NAME" --json
```

The scenario runner uses the same command shape for every scenario:

```sh
pnpm --silent --filter @firegrid/scenarios run <scenario-name>
pnpm --filter @firegrid/scenarios run <receiver-name> -- \
  --stream-url "$DURABLE_STREAMS_URL"
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Emitters write newline-delimited JSON to stdout. Pipe each row into the Durable
Streams CLI:

```sh
pnpm --silent --filter @firegrid/scenarios run <scenario-name> \
  | while IFS= read -r row; do
      durable-stream write "$STREAM_NAME" "$row" --json
    done
```

Receivers are app-owned runtime entrypoints that attach to the existing stream
with `run({ connection, runtime })`. They are long-running processes; stop the
receiver after inspection shows the expected terminal state.

## FW2 Happy Path

Available after PR #67.

Terminal 1, start the receiver:

```sh
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid

pnpm --filter @firegrid/scenarios run fireline-shaped-receiver -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Terminal 2, emit the Fireline-shaped operation and matching app EventStream
row:

```sh
export STREAM_NAME=firegrid
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid

pnpm --silent --filter @firegrid/scenarios run fireline-shaped \
  | while IFS= read -r row; do
      durable-stream write "$STREAM_NAME" "$row" --json
    done
```

Terminal 2, inspect:

```sh
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Expected pass signals:

- `runs[]` contains `runId: "run-fireline-shaped-happy-path-cli-1"`.
- That run reaches `state: "completed"`.
- The completed result contains `requestId: "request-fireline-shaped-cli-1"`
  and `approved: true`.
- `completions[]` contains a `kind: "projection_match"` completion with
  `state: "resolved"`.
- `eventStreams[]` contains a `FirelineApprovalEvents` row whose event has
  `status: "approved"`.
- `counts.readyWork` is `0` after terminalization.

Expected fail signals:

- The receiver exits before interruption.
- The run stays `started` or `blocked` after repeated inspection.
- The projection-match completion is absent or remains `pending`.
- The run completes without the Fireline-shaped result above.
- `counts.readyWork` remains non-zero after the run terminalizes.

The focused smoke command is:

```sh
pnpm --filter @firegrid/scenarios run fireline-shaped-receiver:self-test
```

Implementation note: the happy-path receiver is the first Fireline scenario
using `Firegrid.composeRuntime(...)`. It still lists the projection-match
subscriber, Firegrid handler, `RunWait.layer(...)`, and
`triggerMatchersLayer(...)` explicitly; the helper only removes Layer wiring
boilerplate.

## FW3 Rejection Path

Available after PR #69.

Terminal 1, start the receiver:

```sh
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid

pnpm --filter @firegrid/scenarios run fireline-rejection-receiver -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Terminal 2, emit the Fireline-shaped operation and app-level rejection event:

```sh
export STREAM_NAME=firegrid
export DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid

pnpm --silent --filter @firegrid/scenarios run fireline-rejection \
  | while IFS= read -r row; do
      durable-stream write "$STREAM_NAME" "$row" --json
    done
```

Terminal 2, inspect:

```sh
pnpm --silent --filter @firegrid/scenarios run inspect -- \
  --stream-url "$DURABLE_STREAMS_URL"
```

Expected pass signals:

- `runs[]` contains `runId: "run-fireline-rejection-cli-1"`.
- That run reaches `state: "failed"`.
- The failed error contains `_tag: "FirelineRequestRejected"`,
  `requestId: "request-fireline-rejection-cli-1"`, and the app-level rejection
  reason/reviewer.
- `completions[]` contains a `kind: "projection_match"` completion with
  `state: "resolved"`. This is app-level rejection data delivered through a
  resolved match, not timeout/cancellation.
- `eventStreams[]` contains a `FirelineDecisionEvents` row whose event has
  `status: "rejected"`.
- `counts.readyWork` is `0` after terminalization.

Expected fail signals:

- The run reaches `completed`; rejection should be mapped by the app handler to
  the operation error schema.
- The run stays `started` or `blocked` after repeated inspection.
- The projection-match completion is absent or remains `pending`.
- The failed run error is missing `FirelineRequestRejected`.
- Any timeout/cancellation state appears; timeout resume is out of scope for
  FW3.

The focused smoke command is:

```sh
pnpm --filter @firegrid/scenarios run fireline-rejection-receiver:self-test
```

## Runner Rules

All Fireline-shaped scenario commands should keep using the FW0 runner
contract:

- add scenario definitions to `scenarios/firegrid/src/registry.ts`;
- route package scripts through `tsx src/cli.ts <name>`;
- let the runner own `--stream-url`, `DURABLE_STREAMS_URL`, NDJSON output,
  receiver dispatch, seed-row output, and self-test invocation;
- keep emitters declarative and schema-derived;
- keep receivers app-owned and composed through `run({ connection, runtime })`;
- keep durable wait primitives behind `RunWait`;
- do not document or import lower-level internal wait services or `*Live`
  Layers as the app-facing path.

## Current Main Fallback

Before PR #67/#69 land, the closest available runner smoke checks on `main`
are:

```sh
pnpm --filter @firegrid/scenarios run wait-for-receiver:self-test
pnpm --filter @firegrid/scenarios run failing-operation-receiver:self-test
pnpm --filter @firegrid/scenarios run sleep-receiver:self-test
pnpm --filter @firegrid/scenarios run scheduled-work-receiver:self-test
```

They do not prove the Fireline-shaped descriptors, but they exercise the same
runner-owned receiver/self-test path, projection-match resolution, typed
handler failure terminalization, `RunWait`, and read-only inspection surfaces
that FW2/FW3 compose.

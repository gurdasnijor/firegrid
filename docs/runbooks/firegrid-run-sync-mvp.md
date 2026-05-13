# Firegrid Run — Synchronous MVP

This runbook smokes the synchronous run entrypoint
(`firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.*`,
`firegrid-workflow-driven-runtime.VALIDATION.2`).

The entrypoint takes one local-process command after `--`, creates a
`RuntimeContext` row through the same control-plane table the runtime host
owns, calls `startRuntime(contextId)`, blocks until the runtime exits, and
exits with the runtime execution's exit code.

## Configuration

Configuration matches `pnpm firegrid:host`. There are no `--token` or
`--auth-token` flags; secrets come only through env-backed Effect Config
(`PHASE_2_SYNC_RUN.4`).

```sh
export DURABLE_STREAMS_BASE_URL="https://api.electric-sql.cloud/v1/stream/<service>"
export FIREGRID_RUNTIME_NAMESPACE="firegrid-run-smoke-$(date +%s)"
export FIREGRID_DURABLE_STREAMS_TOKEN="<from 1Password / Electric Cloud>"
export FIREGRID_RUNTIME_INPUT_ENABLED="false"
```

Or copy the root `.env.example` to `.env`, fill it in, and use
`pnpm firegrid:run:env` instead of `pnpm firegrid:run`.

## Smoke Command

```sh
pnpm firegrid:run -- node -e 'console.log(JSON.stringify({hello:"firegrid"}))'
```

Expected:

- a `RuntimeContext` row is upserted with `createdBy: "firegrid-run"`
- `startRuntime` runs the local-process command, the JSONL line lands in
  `RuntimeOutputTable.events`, the `runs` row reaches `exited`, and the
  process exits with the child's exit code (`0` for the example)
- the entrypoint blocks until that durable evidence is recorded

To inspect afterward, run a separate Firegrid client read against the same
namespace and look up the printed `contextId`.

## Failure Modes

- Missing `--`: usage error, exit `2`.
- Empty argv after `--`: usage error, exit `2`.
- Pre-`--` argv: usage error, exit `2`. The MVP intentionally does not accept
  flags before `--`; configure the host through env.
- Durable Streams unavailable / auth missing: the layer acquisition fails and
  the entrypoint exits `1` with the cause printed to stderr. No `RuntimeContext`
  row is written in that case.

## Coordination With Phase 1

This entrypoint calls the existing `startRuntime` API. When Coding Agent's
Phase 1 PR lands and `startRuntime(contextId)` delegates to
`RuntimeContextWorkflow`, this entrypoint automatically picks up the
workflow-backed implementation — no edits required here.

## Out Of Scope

- `HostWorkflow`, `DurableClaim`, `DurableKeyedMutex`,
  `DurableTable.insertIfAbsent`.
- Terminal stdin/stdout passthrough to the child process. The Phase 2 MVP
  exercises the substrate paths; output evidence lives in
  `RuntimeOutputTable`, not in the entrypoint's own stdio.
- Per-context flag parsing beyond the `--` separator.

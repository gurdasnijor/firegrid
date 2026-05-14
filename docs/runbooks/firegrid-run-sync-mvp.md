# Firegrid Run - Synchronous MVP

This runbook smokes the synchronous run entrypoint
(`firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.*`,
`firegrid-workflow-driven-runtime.VALIDATION.2`).

The entrypoint takes one local-process command after `--`, creates a
`RuntimeContext` row through the same control-plane table the runtime host
owns, calls `startRuntime(contextId)`, blocks until the runtime exits, and
exits with the runtime execution's exit code.

The production-shaped tracer for this path is:

```sh
pnpm --filter @firegrid/scenario-firegrid exec vitest run src/tracer-019-sync-run.test.ts
```

That scenario starts a local Durable Streams test server, invokes the root
`pnpm firegrid:run` script, and then reads retained durable rows to prove the
context, ingress, run, and output evidence.

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

## Local Smoke Command

The scenario-owned local smoke covers the full Tracer B path:

```sh
pnpm --filter @firegrid/scenario-firegrid exec vitest run src/tracer-019-sync-run.test.ts
```

It invokes the production root command with this shape:

```sh
pnpm firegrid:run \
  --cwd "$TMP_WORKDIR" \
  --prompt "$PROMPT_TEXT" \
  --secret-env CHILD_MARKER_SECRET=FIREGRID_TRACER_PARENT_SECRET \
  -- \
  node --input-type=module -e "$PROBE_AGENT"
```

Expected durable evidence:

- a `RuntimeContext` row is upserted with `createdBy: "firegrid-run"`
- `RuntimeContext.runtime.config.cwd` equals the supplied `--cwd`
- `RuntimeContext.runtime.config.envBindings` contains only
  `{ name: "CHILD_MARKER_SECRET", ref: "env:FIREGRID_TRACER_PARENT_SECRET" }`
- one `RuntimeIngressTable.inputs` row is appended before `startRuntime`, with
  `kind: "message"`, `authoredBy: "client"`, `status: "sequenced"`, and the
  prompt payload
- `RuntimeControlPlaneTable.runs` contains `started` and `exited` rows for the
  context
- `RuntimeOutputTable.events` contains the child probe output from stdout
- the root command exits with the child exit code

The child probe prints only SHA-256 digests for prompt and env checks. Firegrid
does not write resolved secret values into durable config or run evidence. Child
stdout/stderr are still untrusted output and are journaled verbatim; a child that
prints its own secret can leak it.

## Minimal Manual Command

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

## Electric Cloud Smoke

The Electric Cloud smoke is opt-in and uses the same `pnpm firegrid:run` command
shape as the local scenario. It does not add Electric-specific runtime-host code.

Required env:

```sh
export FIREGRID_ELECTRIC_SMOKE=1
export DURABLE_STREAMS_BASE_URL="https://api.electric-sql.cloud/v1/stream/<service>"
export FIREGRID_DURABLE_STREAMS_TOKEN="<from 1Password / Electric Cloud>"
export FIREGRID_TRACER_PARENT_SECRET="non-production-marker-value"
```

Namespace options:

```sh
# Fresh namespace for repeatable local development.
unset FIREGRID_ELECTRIC_SMOKE_NAMESPACE

# Or stable namespace for retained-state inspection in Electric Cloud.
export FIREGRID_ELECTRIC_SMOKE_NAMESPACE="tracer-019-sync-run-stable"
```

Run:

```sh
pnpm --filter @firegrid/scenario-firegrid exec vitest run src/tracer-019-sync-run.test.ts
```

When `FIREGRID_ELECTRIC_SMOKE` is not `1`, or the Electric service URL/token are
not present, the Electric scenario is skipped. The local smoke still runs.

Manual Electric command shape:

```sh
pnpm firegrid:run:env \
  --cwd "$PWD" \
  --prompt "electric sync smoke" \
  --secret-env CHILD_MARKER_SECRET=FIREGRID_TRACER_PARENT_SECRET \
  -- \
  node --input-type=module -e 'console.log(JSON.stringify({type:"manual-electric-smoke"}))'
```

Do not pass raw token or secret values as CLI flags. Use
`FIREGRID_DURABLE_STREAMS_TOKEN` for the Durable Streams token and
`--secret-env CHILD_ENV=PARENT_ENV` for child env binding authorization.

## Failure Modes

- Missing `--`: usage error, exit `2`.
- Empty argv after `--`: usage error, exit `2`.
- Unsupported pre-`--` argv: usage error, exit `2`. Supported sync-run flags are
  `--cwd`, `--prompt`, and `--secret-env`.
- Durable Streams unavailable / auth missing: the layer acquisition fails and
  the entrypoint exits `1` with the cause printed to stderr. No `RuntimeContext`
  row is written in that case.
- Invalid `--secret-env`: usage error, exit `2`. Both sides of
  `CHILD_ENV=PARENT_ENV` must be env-var names, never literal values.

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

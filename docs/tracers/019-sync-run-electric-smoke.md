# 019 B/C: Sync-Run And Electric Smoke

Tracer 019 B/C proves that the synchronous runner is a production-shaped path,
not a scenario-only composition root.

The smoke starts at:

```sh
pnpm firegrid:run --cwd <path> --prompt <text> --secret-env CHILD=HOST -- <agent>
```

It proves:

- `firegrid:run` creates the `RuntimeContext` row;
- `--prompt` writes a `RuntimeIngressTable.inputs` row before `startRuntime`;
- the runtime workflow path starts the local-process provider;
- child stdout is retained in `RuntimeOutputTable`;
- child exit code is propagated to the root command;
- env binding values do not traverse durable rows;
- unrelated host-only env vars are not inherited by the child;
- the Electric Cloud variant is opt-in and credential-gated.

Run the local smoke:

```sh
pnpm smoke:firegrid-run
```

Run the Electric-gated variant by setting:

```sh
export FIREGRID_ELECTRIC_SMOKE=1
export DURABLE_STREAMS_BASE_URL="https://api.electric-sql.cloud/v1/stream/<service>"
export FIREGRID_DURABLE_STREAMS_TOKEN="<token>"
```

Then run the same smoke command. Without those env vars, the local smoke runs
and the Electric case is skipped.

Primary references:

- [Firegrid Run - Synchronous MVP](../runbooks/firegrid-run-sync-mvp.md)
- [Runtime Environment Boundary](../architecture/runtime-env-boundary.md)
- [019: Workflow-Driven Runtime Next Wave](./019-workflow-driven-runtime-next-wave.md)

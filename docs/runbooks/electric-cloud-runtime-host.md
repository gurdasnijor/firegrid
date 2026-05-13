# Electric Cloud Runtime Host

This runbook smokes the root Firegrid host against Electric Cloud Durable
Streams. The host uses environment variables only; there is no token or stream
URL flag.

```sh
export DURABLE_STREAMS_BASE_URL="https://api.electric-sql.cloud/v1/stream/svc-supposed-penguin-8p1omx0k5u"
export FIREGRID_RUNTIME_NAMESPACE="firegrid-smoke-$(date +%s)"
export FIREGRID_RUNTIME_INPUT_ENABLED="false"
export FIREGRID_DURABLE_STREAMS_TOKEN="<from 1Password / Electric Cloud>"

pnpm firegrid:host
```

Or copy the root `.env.example` to `.env`, set a smoke namespace and token, and
run:

```sh
pnpm firegrid:host:env
```

Expected result: stream creation succeeds or reports already-exists internally,
all runtime and workflow DurableTable layers acquire, and the process remains
running until Ctrl-C.

The `firegrid-smoke-$(date +%s)` namespace pattern is for one-time smoke
tests. Production deployments use a stable namespace tied to the environment so
retained state survives restarts.

After a successful smoke, run the same command again with the same namespace.
The second run should acquire the same streams idempotently and then remain
running until Ctrl-C.

Shutdown is the normal Effect runtime path: `firegridHostProgram` parks on
`Effect.never`, and `NodeRuntime.runMain` interrupts it on SIGINT or SIGTERM.
The interruption releases the runtime and workflow Layer scopes, which closes
the underlying DurableTable resources. Do not add a separate signal handler for
this flow.

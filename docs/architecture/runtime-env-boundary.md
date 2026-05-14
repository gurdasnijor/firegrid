# Runtime Environment Boundary

Firegrid treats the host process environment as runtime authority, not as a
default child-process environment. This matters for local agents and Electric
Cloud credentials.

## Host-Only Values

These values configure the Firegrid host or synchronous runner:

```sh
DURABLE_STREAMS_BASE_URL
FIREGRID_RUNTIME_NAMESPACE
FIREGRID_RUNTIME_INPUT_ENABLED
FIREGRID_DURABLE_STREAMS_TOKEN
```

`FIREGRID_DURABLE_STREAMS_TOKEN` is used only to construct Durable Streams
Authorization headers. It is not passed to launched agents unless the operator
explicitly authorizes that binding.

## Child Environment

The local-process provider builds a child env from:

1. a minimal process baseline, such as `PATH`;
2. provider-level `SandboxConfig.envVars`;
3. command-level `SandboxCommand.envVars`.

It does not inherit unrelated host process env vars by default.

For `pnpm firegrid:run`, command-level env vars come from `--secret-env`
bindings:

```sh
pnpm firegrid:run \
  --secret-env CHILD_API_KEY=PARENT_API_KEY \
  -- \
  node agent.mjs
```

The flag authorizes an exact child/host pair. Both sides are env-var names, not
secret values. The durable `RuntimeContext` row stores only:

```ts
{ name: "CHILD_API_KEY", ref: "env:PARENT_API_KEY" }
```

The host resolves `PARENT_API_KEY` at spawn time and presents the value to the
child as `CHILD_API_KEY`.

## Durable Evidence

Secret values are not stored in durable config, run evidence, or ingress rows by
Firegrid. Runtime stdout/stderr are different: they are child-controlled output
and are journaled verbatim to `RuntimeOutputTable`. A child process can leak a
secret by printing it.

## Validation

The Tracer 019 smoke proves this boundary:

```sh
pnpm smoke:firegrid-run
```

It fails if the child can read host-only `FIREGRID_TRACER_PARENT_SECRET`
directly, still requires the explicitly bound child secret, and in Electric mode
also fails if `FIREGRID_DURABLE_STREAMS_TOKEN` reaches the launched agent.

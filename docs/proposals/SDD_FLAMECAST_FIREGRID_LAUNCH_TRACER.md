# SDD: Flamecast Firegrid Launch Tracer

Date: 2026-05-07

Status: Tracer bullet started, backed by
`flamecast-firegrid-launch-tracer.*` and
`firegrid-durable-launch-runtime-operator.*`

## Purpose

This tracer bullet validates the smallest useful bridge between Firegrid's
durable launch operator and a clean-room Flamecast runtime.

The goal is not to port legacy Flamecast. The goal is to prove that Flamecast
can describe an agent runtime as durable launch data:

```txt
Flamecast appends Firegrid launch row
Firegrid starts disposable runtime process
Firegrid injects declared plane bindings
runtime appends Flamecast-owned provider wire rows to session plane
Firegrid records process lifecycle facts
Flamecast materializes provider/session state from durable rows
```

## Firegrid Side

The first executable tracer lives in `@firegrid/runtime` and proves:

- launch is durable data on a launch stream;
- the launched process is a local command started through the runtime launcher;
- the session plane is a separate Durable Stream;
- the process receives the session stream URL only through declared bindings;
- the process appends a provider-wire row to that session stream;
- Firegrid records `started`, `ready`, and `exited` lifecycle facts;
- Firegrid does not interpret the provider-wire row as a product message.

This covers:

- `firegrid-durable-launch-runtime-operator.PLANES.1`
- `firegrid-durable-launch-runtime-operator.PLANES.5`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7`

## Flamecast Side

Flamecast needs to supply product-owned definitions, not runtime plumbing.

### Provider Wire Rows

Flamecast defines the raw rows emitted by launched providers. For the tracer,
one row is enough:

```ts
const FlamecastProviderReady = Schema.Struct({
  type: Schema.Literal("flamecast.provider.ready"),
  launchId: Schema.String,
  sessionId: Schema.String,
  provider: Schema.String,
  text: Schema.String,
})
```

Later provider adapters can emit richer rows for Anthropic Managed Agents,
Claude ACP, Codex SDK, Cursor, Devin, or another provider. Firegrid should keep
those rows durable and opaque unless a Flamecast materializer maps them.

### Runtime Target

Flamecast defines the target per provider. A local stdio ACP provider could be:

```ts
const target = {
  kind: "command",
  spec: {
    argv: ["npx", "-y", "claude-agent-acp"],
    protocol: "acp-stdio",
  },
  readiness: {
    stream: "provider-wire",
    rowType: "flamecast.provider.ready",
    predicateRef: "flamecast-provider-ready-v1",
  },
  rebuild: {
    inputs: ["provider-wire"],
    strategy: "session-load",
    entrypointRef: "flamecast-provider-rebuild-v1",
  },
}
```

For a remote hosted provider such as Cursor or Devin, the target would likely be
a Flamecast-owned adapter process that talks to the remote provider and writes
provider wire rows back to the session plane.

### Planes

Flamecast supplies concrete plane refs:

```ts
const planes = {
  session: {
    "provider-wire": {
      kind: "stream",
      role: "events",
      streamUrl: providerWireStreamUrl,
    },
  },
  diagnostics: {
    logs: {
      kind: "stream",
      role: "diagnostics",
      streamUrl: diagnosticsStreamUrl,
    },
  },
  execution: {
    "agent-process": {
      kind: "local-process",
    },
    workspace: {
      kind: "remote-sandbox",
      provider: "daytona",
      ref: "sandbox:daytona:abc",
    },
  },
  resources: {
    workspace: {
      kind: "filesystem-mount",
      ref: "volume:workspace",
      mountPath: "/workspace",
    },
    anthropic: {
      kind: "secret",
      ref: "secret:anthropic-api-key",
    },
  },
}
```

Firegrid carries these as opaque capabilities and materialization facts.
Flamecast owns what they mean for a provider.

### Bindings

Bindings map plane refs into the runtime process:

```ts
const bindings = [
  {
    kind: "env",
    name: "FLAMECAST_PROVIDER_WIRE_STREAM_URL",
    from: { plane: "session", name: "provider-wire", field: "streamUrl" },
  },
  {
    kind: "mount",
    name: "workspace",
    from: { plane: "resources", name: "workspace", field: "mountPath" },
  },
]
```

The tracer implements the env-binding path first. Mount and stdio bindings are
next because they exercise remote filesystem and ACP-style launch shapes.

### Materializer

Flamecast defines a pure fold from provider wire rows into product state:

```ts
const FlamecastProviderWireMaterializer = Materializer.define({
  name: "flamecast.provider-wire",
  version: "tracer-1",
  inputs: ["provider-wire"],
  output: "flamecast-session",
  fold: ({ row, emit }) => {
    if (row.type === "flamecast.provider.ready") {
      emit.session({
        sessionId: row.sessionId,
        status: "running",
        updatedAt: rowSeenAt(row),
      })
    }
  },
})
```

The materializer is product authority for Flamecast projection semantics.
Firegrid is only the durable substrate and runtime operator.

## Next Slice

The tracer should advance in this order:

1. Keep the current local command tracer passing.
2. Add a Flamecast-owned provider wire schema and materializer test in
   `apps/flamecast`.
3. Add a mount-binding test that proves a local ACP command can see a declared
   workspace path without Firegrid owning filesystem semantics.
4. Add a death/restart test where the second process attempt rebuilds from the
   provider-wire stream and the Flamecast materializer emits one continuous
   session projection.
5. Add an opt-in Val Town remote tracer that invokes a tiny remote TypeScript
   val, passes only stream references and secret references across the durable
   launch boundary, and verifies the remote val writes the same provider-wire
   readiness row as the local process tracer.
6. Replace the placeholder child command with a minimal ACP-over-stdio adapter
   or Claude SDK command once the pure tracer boundary is stable.

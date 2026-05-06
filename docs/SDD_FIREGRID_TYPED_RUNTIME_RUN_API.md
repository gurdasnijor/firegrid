# SDD: Firegrid Typed Runtime Run API

Status: Draft
Product: Firegrid
Related: `firegrid-runtime-process`, `firegrid-operation-messaging`, `durable-subscribers`, `claim-and-operator-authority`

## Summary

Firegrid runtime programs should use an app-owned, typed entrypoint. The shape is
similar to Restate's TypeScript model: application code defines typed services,
handlers, subscribers, or Layers, then calls a Firegrid `run(...)` API from its
own executable.

The Firegrid runtime should not discover application code by dynamically
importing module paths from environment variables. The app owns the process
entrypoint; Firegrid owns the runtime library that attaches to Durable Streams
and runs the caller-provided graph.

## Intended Shape

Application code should express its runtime graph as an Effect `Layer`. This
matches Effect's requirements-management model: Layers describe the dependency
graph of a program and keep service requirements explicit in the type system.

The core runtime graph type is:

```ts
type FiregridRuntimeGraph<E = never, R = never> =
  Layer.Layer<never, E, RuntimeContext | R>
```

The first type parameter is `never` because Firegrid runtime graph Layers are
installation Layers: they install scoped handlers, materializers, and subscriber
fibers rather than producing a public service for the caller. The third type
parameter includes `RuntimeContext` because Firegrid supplies process identity
and attached stream configuration at runtime. Any remaining `R` is the app's own
typed dependency requirement.

Application code should be able to compose that graph directly:

```ts
import { Config, Effect, Layer } from "effect"
import { Firegrid, run } from "@firegrid/runtime"
import { EchoOperation } from "./operations.ts"

const runtime = Layer.mergeAll(
  Firegrid.handler(EchoOperation, (input) =>
    Effect.succeed({
      message: input.message,
      length: input.message.length,
    }),
  ),
  Firegrid.subscribers.timer,
  Firegrid.subscribers.scheduledWork,
)

const program = Effect.gen(function* () {
  const streamUrl = yield* Config.string("DURABLE_STREAMS_URL")

  return yield* run({
    connection: { streamUrl },
    runtime,
  })
})
```

The exported API is top-level `run(...)` from `@firegrid/runtime`. The import
path already supplies the product noun; adding both `run` and `Firegrid.run`
would create two permanent surfaces for the same behavior.

## Boundary

The `run(...)` API is the boundary between app code and Firegrid runtime
execution:

1. The caller supplies one composed typed runtime graph:
   `Layer.Layer<never, E, RuntimeContext | R>`.
2. Firegrid supplies `RuntimeContext`, Durable Streams attachment, scoped
   execution, and shutdown behavior.
3. The API composes with existing `FiregridRuntimeBoot.attached({ runtime })`
   internals rather than replacing them.
4. The API does not import or provide `@firegrid/client`.
5. The API does not start Durable Streams or supervise child processes.

A minimal type shape:

```ts
interface FiregridRuntimeConnection {
  readonly streamUrl: string
}

interface RunOptions<E = never, R = never> {
  readonly connection: FiregridRuntimeConnection
  readonly runtime: Layer.Layer<never, E, RuntimeContext | R>
}

declare const run: <E, R>(
  options: RunOptions<E, R>,
) => Effect.Effect<never, E, Exclude<R, RuntimeContext>>
```

The exact implementation may choose an equivalent signature, but it must
preserve the important property: after Firegrid provides `RuntimeContext`, any
unprovided app requirements remain visible in the returned Effect type.

`connection` is intentionally an object instead of a top-level `streamUrl` so
the runtime boundary has room for durable-stream connection concerns such as
auth headers or retry policy without turning the API into a loose collection of
top-level options. App-specific services still flow through the Layer
requirements channel.

## Runtime Composition

`run(...)` does not install stock subscribers, materializers, or operator loops
implicitly. The runtime graph is the source of truth for what the process does.
Callers compose the stock pieces explicitly:

```ts
const runtime = Layer.mergeAll(
  Firegrid.defaults,
  Firegrid.handler(EchoOperation, echoHandler),
)
```

`Firegrid.defaults` may exist as an ergonomic Layer that groups standard
runtime subscribers and operator loops, but it remains an explicit Layer in the
application entrypoint rather than hidden behavior inside `run(...)`.

## Lifecycle And Failure Surface

`run(...)` is a long-running Effect and should not resolve successfully under
normal operation. It attaches to the configured durable stream, installs the
caller-provided graph in a scope, and runs until interrupted or until startup
or runtime installation fails.

Startup and configuration failures are fail-fast typed failures from the
returned Effect. A binary wrapper may map those failures to a logged diagnostic
and non-zero process exit through `NodeRuntime.runMain`, but the library API
does not hide them behind process exits or silent hangs.

Process-signal behavior belongs at the executable edge. The default binary
should interrupt the running scope on termination so runtime fibers finalize
through Effect scopes. Handler unit tests should test the Layers directly;
`run(...)` is for app-entrypoint and process integration tests.

## Multi-Stream Scope

The first API is one durable stream per `run(...)` call. Multi-stream deployment
can run multiple processes or compose a higher-level application entrypoint
later. This SDD does not add a multi-stream registry or control plane.

## Why Not Module Loading

An environment variable such as `FIREGRID_RUNTIME_MODULE=./runtime.ts` would
make the `firegrid` binary responsible for discovering and importing application
code. That is not the intended boundary.

Dynamic module loading has weaker type guarantees at the call site, depends on
current working directory and module-loader behavior, and moves app ownership
into a Firegrid-owned executable. It also conflicts with the intended
Restate-style mental model where app code visibly declares its services and
starts its own runtime process.

## Relationship To CLI Scenarios

`docs/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md` covers scenario emitters that
write schema-valid durable rows through the Durable Streams CLI. Those emitters
prove the input side.

When a scenario needs runtime execution, the runtime side should be an
app-owned TypeScript entrypoint that calls `run(...)` with the scenario's typed
runtime graph. It should not be a Firegrid binary flag that imports arbitrary
scenario modules.

## Non-Goals

1. Do not add `FIREGRID_RUNTIME_MODULE` or equivalent dynamic app-module
   loading to the `firegrid` binary.
2. Do not reintroduce `firegrid dev -- ...`, embedded Durable Streams launchers,
   or child-process environment injection.
3. Do not add a mutable runtime control plane or HTTP command endpoint.
4. Do not add scenario-specific runtime Layers inside `packages/runtime/src`.
5. Do not make the runtime package import `@firegrid/client`.

## First Slice

The first implementation slice should add only the typed `run(...)` API and
README-level example plus focused tests proving:

1. The caller-provided runtime graph is passed to attached boot.
2. `RuntimeContext` is supplied by Firegrid.
3. The runtime package root does not expose dynamic module-loading helpers.
4. The `firegrid` binary remains attached-only and does not discover app
   modules.
5. Stock runtime defaults are composed explicitly by the app entrypoint rather
   than installed implicitly by `run(...)`.

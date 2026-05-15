# SDD: Firegrid Schema Projection Contract

Status: Draft design contract

Related specs:

- `firegrid-schema-projection-contract`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-local-mcp-run`

## Mental Model

Firegrid should converge on one simple contract model:

```txt
Effect Schema catalog
  -> agent/tool definitions
  -> programmer client API
  -> CLI args/help
```

The schema catalog is the product contract. Tools, client APIs, docs, and CLI
commands are projections of that contract.

This is deliberately not:

```txt
agent tools -> client API
client API -> agent tools
new service layer -> everything
```

`packages/runtime/src/agent-tools/tools.ts` is one projection, not the source
of truth. `packages/client` should not import `Tool.make(...)` values. The CLI
should not invent a separate launch/control vocabulary. All surfaces should
name and validate the same operations through the same Effect Schemas and
metadata.

In other words:

```txt
schema -> [tool, client api, cli args]
```

The projections may have different user-facing names, but they must not define
different contracts.

## Shape

Prefer a small schema catalog over parallel package trees:

```txt
packages/protocol/src/schemas/
  sessions.ts
  wait.ts
  permissions.ts
  facts.ts          # later, only if needed
  index.ts
```

If this feels too granular during implementation, one file is acceptable:

```txt
packages/protocol/src/control/schema.ts
```

The important property is not the directory name. The important property is
that every user-facing operation has one schema-owned definition.

Existing files then project those schemas:

```txt
schema catalog entry
  -> packages/runtime/src/agent-tools/tools.ts
  -> packages/client/src/firegrid.ts / packages/client/src/sessions.ts
  -> src/run.ts

runtime effectful lowering
  -> packages/runtime/src/agent-tools/tool-use-to-effect.ts
  -> packages/client/src/firegrid.ts transport/backend calls
  -> src/run.ts command execution

```

The projection files should be easy to identify:

```txt
packages/runtime/src/agent-tools/
  tools.ts              # schema -> Tool.make(...)
  tool-use-to-effect.ts # tool call -> RuntimeContext/Ingress/WaitFor/etc.

packages/client/src/
  firegrid.ts           # schema -> user-facing client object
  sessions.ts           # schema -> sessions namespace helpers, if split helps

src/
  run.ts                # schema -> CLI args/help/defaults, then execution
```

Do not add `packages/runtime/src/session-control/` as part of the default
shape. Add a runtime service only if repeated implementation code proves a
real abstraction is needed.

This distinction is load-bearing:

- projection files are allowed to serialize schemas into a surface;
- lowering files are allowed to perform effects;
- schema files are not allowed to know about runtime lowering, MCP, HTTP
  transports, client environments, or CLI process execution.

## Schema Catalog

The schema catalog should expose operation-shaped schema entries, not only
loose input/output types. Projection metadata should prefer Effect Schema
annotations over parallel descriptor objects.

```ts
export const SessionCreateInputSchema = Schema.Struct({
  // fields
}).annotations({
  identifier: "firegrid.operation.session.create.input",
  title: "Create session input",
  description: "Create a RuntimeContext-backed session.",
  examples: [
    // examples
  ],
  [FiregridOperationAnnotationId]: {
    operation: "session.create",
    toolName: "session_new",
    clientName: "sessions.create",
    cliName: "sessions create",
  },
})
```

Effect's built-in Schema annotation keys already cover the common metadata
needed for serialization:

- `identifier`;
- `title`;
- `description`;
- `examples`;
- `default`;
- `jsonSchema`;
- `documentation`.

Firegrid should add a small custom annotation key only for projection metadata
that Effect does not already model, such as operation id and surface-specific
names.

This is not a request for a new framework. The exact helper type can evolve,
but each operation should make the following metadata discoverable from the
schema AST:

- stable operation id;
- optional projection names, such as tool name, client method name, and CLI
  command or option names;
- input schema;
- output schema;
- human-readable description;
- examples;
- notes for CLI or agent help only when needed.

The schema entry is the thing that projections serialize from:

- tool projection serializes the input/output schemas into Effect AI tool
  parameters, result schemas, descriptions, and examples;
- client projection serializes the same schemas into input validation and
  typed method signatures;
- CLI projection serializes the same schemas and metadata into command args,
  option parsing, validation, help, and examples.

Initial operation entries should cover:

- `session.create` projected as `session_new` and `sessions.create`;
- `session.prompt` projected as `session_prompt` and `sessions.prompt`;
- `session.status` projected as `sessions.status`;
- `session.cancel` projected as `session_cancel` and `sessions.cancel`;
- `session.close` projected as `session_close` and `sessions.close`;
- `wait.for` projected as `wait_for` and `wait.for`;
- `permission.respond` projected as `permissions.respond`.

Existing `@firegrid/protocol/agent-tools` schemas should be reused or
compatibility-exported from the catalog. Do not copy their shapes into a
second divergent schema family.

If an operation needs both input and output schemas, a tiny helper may pair
them for import ergonomics, but the helper should not become the metadata
source of truth. The metadata should remain on the schemas through annotations.

## Agent Tool Projection

`packages/runtime/src/agent-tools/tools.ts` should project catalog entries into
Effect AI tools:

```txt
SessionCreate.input  -> Tool.make("session_new").setParameters(...)
SessionCreate.output -> .setSuccess(...)
SessionCreate.description -> tool description
```

The runtime handler keeps using `tool-use-to-effect.ts` for lowering. The
near-term goal is to remove schema/description drift, not to introduce a new
runtime service abstraction.

`tool-use-to-effect.ts` remains the place where agent tool calls turn into
Firegrid primitives such as:

- `insertLocalRuntimeContext`;
- `appendRuntimeIngress`;
- `WaitFor.match`;
- `RuntimeObservationSourceNames`;
- host-authority checks;
- provider/capability execution where available.

## Client Projection

The published package remains one package:

```txt
@firegrid/client
```

It can expose namespaces and subpath exports, but it should not become many
tiny packages:

```ts
firegrid.sessions.create(...)
firegrid.sessions.prompt(...)
firegrid.sessions.status(...)
firegrid.sessions.cancel(...)
firegrid.sessions.close(...)
firegrid.wait.for(...)
firegrid.permissions.respond(...)
```

Client methods decode inputs through the same schema catalog. They do not
import `@effect/ai` `Tool` values, MCP server layers, or runtime-only handler
dependencies. The client is one projection of the schema catalog, not a
wrapper around the agent-tool catalog.

For durable RuntimeContext-backed work, the client should expose a session
facade that keeps low-level runtime identity and ingress details out of product
apps:

```ts
const session = yield* firegrid.sessions.createOrLoad({
  externalKey: { source: "linear", id: "LIN-123" },
  runtime: { provider: "local-process", config },
  createdBy: "dark-factory",
})

yield* session.prompt({
  idempotencyKey: "initial",
  payload,
})

yield* session.start()

const permission = yield* session.wait.forPermissionRequest({ timeoutMs })
yield* permission.respond({ decision })
```

This facade is still a projection over Firegrid primitives. It should hide
deterministic `RuntimeContext` identity, `RuntimeIngress` input id construction,
permission-response idempotency, and runtime-observation joins from callers.
Product apps may still own product facts and read models, but they should not
rebuild Firegrid session/ingress identity helpers.

`packages/client` remains runtime-source-free. If a facade method actively
starts a runtime, it must depend on a protocol-owned runtime-start
capability/service supplied by host/runtime composition. The client package must
not import `packages/runtime/src` or call `startRuntime` directly. Read and wait
helpers should use protocol-owned runtime observation source names rather than
runtime-host modules.

The client projection should use product-facing names. For example:

```txt
operation id: session.prompt
tool name:    session_prompt
client API:   firegrid.sessions.prompt(...)
```

## CLI Projection

The CLI can later project the same catalog into commands:

```txt
firegrid sessions create ...
firegrid sessions prompt <sessionId> ...
firegrid wait for ...
firegrid permissions respond ...
```

The current `firegrid run/start` launch surface remains valid. This SDD only
sets the contract rule: future CLI help, examples, parsing, and validation
should be driven by schema catalog metadata wherever practical.

`src/run.ts` should continue using `@effect/cli` for the command surface, but
the accepted values, validation, defaults, and examples should come from
schema-owned launch/control entries rather than private CLI-only types.

## Boundary Rules

- Schema catalog is source of truth for operation shapes and metadata.
- Agent tools are a projection, not the programmer API.
- Client APIs are a projection, not a separate contract.
- Runtime lowering stays in existing runtime modules until repeated projection
  code proves that a runtime service would remove real duplication.
- Runtime-host active execution is injected into client facades through a
  protocol-owned capability/service; `packages/client` does not import
  runtime-host source.
- Do not split `@firegrid/client` into multiple packages.
- Do not introduce a platform parent/child session hierarchy beyond
  `RuntimeContext` identity and explicit metadata.
- Dark-factory may depend on this facade for the first working app path because
  it prevents product code from reimplementing runtime identity and ingress
  details.

## First Implementation Slice

1. Add the schema catalog in `@firegrid/protocol`, initially by re-exporting
   or aliasing existing `@firegrid/protocol/agent-tools` schemas where they
   are already correct.
2. Update `packages/runtime/src/agent-tools/tools.ts` to read schemas,
   descriptions, and examples from catalog entries.
3. Add a small `@firegrid/client` projection over `session.prompt`,
   `wait.for`, and `permission.respond` first, because those lower directly to
   existing primitives.
4. Add tests proving the same schema object or catalog entry feeds both the
   tool projection and client projection.
5. Add examples showing one operation through both projections.

The next implementation slice should add the durable session facade described
above. Its `start` method should require the protocol runtime-start capability;
the package-boundary rule is more important than making `packages/client`
directly call runtime-host.

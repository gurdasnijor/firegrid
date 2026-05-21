# SDD: Firegrid Schema Projection Contract

Status: Draft design contract

Related specs:

- `firegrid-schema-projection-contract`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-local-mcp-run`

## Mental Model

Firegrid should converge on one simple contract model:

```txt
protocol operation catalog
  -> bindings
       -> agent tool binding
       -> TypeScript SDK binding
       -> CLI binding
       -> future REST / gRPC / JSON-RPC bindings
  -> execution
       -> shared operation execution where the substrate is actually common
```

The schema and channel catalog is the product contract. Tools, client APIs,
docs, CLI commands, and future transport adapters such as REST, gRPC, or
JSON-RPC are bindings of that contract. The bindings expose the same operation
constraints and semantic channel names to different touchpoints; execution
turns a validated operation or channel call into concrete Firegrid substrate
effects.

This is deliberately not:

```txt
agent tools -> client API
client API -> agent tools
new service layer -> everything
```

`packages/runtime/src/agent-tools/tools.ts` is one binding, not the source
of truth. `packages/client` should not import `Tool.make(...)` values. The CLI
should not invent a separate launch/control vocabulary. All surfaces should
name and validate the same operations through the same Effect Schemas and
metadata.

In other words:

```txt
schema/channel contract -> [tool binding, client binding, cli binding]
```

The bindings may have different user-facing names and transports, but they must
not define different contracts.

The package-level shape is:

| Binding | Target package | Projection |
| --- | --- | --- |
| Host/agent binding | `@firegrid/host-sdk` | Protocol operations to Effect AI `Tool`/`Toolkit`, route-scoped MCP exposure, host Layers, provider/webhook/agent adapter installation, and host-authority operation execution. |
| Client binding | `@firegrid/client-sdk` | Protocol operations to browser/app-safe TypeScript session APIs, snapshots, typed waits, and permission response helpers. |
| CLI binding | `@firegrid/cli` | Protocol operations to `@effect/cli` commands, flags, help, examples, local defaults, and Node-only process entrypoints. |
| Future transport bindings | app or adapter packages | Protocol operations to REST, gRPC, JSON-RPC, or other transport shapes. These adapters validate protocol schemas and delegate to client/host/runtime capabilities; they do not clone schemas or introduce a graph DSL. |

`@firegrid/runtime` is not a binding package. It owns the execution substrate
that bindings call into through explicit services and protocol schemas.

## Package-Boundary Convergence Target

Projection constraints should be enforced at package boundaries, not only by
review convention. The target graph is:

```text
@firegrid/protocol
  -> @firegrid/client-sdk
  -> @firegrid/agent-tools        # or equivalent MCP/agent projection package
  -> @firegrid/cli
  -> @firegrid/rest               # future
  -> @firegrid/grpc               # future
  -> @firegrid/jsonrpc            # future
  -> @firegrid/runtime
```

Projection packages are runtime/environment-specific adapters:

- `@firegrid/client-sdk`: browser/edge/app-safe client runtime;
- `@firegrid/agent-tools`: MCP/agent host runtime and Effect AI tool binding;
- `@firegrid/cli`: terminal/Node runtime;
- `@firegrid/rest`: HTTP server runtime;
- `@firegrid/grpc`: gRPC server runtime;
- `@firegrid/jsonrpc`: JSON-RPC server/runtime.

Each projection package may own transport glue, runtime/environment
dependencies, surface-specific names, auth/config parsing, help text,
serialization/deserialization, and ergonomic wrappers. It must not own
independent operation schemas, independent observation schemas, workflow
handles as public API, durable-table details as public API, or copied operation
catalogs.

The dependency rules are:

```text
projection package -> @firegrid/protocol
projection package -/-> another projection package
projection package -/-> @firegrid/runtime
@firegrid/runtime -> @firegrid/protocol
@firegrid/runtime -/-> projection packages
```

Server-side packages that need to execute work should depend on runtime through
explicit host/runtime composition packages, not by making the projection package
itself a runtime substrate owner. `@firegrid/host-sdk` is therefore not "the
projection package for everything"; it should be the host composition package
that wires runtime capabilities and selected projection adapters. Client,
agent, CLI, REST, gRPC, and JSON-RPC contracts must still project from protocol
rather than from host-sdk.

All projected surfaces should use one substrate interaction pattern:

```text
protocol operation / observation / channel contract
  -> environment projection package
  -> transport or runtime-owned capability tag
  -> runtime authority / workflow / adapter
  -> durable streams substrate
```

Durable Streams may be a backing transport for local client or host processes,
but direct `DurableTable` facades, stream URLs, workflow handles, deferred row
names, execution ids, table names, and runtime observation resolver tags are
not the public projection semantics. They belong inside runtime authorities,
host/runtime composition internals, or a named projection transport
implementation.

Convergence acceptance:

- `defineFiregridOperation(...)` or its replacement catalog grouping exists only
  under `@firegrid/protocol`.
- `@firegrid/client-sdk`, agent-tool, CLI, REST, gRPC, and JSON-RPC packages
  import or re-export protocol operation entries; they do not define their own
  operation catalogs.
- normalized observation schemas and observation source names are exported from
  protocol; runtime packages resolve streams, but do not define public
  observation contracts.
- projection packages do not expose durable table facades or workflow/runtime
  coordinates as the caller-facing way to launch, prompt, wait, observe, or use
  channels.
- dependency guardrails reject projection-package imports from runtime and
  cross-projection imports except package-barrel compatibility shims explicitly
  scheduled for deletion.

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

Existing files should be refactored into binding surfaces and execution
surfaces:

```txt
protocol/
  operation catalog

bindings/
  agent-tools/       # operation catalog -> Effect AI Tool / Toolkit / MCP exposure
  client/            # operation catalog -> TypeScript SDK shape
  cli/               # operation catalog -> @effect/cli Command

execution/
  operations.ts      # validated operation input -> Effect over Firegrid substrate
```

This is a semantic layout, not necessarily one published package. The binding
surfaces have different runtime environments and dependencies:

- agent-tool binding may depend on `@effect/ai`;
- client binding must remain browser/app-safe and runtime-source-free;
- CLI binding may depend on `@effect/cli`;
- execution may depend on runtime host, waits, workflow engine, ingress,
  durable tables through authority surfaces, and source registration when the
  operation semantics require them.

The physical files should make the split easy to audit:

```txt
packages/runtime/src/agent-tools/
  binding.ts            # schema catalog -> Tool.make(...) / Toolkit
  mcp.ts                # Toolkit exposure over MCP transport, if needed here

packages/client/src/
  binding.ts            # schema catalog -> user-facing client object
  operations.ts         # protocol operation catalog -> client binding helpers
  sessions.ts           # schema -> sessions namespace helpers, if split helps

packages/cli/src/
  binding.ts            # schema catalog -> CLI args/help/defaults
  run.ts                # command execution boundary

packages/runtime/src/operations/
  operations.ts         # common execution core where semantics are shared
  agent-tool-events.ts  # ToolUse/ToolResult adapter, if still needed
```

The names are illustrative; the invariant is not. A binding file serializes
schemas into a user-facing surface. An execution file performs effects against
Firegrid substrate. A single source file should not do both.

Do not add `packages/runtime/src/session-control/` as a parallel product API.
If repeated execution code proves a real abstraction is needed, it should be
the common operation execution surface above, not a second contract family.

This distinction is load-bearing:

- binding files are allowed to serialize schemas into a surface;
- execution files are allowed to perform effects;
- schema files are not allowed to know about runtime execution, MCP, HTTP
  transports, client environments, or CLI process execution.
- binding files are not allowed to import substrate implementations they do
  not execute themselves.

## Transactional Binding Cutover

Do not move this one binding at a time. The binding/execution split is only
useful if the dependency boundary becomes visible everywhere at once. The
acceptance target is
`firegrid-schema-projection-contract.BINDING_EXECUTION_SPLIT.1` through
`firegrid-schema-projection-contract.BINDING_EXECUTION_SPLIT.5`. The
implementation cutover should be transactional:

1. prove feasibility with dependency analysis and browser-safety checks;
2. introduce the operation catalog entries needed by all three bindings;
3. move agent-tool, client, and CLI binding code to binding-owned files;
4. move shared operation execution out of binding files where the runtime
   substrate is common;
5. add static rules that prevent bindings from importing execution/substrate
   internals and prevent execution code from importing binding modules;
6. update examples, tests, and package exports in the same PR.

The transaction can still preserve public import paths through package barrels,
but not through compatibility files that keep the old mixed layout alive. If a
consumer breaks because it imported a mixed implementation file, migrate the
consumer to the target binding or execution surface.

Feasibility must be validated before the implementation PR starts:

| Current surface | Binding dependencies | Execution/substrate dependencies | Feasibility read |
| --- | --- | --- | --- |
| `packages/runtime/src/agent-tools/tools.ts` | `@effect/ai`, protocol operation schemas | currently also imports workflow services and `toolUseToEffect` | Split is feasible only if `Tool.make(...)` / `Toolkit.make(...)` move away from `ToolCallWorkflow` execution wiring. |
| `packages/runtime/src/agent-tools/tool-use-to-effect.ts` | none required after the split | `@effect/workflow`, waits, runtime events, `AgentToolHost`, scheduled workflow | Strong candidate for the common runtime operation execution core, with a `ToolUse` adapter at the edge. |
| `packages/client/src/firegrid.ts` | protocol operation schemas, Effect `Context`/`Effect`/`Stream` | durable-stream table access through protocol tables and protocol runtime-start capability | Browser-safe if it continues to import only protocol/effect packages and no runtime package. Split binding helpers from transport execution inside `@firegrid/client`. |
| `src/run.ts` | `@effect/cli`, protocol launch/session schemas | Node process/env, embedded durable-streams server, runtime host, MCP server | Must move to a CLI package or CLI folder with binding and execution separated; CLI binding can be shared, execution stays Node-only. |

Browser-safety checks for the binding layer:

- `packages/client/**/binding*` must not import `@firegrid/runtime`,
  `@effect/ai`, `@effect/cli`, `@effect/platform-node`, or `node:*`;
- agent-tool binding may import `@effect/ai` but not waits, host, workflow
  engine, durable-table facades, or runtime execution modules;
- CLI binding may import `@effect/cli` but not `@effect/platform-node`,
  `node:*`, durable-stream server setup, or runtime host execution modules;
- execution modules must not import client binding or CLI binding modules.

## Schema Catalog

The schema catalog should expose operation-shaped schema entries, not only
loose input/output types. Operation metadata must use Effect Schema's native
surface:

- built-in annotations (`identifier`, `title`, `description`, `examples`,
  `default`, `jsonSchema`, `documentation`) for documentation, help, examples,
  and JSON Schema generation;
- one tiny Firegrid custom annotation only for Firegrid-specific operation
  identity and surface names;
- `Schema.transform` / encoded-decoded schema shapes for conversions such as
  durable rows to app-facing observations or public session ids to runtime
  context ids;
- schema projections for deriving narrower public views from richer durable
  or provider rows.

Do not replace those APIs with a Firegrid `OperationEntry`, registry, or
descriptor object as the contract source of truth. A catalog may group schemas
for import ergonomics, but it must be derived from schema values and their AST
annotations.

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
needed for binding serialization:

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

This is not a request for a new framework. Each operation should make the
following metadata discoverable from the schema AST:

- stable operation id;
- optional projection names, such as tool name, client method name, and CLI
  command or option names;
- input schema, as a schema value;
- output schema, as a schema value;
- human-readable description;
- examples;
- notes for CLI or agent help only when needed.

The schema entry is the thing that bindings serialize from:

- tool binding serializes the input/output schemas into Effect AI tool
  parameters, result schemas, descriptions, and examples;
- client binding serializes the same schemas into input validation and
  typed method signatures;
- CLI binding serializes the same schemas and metadata into command args,
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

If an operation needs both input and output schemas, export a plain grouped
object or tuple for import ergonomics only. Do not expose a Firegrid-specific
`defineOperation(...)` abstraction that copies annotation data into a second
metadata object.

The current `packages/protocol/src/operations/schema.ts` shape is therefore a
transitional implementation detail, not the target. It should be removed in the
binding cutover and replaced with:

```ts
export const SessionCreateOrLoad = {
  input: SessionCreateOrLoadInputSchema,
  output: SessionHandleReferenceSchema,
} as const
```

Bindings that need title, description, examples, or Firegrid operation names
read those values from `SessionCreateOrLoad.input.ast.annotations` using
Effect's annotation ids and the tiny Firegrid custom annotation id. They do not
depend on `FiregridOperationEntry`, `defineFiregridOperation`, or a copied
`metadata` field.

Runtime read-side conversion should use Effect Schema's transformation and
projection vocabulary where practical. For example, "RuntimeOutput event row
raw envelope -> normalized agent-output observation" is a projection from a
richer durable row into a public observation, not a separate client-local
parser or operation descriptor.

## Agent Tool Binding

The agent tool binding projects catalog entries into Effect AI tools:

```txt
SessionCreate.input  -> Tool.make("session_new").setParameters(...)
SessionCreate.output -> .setSuccess(...)
SessionCreate.description -> tool description
```

The runtime execution path stays separate. The near-term goal is to remove
schema/description drift and make it statically impossible for the tool binding
to import runtime substrate.

The existing `tool-use-to-effect.ts` code is the best candidate for the common
operation execution core because it already turns validated operation-shaped
inputs into Firegrid primitives such as:

- `insertLocalRuntimeContext`;
- protocol host/session channel dispatch;
- normalized channel wait matching;
- protocol observation source names;
- host-authority checks;
- provider/capability execution where available.

The transaction should split the Effect AI `Tool.make(...)` binding from
`ToolCallWorkflow`, `ScheduledInputWorkflow`, `AgentToolHost`, and runtime
wait/host/workflow execution. A `ToolUse` / `ToolResult` adapter may remain at
the edge so agent events can call the common operation executor without making
the executor agent-tool-specific.

## Client Binding

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
dependencies. The client is one binding of the schema catalog, not a
wrapper around the agent-tool catalog.

For durable RuntimeContext-backed work, the client should expose a session
facade that keeps low-level runtime identity and delivery details out of
product apps. Client write methods project onto protocol-owned host/session
channels or host-control capabilities; they do not write runtime-owned state,
workflow deferred rows, or live adapter transports directly.

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

This facade is still a binding over Firegrid primitives. After the channel
cutover, `sessions.createOrLoad`, `session.start`, and
`permissions.respond` dispatch through protocol-owned channel/capability
contracts rather than through client-local substrate writes. It should hide
deterministic `RuntimeContext` identity, runtime input intent id construction,
permission-response idempotency, and runtime-observation joins from callers.
Product apps may still own product facts and read models, but they should not
rebuild Firegrid session/control-intent identity helpers.

The post-Path-X input boundary is:

```txt
client method
  -> append protocol-owned RuntimeInputIntent to the namespace control stream

owning host/workflow
  -> host-wide local dispatcher observes accepted intent for an active
     per-context RuntimeContext engine
  -> complete the workflow runtime-input DurableDeferred
  -> dispatch through RuntimeContextWorkflowSession.send
```

The client must not write `RuntimeIngressTable` rows, workflow deferred rows, or
host-owned stream segments directly. Those are runtime-owned state or host
execution details. Programmatic prompting stays on the client surface because
the client writes intent; the workflow remains the single writer that turns
accepted intent into runtime input state.

`RuntimeInputIntent` is the long-term durable record for client-written runtime
input. It is not a bridge to keep the old ingress tier alive. After Path X, the
allowed chain is client -> intent -> host-wide local dispatcher -> local
per-context workflow `DurableDeferred` completion ->
`RuntimeContextWorkflowSession.send`. The runtime-ingress table, delivery
tracker, old delivery subscriber, `appendRuntimeIngressToOwner`, and
owner-host workflow stream routing remain deleted. The dispatcher is a local
demux to active per-context engines, not a cross-host router.

`packages/client` remains runtime-source-free. If a facade method actively
starts a runtime, it must depend on a protocol-owned runtime-start
capability/service supplied by host/runtime composition. The client package must
not import `packages/runtime/src` or call `startRuntime` directly. Read and wait
helpers should use protocol-owned runtime observation source names rather than
runtime-host modules.

The client binding should use product-facing names. For example:

```txt
operation id: session.prompt
tool name:    session_prompt
client API:   firegrid.sessions.prompt(...)
```

The client operation catalog lives in protocol session-facade schemas and is
re-exported from `@firegrid/client`. It may compatibility-reuse existing
agent-tool schemas for operations whose protocol shape already exists there,
but client decoders should import the client operation catalog rather than the
runtime agent-tool operation catalog.

## Client Read Binding

The same binding rule applies to read-side data. Operation schemas project
into methods; observation schemas project into snapshots, streams, and waits.

Runtime output rows are storage/journal rows. Product apps should not parse
`RuntimeEvent.raw` or know about the `firegrid.agent-output` envelope. The
protocol package should own the normalized observation schemas, and the client
should project runtime output rows into those observations before returning
app-facing snapshots or waits.

Target protocol-owned contracts:

```ts
export const RuntimeAgentOutputObservationSchema = Schema.Struct({
  source: Schema.Literal("firegrid.runtime.agent-output-events"),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  _tag: Schema.String,
  event: AgentOutputEventSchema,
})

export const RuntimePermissionRequestObservationSchema = Schema.Struct({
  source: Schema.Literal("firegrid.runtime.agent-output-events"),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  event: PermissionRequestEventSchema,
})
```

The exact file can be `@firegrid/protocol/session-facade` or a nearby
protocol-owned observation module. The important boundary is that
`@firegrid/client` and apps import protocol schemas, not
`@firegrid/runtime/events`.

Target app-facing client ergonomics:

```ts
const firegrid = yield* Firegrid

const session = yield* firegrid.sessions.createOrLoad({
  externalKey: { source: "linear", id: "LIN-123" },
  runtime: { provider: "local-process", config },
  createdBy: "dark-factory",
})

yield* session.prompt({
  idempotencyKey: "initial",
  payload: Prompt.userMessage({
    content: [Prompt.textPart({ text: "Plan the fix." })],
  }),
})

yield* session.start()

const snapshot = yield* session.snapshot()
for (const output of snapshot.agentOutputs) {
  if (output._tag === "PermissionRequest") {
    yield* session.permissions.respond({
      permissionRequestId: output.permissionRequestId,
      decision: { outcome: "allow_once" },
    })
  }
}
```

For reactive or blocking UI flows, the same binding should be available as a
session-scoped wait:

```ts
const next = yield* session.wait.forAgentOutput({
  afterSequence: snapshot.agentOutputs.at(-1)?.sequence,
  timeoutMs: 30_000,
})

if (next.matched && next.output._tag === "PermissionRequest") {
  yield* session.permissions.respond({
    permissionRequestId: next.output.permissionRequestId,
    decision: { outcome: "allow_once" },
  })
}
```

`forPermissionRequest(...)` remains useful as permission-specific sugar, but it
should be implemented as a specialization of the same normalized agent-output
binding rather than a separate raw-envelope parser.

This does not remove raw table access for packages that deliberately build
inspectors or diagnostics. `DurableTableProvider` and direct `RuntimeOutputTable`
reads may remain appropriate there when clearly labeled as raw storage views.
They are not the normal product API, and end-user examples should use session
methods, normalized observations, and semantic channels for Firegrid session
semantics.

With this boundary, an app like Dark Factory owns its product facts, prompt
copy, run-status read model, and permission-resolution facts, but it does not
own Firegrid envelope decoding:

```txt
factory status view
  = app facts/runs
  + session.snapshot().runs
  + session.snapshot().agentOutputs
```

No product app should need:

```ts
JSON.parse(row.raw)
Schema.decodeUnknownEither(AgentOutputEventSchema)(parsed.event)
```

## CLI Binding

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

The binding and execution halves of `src/run.ts` should split transactionally.
The binding half owns `Command`, `Options`, help text, defaults, examples, and
schema-aligned decode errors. The execution half owns `process.env`,
`process.argv`, embedded durable-streams startup, runtime host composition, MCP
server startup, and command side effects.

## Boundary Rules

- Schema catalog is source of truth for operation shapes and metadata.
- Protocol observation schemas are source of truth for client read bindings.
- Agent tools are a binding, not the programmer API.
- Client APIs are a binding, not a separate contract.
- Client snapshots and waits return normalized protocol observations when the
  caller asks for Firegrid session semantics.
- Common execution is introduced only where multiple bindings share the same
  runtime substrate semantics.
- Runtime-host active execution is injected into client facades through a
  protocol-owned capability/service; `packages/client` does not import
  runtime-host source.
- Do not split `@firegrid/client` into multiple packages.
- Do not publish one package that mixes browser-safe client code, Node CLI
  code, MCP/Effect AI tooling, and runtime host execution.
- Do not introduce a platform parent/child session hierarchy beyond
  `RuntimeContext` identity and explicit metadata.
- Dark-factory may depend on this facade for the first working app path because
  it prevents product code from reimplementing runtime identity and ingress
  details.
- Dark-factory and other product apps should not parse runtime output envelopes
  or import `@firegrid/runtime/events` to recover normalized agent output.

## Transactional Implementation Slice

This SDD no longer recommends an incremental "move one projection" path. The
next implementation slice should be one binding-boundary cutover:

1. Update or complete the protocol operation catalog in `@firegrid/protocol`,
   reusing existing `@firegrid/protocol/agent-tools` and
   `@firegrid/protocol/session-facade` schemas where they are already correct.
2. Remove the transitional `packages/protocol/src/operations/schema.ts`
   operation-entry wrapper. Keep Firegrid operation identity on Schema
   annotations and expose only plain schema groupings for import ergonomics.
3. Split agent-tool binding from runtime operation execution so Effect AI
   `Tool.make(...)` definitions and `Toolkit.make(...)` do not import waits,
   host, workflow engine, or tool-call execution.
4. Split `@firegrid/client` binding helpers from durable transport execution
   while keeping the package runtime-source-free.
5. Move the root CLI into a CLI package or CLI folder and split command binding
   from Node/runtime-host execution.
6. Introduce common operation execution only for operations whose semantics are
   identical across bindings, with `ToolUse` / `ToolResult`, client, and CLI
   adapters at the edges.
7. Add dependency-cruiser or semgrep rules for the browser-safety and import
   direction checks listed above.
8. Update public barrels, examples, tests, and docs in the same PR so no
   long-lived compatibility surface keeps the old mixed files alive.

Acceptance should explicitly prove:

- client binding files have no runtime, Node, CLI, or Effect AI imports;
- agent-tool binding files have no wait, host, workflow-engine, durable-table,
  or runtime execution imports;
- CLI binding files have no Node/process/runtime-host imports;
- execution files do not import client or CLI binding modules;
- each operation's tool, client, and CLI binding points to the same protocol
  schema group;
- no production binding depends on `FiregridOperationEntry`,
  `defineFiregridOperation`, or copied operation metadata objects.

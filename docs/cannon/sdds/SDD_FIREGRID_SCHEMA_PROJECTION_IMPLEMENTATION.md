# SDD: Schema Projection — Implementation Spec

Status: Buildable spec. Companion to `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
(the "why/rules"). This doc is the "what/how": the real catalog as it exists, the
decisions it forces, the projection helpers to build, a worked end-to-end
example, and file-level slices with acceptance.

---

## 1. The catalog as it exists today

The operation catalog is **federated across two protocol modules**, each carrying
`firegridProjection({ operationId, toolName?, clientName?, cliName? })` annotations:

**`@firegrid/protocol/agent-tools`** — the surface an *agent* calls (MCP tools):

| operationId | toolName | clientName | cliName |
| --- | --- | --- | --- |
| `sleep` | `sleep` | — | — |
| `wait.for` | `wait_for` | `wait.for` | — |
| `channel.send` | `send` | — | — |
| `channel.call` | `call` | — | — |
| `channel.waitForAny` | `wait_for_any` | — | — |
| `session.create` | `session_new` | `sessions.create` | `sessions create` |
| `session.prompt` | `session_prompt` | `sessions.prompt` | `sessions prompt` |
| `session.status` | — | `sessions.status` | `sessions status` |
| `session.cancel` | `session_cancel` | `sessions.cancel` | `sessions cancel` |
| `session.close` | `session_close` | `sessions.close` | `sessions close` |
| `schedule.me` | `schedule_me` | — | — |
| `capability.execute` | `execute` | — | — |
| `permission.respond` | — | `permissions.respond` | — |
| `session.spawnLegacy` | `spawn` | — | — |
| `session.spawnAllLegacy` | `spawn_all` | — | — |

**`@firegrid/protocol/session-facade`** — the surface an *app/developer* calls:

| operationId | clientName |
| --- | --- |
| `session.createOrLoad` | `sessions.createOrLoad` |
| `session.attach` | `sessions.attach` |
| `session.prompt.scoped` | `session.prompt` |
| `session.wait.forPermissionRequest` | `session.wait.forPermissionRequest` |
| `session.wait.forAgentOutput` | `session.wait.forAgentOutput` |
| `permission.respond.scoped` | `session.permissions.respond` |

---

## 2. Decisions this catalog forces (resolve before building)

These are **not duplicates to merge blindly** — agent and app surfaces are
different actors with different inputs (`session_new(prompt)` vs
`sessions.createOrLoad(externalKey)`). The concrete questions:

The concrete questions — **resolved in `tf-0awo.1`**:

1. **Federation: keep two modules, gate uniqueness.** `agent-tools` (agent verbs)
   and `session-facade` (app ops) map to two actor surfaces — keep both. Safety: a
   build-time test asserts `operationId` uniqueness across both (slice `.3`).
2. **`session.create` vs `session.createOrLoad`: two distinct operations.** Agent
   `session_new(prompt)` (child by prompt) vs app `createOrLoad(externalKey, runtime)`
   (converge on a key) — different inputs and actors. Keep both; document the link.
3. **`spawn`/`spawn_all`: first-class, not legacy.** `spawn` (run-and-await) is
   semantically distinct from `session_new` (return-handle), shipped, and
   README/RFC-advertised. Rename `session.spawnLegacy`/`spawnAllLegacy` →
   `session.spawn`/`session.spawnAll` (slice `.5`).
4. **The wait surface is reshaped into a `wait.*` family** (slice `.15`). Collapse
   `sleep` / `wait_for` / `wait_for_any` / `schedule_me` into
   `wait_for(event, prompt?)` / `wait_until(time, prompt?)` / `wait_any([…], prompt?)`,
   `sleep` a thin alias for `wait_until("+d")`. `prompt?` is the proactivity lever
   (no prompt → resolve inline; with prompt → suspend durably + wake with it as a
   new turn). The over-promised `clientName: wait.for` becomes accurate by
   *building* the real client `wait.*` namespace (`firegrid.wait.for/until`), not by
   dropping it. README + RFC already updated.

---

## 3. The boilerplate to remove: one projection helper

Today every tool is hand-wired in `runtime/src/unified/mcp-host/toolkit.ts`:

```ts
export const SleepTool = Tool.make(schemaToolName(SleepToolInputSchema, "sleep"), {
  description: schemaDescription(SleepToolInputSchema, "sleep"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(SleepToolInputSchema)
  .setSuccess(SleepToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)
// …×15, identical shape
```

The name/description already come from the schema annotation. **Build one helper**
so a tool is its `{ input, output }` group plus nothing:

```ts
// runtime/src/unified/mcp-host/project-tool.ts
const projectTool = <In extends Schema.Schema.Any, Out extends Schema.Schema.Any>(
  group: { readonly input: In; readonly output: Out },
) => {
  const meta = Option.getOrThrow(getFiregridProjectionMetadata(group.input)) // operationId required
  const toolName = meta.toolName ?? meta.operationId
  return Tool.make(toolName, {
    description: stringAnnotation(group.input.ast, SchemaAST.DescriptionAnnotationId) ?? toolName,
    dependencies: FiregridToolDependencies,
  })
    .setParameters(group.input)
    .setSuccess(group.output)
    .setFailure(FiregridMcpToolFailureSchema)
}

export const FiregridAgentToolkit = Toolkit.make(
  ...AGENT_TOOL_GROUPS.map(projectTool),   // one source list, no per-tool boilerplate
)
```

This is the contract's "bindings serialize from the schema" made literal: the
binding reads `toolName` + `description` from the AST, never re-declares them.
The client and CLI get the analogous mechanisms below.

---

## 3b. Client-SDK binding mechanism

The client does **not** call `ToolDispatch`. A method decodes the operation's
input schema, dispatches the **protocol-owned channel** for that operation,
decodes the output, returns a typed handle. It imports protocol only
(browser-safe; enforced by `client-sdk-no-runtime`).

Real shape today (`client-sdk/src/firegrid.ts`, `createOrLoadSession`):

```ts
const decoded = yield* Schema.decodeUnknown(
  FiregridClientOperations.sessions.createOrLoad.inputSchema, { onExcessProperty: "error" },
)(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))

const response = yield* hostSessionsCreateOrLoadChannel.binding.call({
  externalKey: decoded.externalKey, runtime, ...rest,
}).pipe(Effect.mapError(cause => new AppendError({ contextId, cause })))

return yield* makeSessionHandle(response.contextId)
```

Factor the repeated **decode → dispatch → map** into one helper, so each method
is its schema group plus its channel:

```ts
// client-sdk/src/project-method.ts
const projectChannelMethod = <In extends Schema.Schema.Any, Out>(
  inputSchema: In,
  dispatch: (input: Schema.Schema.Type<In>) => Effect.Effect<Out, unknown>,
  onError: (contextId: string, cause: unknown) => FiregridError,
  contextIdOf: (i: Schema.Schema.Type<In>) => string,
) =>
  (request: unknown): Effect.Effect<Out, FiregridError> =>
    Schema.decodeUnknown(inputSchema, { onExcessProperty: "error" })(request).pipe(
      Effect.mapError(cause => new LaunchInputError({ cause })),
      Effect.flatMap((i) => dispatch(i).pipe(Effect.mapError(c => onError(contextIdOf(i), c)))),
    )

// usage — method name = the annotation's clientName ("sessions.cancel")
sessions.cancel = projectChannelMethod(
  SessionCancel.input,
  (i) => sessionCancelChannel.binding.append(i),
  (contextId, cause) => new AppendError({ contextId, cause }),
  (i) => i.sessionId,
)
```

Rules: the dispatch target is always a **protocol-owned channel/capability**
(`SessionCancelChannel`, `HostSessionsCreateOrLoadChannel`, …), never a runtime
import and never a durable-table write. Read methods return **normalized
observations** (`RuntimeAgentOutputObservationSchema`), projected via
`Schema.transform`, not raw rows.

Migration note: `FiregridClientOperations` is the protocol catalog re-exported,
but it is built with `defineFiregridOperation`, so methods read `.inputSchema`.
Slice 3 swaps those to plain `{ input, output }` groups (`.input`).

---

## 3c. CLI binding mechanism

The CLI projects the **same** schema group into an `@effect/cli` `Command`, split
into a **binding** half (`Command`/`Options`/help) and an **execution** half
(decode + dispatch the same channel the client uses). Per the CLI SDD the
execution half is runtime-side; the CLI package stays a thin launcher.

`@effect/cli` `Options` are not a 1:1 derivation from a `Schema.Struct` (flags
are stringly-typed; schemas are richer), so the mechanism derives what is
mechanical and reads the rest from annotations:

```ts
// binding half — names/help/choices come from the schema + firegridProjection
const sessionIdArg = Args.text({ name: "sessionId" }).pipe(
  Args.withDescription(fieldDescription(SessionCancel.input, "sessionId")),
)
const reasonOption = Options.text("reason").pipe(
  Options.withDescription(fieldDescription(SessionCancel.input, "reason")),
  Options.optional,                        // because the schema field is Schema.optional
)

const cancelCommand = Command.make(
  cliLeaf(SessionCancel.input),            // "sessions cancel" -> leaf "cancel"
  { sessionId: sessionIdArg, reason: reasonOption },
  ({ sessionId, reason }) =>
    runSessionCancel({ sessionId, reason: Option.getOrUndefined(reason) }), // execution half
).pipe(Command.withDescription(operationDescription(SessionCancel.input)))
```

Field→option projection rules (the mechanical part):

| Schema field | `@effect/cli` |
| --- | --- |
| `Schema.optional(...)` field | `Options.optional` |
| `Schema.Literal("a","b")` field | `Options.choice(name, ["a","b"])` |
| array / repeated input (`--secret-env`, agent argv) | `Options.repeated` / `Args.repeated` |
| `Schema.String` / `Schema.Number` | `Options.text` / `Options.integer` |

`cliLeaf` / `fieldDescription` / `operationDescription` read `cliName`,
field-level `description`, and `examples` from the AST + the `firegridProjection`
annotation — replacing the old CLI-local `LaunchCliHelp` literals. The execution
half dispatches the protocol channel, so the CLI, client, and agent paths share
one schema and one execution semantics.

---

## 4. Worked round-trip — `session.cancel` end to end

**(a) Protocol — the one definition** (`protocol/src/agent-tools/schema.ts`):

```ts
export const SessionCancelToolInputSchema = Schema.Struct({
  sessionId: FiregridSessionIdSchema,
  reason: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.operation.session.cancel.input",
  description: "Durably interrupt a session's in-flight work.",
  ...firegridProjection({
    operationId: "session.cancel",
    toolName: "session_cancel",
    clientName: "sessions.cancel",
    cliName: "sessions cancel",
  }),
})
export const SessionCancel = { input: SessionCancelToolInputSchema, output: SessionCancelToolOutputSchema } as const
```

**(b) Agent-tool binding** — `projectTool(SessionCancel)` (no hand-wiring).

**(c) Client binding** (`client-sdk/src/firegrid.ts`) — `session.cancel(...)`
decodes `SessionCancel.input`, dispatches the **protocol-owned `SessionCancelChannel`**
(no runtime import; the channel-binding lowers it to a terminal signal).

**(d) CLI binding** (per the CLI SDD) — `firegrid sessions cancel <id>`; args/help
read from `SessionCancel.input` annotations + `cliName`.

**(e) Execution** — agent path: the toolkit handler calls
`ToolDispatch.call({ contextId, toolUseId, toolName: "session_cancel", input })`
(at-most-once on `toolUseId`). Client path: `SessionCancelChannelSignalingLive`
→ `emitSessionTerminalSignal` → `SignalTable` → `RuntimeContextSessionWorkflow`
→ `adapter.deregister`. **Same operation, one schema, two entry surfaces, one
execution semantics.**

---

## 5. Execution seam (the narrow boundary bindings call)

```ts
// runtime/src/unified/mcp-host/tool-dispatch.ts (exists)
interface ToolDispatchInput { contextId: string; toolUseId: string; toolName: string; input: unknown }
ToolDispatch.call(input): Effect<unknown, ToolError>   // at-most-once on toolUseId
```

Client write methods do **not** go through `ToolDispatch`; they dispatch the
protocol-owned channel for the operation. Both seams terminate in the same
unified host substrate (signal → workflow → adapter). Bindings never import the
substrate directly.

---

## 6. File-level slices (each independently shippable)

| # | Slice | Files | Acceptance |
| --- | --- | --- | --- |
| 1 | `projectTool` helper; collapse toolkit boilerplate | `runtime/src/unified/mcp-host/{project-tool,toolkit}.ts` | `toolkit.ts` has zero per-tool `.setParameters/.setSuccess` repetition; tool list is one array; `register_toolkit` still reports the same 15 tools |
| 2 | `operationId` uniqueness gate | `protocol/test/catalog-uniqueness.test.ts` | test folds every annotated schema in both modules; fails on duplicate `operationId` |
| 3 | Remove `FiregridOperationEntry`/`defineFiregridOperation` | `protocol/src/operations/schema.ts` (delete wrapper), callers | no production import of `defineFiregridOperation`; groups are `{ input, output } as const`; `lint:dead` clean |
| 4 | Resolve `Legacy` spawn + `wait.for` clientName | `protocol/src/agent-tools/schema.ts` | annotations match the advertised surface (README); no `Legacy` operationId in the shipped toolkit, or an explicit deprecation note |
| 5 | Client read-path off durable-table facades (tf-ll90.8.3) | `client-sdk/src/firegrid.ts`, a protocol read capability | client no longer resolves `RuntimeControlPlaneTable` / builds `RuntimeOutputTable.layer`; reads go through a protocol-owned observation source; `client-sdk-no-broad-durable-streams-root` tightened |
| 6 | `projectClientMethod` / `projectCliCommand` helpers | `client-sdk`, CLI package | client + CLI bindings read names/help from annotations, not literals |

Slices 1–4 are protocol/host-local and low-risk; 5 is the real boundary fix; 6
follows the CLI rebuild.

---

## 7. Acceptance for the whole effort

- Every operation: tool + client + CLI bindings point at the **same** protocol
  schema group; names/help come from annotations, not binding-local literals.
- No `defineFiregridOperation` / `FiregridOperationEntry` in production.
- `operationId` is unique across the catalog (gated by test).
- Agent-tool binding files import only `@effect/ai` + protocol schemas + the
  `ToolDispatch` tag (enforced by dep-cruiser).
- Client binding files import protocol only; no durable-table facade as the
  caller path.
- The 15-tool `register_toolkit` profile and the tf-r1gz live-ACP proof are
  unchanged after the refactor (no surface regression).

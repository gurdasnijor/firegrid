# SDD: Firegrid Agent Tools MCP Bridge

Status: Draft

## Problem

Firegrid now has the canonical agent tool contract:

- `@firegrid/protocol/agent-tools` owns the Effect Schemas for tool inputs and
  outputs.
- `@firegrid/runtime/agent-tools` owns `FiregridAgentTools`, the explicit
  descriptor manifest.
- `toolUseToEffect` lowers descriptor-backed `ToolUse` events to workflow
  effects.

MCP-capable agents still need a concrete way to discover and call those tools
without a harness-specific adapter. The bridge must expose the same descriptors
that `toolUseToEffect` implements, and it must not become a second tool registry
or a custom JSON-RPC stack.

## Decision

Build a thin Streamable HTTP MCP bridge in `packages/runtime/src/agent-tools`
backed by `FiregridAgentTools` and `toolUseToEffect`.

Use the official `@modelcontextprotocol/typescript-sdk` server primitives for
MCP protocol handling. Firegrid provides MCP request handlers for `tools/list`
and `tools/call`; the SDK owns JSON-RPC parsing, MCP lifecycle, protocol
framing, and transport details. Do not write a custom JSON-RPC parser.

The bridge is a protocol projection:

- It does not define new tool schemas.
- It does not define dynamic tool registration.
- It does not expose arbitrary `@firegrid/protocol` schemas as tools.
- It does not create a product-specific transport package.
- It does not introduce substrate row families beyond the durable invocation and
  result facts needed by the bridge's durable mode.

This is governed by
`firegrid-workflow-driven-runtime.AGENT_TOOL_BOUNDARIES.7`.

## Why SDK Server Primitives

The MCP TypeScript SDK integration tests show two useful layers:

1. A protocol server/transport layer that handles JSON-RPC, initialization,
   capabilities, request routing, cancellation, and streamable HTTP behavior.
2. Higher-level helpers such as tool registration APIs that often assume a
   library-specific schema representation.

Firegrid should use the first layer. The descriptor manifest already has Effect
Schema as the source of truth, so we should not re-author every tool in a second
schema system just to call a high-level helper. Request handlers can return MCP
tool descriptors projected from `FiregridAgentTools` and can route `tools/call`
to `toolUseToEffect`.

The implementation rule is:

> Use the MCP SDK for protocol handling; use Firegrid's descriptor manifest for
> tool schema and semantics.

## Schema Projection

`descriptors.ts` is an explicit exposure manifest, not a second schema source.
It selects which protocol-owned operations are safe and meaningful as
agent-callable tools.

`catalog.ts` projects those descriptors into MCP `Tool` records:

- `name` comes from the descriptor.
- `description` comes from descriptor metadata.
- `inputSchema` is generated from the descriptor's Effect Schema encoded shape
  and annotations.
- Output schemas are kept in the descriptor manifest for host-side validation and
  documentation; MCP's basic `tools/list` shape does not need to expose every
  output schema in v0.

Do not reflect every schema in `@firegrid/protocol`. Protocol contains durable
rows, launch records, ingress rows, and coordination facts. Reflection can
derive a JSON shape, but it cannot decide exposure, authority, naming, or host
lowering. `FiregridAgentTools` is the allowlist that prevents accidental schema
exposure.

## Effect AI Toolkit As Integration Point

Effect AI's `Tool` and `Toolkit` model is the right starting point for the
in-process tool definition layer:

- an Effect AI `Tool` corresponds to one Firegrid tool descriptor plus schemas;
- an Effect AI `Toolkit` corresponds to the `FiregridAgentTools` manifest;
- a tool parameter schema corresponds to the protocol-owned input schema;
- a tool success schema corresponds to the protocol-owned output schema;
- a toolkit handler corresponds to the `toolUseToEffect` lowering arm.

The implementation should first verify dependency compatibility for
`@effect/ai`. If it does not force an incompatible Effect bump, represent
`FiregridAgentTools` as or project it to an Effect AI `Toolkit` before building
the MCP bridge. This lets three surfaces share one Effect-native tool definition
layer:

1. MCP bridge catalog and `tools/call` handling.
2. Workflow lowering tests for `toolUseToEffect`.
3. In-process agent tests using Effect AI / `AiChat`-style execution.

The Firegrid descriptor manifest remains the authority boundary. Effect AI is
the integration model, not the schema authority. Protocol-owned Effect Schemas
still define input and output shapes, and only descriptors explicitly listed in
`FiregridAgentTools` are exposed.

Firegrid tools are durable runtime capabilities, not only model-provider tool
calls. They carry workflow identity, replay safety, context routing, and host
lowering semantics that are outside Effect AI's provider-agnostic LLM layer. The
toolkit handler therefore lowers into workflow-backed `toolUseToEffect`, rather
than bypassing workflow services.

## Rember Pattern To Copy

`repos/rember-mcp` provides the concrete implementation pattern Firegrid should
copy, adjusted for Firegrid's durable workflow requirements.

The useful structure:

1. Define each tool as a `Schema.TaggedRequest`.
2. Build one toolkit with `AiToolkit.empty.add(ToolSchema)`.
3. Implement handlers once with `toolkit.implement((handlers) =>
   handlers.handle(...))`.
4. Build the MCP server from the toolkit handlers, not from a parallel registry.
5. Project each tool's Effect Schema AST into MCP `inputSchema`.
6. Decode `tools/call` arguments by injecting the tagged request `_tag`.
7. Invoke the toolkit handler.
8. Encode the handler result through the tool's success schema.
9. Convert expected failures and defects into MCP `isError: true` results.
10. Test the same toolkit through an Effect AI / `AiChat` path so the MCP bridge
    and model-facing tests share the same definitions.

The Rember server uses the official MCP SDK's low-level `Server` and
`setRequestHandler` APIs. That is the right level for Firegrid too: it avoids a
custom JSON-RPC parser while still letting Firegrid project Effect Schemas
directly instead of re-authoring tool schemas in a second DSL.

Firegrid differences from Rember:

- Firegrid must use the canonical `FiregridAgentTools` allowlist and
  protocol-owned schemas rather than product-specific schemas.
- Firegrid tool names are already canonical (`sleep`, `wait_for`, etc.); do not
  rely on a PascalCase-to-snake_case conversion unless the Effect AI
  `TaggedRequest` path requires an internal tag mapping.
- Firegrid must not restrict MCP results to `Schema.String`; it should encode
  structured tool results as JSON content or MCP structured content when
  supported by the SDK version.
- Firegrid `tools/call` handling must route through a workflow-backed runner that
  calls `toolUseToEffect`; the toolkit handler must not bypass DurableClock,
  workflow identity, or host seams.
- Firegrid's first bridge should target Streamable HTTP MCP, not stdio-only MCP.

Dependency note: `@effect/ai` version compatibility must be checked before
implementation. The current latest `@effect/ai` peer range may require an Effect
version newer than this repo currently pins. If a compatible `@effect/ai` version
cannot be used without a broader Effect bump, stop and decide whether to bump
Effect first or land a narrow internal toolkit shape that mirrors the Rember
pattern and can later be replaced by `@effect/ai`.

## In-Process Effect AI Sandbox Provider

An in-process sandbox provider is useful for validation and future codec work.
It should live under `packages/runtime/src/providers`, not under the MCP bridge.

Purpose:

- Exercise the `SandboxProvider` and `AgentByteStream` boundary without spawning
  a local process.
- Avoid overfitting agent I/O and tool validation to
  `providers/sandboxes/local-process.ts`.
- Provide a convenient test host for Effect AI-style in-process agents and
  deterministic tool-call scenarios.

Suggested shape:

```
packages/runtime/src/providers/effect-ai/
  effect-ai-sandbox.ts       // SandboxProvider implementation
  README.md                  // public API, intended use, non-goals
```

The provider implements the existing `SandboxProviderService`:

- `create` and `getOrCreate` return an in-process sandbox record;
- `openBytePipe` returns an `AgentByteStream` backed by in-memory web streams;
- `stream` and `execute` can be narrow convenience wrappers for tests;
- filesystem upload/download, snapshots, GPU, and external process control are
  unsupported unless a concrete consumer needs them.

The in-process provider may use Effect AI services internally to model a test
agent, but it must still present the same byte-stream contract as any other
sandbox provider. That keeps runtime-context execution agnostic to whether the
agent is a subprocess, a remote sandbox, or an in-process Effect program.

This provider is not part of MCP bridge correctness. It is a de-risking tool:
MCP bridge tests can use it when they need a stable in-process agent, while local
process tests remain available for real subprocess behavior.

## V0: Local Direct Bridge

The first implementation should prove that an MCP client can call Firegrid tools
through the SDK server without adding the durable invocation/result stream path
yet.

### Scope

Files:

```
packages/runtime/src/agent-tools/
  toolkit.ts             // FiregridAgentTools -> Effect AI Toolkit projection
  mcp-bridge.ts          // SDK server wiring and tools/list + tools/call handlers
  catalog.ts             // FiregridAgentTools -> MCP Tool projection
  mcp-tool-call.ts       // ToolUse construction and MCP result formatting
```

The exact file split can change, but those three responsibilities should remain
separate.

### Request Flow

1. MCP client calls `tools/list`.
2. Bridge returns the projection of `FiregridAgentTools`.
3. MCP client calls `tools/call` with a tool name and arguments.
4. Bridge builds a normalized `ToolUse` event:

   ```ts
   {
     _tag: "ToolUse",
     toolUseId,
     name,
     input,
   }
   ```

5. Bridge executes the call through a workflow-backed runner that invokes
   `toolUseToEffect`.
6. Bridge converts the returned `ToolResult` event into an MCP `CallToolResult`.

If `@effect/ai` compatibility is green, step 5 goes through the shared toolkit
handler instead of duplicating dispatch inside the bridge. The toolkit handler
still calls `toolUseToEffect`; it is an integration layer, not a new runtime
semantics layer.

The workflow-backed runner matters. `sleep`, `wait_for`, `schedule_me`, and
spawn semantics depend on workflow services such as DurableClock and deterministic
workflow identity. The bridge should not call `toolUseToEffect` as a plain
process-local Effect outside a workflow execution.

### Deterministic Identity

`toolUseId` must be stable for retry and replay. In v0:

```
toolUseId = "mcp:" + sessionId + ":" + requestId
```

If the SDK transport does not expose a durable MCP session id in the local test
path, use a bridge-generated session id and the MCP JSON-RPC request id. The
implementation should keep this logic in one helper so the durable path can
replace it with the invocation row id.

### Result Mapping

`ToolResult` maps to MCP `CallToolResult`:

- `isError` maps to MCP `isError`.
- The Firegrid result payload is encoded as structured JSON when the SDK supports
  structured content.
- Otherwise, encode the JSON payload as a single text content item.

Invalid tool names, invalid input, and arm failures stay successful MCP protocol
responses with `isError: true`; they are not HTTP 500s and not MCP protocol
errors. Protocol errors are reserved for malformed MCP requests, auth failures,
or bridge infrastructure failures.

### V0 Validation

Required checks:

1. `tools/list` returns exactly the six `FiregridAgentTools` descriptors.
2. The listed schemas are generated from the protocol Effect Schemas and
   descriptor annotations, not handwritten MCP schemas.
3. `tools/call sleep` succeeds through the SDK client and returns the expected
   `ToolResult` mapping.
4. Malformed `sleep` input returns `isError: true`.
5. Unknown tool name returns `isError: true`.
6. The implementation uses MCP SDK server/transport primitives; tests should not
   pass through a custom JSON-RPC parser.
7. A Codex or MCP inspector smoke can be pointed at the local bridge URL and run
   `tools/list` plus `sleep`.
8. If `@effect/ai` is used, a unit test proves the MCP bridge and an Effect AI
   chat/tool test consume the same toolkit definition, not duplicate tool
   schemas.

## V1: Durable Indirect Bridge

After V0 proves the MCP protocol shape, add durable invocation/result state. This
is the production shape for external agents and cross-process routing.

### Durable Facts

The bridge writes runtime-owned rows under `packages/runtime/src/agent-tools`.
They are not `@firegrid/protocol` browser/client API rows.

Suggested rows:

```ts
interface AgentToolInvocationFact {
  readonly invocationId: string
  readonly contextId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
  readonly createdAt: string
  readonly source: {
    readonly _tag: "Mcp"
    readonly sessionId?: string
    readonly requestId: string | number
  }
  readonly status: "pending" | "completed" | "failed"
}

interface AgentToolResultFact {
  readonly invocationId: string
  readonly toolUseId: string
  readonly isError: boolean
  readonly content: unknown
  readonly completedAt: string
}
```

Use deterministic primary keys and `DurableTable.insertOrGet` for invocation
facts. The second observation of the same invocation must observe the existing
fact rather than scheduling duplicate workflow work.

### Request Flow

1. MCP client calls `tools/call`.
2. Bridge writes an invocation fact with deterministic `invocationId`.
3. `invocations-consumer.ts` subscribes to invocation facts.
4. Consumer routes each invocation to the owning `RuntimeContextWorkflow` or a
   workflow-backed tool-call runner.
5. `toolUseToEffect` produces a `ToolResult`.
6. Consumer writes a result fact.
7. Bridge responds to the original MCP call or lets the client resume/poll the
   result depending on SDK transport support.

The bridge may remain mostly stateless: durable rows provide replay, dedup, and
recovery. In-memory request waiters are an optimization, not correctness state.

### V1 Validation

Required checks:

1. Duplicate MCP `tools/call` requests with the same invocation identity produce
   one invocation fact and one result fact.
2. If the bridge process crashes after writing the invocation fact but before the
   result is observed, a restarted runtime consumes the fact and writes the
   result.
3. `tools/list` is served from the same descriptor projection used by v0.
4. Direct path and durable indirect path produce the same `ToolUse` at
   `toolUseToEffect` and the same `ToolResult` payload.
5. Result facts contain no credentials, Durable Streams tokens, provider session
   handles, or sandbox handles.

## Authentication And Routing

V0 can run with local-only unauthenticated HTTP for development tests. Production
mode needs explicit auth before the bridge can be installed into real agents.

The bridge must not put Durable Streams tokens or Firegrid host credentials in
the visible MCP tool catalog. Credentials belong in the MCP client config,
HTTP headers, signed URLs, or runtime-side bridge configuration.

The bridge needs a context routing rule. For the first durable implementation,
prefer an explicit bridge instance scoped to one runtime context:

```
/mcp/runtime-context/:contextId
```

That avoids accepting arbitrary `contextId` fields from agent tool arguments.
The context id is bridge configuration, not an agent-visible tool input.

Broader multi-context routing can be added later with signed invocation payloads
or token-scoped context authorization.

## Module Shape

```
packages/runtime/src/agent-tools/
  toolkit.ts             // FiregridAgentTools -> Effect AI Toolkit projection
  catalog.ts              // descriptor manifest -> MCP tool projection
  mcp-bridge.ts           // MCP SDK server + streamable HTTP transport wiring
  mcp-tool-call.ts        // ToolUse construction + CallToolResult formatting
  invocations-consumer.ts // V1 durable invocation consumer
  mcp-client.ts           // optional helper for codecs that bridge directly
```

`mcp-client.ts` is only needed for codecs that cannot install an MCP server into
their agent and instead need to act as a client of the Firegrid bridge
themselves.

## Non-Goals

- Custom JSON-RPC parser.
- Stdio MCP shim binary.
- Dynamic tool registry.
- Automatic exposure of all protocol schemas.
- Product-specific tool descriptors.
- Per-agent descriptor variation.
- Long-running per-context sidecar bridge as correctness state.
- Browser/client API surface.
- Implementing durable invocation/result rows in the first local smoke if the
  SDK-backed `tools/list` and `sleep` proof is not yet green.

## Implementation Sequence

1. Add `catalog.ts` projection tests over `FiregridAgentTools`.
2. Check `@effect/ai` dependency compatibility. If compatible, add
   `toolkit.ts` and prove `FiregridAgentTools` projects to one Effect AI
   Toolkit consumed by both bridge tests and Effect AI-style tool tests. Follow
   the `repos/rember-mcp` pattern: tagged request schemas, one toolkit, one
   toolkit implementation, MCP handlers generated from that toolkit.
3. Add an SDK-backed local `mcp-bridge.ts`.
4. Prove `tools/list`, `sleep`, invalid input, and unknown tool through an SDK
   client.
5. Add a Codex or MCP inspector local runbook and smoke.
6. Add durable invocation/result facts and `invocations-consumer.ts`.
7. Add restart and duplicate-invocation tests.
8. Wire the bridge into the runtime host only after the local SDK proof and
   durable indirect path are both green.

The in-process Effect AI sandbox provider can run in parallel with steps 1-4.
It is not on the bridge critical path, but it should be available before deeper
codec and provider tests if local-process behavior starts obscuring agent
protocol issues.

## Open Questions

1. Which SDK HTTP transport shape fits this repo with the least dependency
   weight: SDK-provided streamable HTTP transport directly, an Effect Platform
   HTTP adapter, or a small Node HTTP wrapper around the SDK transport?
2. Does the SDK expose structured content for `CallToolResult` in the version we
   adopt, or should v0 encode all result payloads as JSON text content?
3. Should long-running calls use MCP tasks/progress notifications in v1, or is a
   held `tools/call` response sufficient for the first durable path?
4. Should catalog projection include output schemas as annotations even if MCP
   clients do not require them for `tools/list`?
5. What is the first real agent smoke target: Codex CLI, Claude Code, ACP sample
   agent, or MCP inspector?
6. If `@effect/ai` requires an Effect version bump, should the toolkit work wait
   for that bump or should the MCP V0 bridge land with a small internal toolkit
   shape that mirrors Effect AI and can be replaced later?

## Decision Log

- **Why an MCP SDK server.** MCP has protocol details beyond `tools/list` and
  `tools/call`: initialize, capabilities, request ids, cancellation, streamable
  HTTP behavior, and error framing. The SDK should own that protocol surface.
- **Why start from Effect AI Toolkit.** The toolkit is the shared integration
  point between MCP publication, unit tests, and in-process agents. Defining the
  tools once as a toolkit prevents the bridge and tests from growing parallel
  schema catalogs.
- **Why copy the Rember MCP pattern.** Rember already demonstrates the practical
  shape: Effect Schema tagged requests define tools, one AiToolkit collects them,
  one toolkit implementation handles calls, the MCP SDK serves `tools/list` and
  `tools/call`, and tests reuse the same toolkit through Effect AI chat. Firegrid
  should copy that integration structure while replacing Rember's product handler
  with workflow-backed `toolUseToEffect`.
- **Why not the SDK's schema-first registration helpers by default.** Firegrid's
  schema source of truth is Effect Schema in `@firegrid/protocol`. If a helper
  requires re-authoring schemas in a second system, use lower-level SDK request
  handlers instead.
- **Why `descriptors.ts` remains explicit.** Schema reflection prevents drift,
  but exposure is an authority decision. `FiregridAgentTools` is the allowlist.
- **Why V0 is direct.** Before adding durable invocation/result facts, prove the
  protocol and descriptor projection with a real MCP client. This keeps the first
  failure surface small.
- **Why V1 is durable.** External agents and process restarts need invocation and
  result facts so tool calls are not lost if the bridge or runtime restarts.
- **Why context routing is not a tool argument.** Agents should not choose which
  runtime context they control through tool input. Context routing belongs to
  bridge configuration and authorization.
- **Why an in-process provider belongs under providers, not the bridge.** The
  bridge is an MCP protocol projection. In-process agent execution is a sandbox
  provider concern. Keeping it behind `SandboxProvider` proves the runtime is
  not coupled to the local-process subprocess model.

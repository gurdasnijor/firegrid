# SDD: Agent I/O Substrate

**Status:** Draft
**Scope:** A normalized agent-process event contract, a neutral agent-tool descriptor contract, a codec layer that adapts vendor protocols (ACP, stdio-jsonl, future) to those contracts, and the runtime-side integration that lets `RuntimeContextWorkflow` consume the contract.
**Prerequisite for:** "Agent Tool Surface as Workflow Expressions" (Phase 2)

---

## Premise

Firegrid hosts agent processes. Today it hosts them through `SandboxProvider` (currently `LocalProcessSandboxProvider`) which exposes a line-split stdout/stderr stream — good for line-oriented journaling, lossy for any wire protocol that requires byte-level framing. The recent ACP spike (tracer 023) had to bypass `SandboxProvider` and call `child_process.spawn` directly because ACP's JSON-RPC framing doesn't survive line-splitting.

Above the wire, every agent the runtime hosts has its own protocol:

- ACP (Zed, agent-client-protocol) — JSON-RPC over stdio with structured request/response/notification
- Claude Code subprocess mode — a different stdio JSON shape
- Codex / OpenAI Responses API — HTTP, not stdio
- Plain stdio-jsonl (what the existing local-process provider already supports) — line-delimited JSON
- Vendor-specific subprocess protocols that don't exist yet

The substrate has no contract for what flows between an agent process and the supervising workflow. As a result:

- The ACP tracer is an island; it doesn't compose with `RuntimeContextWorkflow`, `RuntimeOutputTable`, or any other Firegrid runtime path.
- The agent-tool-surface SDD (Phase 2) assumes the workflow body can lower known tool invocations to Effects. Today nothing publishes a protocol-neutral tool descriptor contract or produces validated tool invocations in a uniform shape.
- Adding a new agent type means either reinventing the runtime path or building another scenario-owned adapter.

This SDD defines that missing contract. The shape is borrowed from how editors handle multi-protocol language servers (LSP, DAP, ACP — same family): a small set of normalized event types, a per-protocol codec that maps the wire to the events, and a runtime that consumes the events without knowing which protocol produced them.

## Goals

1. Define a small, stable, normalized event-stream contract between agent processes and `RuntimeContextWorkflow`.
2. Define a small neutral agent-tool descriptor contract that every codec can publish through its protocol-specific mechanism.
3. Keep descriptor schemas rooted in shared `@firegrid/protocol` Effect Schemas, with catalog publication derived through schema projections rather than hand-written tool JSON.
4. Define a codec interface that maps a duplex byte stream to and from those events. Each agent kind has one codec.
5. Add a byte-pipe variant of `SandboxProvider` so agent processes can be launched through the runtime substrate, not bypassed.
6. Wire `RuntimeContextWorkflow` to consume codec output as durable events.
7. Provide an ACP codec as the first concrete implementation, replacing the scenario-owned adapter in tracer 023.
8. Provide a stdio-jsonl codec preserving the existing local-process behavior under the new contract.

## Non-goals

- No agent-side SDK. The contract is consumed by codec authors and by `RuntimeContextWorkflow`; agents themselves implement their existing protocols unchanged.
- No new public Firegrid wire protocol. ACP, MCP, vendor protocols stay external; codecs translate.
- No implementation of the six Firegrid choreography tools. This SDD defines the neutral descriptor and publication contract that codecs consume; Phase 2 defines the tool semantics and workflow lowering.
- No protocol-specific tool server implementation beyond the minimal codec proof. MCP servers for ACP, Claude/Codex tool config generation, and vendor-specific mounting can land incrementally after the descriptor contract exists.
- No automatic exposure of every `@firegrid/protocol` schema as an agent tool. Tool exposure remains an explicit manifest decision.
- No agent-process lifecycle policy (when to keep the process alive vs. exit-and-relaunch around suspensions). That decision lives in `RuntimeContextWorkflow` and is informed by the contract but not defined by it.
- No `runtime-scheduling`, no agent-tool-surface implementation. Those are downstream of this work. The tool surface SDD lands after this one.

## Conceptual model

An agent is a process. The process has a duplex byte interface — stdin and stdout in the local-process case; could be a websocket or HTTP-bidi for other deployments. The process speaks some protocol over that interface (ACP, stdio-jsonl, OpenAI API, whatever).

The runtime doesn't speak the agent's protocol directly. Instead, it speaks a small, normalized event protocol with a **codec**. The codec sits between the wire and the runtime:

```
agent process              codec                       runtime
─────────────              ─────                       ───────
                ← bytes ←
                            decodes wire → normalized event stream → workflow body
                            encodes normalized input → wire
                → bytes →
```

The codec is stateful (it tracks lifecycle, session IDs, pending request correlations, etc.). The runtime is stateless with respect to the wire format — it only sees normalized events.

This is structurally identical to how LSP works in an editor: the editor speaks an internal event model (cursor moved, document changed, hover requested); the LSP client translates those to JSON-RPC for the language server, and translates the server's responses back to internal events. Different language servers, same editor model.

## The contract

The contract has two layers:

1. **Agent I/O events**: normalized input and output events exchanged between
   `RuntimeContextWorkflow` and a codec.
2. **Agent tool descriptors**: the neutral published contract for tools that
   agents may call. Codecs lower these descriptors to ACP/MCP/Claude/Codex/etc.
   presentation, then normalize invocations back to `ToolUse`.

The tool descriptor contract is part of Phase 1 because codecs need it to
publish the same logical tool surface across protocols. Tool implementations
remain Phase 2.

### Input events (runtime → agent codec)

Sent by the workflow body, encoded by the codec, written to the agent process.

```ts
type AgentInputEvent =
  | { _tag: "Prompt"; content: PromptContent; correlationId: string }
  | { _tag: "ToolResult"; toolUseId: string; content: unknown; isError: boolean }
  | { _tag: "PermissionResponse"; permissionRequestId: string; decision: PermissionDecision }
  | { _tag: "Cancel"; reason?: string }
  | { _tag: "Terminate" }

type PromptContent = ReadonlyArray<PromptPart>
type PromptPart =
  | { _tag: "Text"; text: string }
  | { _tag: "Image"; mediaType: string; data: Uint8Array | string }
  | { _tag: "Structured"; data: unknown }

type PermissionDecision =
  | { _tag: "Allow"; optionId?: string }
  | { _tag: "Deny"; reason?: string }
  | { _tag: "Cancelled" }
```

`Prompt` carries a user/system message. `ToolResult` correlates back to a prior `ToolUse` output event by `toolUseId`. `PermissionResponse` correlates back to a prior `PermissionRequest` output event. `Cancel` requests turn-level cancellation. `Terminate` shuts down the process cleanly.

### Output events (agent codec → runtime)

Produced by the codec from the agent's wire output, consumed by the workflow body.

```ts
type AgentOutputEvent =
  | { _tag: "Ready"; capabilities: AgentCapabilities }
  | { _tag: "TextChunk"; text: string; messageId: string }
  | { _tag: "ToolUse"; toolUseId: string; name: string; input: unknown }
  | { _tag: "PermissionRequest"; permissionRequestId: string; toolUseId: string; options: ReadonlyArray<PermissionOption> }
  | { _tag: "TurnComplete"; stopReason: StopReason; messageId?: string }
  | { _tag: "Status"; kind: string; payload?: unknown }
  | { _tag: "Error"; cause: unknown; recoverable: boolean }
  | { _tag: "Terminated"; exitCode?: number }

type StopReason = "end_turn" | "tool_use" | "cancelled" | "max_tokens" | "error"

type PermissionOption = {
  readonly optionId: string
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
  readonly name: string
}
```

`Ready` is the first event a codec emits after the agent is initialized; carries capability negotiation results. `TextChunk` is streamed text output. `ToolUse` is a tool invocation request for a descriptor that was published to the agent. `PermissionRequest` is a synchronous request from the agent that requires a `PermissionResponse` input event. `TurnComplete` marks the end of a turn. `Status` is a catch-all for protocol-specific status updates (thinking, progress, etc.) — workflows can ignore by default. `Error` is a recoverable or fatal protocol error. `Terminated` is the process exiting.

### Tool descriptor contract

Tool descriptors are the public contract. The Phase 2 match expression is only
the host-side lowering of a validated invocation.

```ts
interface AgentToolDescriptor<I, O> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema.Schema<I>
  readonly outputSchema: Schema.Schema<O>
  readonly stability: "stable" | "experimental"
  readonly capabilities: AgentToolCapabilities
}

interface AgentToolCapabilities {
  readonly requiresPermission: boolean
  readonly idempotent: boolean
  readonly streaming: boolean
}
```

The schemas referenced by descriptors should come from shared protocol modules
whenever the tool is a public Firegrid operation:

```
packages/protocol/src/agent-tools/schema.ts
```

For example, `SleepToolInputSchema`, `SpawnToolInputSchema`, and
`ScheduleMeToolInputSchema` live in protocol and are imported by the runtime's
descriptor manifest. This keeps client APIs, runtime validation, and
agent-facing catalogs on the same Effect Schema source of truth.

Effect Schema projections define which side of the schema is exposed:

- `Schema.encodedSchema(descriptor.inputSchema)` is the JSON shape published to
  agents and MCP/OpenAI/Claude-style catalogs.
- `Schema.typeSchema(descriptor.inputSchema)` is the decoded runtime type that
  tool implementations consume after validation.
- `Schema.annotations` carry agent-visible descriptions, titles, examples, and
  other catalog metadata when the schema itself is the best owner for that text.
- `Schema.transform` / `Schema.transformOrFail` may keep ergonomic host-side
  types while preserving a stable encoded wire shape.

Descriptor values must not include credentials, callback tokens, signing keys,
provider session tokens, Durable Streams URLs, sandbox handles, host ids, or
transport references. Codecs may need protocol-local transport objects to expose
tools, such as MCP server config for ACP, but those objects remain below the
codec boundary and are not part of the neutral descriptor.

The same descriptor set is passed to every codec. Each codec lowers it to the
agent's protocol-specific catalog mechanism:

- ACP: MCP servers or the ACP-supported catalog mechanism for the agent.
- Claude/Codex/vendor subprocess agents: their tool catalog/config format.
- stdio-jsonl: a startup handshake or explicit introspection message if the
  codec supports tool catalogs.

Codecs do not know tool semantics. They publish descriptors, validate or route
incoming tool invocations against the descriptor catalog, and normalize accepted
invocations to `ToolUse`. Phase 2 owns what the host does with that validated
invocation.

Codecs also do not hand-author tool JSON schemas. They consume catalog entries
derived from descriptor schemas. Any codec-specific serialization, such as MCP
`inputSchema` or OpenAI function-tool parameters, is a projection of the shared
Effect Schema and annotations.

This descriptor layer is bound by
`firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.*`,
`firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.*`,
`firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.*`, and
`firegrid-scheduling-tool-bindings.TOOL_BINDINGS.*`.

### Capabilities

Codecs declare what their agent supports. The runtime queries capabilities at startup and matches workflow behavior to them.

```ts
interface AgentCapabilities {
  readonly streamingText: boolean
  readonly tools: boolean
  readonly permissions: boolean
  readonly images: boolean
  readonly structuredInput: boolean
  readonly cancellation: boolean
  readonly multiTurn: boolean
  readonly customStatus: ReadonlyArray<string>
}
```

The workflow body should refuse to send input event types the codec's capabilities don't support, and should expect not to receive output event types not declared as supported. For example, a codec with `tools: false` will never emit `ToolUse`; the workflow shouldn't construct prompts that require tool use against it.

### Why these eight output types, four input types

Each event type maps to a concrete need observed across ACP, stdio-jsonl, Claude Code subprocess, and OpenAI-API-style agents:

| Event | ACP equivalent | stdio-jsonl equivalent | Claude Code | OpenAI |
|---|---|---|---|---|
| `Ready` | `initialize` response | first line after launch | startup ack | — (always ready) |
| `Prompt` | `session/prompt` | `{"role":"user","content":...}` line | injected via stdin | API request body |
| `TextChunk` | `session/update agent_message_chunk` | `{"type":"assistant","text":...}` lines | streamed deltas | streaming chunks |
| `ToolUse` | `session/update tool_call` | `{"type":"tool_use",...}` line | function-call deltas | `tool_calls` |
| `ToolResult` | n/a (out-of-band in ACP) | `{"type":"tool_result",...}` line | function-call results | tool-output messages |
| `PermissionRequest` | `session/request_permission` | n/a (or custom) | n/a | n/a |
| `PermissionResponse` | response to permission | n/a | n/a | n/a |
| `TurnComplete` | `session/prompt` response with stopReason | `{"type":"end_turn",...}` line | finish_reason | response.completed |
| `Status` | `session/update` (other kinds) | `{"type":"status",...}` lines | progress events | — |
| `Cancel` | `session/cancel` | SIGINT or `{"type":"cancel"}` | SIGINT | abort signal |
| `Terminate` | close stream | EOF stdin | SIGTERM | — (no process) |
| `Error` | error notifications | stderr line interpreted | stderr | API errors |
| `Terminated` | process exits | process exits | process exits | — |

Every event type is required by at least one current target. None are speculative. Some codecs (`Codec.permissions: false`) won't use permission events; that's fine.

## Codec interface

A codec is a per-agent-kind module implementing this interface:

```ts
interface AgentCodec {
  readonly kind: string
  readonly capabilities: AgentCapabilities

  // Open: bind the codec to a duplex byte stream. Returns a scoped Effect
  // that produces the event streams. When the scope closes, the codec
  // tears down (closes streams, finalizes pending correlations).
  open: (
    bytes: AgentByteStream,
    options: AgentCodecOpenOptions,
  ) => Effect.Effect<AgentSession, AgentCodecError, Scope.Scope>
}

interface AgentCodecOpenOptions {
  readonly toolCatalog: ReadonlyArray<AgentToolDescriptor<unknown, unknown>>
}

interface AgentByteStream {
  readonly stdin: Writable<Uint8Array>
  readonly stdout: Readable<Uint8Array>
  readonly stderr: Readable<Uint8Array>
}

interface AgentSession {
  // Push an input event. Codec encodes and writes to stdin.
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>

  // Consume output events. Stream completes when the agent terminates
  // or the session is interrupted.
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}
```

`AgentByteStream` is the duplex interface the substrate provides — see "Byte-pipe SandboxProvider" below. The codec doesn't know whether the bytes are coming from a local process, a remote agent, or a websocket.

`AgentCodecError` is a tagged union for codec-level failures (framing errors, protocol violations, unexpected EOF). The codec is responsible for distinguishing recoverable errors (`Error` output event with `recoverable: true`) from fatal ones (stream fails with `AgentCodecError`).

The codec is **stateful**. It tracks:
- Lifecycle phase (initializing, ready, busy, terminated)
- Pending request correlations (ACP request IDs, tool_use IDs)
- Session identifiers (for protocols that have them, like ACP's `sessionId`)
- Capability negotiation results
- The frozen descriptor catalog visible to the agent

These are internal to the codec; the workflow body never sees protocol-specific
state. The workflow body sees only normalized events and descriptor-backed tool
invocations.

## Byte-pipe SandboxProvider

The current `LocalProcessSandboxProvider.stream(...)` line-splits stdout/stderr and journals each line to `RuntimeOutputTable.events`. This is correct for jsonl agents but wrong for byte-framed protocols like ACP.

This SDD adds a parallel API:

```ts
interface SandboxProvider {
  // Existing line-split API (preserved for jsonl agents)
  readonly stream: (...) => Effect.Effect<LineStream, ...>

  // New byte-pipe API for protocols that need raw framing
  readonly openBytePipe: (
    config: SandboxConfig,
  ) => Effect.Effect<AgentByteStream, SandboxProviderError, Scope.Scope>
}
```

`openBytePipe` returns a scoped `AgentByteStream` — the same duplex shape codecs consume. The process is launched, scoped to the returned scope; closing the scope kills the process.

For `LocalProcessSandboxProvider`, `openBytePipe` is a thin wrapper around `child_process.spawn` returning the child's stdio as web streams. For remote sandboxes (E2B, Daytona, future providers), the implementation differs but the interface is the same.

**Journaling under byte-pipe mode:** the codec is responsible for emitting durable observations of the bytes flowing through. A codec wraps each direction in a tap that writes to a caller-owned observation table (the pattern tracer 023 already established). The substrate doesn't journal raw bytes — that's the codec's call. This is intentional: byte-level framing is opaque to the substrate, so journaling has to happen at the protocol-aware layer.

A `StdioJsonlCodec` preserves the existing journaling behavior by writing `RuntimeOutputTable.events` rows from each parsed JSON line, exactly as the current local-process path does. The line-split `stream` API stays for backwards compatibility but new agents launched via `openBytePipe` get codec-driven journaling instead.

## Integration with `RuntimeContextWorkflow`

The workflow body's outer loop becomes:

```ts
const runtimeContextWorkflowBody = ({ contextId, agentKind }) =>
  Effect.gen(function* () {
    const codec = yield* selectCodec(agentKind)
    const sandbox = yield* SandboxProvider
    const bytes = yield* sandbox.openBytePipe(config)
    const toolCatalog = yield* selectToolCatalog(contextId, agentKind)
    const session = yield* codec.open(bytes, { toolCatalog })

    // Wait for Ready event
    const ready = yield* expectReady(session.outputs)

    // Main loop: pull input from RuntimeIngressTable, feed to agent,
    // consume output events, write durable observations.
    while (true) {
      const input = yield* readNextInputOrTerminate(contextId)
      if (input._tag === "terminate") {
        yield* session.send({ _tag: "Terminate" })
        return
      }

      yield* session.send({ _tag: "Prompt", content: input.content, correlationId: input.inputId })

      const turnResult = yield* consumeUntilTurnComplete(session.outputs, contextId)
      if (turnResult._tag === "terminated") return
    }
  })
```

`consumeUntilTurnComplete` is the loop that reads output events and writes durable observations:

```ts
const consumeUntilTurnComplete = (outputs, contextId) =>
  Stream.runForeachEffect(outputs, event =>
    Match.value(event).pipe(
      Match.tag("TextChunk", e => recordOutputEvent(contextId, e)),
      Match.tag("ToolUse", e => handleToolUse(contextId, e)),  // ← Phase 2 hooks in here
      Match.tag("PermissionRequest", e => handlePermissionRequest(contextId, e)),
      Match.tag("Status", e => recordStatusEvent(contextId, e)),
      Match.tag("TurnComplete", e => Effect.succeed({ _tag: "complete" as const })),
      Match.tag("Error", e => handleError(contextId, e)),
      Match.tag("Terminated", e => Effect.succeed({ _tag: "terminated" as const })),
      Match.exhaustive,
    )
  )
```

The Phase 2 tool surface attaches at the `ToolUse` arm. Phase 1 is responsible
for making `ToolUse` refer to a published descriptor and for validating, or
otherwise explicitly routing, the invocation through the descriptor catalog.
The Phase 2 SDD's `toolUseToEffect` becomes the implementation of
`handleToolUse`; the workflow body sends back a `ToolResult` input event when
the tool completes.

This is the seam between the two SDDs: Phase 1 defines `ToolUse`/`ToolResult`
as event types plus the descriptor catalog publication contract; Phase 2
defines what work the workflow does between observing a descriptor-backed
`ToolUse` and sending the `ToolResult`.

## Codecs to implement

### `AcpCodec`

Replaces the scenario-owned ACP adapter in tracer 023. The codec must consume
the neutral tool catalog passed to `AgentCodec.open` and lower it through ACP's
actual tool presentation mechanism. If that mechanism is MCP, the MCP mount is
codec/deployment plumbing around the same neutral descriptor contract; the codec
still emits normalized `ToolUse` events backed by the descriptor catalog.

Implements:
- `initialize` lifecycle → `Ready` output
- `session/new` once at session start (internal to codec)
- `session/prompt` ← `Prompt` input
- `session/update agent_message_chunk` → `TextChunk` output
- `session/update tool_call` → descriptor-backed `ToolUse` output
- `session/update tool_call_update` → either `ToolUse` follow-up (status: pending → completed) or `Status` if it's purely informational
- `session/request_permission` → `PermissionRequest` output
- response to `session/request_permission` ← `PermissionResponse` input
- `session/prompt` response → `TurnComplete` output
- `session/cancel` ← `Cancel` input

Capabilities: `{ streamingText: true, tools: true, permissions: true, images: false, structuredInput: false, cancellation: true, multiTurn: true, customStatus: ["tool_call_update"] }` (or whatever the actual ACP capability set is).

Lives in `packages/runtime/src/agent-codecs/acp/`. Depends on `@agentclientprotocol/sdk`.

### `StdioJsonlCodec`

Implements the existing local-process JSON-lines protocol. Each stdout line is parsed as JSON; the `type` field switches on event mapping:

- `{"type":"assistant","text":"..."}` → `TextChunk`
- `{"type":"tool_use",...}` → `ToolUse`
- `{"type":"end_turn",...}` → `TurnComplete`
- (etc., based on existing local-process protocol)

stdin receives JSON lines: `Prompt` and `ToolResult` are serialized to lines.

Capabilities: matches what current local-process agents support. Probably `{ streamingText: true, tools: true, permissions: false, ... }`.

Lives in `packages/runtime/src/agent-codecs/stdio-jsonl/`. No external dependency.

### Other codecs (future)

`ClaudeCodeCodec`, `OpenAiResponsesCodec`, `CodexCodec`, etc. land independently as product needs surface. Each is a codec module implementing `AgentCodec`. None require substrate changes.

## Codec registration

Codecs are registered at runtime-host startup:

```ts
const codecRegistry = CodecRegistry.make([
  AcpCodec,
  StdioJsonlCodec,
  // future codecs
])
```

`RuntimeContextWorkflow` looks up the codec by the context's declared `agentKind` field. The agent-kind is part of the `RuntimeContext` row schema (a new field, optional with a default of `"stdio-jsonl"` for backward compatibility).

Registration is static — codecs are TS modules compiled into the runtime host. There's no plugin system, no dynamic discovery. Adding a codec is a PR.

## Module layout

```
packages/runtime/src/
  agent-io/
    contract.ts              // AgentInputEvent, AgentOutputEvent, AgentCapabilities
    codec.ts                 // AgentCodec interface, AgentSession, errors
    byte-stream.ts           // AgentByteStream type
    registry.ts              // CodecRegistry
  agent-codecs/
    acp/
      index.ts               // AcpCodec
      framing.ts             // ndjson framing helpers
      ...
    stdio-jsonl/
      index.ts               // StdioJsonlCodec
      ...
  providers/
    sandboxes/
      SandboxProvider.ts     // updated interface (existing file)
      local-process.ts       // adds openBytePipe (existing file)
  runtime-context/           // (Phase 2 lives here, depends on agent-io)
```

Shared agent-tool schemas live outside the runtime package:

```
packages/protocol/src/agent-tools/
  schema.ts                  // shared Effect Schemas for tool inputs/outputs
  index.ts                   // exports shared schemas and types
```

## Validation

### Per-codec tests

For each codec (ACP, stdio-jsonl):

1. Lifecycle: agent launches, codec emits `Ready` with correct capabilities.
2. Prompt → text response: `Prompt` input produces `TextChunk` outputs and a `TurnComplete`.
3. Tool use round-trip: agent emits `ToolUse`, runtime sends `ToolResult`, agent continues.
4. Permission round-trip (codecs that support it): agent emits `PermissionRequest`, runtime sends `PermissionResponse`, agent continues.
5. Cancellation: `Cancel` input results in `TurnComplete` with `stopReason: "cancelled"`.
6. Error: malformed wire input produces `Error` output event with `recoverable: true` (or stream fails for fatal errors).
7. Termination: `Terminate` input produces `Terminated` output and clean process exit.

### Contract tests

For both codecs against the same workflow body:

1. Run an end-to-end turn through `RuntimeContextWorkflow` with the codec selected; assert `RuntimeIngressTable` and `RuntimeOutputTable` rows match expected shape regardless of codec.
2. The workflow body should be identical for both codecs (modulo capability differences). This is the proof that the contract abstracts correctly.
3. Descriptor catalog entries are generated from shared protocol Effect Schemas
   using encoded-schema projection and annotations; tests must not compare
   against a separately hand-authored JSON Schema copy.

### Tracer 023 re-targeting

The existing ACP tracer is re-pointed at `AcpCodec` going through
`RuntimeContextWorkflow` and `openBytePipe`. The scenario-owned `runAcpTurn`
adapter is deleted. The tracer must not fake descriptor injection; it either
proves the ACP codec can publish the neutral catalog through ACP's real tool
mechanism or explicitly documents the mount blocker while still proving prompt
and observation behavior. What remains: a tracer proving the ACP codec, the
byte-pipe SandboxProvider, and `RuntimeContextWorkflow` integrate end-to-end.

## PR sequencing

### PR 1: Contract + registry + byte-pipe SandboxProvider

- `packages/runtime/src/agent-io/` with event types, neutral tool descriptor
  type, codec interface, registry
- `packages/protocol/src/agent-tools/` with shared Effect Schemas for
  descriptor inputs/outputs that are exposed to agents
- `SandboxProvider.openBytePipe` API added
- `LocalProcessSandboxProvider.openBytePipe` implemented
- Unit tests for descriptor validation, schema projection, the registry, and the
  byte-pipe wrapper
- No codecs yet, no `RuntimeContextWorkflow` changes

Lands as a foundation. ~400 lines of production code, ~300 of tests.

### PR 2: `StdioJsonlCodec` + workflow integration

- `StdioJsonlCodec` implementing the existing line-protocol under the contract
- A minimal catalog publication/handshake path for codecs that support it, or
  explicit capability refusal for codecs that do not
- `RuntimeContextWorkflow` updated to consume codec output events
- Existing local-process integration tests re-targeted at the codec path
- Old line-split path remains for non-workflow callers

Lands to prove the contract works for the existing case. ~500 lines + tests.

### PR 3: `AcpCodec`

- `AcpCodec` implementing ACP semantics under the contract
- Neutral descriptor catalog lowering through ACP's real tool presentation path,
  or an explicit documented blocker if the ACP SDK surface does not expose one
- Tracer 023 re-targeted; scenario-owned adapter deleted
- ACP-specific tests for permission round-trip, session lifecycle

Lands to prove the contract works for a second, structurally different agent. ~600 lines + tests.

### PR 4 (Phase 2): Agent Tool Surface as Workflow Expressions

The revised Phase 2 SDD lands here. The descriptor set is the public contract;
the `handleToolUse` arm in `consumeUntilTurnComplete` invokes
`toolUseToEffect` as the host-side lowering of a validated descriptor
invocation; the workflow body sends the resulting `ToolResult` event back
through the codec. The tool surface SDD's primitives (`DurableClock.sleep`,
`Workflow.execute`, activities) are unchanged.

## Open questions

1. **Permission semantics in non-ACP codecs.** ACP has structured permissioning. `StdioJsonlCodec` doesn't. Does the contract require any codec without `permissions: true` to fall back on a default decision, or do workflows simply not emit tool calls that would require permission against such codecs? Lean: latter. Tools requiring permission are agent-kind-specific and shouldn't be exposed against codecs that can't handle them.

2. **Image input encoding.** `PromptPart.Image` carries `Uint8Array | string`. ACP supports base64-encoded images; OpenAI API supports URLs. Codecs handle the encoding per their wire format. The contract's union allows both shapes; codec validation rejects what it can't encode.

3. **Status event proliferation.** ACP has `tool_call_update`, `available_commands_update`, `current_mode_update`, etc. as `session/update` variants. Mapping them all to `Status` events is lossy but compact. Workflow bodies can ignore by default. If specific status kinds become important, they can be promoted to dedicated event types later.

4. **Multi-session protocols.** ACP supports multiple concurrent sessions per agent process. The contract assumes one session per codec instance. If multi-session is needed, the codec can multiplex internally but expose the contract as if it were single-session, with multiple codec instances if necessary.

5. **Codec capabilities at compile time vs. negotiated at runtime.** Some capabilities are static (ACP always supports tools); some are negotiated (specific agent instances may not). For now, capabilities are codec-static. If runtime negotiation becomes important, `Ready` can carry runtime-negotiated capabilities that override codec-static defaults.

6. **Backpressure.** The contract is stream-based but doesn't specify backpressure semantics. Effect's `Stream` provides natural backpressure; codecs should respect it. Worth confirming with one slow-consumer scenario test.

## Decision log

- **Why a normalized event contract rather than picking ACP as canonical.** ACP is one of several protocols. Adoption is limited. The runtime substrate shouldn't be coupled to one external protocol's vocabulary; coupling at the codec layer is cheap, coupling at the substrate is expensive.
- **Why eight output / four input event types.** Each event maps to an observed need across the four most likely codecs. Smaller would force codecs to fake structure; larger would force workflow bodies to handle protocol-specific noise.
- **Why static codec registration.** Plugin systems add complexity for a benefit (third-party codecs) that isn't a current need. Static registration with a PR per codec is the right friction for the current product surface.
- **Why byte-pipe alongside line-split rather than replacing.** Existing local-process tests, journaling, and operational tooling depend on the line-split shape. Adding byte-pipe as a parallel API lets new agents use it without breaking the existing path.
- **Why codecs own journaling under byte-pipe mode.** Bytes are opaque; only the codec knows how to write meaningful observation rows. Pushing journaling into the substrate would require the substrate to understand every protocol, which is exactly what this SDD avoids.
- **Why no agent-side SDK.** The runtime is the integration point. Agents implement their existing protocols; codecs handle translation. Agents shipping a Firegrid SDK would be appropriate if Firegrid wanted to be an agent protocol — it doesn't.
- **Why this is Phase 1 and the tool surface is Phase 2.** The tool surface SDD assumed parsed `ToolUse` events; this SDD produces them. Reversing the order would mean the tool surface SDD inventing a private event model in the workflow body, which is exactly the duplication this avoids.
- **Why shared protocol schemas and explicit runtime descriptors.** Effect
  Schemas for public tool inputs and outputs live in `@firegrid/protocol` so
  clients, codecs, and runtime validation cannot drift. The runtime descriptor
  manifest explicitly selects which schemas are exposed as tools and binds each
  to a host-side lowering arm. Reflection over every protocol schema would expose
  storage rows and internal facts that are not agent-callable operations.
- **Why catalog JSON is generated from Effect Schema projections.** Agents see
  encoded JSON shapes, while runtime code consumes decoded types. Using
  `Schema.encodedSchema`, annotations, and transforms preserves that distinction
  and avoids duplicating JSON Schema by hand in codec or catalog code.

## Migration

- Existing local-process tests using line-split journaling continue to work; the line-split `stream` API is preserved.
- `RuntimeContextWorkflow` gains a codec-selection step; default codec is `StdioJsonlCodec` for backward compatibility.
- Existing `RuntimeContext` rows without an explicit `agentKind` default to `"stdio-jsonl"`.
- The ACP tracer scenario-owned adapter (`scenarios/firegrid/src/fixtures/acp-adapter.ts`) is deleted in PR 3; replaced by `AcpCodec` consumed through the standard runtime path.

## Out of scope (named explicitly)

- **Implementation of Firegrid's six choreography tools.** Phase 1 defines the
  descriptor contract and codec publication boundary. Phase 2 defines the
  canonical Firegrid descriptor set and the workflow lowering for each tool.
- **Automatic protocol-schema reflection.** `@firegrid/protocol` is the schema
  source of truth, but only explicitly listed descriptors are exposed to agents.
- **Protocol-specific production tool servers.** MCP servers for ACP and
  vendor-specific catalog/config generation can be implemented per codec or
  deployment profile. They must consume the neutral descriptor catalog rather
  than defining separate tool schemas.
- **Codec authoring SDK or guide for third parties.** Internal codecs only for now.
- **Remote agent processes.** `openBytePipe` is implemented for local processes here; remote-sandbox implementations land as separate `SandboxProvider` work when remote sandboxes mature.

---

## On the Phase 2 SDD

The "Agent Tool Surface as Workflow Expressions" SDD needs a framing correction
before implementation: the match expression is the host implementation, not the
public abstraction. The descriptor set is the public contract that codecs
publish and agents call. With that correction, the workflow primitives and most
per-tool semantics remain usable.

**1. The premise paragraph should be amended** to make the dependency on Phase 1 explicit. Replace:

> When an agent emits a `tool_use` message in its stdout, the runtime must produce a corresponding `tool_result` and inject it into the agent's stdin.

with:

> The Agent I/O Substrate (Phase 1) gives `RuntimeContextWorkflow` a normalized stream of agent output events including `ToolUse`. The substrate also accepts a `ToolResult` input event that the workflow body emits back to the codec, which encodes and writes it to the agent. This SDD specifies what work happens between observing the `ToolUse` event and emitting the corresponding `ToolResult` event.

**2. The `toolUseToEffect` signature should be amended** to consume a
descriptor-backed Phase 1 event:

```ts
toolUseToEffect: (
  ctx: { contextId: string },
  event: Extract<AgentOutputEvent, { _tag: "ToolUse" }>,
) => Effect.Effect<Extract<AgentInputEvent, { _tag: "ToolResult" }>, never, R>
```

The function returns a `ToolResult` *input event* directly, not an ad-hoc
`ToolResult` type. The Phase 1 contract owns the types. Phase 2 owns the
canonical Firegrid descriptor set and the lowering implementation.

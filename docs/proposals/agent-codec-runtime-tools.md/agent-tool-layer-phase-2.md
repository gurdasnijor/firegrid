# SDD: Agent Tool Surface as Workflow Expressions (Phase 2)

**Status:** Draft
**Depends on:** Agent I/O Substrate (Phase 1) — defines `AgentInputEvent`, `AgentOutputEvent`, neutral `AgentToolDescriptor`, codec publication, byte-pipe `SandboxProvider`
**Scope:** Canonical Firegrid agent-tool descriptors plus host-side lowering of validated descriptor invocations (`sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, `execute`) to Effect expressions in `RuntimeContextWorkflow`'s body

---

## Premise

The Agent I/O Substrate (Phase 1) gives `RuntimeContextWorkflow` a normalized stream of agent output events including descriptor-backed `ToolUse`. The substrate also accepts a `ToolResult` input event that the workflow body emits back to the codec, which encodes and writes it to the agent. This SDD specifies the canonical Firegrid tool descriptors and what work happens between observing a validated `ToolUse` invocation and emitting the corresponding `ToolResult` event.

The premise: **agent tools have a published descriptor contract and a host-side lowering implementation.** The descriptor contract is the neutral binding surface that every codec publishes. The match expression is the implementation technique that lowers a validated descriptor invocation to an Effect; it is not the public abstraction.

```
toolUseToEffect: (
  ctx: { contextId: string },
  event: Extract<AgentOutputEvent, { _tag: "ToolUse" }>,
) => Effect.Effect<Extract<AgentInputEvent, { _tag: "ToolResult" }>, never, R>
```

Defined by looking up the descriptor for `event.name`, decoding `event.input`
with that descriptor's `inputSchema`, then pattern matching on the canonical
tool name. Unknown tools, invalid inputs, and tool execution failures all become
`ToolResult` events with `isError: true`; they do not fail the workflow. New
tools require both a descriptor (public contract) and a match arm (host
implementation).

Phase 1 owns the event and descriptor types. Phase 2 owns the canonical Firegrid descriptor set and the lowering function.

## Goals

1. Define the canonical Firegrid descriptor set for all six agent tools (`sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, `execute`) as an explicit manifest over shared `@firegrid/protocol` Effect Schemas.
2. Implement all six agent tools as composable arms of `toolUseToEffect` in `RuntimeContextWorkflow`.
3. Use only existing primitives. Introduce no new substrate modules.
4. Each tool arm produces the correct `ToolResult` input event for the codec to encode and deliver to the agent.
5. Establish replay-safe execution: every tool arm must be safe to re-execute under workflow replay.
6. Prove runtime API calls and agent tool calls lower to the same durable shapes.

## Non-goals

- No dynamic tool-registration registry. Tools are statically known; new tools are PRs that add shared protocol schemas, a descriptor, and a match arm.
- No agent-side SDK changes. Agents emit `tool_use` in their native protocol; the codec normalizes; the workflow body matches.
- No new sandbox provider work beyond what Phase 1 lands. `execute` consumes the existing `SandboxProvider` interface.
- No protocol-specific catalog mounting implementation. Phase 1 codecs publish neutral descriptors through their wire protocol; MCP/ACP/Claude/Codex presentation details stay below the codec boundary.
- No agent-process lifecycle policy. Whether the process stays alive across a long suspension is decided by Phase 1's codec/workflow integration, not by individual tool arms.
- No automatic reflection of every `@firegrid/protocol` schema. Protocol schemas are the source of truth for shapes, but descriptor exposure is an explicit allowlist.

## Primitives used

Three from `@effect/workflow`:

- **`DurableClock.sleep`** — durable timer. Survives replay.
- **`Workflow.execute` / `Workflow.await`** — start a child workflow and durably await its completion. Used for `spawn`, `spawn_all`, and the fire-and-forget background workflow for `schedule_me`.
- **Workflow activities** — retried, replayed side-effecting functions. Used for sandbox tool execution, ingress appends, and durable stream subscriptions.

The Agent I/O Substrate (Phase 1) provides:

- The `ToolUse` and `ToolResult` event types
- The neutral `AgentToolDescriptor<I, O>` type and codec publication contract
- The codec layer that translates these to/from each agent's wire format
- The byte-pipe `SandboxProvider` variant that hosts the agent process

`DurableDeferred` from `@effect/workflow` is available but unused by any of the six initial tools. After working through each tool, the wait cases were cleaner with long-running activities than with ID-addressable rendezvous.

## Canonical descriptors

The descriptor set is the public contract. Codecs publish this set to agents
through their protocol-specific mechanism, and the workflow lowering implements
the same set.

The descriptor set is not a second schema universe. It is an explicit exposure
manifest over schemas owned by `@firegrid/protocol`. Public tool input/output
schemas live in:

```
packages/protocol/src/agent-tools/schema.ts
```

`descriptors.ts` imports those schemas and attaches exposure metadata: canonical
tool name, stability, capabilities, and the lowering identity used by
`toolUseToEffect`.

```ts
export const FiregridAgentTools = {
  sleep: defineAgentTool({
    name: "sleep",
    description: "Durably suspend until a duration elapses.",
    inputSchema: AgentToolSchemas.SleepToolInputSchema,
    outputSchema: AgentToolSchemas.SleepToolOutputSchema,
    stability: "stable",
    capabilities: { requiresPermission: false, idempotent: true, streaming: false },
  }),
  wait_for: defineAgentTool({ /* ... */ }),
  spawn: defineAgentTool({ /* ... */ }),
  spawn_all: defineAgentTool({ /* ... */ }),
  schedule_me: defineAgentTool({ /* ... */ }),
  execute: defineAgentTool({ /* ... */ }),
} as const
```

The initial descriptors are:

- `sleep`: input `{ durationMs: number }`, output `{ slept: true }`, stable.
- `wait_for`: input `{ eventQuery: EventQuery; timeoutMs?: number }`, where
  `EventQuery` starts as `{ stream: string; whereFields: Record<string, unknown> }`;
  output `{ matched: true; event: unknown } | { matched: false; timedOut: true }`,
  experimental until production validation.
- `spawn`: input `{ agentKind: string; prompt: string; options?: SpawnOptions }`,
  output `{ childContextId: string; terminalState: WorkflowTerminalState }`,
  stable once Phase 1 child context execution is production-shaped.
- `spawn_all`: input `{ tasks: SpawnTask[] }`, output
  `{ children: { key: string; childContextId: string; terminalState: WorkflowTerminalState }[] }`,
  experimental until fan-out limits are validated.
- `schedule_me`: input `{ when: number; prompt: string }`, output
  `{ scheduled: true; scheduleId: string }`, experimental until cancellation and
  recurring schedule needs are clearer.
- `execute`: input `{ sandbox: SandboxRef; input: unknown }`, output `unknown`
  at the descriptor level with sandbox-specific runtime validation, stable for
  activity-bounded sandbox calls.

Descriptor fields do not include credentials, callback tokens, provider session
tokens, Durable Streams URLs, sandbox handles, host ids, or transport refs.
Those are host-side authority and codec/deployment configuration, not
agent-visible contract.

`catalog.ts` is only a projection/publication layer. It derives the
agent-visible catalog from descriptors using the shared schemas:

- publish `Schema.encodedSchema(descriptor.inputSchema)` as the agent-callable
  JSON shape;
- use `Schema.annotations` for titles, descriptions, examples, and other
  catalog metadata where the schema is the natural owner;
- keep `Schema.typeSchema(descriptor.inputSchema)` as the decoded host-side
  input shape after validation;
- preserve transforms so host ergonomics can improve without changing the
  encoded catalog shape.

Catalog code must not maintain a hand-written JSON Schema copy of any tool
input or output shape.

## The function

```ts
import type { AgentInputEvent, AgentOutputEvent } from "@firegrid/runtime/agent-io"

const toolUseToEffect = (
  ctx: { contextId: string },
  event: Extract<AgentOutputEvent, { _tag: "ToolUse" }>,
): Effect.Effect<Extract<AgentInputEvent, { _tag: "ToolResult" }>, never, WorkflowContext> =>
  Effect.gen(function* () {
    const descriptor = FiregridAgentTools[event.name as keyof typeof FiregridAgentTools]
    if (descriptor === undefined) {
      return unknownToolResult(event.toolUseId, event.name)
    }

    const decoded = yield* Schema.decodeUnknown(descriptor.inputSchema)(event.input).pipe(
      Effect.either,
    )
    if (decoded._tag === "Left") {
      return invalidInputResult(event.toolUseId, event.name, decoded.left)
    }

    return yield* runKnownTool(ctx, {
      toolUseId: event.toolUseId,
      name: descriptor.name,
      input: decoded.right,
    }).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknown(descriptor.outputSchema)(result.content).pipe(
          Effect.as(result),
          Effect.catchAll((cause) =>
            Effect.succeed(toolExecutionFailedResult(event.toolUseId, event.name, cause))
          ),
        )
      ),
      Effect.catchAll((error) =>
        Effect.succeed(toolErrorResult(event.toolUseId, event.name, error))
      ),
    )
  })

const runKnownTool = (ctx, invocation) =>
  Match.value(invocation).pipe(
    Match.when({ name: "sleep" }, ({ toolUseId, input }) =>
      DurableClock.sleep({
        name: `tool:${toolUseId}`,
        duration: Duration.millis(input.durationMs),
      }).pipe(Effect.as(toolResult(toolUseId, { slept: true })))
    ),
    Match.when({ name: "wait_for" }, ({ toolUseId, input }) =>
      runWaitForTool(ctx, toolUseId, input)
    ),
    Match.when({ name: "spawn" }, ({ toolUseId, input }) =>
      runSpawnTool(ctx, toolUseId, input)
    ),
    Match.when({ name: "spawn_all" }, ({ toolUseId, input }) =>
      runSpawnAllTool(ctx, toolUseId, input)
    ),
    Match.when({ name: "schedule_me" }, ({ toolUseId, input }) =>
      runScheduleMeTool(ctx, toolUseId, input)
    ),
    Match.when({ name: "execute" }, ({ toolUseId, input }) =>
      runExecuteTool(ctx, toolUseId, input)
    ),
    Match.exhaustive,
  )
```

That is the implementation shape. Descriptor lookup and Schema decoding are the boundary; the match expression lowers known, validated descriptor invocations to Effects.

## Per-tool semantics

### `sleep`

**Input shape:** `{ durationMs: number }`
**Suspension:** workflow-only via `DurableClock.sleep`. The codec/workflow integration decides whether the agent process stays alive (Phase 1 concern).
**Replay safety:** `DurableClock.sleep` with a named identifier is idempotent under replay.
**Result:** `{ slept: true }`

### `wait_for`

**Input shape:** `{ eventQuery: EventQuery; timeoutMs?: number }`
**Suspension:** workflow-only via `waitForMatchActivity` (a long-running activity that subscribes to a durable stream and returns on first match), optionally raced against `DurableClock.sleep` for timeout.
**Replay safety:** the activity's key is deterministic from `toolUseId`. On replay, the activity re-subscribes from the durable stream's snapshot; first-match semantics are deterministic given the stream contract.
**Result:** `{ matched: true, event: ... }` or `{ matched: false, timedOut: true }`

**Open:** the shape of `EventQuery`. Initial proposal: a fixed-record match query (`{ stream: string; whereFields: Record<string, unknown> }`). CEL-expression predicates are deferred until concrete need.

### `spawn`

**Input shape:** `{ agentKind: string; prompt: string; options?: SpawnOptions }`
**Suspension:** workflow-only via `Workflow.execute`'s implicit await on child completion.
**Replay safety:** child execution ID is deterministic from parent `contextId` and `toolUseId`. Re-execution with an existing executionId returns the existing child's result.
**Result:** `{ childContextId, terminalState }`

### `spawn_all`

**Input shape:** `{ tasks: SpawnTask[] }` where each task has `agentKind`, `prompt`, optional `key`, optional `options`.
**Suspension:** workflow-only. Awaits all children concurrently.
**Replay safety:** each child's executionId derives from `toolUseId` and either the task's `key` or its index.
**Result:** `{ children: [{ key, childContextId, terminalState }] }`

**Note:** `concurrency: "unbounded"` is the default. A real fan-out limit may be needed at scale; this is a tuning parameter, not a design decision.

### `schedule_me`

**Input shape:** `{ when: number; prompt: string }`
**Suspension:** none. This is Shape B — the call returns immediately after committing the schedule intent via fire-and-forget child workflow. The agent's *current* execution continues without pause.
**Replay safety:** the `ScheduledInputWorkflow` is started with a deterministic executionId derived from `toolUseId`; re-execution is idempotent.
**Result:** `{ scheduled: true, scheduleId }`

**Note:** the agent's *future* execution receives the scheduled prompt via Phase 1's `Prompt` input event on its next launch; it does not observe the connection to this `schedule_me` call. This is the intended Shape B semantic.

### `execute`

**Input shape:** `{ sandbox: SandboxRef; input: unknown }`
**Suspension:** activity-bounded. The workflow suspends for the duration of the activity.
**Replay safety:** activity execution is the workflow engine's responsibility; under replay the activity's recorded result is returned without re-execution.
**Result:** the activity's return value (sandbox tool result).

### Unknown tool

If the agent emits a `ToolUse` with a name not present in the descriptor set published for this runtime, `toolUseToEffect` returns a `ToolResult` with `isError: true` and an error message. The workflow doesn't fail; the agent receives a structured error and can choose to retry, escalate, or terminate.

## Descriptor publication to codecs

The descriptor set is read by Phase 1's codec layer at session-open time via
`AgentCodecOpenOptions.toolCatalog`. The same descriptor instances are passed to
every codec. There is no per-codec descriptor variation; only per-codec
lowering.

For MCP-capable agents, Firegrid publishes the descriptor set through a
Streamable HTTP MCP tool bridge. The bridge is a thin HTTP handler over Durable
Streams-backed catalog, invocation, and result streams:

- catalog stream: durable source for MCP `tools/list`;
- invocations stream: durable source for MCP `tools/call` requests;
- results stream: durable source for invocation results and resumable delivery.

The bridge URL must speak MCP's Streamable HTTP JSON-RPC protocol. A raw Durable
Streams stream URL is not itself an MCP endpoint: Durable Streams provides
append/read/live-tail HTTP primitives, while MCP clients expect JSON-RPC
`initialize`, `tools/list`, `tools/call`, and session/lifecycle behavior at one
endpoint. The bridge can be stateless and can be hosted as a product route or
Worker backed by Durable Streams, but some handler must perform this protocol
mapping.

Codecs use the bridge as follows:

- ACP: pass the bridge URL through `NewSessionRequest.mcpServers` when the ACP
  agent supports MCP servers.
- Claude Code / Codex / other CLI agents: write the agent's normal MCP config
  pointing at the bridge URL, with credentials referenced through env/config.
- HTTP-shaped model codecs: either pass the bridge URL through a native MCP
  connector if the API supports one, or use `mcp-client.ts` to list tools,
  append invocations, and subscribe for results while presenting native tool
  schemas to the API.

The match expression does not depend on which codec published the catalog or
which transport produced the invocation. Phase 1 normalizes invocations to the
same `ToolUse` event shape.

Descriptor publication is bound by
`firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.*`,
`firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.*`,
`firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.*`, and
`firegrid-scheduling-tool-bindings.TOOL_BINDINGS.*`.

## Invocation routing

Tool invocations arrive at Firegrid through two paths:

1. **Direct path**: a codec normalizes a protocol-specific tool call, such as
   ACP `session/update tool_call` or stdio-jsonl `{"type":"tool_use",...}`, into
   a `ToolUse` event delivered to the workflow body's
   `consumeUntilTurnComplete` loop. This is used when the codec is in-process
   with the workflow.
2. **Indirect path**: an agent's MCP client calls the Firegrid Streamable HTTP
   MCP bridge. The bridge records the invocation durably, then
   `invocations-consumer.ts` subscribes to the invocation stream and routes the
   invocation to the appropriate `RuntimeContextWorkflow` based on the
   invocation payload.

Both paths converge at `toolUseToEffect`. The function does not distinguish
between them; by the time the host implementation runs, the invocation is a
descriptor-backed `ToolUse` event.

Result delivery follows the inverse path:

- Direct invocations produce a `ToolResult` event that the codec encodes back
  into the agent's wire format.
- Indirect invocations produce a `ToolResult` row in the results stream; the MCP
  bridge turns that row into the MCP `tools/call` response or streamed response.

## Tool error semantics

Each tool arm may fail with `ToolError`, but `toolUseToEffect` catches that
failure and returns a `ToolResult` with `isError: true`. `ToolError` is a tagged
union:

```ts
type ToolError =
  | { _tag: "ToolInvalidInput"; toolUseId: string; name: string; reason: string }
  | { _tag: "ToolExecutionFailed"; toolUseId: string; name: string; cause: unknown }
  | { _tag: "ToolCancelled"; toolUseId: string; name: string }
```

From the codec's perspective, this is still a normal `ToolResult` — the codec
encodes it according to its protocol's error-result shape.

Tool failures are not workflow failures. The workflow continues; the agent receives the error and decides how to respond.

## Integration with `RuntimeContextWorkflow`

Phase 1's workflow body has an outer loop that consumes `AgentOutputEvent`s from the codec. The `ToolUse` arm of that loop is where Phase 2 hooks in:

```ts
// Inside Phase 1's consumeUntilTurnComplete (paraphrased)
Match.tag("ToolUse", event =>
  toolUseToEffect({ contextId }, event).pipe(
    Effect.tap(toolResult => session.send(toolResult)),
    Effect.tap(toolResult => recordToolResultEvent(contextId, toolResult)),
    Effect.asVoid,
  )
)
```

`session.send` is the Phase 1 codec session's input-event entrypoint; it encodes the `ToolResult` event according to the codec's wire protocol and writes to the agent. `recordToolResultEvent` writes a durable observation row for the tool result.

The Phase 2 surface is the canonical descriptor set plus `toolUseToEffect`. Everything around it — the outer loop, the codec session, descriptor publication, and the durable observations — is Phase 1.

## `ScheduledInputWorkflow`

The only new workflow this SDD introduces. Used solely by `schedule_me`:

```ts
const ScheduledInputWorkflow = Workflow.make({
  name: "firegrid.agent-tool.scheduled-input",
  payload: Schema.Struct({
    contextId: Schema.String,
    dueAtMs: Schema.Number,
    promptContent: PromptContentSchema,  // from Phase 1's contract
    inputId: Schema.String,
  }),
  success: Schema.Void,
  error: ScheduledInputError,
})

const ScheduledInputWorkflowBody = ({ contextId, dueAtMs, promptContent, inputId }) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* DurableClock.sleep({
      name: "scheduled-input.wait",
      duration: Duration.millis(Math.max(0, dueAtMs - now)),
    })
    yield* appendRuntimeInputActivity({
      contextId,
      inputId,
      content: promptContent,
      kind: "message",
      authoredBy: "agent",
    })
  })
```

It sleeps until `dueAtMs`, then appends a runtime input row that the target context's `RuntimeContextWorkflow` will consume on its next turn. Pure composition of existing primitives.

`appendRuntimeInputActivity` is the only new activity introduced beyond Phase 1's set. It wraps existing ingress append logic (idempotent on `inputId`) for use inside a workflow.

## Module layout

```
packages/protocol/src/agent-tools/
  schema.ts                   // shared Effect Schemas for tool inputs/outputs
  index.ts                    // exports schemas and schema-derived types

packages/runtime/src/agent-tools/
  descriptors.ts               // FiregridAgentTools explicit exposure manifest
  tool-use-to-effect.ts        // toolUseToEffect + runToolArm match expression
  tool-error.ts                // ToolError ADT, formatToolError
  scheduled-input-workflow.ts  // ScheduledInputWorkflow + body
  activities/
    wait-for-match.ts          // waitForMatchActivity
    execute-sandbox-tool.ts    // executeSandboxToolActivity
    append-runtime-input.ts    // appendRuntimeInputActivity
  catalog.ts                   // projects descriptors to catalog rows and publishes
  invocations-consumer.ts      // indirect-path invocation consumer
  mcp-client.ts                // helper for codecs that bridge directly
  mcp-bridge.ts                // thin Streamable HTTP MCP handler backed by streams
  index.ts                     // exports
```

`packages/protocol/src/agent-tools/schema.ts`, `descriptors.ts`, and
`tool-use-to-effect.ts` are the load-bearing files. Protocol schemas are the
shape source of truth. Descriptors are the explicit public exposure manifest.
The match expression and its arms are the host implementation. Each activity is
a small Effect function.

## Validation

### Per-tool unit tests

For each tool arm:

1. Descriptor schema accepts valid inputs and rejects malformed inputs.
2. Descriptor schemas are imported from `@firegrid/protocol`, not duplicated in
   runtime descriptor or catalog code.
3. Catalog projection uses the encoded schema and annotations from the shared
   Effect Schema.
4. Happy-path execution produces the expected `ToolResultEvent`.
5. Replay produces the same result without re-executing side effects.
6. Cancellation propagates correctly through the workflow's interruption channel.
7. Invalid input produces `ToolInvalidInput` error.
8. Unknown tool names produce a `ToolResult` with `isError: true`; known tool names with invalid input produce `ToolInvalidInput`.

### Bridge and catalog tests

1. Catalog stream publication: runtime startup writes exactly the
   `FiregridAgentTools` descriptor set, with no credentials, transport URLs, or
   secret-shaped fields in descriptor rows.
2. Catalog rows are generated from `Schema.encodedSchema` projections and schema
   annotations, not from a hand-authored JSON Schema copy.
3. MCP bridge conformance: a standard MCP client or inspector can call
   `tools/list` and `tools/call` against the Streamable HTTP bridge URL.
4. Indirect path round-trip: a test client calls or appends an invocation through
   the bridge path; the runtime consumes it, executes it, and writes a result
   that the client observes.
5. Codec-agnostic invocation equivalence: the same logical invocation arriving
   through a direct codec path and through the bridge path produces the same
   `ToolUse` at `toolUseToEffect` and the same `ToolResult` shape.

### Integration tests

End-to-end scenarios in `scenarios/firegrid/`. Each uses a test codec (Phase 1's `StdioJsonlCodec` is appropriate) that emits a synthetic `ToolUse` event and asserts on the resulting `ToolResult`:

1. **`sleep`**: codec emits `ToolUse` for sleep, workflow suspends, after duration a `ToolResult` event is sent back.
2. **`wait_for`**: codec emits `ToolUse` for wait_for, separate ingress appends a matching event, workflow sends `ToolResult` with the matched event.
3. **`wait_for` with timeout**: codec emits `ToolUse` for wait_for with short timeout, no matching event, workflow sends `ToolResult` with `timedOut: true`.
4. **`spawn`**: codec emits `ToolUse` for spawn, child workflow runs to completion, parent sends `ToolResult` with terminal state.
5. **`spawn_all`**: codec emits `ToolUse` for spawn_all with three tasks, all complete, parent sends `ToolResult` with aggregated results.
6. **`schedule_me`**: codec emits `ToolUse` for schedule_me 60s in the future, workflow sends `ToolResult` with `scheduled: true` immediately, scheduled input fires later and appears in a new turn's `Prompt` event.
7. **`execute`**: codec emits `ToolUse` for execute against a local sandbox, sandbox returns, workflow sends `ToolResult` with the sandbox result.
8. **Crash recovery**: each tool tested with a host-restart mid-execution. Workflow replay resumes correctly.
9. **Unknown tool**: codec emits `ToolUse` with a name not in the match table; workflow sends `ToolResult` with `isError: true`.

### Manual validation

After the integration tests pass, smoke-test against a real agent (via Phase 1's `AcpCodec` or `StdioJsonlCodec` with a Claude-shaped agent) to verify the tool surface is usable end-to-end. This catches protocol-mapping mismatches that synthetic codec tests miss.

## PR sequencing

Single PR.

The implementation has one descriptor set and one lowering entrypoint. Splitting every tool into separate PRs would create scaffolding cost, but descriptor publication and schema validation should land before or with the first tool lowering.

Scope:

1. Create `packages/runtime/src/agent-tools/` module skeleton.
2. Create `packages/protocol/src/agent-tools/` with shared Effect Schemas for
   the six tools' inputs/outputs.
3. Define canonical tool descriptors as an explicit exposure manifest over those
   shared schemas, plus `ToolError` ADT.
4. Implement descriptor lookup and `Schema.decodeUnknown` validation before lowering.
5. Implement `toolUseToEffect` with all six match arms and the unknown-tool branch.
6. Implement the three activities (`waitForMatchActivity`, `executeSandboxToolActivity`, `appendRuntimeInputActivity`).
7. Implement `ScheduledInputWorkflow`.
8. Implement catalog projection/publication to the tool bridge's catalog stream.
9. Implement `invocations-consumer.ts` for the indirect path.
10. Implement `mcp-client.ts` for codecs that bridge directly.
11. Implement the thin Streamable HTTP MCP bridge handler backed by catalog,
    invocations, and results streams.
12. Wire `toolUseToEffect` into Phase 1's `consumeUntilTurnComplete` `ToolUse`
    arm.
13. Unit tests per descriptor and tool arm.
14. Bridge/catalog tests.
15. Integration scenarios in `scenarios/firegrid/`.
16. Update feature spec with new ACID identifiers.
17. Update exports.

Estimated size: ~900 lines of production code, ~1100 lines of test code.

### Sequencing constraints

- Depends on Phase 1 (Agent I/O Substrate) PRs 1, 2 having landed. Specifically: the `ToolUse` and `ToolResult` event types from `agent-io/contract.ts` must exist, and the workflow body's outer loop must be in place.
- Does not depend on Phase 1 PR 3 (`AcpCodec`) — integration tests use `StdioJsonlCodec`. ACP-specific validation lands as a follow-up scenario test.
- No dependency on dispatch SDD (shelved), CEL utility (deferred), or `runtime-scheduling` spike (superseded).

## Feature spec ACIDs

```yaml
PHASE_6_AGENT_TOOLS:
  requirements:
    1: FiregridAgentTools defines the canonical neutral descriptor set for the initial tools: sleep, wait_for, spawn, spawn_all, schedule_me, and execute.
    2: Each descriptor contains name, description, Effect Schema input schema, Effect Schema output schema, stability, and capability metadata.
    3: Descriptor input and output schemas are imported from shared @firegrid/protocol agent-tool schemas rather than duplicated in runtime descriptor or catalog code.
    4: Catalog rows are generated from descriptor schemas using Effect Schema projections and annotations; no hand-written JSON Schema copy is maintained.
    5: toolUseToEffect is the host-side lowering of FiregridAgentTools: it decodes incoming ToolUse inputs against the descriptor's inputSchema before dispatching to a match arm.
    6: The match expression is the implementation; the descriptor set is the public contract. New tools require protocol schemas, a descriptor, and a match arm; removing a tool requires deprecating the descriptor before removing the arm.
    7: Unknown tool names produce a ToolResult with isError:true via descriptor lookup failure; the workflow does not fail.
    8: Invalid tool inputs produce a ToolResult with isError:true and a structured validation error; the workflow does not fail.
    9: Tool execution failures produce a ToolResult with isError:true and a structured error payload; the workflow does not fail.
    10: sleep tool composes DurableClock.sleep; suspends the workflow for the requested duration.
    11: wait_for tool composes waitForMatchActivity, optionally raced against DurableClock.sleep for timeout.
    12: spawn tool composes Workflow.execute against RuntimeContextWorkflow with a deterministic child executionId derived from the parent contextId and the toolUseId.
    13: spawn_all tool composes a fan-out of Workflow.execute calls; per-child executionId is deterministic from the parent context, the toolUseId, and either the task's key or its index.
    14: schedule_me tool starts a ScheduledInputWorkflow with discard:true and returns immediately; the workflow sleeps until due then appends a runtime input via appendRuntimeInputActivity.
    15: execute tool composes executeSandboxToolActivity over the SandboxProvider interface.
    16: Each tool's execution identity is deterministic from the ToolUse event's toolUseId, ensuring idempotency under workflow replay.
    17: The descriptor set is published to the Firegrid tool bridge's catalog stream at runtime startup; codecs read the same descriptor set via AgentCodecOpenOptions.toolCatalog.
    18: Invocations arriving through the indirect MCP bridge path are routed by invocations-consumer.ts to the appropriate RuntimeContextWorkflow and converge with direct-path invocations at toolUseToEffect.

BOUNDARIES:
  11: Agent tools are not a dynamic public registry; new tools require a descriptor contract change and a host lowering arm.
  12: Agent tool implementations introduce no new substrate modules; all six tools compose Phase 1 events with @effect/workflow primitives.
  13: ToolUse parsing and ToolResult encoding are codec concerns (Phase 1); descriptor publication and host-side lowering are workflow concerns (this SDD).
  14: The match expression depends only on Phase 1's event types and the descriptor set; it does not depend on which codec produced an invocation or which transport delivered it.
  15: A raw Durable Streams stream URL is not an MCP endpoint. MCP-capable agents use a Streamable HTTP MCP bridge handler backed by Durable Streams catalog, invocation, and result streams.
  16: @firegrid/protocol is the schema source of truth, but only explicitly listed FiregridAgentTools descriptors are exposed to agents.
  17: Runtime API calls and agent tool calls lower to the same durable workflow/table shapes.
```

## Open questions

1. **`EventQuery` shape for `wait_for`.** Initial proposal: fixed-record match query. CEL predicates deferred. Confirm this is sufficient for immediate use cases.

2. **`spawn_all` concurrency limit.** Default `"unbounded"`. If product needs surface a cap, add a config option to `SpawnAllInput`.

3. **`execute` async variant.** Tools that don't return synchronously (e.g., external API calls that complete via webhook). Would compose with Phase 1's `PermissionRequest`/`PermissionResponse`-style request/response pattern, or with an awakeable-like primitive. Out of scope here.

4. **`cancel_schedule` tool.** Not in the initial six. Natural complement to `schedule_me`. Would compose with workflow interruption: `cancelDispatch(scheduleId)` interrupts the `ScheduledInputWorkflow`. Small follow-up.

5. **Tool result delivery timing.** When the agent process has exited and is being relaunched (Phase 1's lifecycle policy), pending `ToolResult` events queue and are delivered on relaunch. The codec session API must support this; confirm with Phase 1 implementation.

6. **Tool input schema validation location.** The default is descriptor lookup followed by `Schema.decodeUnknown` before lowering. If a codec also validates inputs before emitting `ToolUse`, the workflow still performs host-side validation because the descriptor contract is the authority.

7. **`EventQuery` ownership.** Decide whether `EventQuery` should remain inline in
   the `wait_for` descriptor or be promoted to a Phase 1 shared type that codecs
   can use for autocomplete and richer agent-side catalog metadata.

## Decision log

- **Why a public descriptor set rather than inline match arms as the contract.**
  Tools are a published interface to agents. ACP, MCP-capable CLIs,
  HTTP-shaped model codecs, and future codecs all need to know what tools exist
  with identical semantics. An inline match expression is implementation code,
  not a versionable public contract. The descriptor set is the artifact codecs
  publish and the workflow implementation lowers.
- **Why descriptors plus a single match expression, not a dynamic registry.** Tools are statically known to the runtime, but agents need a published contract. Descriptors are that contract; the match expression is the host implementation. A dynamic registry would add runtime registration semantics without changing the durable lowering model. New tools are PRs adding descriptors and match arms.
- **Why descriptor-driven dispatch with `Schema.decodeUnknown`.** The
  descriptor's `inputSchema` is the single source of truth for what each tool
  accepts. Validating at the workflow boundary catches malformed agent inputs
  before they reach implementation code, produces structured invalid-input
  results, and removes ad-hoc casts from match arms.
- **Why schemas live in `@firegrid/protocol` but descriptors live in runtime.**
  Public operation shapes need one source of truth shared by clients, codecs,
  catalog projection, and runtime validation, so the Effect Schemas live in
  protocol. Exposure is a product and authority decision, so runtime owns the
  explicit `FiregridAgentTools` manifest that selects which schemas become
  agent-callable tools and binds them to host lowering arms.
- **Why not reflect all protocol schemas automatically.** `@firegrid/protocol`
  includes durable rows, launch records, ingress rows, and internal coordination
  facts. Reflection can derive a JSON shape, but it cannot decide whether the
  schema is safe or meaningful for an agent to call, what stable tool name it
  should have, or which workflow expression implements it.
- **Why catalog projection uses Effect Schema projections.** Agents consume the
  encoded JSON shape, while host code consumes decoded types. `Schema.encodedSchema`,
  `Schema.typeSchema`, annotations, and transforms let the catalog and runtime
  share one schema while preserving that encoded/decoded distinction.
- **Why codecs depend on the descriptor set, not the other way around.** Phase 1
  codecs need a descriptor catalog at session open to publish tools through
  their protocol. Phase 2 defines the canonical descriptor instances. Runtime
  wiring passes those instances into the codec; the descriptor module does not
  import codec implementations.
- **Why no MCP shim binary.** MCP-capable agents should use a Streamable HTTP MCP
  bridge URL. The bridge is a thin HTTP handler backed by Durable Streams, so
  there is no long-running stdio shim binary or per-context sidecar. The handler
  still must speak MCP JSON-RPC; a raw Durable Streams stream URL only provides
  append/read/live-tail primitives.
- **Why MCP is the privileged indirect lowering target.** MCP is the closest
  cross-vendor tool-server contract for agent runtimes. Lowering descriptors to
  an MCP bridge covers ACP agents with `mcpServers`, MCP-capable CLIs, and APIs
  with MCP connectors. Non-MCP codecs can still use `mcp-client.ts` internally
  against the same bridge-backed streams and expose native tool schemas.
- **Why deterministic IDs for replay safety.** Workflow engines replay arms during recovery; non-deterministic IDs would create orphan executions, duplicate side effects, or deferred-resolution mismatches. Deriving IDs from `toolUseId` (which is the codec's responsibility to make stable) gives idempotency and traceability.
- **Why `DurableDeferred` is unused.** Working through each tool, the wait cases were cleaner as long-running activities. `DurableDeferred` would shine for cross-execution rendezvous (one workflow completes a deferred awaited by another), which none of these tools require.
- **Why no Trigger/Target ADT, no dispatch abstraction, no CEL utility, no `runtime-scheduling` integration.** Prior design exploration considered all of these as substrates. Working through each tool against the actual execution environment showed they compose cleanly from `@effect/workflow` primitives plus the Phase 1 event types. None of the proposed substrates earned their cost.
- **Why unknown tools are runtime errors while known tools are exhaustive.** The descriptor set is statically known to the runtime, but an agent may emit a name outside the published catalog (older agent, hallucinated tool, codec misconfiguration). Unknown names return structured `ToolResult` errors. Known names are lowered through exhaustive match arms after descriptor-schema validation.
- **Why tool failures are not workflow failures.** A failing tool is information the agent needs. Surfacing it as a workflow failure would terminate the entire context for what may be a recoverable agent-level concern (bad input, transient sandbox failure). The agent can retry, escalate, or terminate based on its own logic.
- **Why Phase 1 owns the event types.** The same `ToolUse`/`ToolResult` shapes need to be consumed by codecs (encoding/decoding wire), the workflow body (Phase 1 outer loop), and tool arms (Phase 2). One owner: Phase 1's contract module. Phase 2 imports.

## Migration

No migration needed. This is net-new functionality. Agents whose `ToolUse` events previously had no handler will start being handled. Calls to unrecognized tools that previously had no defined behavior will now return structured errors.

## Out of scope (named explicitly)

- **Codec authoring SDK.** Codec implementations are internal-only for now.
- **External-party agent tool registration.** Third parties cannot publish
  descriptors into Firegrid's canonical catalog in this phase.
- **Per-tenant or per-deployment descriptor variation.** All deployments expose
  the same canonical descriptor set. Product flags and deployment-specific tool
  surfaces compose with the descriptor contract later.
- **Automatic protocol-schema exposure.** Shared protocol schemas prevent drift,
  but agent-callable tools are only those listed in `FiregridAgentTools`.
- **CEL expression predicates** on `wait_for`. Adds `where?: CelExpression<boolean>` field; integrates via predicate composition. Lands separately if/when product surfaces a need.
- **Async `execute`** variant. For sandbox tools that complete via callback rather than return. Composes with Phase 1's permission-request-shaped sync request/response pattern when needed.
- **Cron-style scheduled tools.** Would compose `Schedule.cron` to compute next-fire times and a recurring-workflow pattern. Lives in its own module; not in `toolUseToEffect`.
- **`cancel_schedule`, `cancel_wait`** tools. Compose with workflow interruption. `cancel_schedule` would interrupt the `ScheduledInputWorkflow` by execution id, but is not one of the initial six tools.
- **Tool result streaming.** All current tools return a single `ToolResult`. Streaming tool results (e.g., `execute` returning incremental output) is a Phase 1 protocol-level concern.
- **Protocol-specific tool-catalog mounting.** ACP/MCP/Claude/Codex presentation is Phase 1 codec/deployment work. This SDD owns the neutral descriptor set and host lowering, not each protocol's mounting mechanics.
- **Codec-specific tool semantics.** Some agents may emit `ToolUse` events with codec-specific quirks (ACP's `tool_call` vs `tool_call_update` status progression; OpenAI's parallel tool calls). The codec normalizes to a single `ToolUse` event per tool invocation. If multi-event tool lifecycles become necessary, the codec aggregates and emits one consolidated `ToolUse` per call.

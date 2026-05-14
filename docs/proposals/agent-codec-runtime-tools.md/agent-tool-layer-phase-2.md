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
) => Effect.Effect<Extract<AgentInputEvent, { _tag: "ToolResult" }>, ToolError, R>
```

Defined by looking up the descriptor for `event.name`, decoding `event.input` with that descriptor's `inputSchema`, then pattern matching on the canonical tool name. New tools require both a descriptor (public contract) and a match arm (host implementation).

Phase 1 owns the event and descriptor types. Phase 2 owns the canonical Firegrid descriptor set and the lowering function.

## Goals

1. Define the canonical Firegrid descriptor set for all six agent tools (`sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, `execute`).
2. Implement all six agent tools as composable arms of `toolUseToEffect` in `RuntimeContextWorkflow`.
3. Use only existing primitives. Introduce no new substrate modules.
4. Each tool arm produces the correct `ToolResult` input event for the codec to encode and deliver to the agent.
5. Establish replay-safe execution: every tool arm must be safe to re-execute under workflow replay.
6. Prove runtime API calls and agent tool calls lower to the same durable shapes.

## Non-goals

- No dynamic tool-registration registry. Tools are statically known; new tools are PRs that add a descriptor and a match arm.
- No agent-side SDK changes. Agents emit `tool_use` in their native protocol; the codec normalizes; the workflow body matches.
- No new sandbox provider work beyond what Phase 1 lands. `execute` consumes the existing `SandboxProvider` interface.
- No protocol-specific catalog mounting implementation. Phase 1 codecs publish neutral descriptors through their wire protocol; MCP/ACP/Claude/Codex presentation details stay below the codec boundary.
- No agent-process lifecycle policy. Whether the process stays alive across a long suspension is decided by Phase 1's codec/workflow integration, not by individual tool arms.

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

```ts
export const FiregridAgentTools = {
  sleep: defineAgentTool({
    name: "sleep",
    description: "Durably suspend until a duration elapses.",
    inputSchema: Schema.Struct({ durationMs: Schema.Number }),
    outputSchema: Schema.Struct({ slept: Schema.Literal(true) }),
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

Descriptor fields do not include credentials, callback tokens, provider session
tokens, Durable Streams URLs, sandbox handles, host ids, or transport refs.
Those are host-side authority and codec/deployment configuration, not
agent-visible contract.

## The function

```ts
import type { AgentInputEvent, AgentOutputEvent } from "@firegrid/runtime/agent-io"

const toolUseToEffect = (
  ctx: { contextId: string },
  event: Extract<AgentOutputEvent, { _tag: "ToolUse" }>,
): Effect.Effect<Extract<AgentInputEvent, { _tag: "ToolResult" }>, ToolError, WorkflowContext> =>
  Effect.gen(function* () {
    const descriptor = FiregridAgentTools[event.name as keyof typeof FiregridAgentTools]
    if (descriptor === undefined) {
      return unknownToolResult(event.toolUseId, event.name)
    }

    const input = yield* Schema.decodeUnknown(descriptor.inputSchema)(event.input).pipe(
      Effect.mapError((cause) => new ToolInvalidInput({
        toolUseId: event.toolUseId,
        name: event.name,
        cause,
      })),
    )

    const result = yield* runKnownTool(ctx, {
      toolUseId: event.toolUseId,
      name: descriptor.name,
      input,
    })

    return yield* Schema.decodeUnknown(descriptor.outputSchema)(result.content).pipe(
      Effect.as(result),
      Effect.mapError((cause) => new ToolExecutionFailed({
        toolUseId: event.toolUseId,
        name: event.name,
        cause,
      })),
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

## Tool error semantics

Each tool arm returns `Effect<ToolResultEvent, ToolError, R>`. `ToolError` is a tagged union:

```ts
type ToolError =
  | { _tag: "ToolInvalidInput"; toolUseId: string; name: string; reason: string }
  | { _tag: "ToolExecutionFailed"; toolUseId: string; name: string; cause: unknown }
  | { _tag: "ToolCancelled"; toolUseId: string; name: string }
```

The workflow body's outer loop catches `ToolError` and constructs a `ToolResult` event with `isError: true` and a structured error payload. From the codec's perspective, this is still a normal `ToolResult` — the codec encodes it according to its protocol's error-result shape.

Tool failures are not workflow failures. The workflow continues; the agent receives the error and decides how to respond.

## Integration with `RuntimeContextWorkflow`

Phase 1's workflow body has an outer loop that consumes `AgentOutputEvent`s from the codec. The `ToolUse` arm of that loop is where Phase 2 hooks in:

```ts
// Inside Phase 1's consumeUntilTurnComplete (paraphrased)
Match.tag("ToolUse", event =>
  toolUseToEffect({ contextId }, event).pipe(
    Effect.catchAll(error =>
      Effect.succeed<ToolResultEvent>({
        _tag: "ToolResult",
        toolUseId: event.toolUseId,
        content: { error: formatToolError(error) },
        isError: true,
      })
    ),
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
packages/runtime/src/agent-tools/
  tool-use-to-effect.ts        // toolUseToEffect match expression
  tool-input-schemas.ts        // SleepInput, WaitForInput, SpawnInput, etc.
  tool-error.ts                // ToolError ADT, formatToolError
  scheduled-input-workflow.ts  // ScheduledInputWorkflow + body
  activities/
    wait-for-match.ts          // waitForMatchActivity
    execute-sandbox-tool.ts    // executeSandboxToolActivity
    append-runtime-input.ts    // appendRuntimeInputActivity
  index.ts                     // exports
```

`tool-use-to-effect.ts` is the load-bearing file. The match expression and its arms live there. Each tool input schema is a small Schema declaration; each activity is a small Effect function.

## Validation

### Per-tool unit tests

For each tool arm:

1. Happy-path execution produces the expected `ToolResultEvent`.
2. Replay produces the same result without re-executing side effects.
3. Cancellation propagates correctly through the workflow's interruption channel.
4. Invalid input produces `ToolInvalidInput` error.
5. Unknown tool names produce a `ToolResult` with `isError: true`; known tool names with invalid input produce `ToolInvalidInput`.

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
2. Define canonical tool descriptors, input/output schemas, and `ToolError` ADT.
3. Implement descriptor lookup and `Schema.decodeUnknown` validation before lowering.
4. Implement `toolUseToEffect` with all six match arms and the unknown-tool branch.
5. Implement the three activities (`waitForMatchActivity`, `executeSandboxToolActivity`, `appendRuntimeInputActivity`).
6. Implement `ScheduledInputWorkflow`.
7. Wire `toolUseToEffect` into Phase 1's `consumeUntilTurnComplete` `ToolUse` arm.
8. Unit tests per descriptor and tool arm.
9. Integration scenarios in `scenarios/firegrid/`.
10. Update feature spec with new ACID identifiers.
11. Update exports.

Estimated size: ~600 lines of production code, ~800 lines of test code.

### Sequencing constraints

- Depends on Phase 1 (Agent I/O Substrate) PRs 1, 2 having landed. Specifically: the `ToolUse` and `ToolResult` event types from `agent-io/contract.ts` must exist, and the workflow body's outer loop must be in place.
- Does not depend on Phase 1 PR 3 (`AcpCodec`) — integration tests use `StdioJsonlCodec`. ACP-specific validation lands as a follow-up scenario test.
- No dependency on dispatch SDD (shelved), CEL utility (deferred), or `runtime-scheduling` spike (superseded).

## Feature spec ACIDs

```yaml
PHASE_6_AGENT_TOOLS:
  requirements:
    1: The Firegrid agent tool surface publishes a canonical descriptor set containing name, description, Effect Schema input schema, Effect Schema output schema, stability, and capability metadata for each supported tool.
    2: toolUseToEffect lowers a descriptor-backed ToolUse event to an Effect producing a ToolResult event after validating input against the descriptor schema.
    3: The host implementation uses a single Match expression over known tool names; each match arm composes existing workflow primitives.
    4: sleep tool composes DurableClock.sleep; suspends the workflow for the requested duration.
    5: wait_for tool composes waitForMatchActivity, optionally raced against DurableClock.sleep for timeout.
    6: spawn tool composes Workflow.execute against RuntimeContextWorkflow with a deterministic child executionId derived from the parent contextId and the toolUseId.
    7: spawn_all tool composes a fan-out of Workflow.execute calls; per-child executionId is deterministic from the parent context, the toolUseId, and either the task's key or its index.
    8: schedule_me tool starts a ScheduledInputWorkflow with discard:true and returns immediately; the workflow sleeps until due then appends a runtime input via appendRuntimeInputActivity.
    9: execute tool composes executeSandboxToolActivity over the SandboxProvider interface.
    10: Each tool's execution identity is deterministic from the ToolUse event's toolUseId, ensuring idempotency under workflow replay.
    11: Unknown tool names produce a ToolResult with isError:true; the workflow does not fail.
    12: Known tool names with malformed input produce a ToolResult with isError:true through ToolInvalidInput rather than type casts.
    13: Tool execution failures produce a ToolResult with isError:true and a structured error payload; the workflow continues consuming subsequent agent events.

BOUNDARIES:
  11: Agent tools are not a dynamic public registry; new tools require a descriptor contract change and a host lowering arm.
  12: Agent tool implementations introduce no new substrate modules; all six tools compose Phase 1 events with @effect/workflow primitives.
  13: ToolUse wire parsing and ToolResult wire encoding are codec concerns (Phase 1); tool descriptor validation and semantics are workflow-body concerns (this SDD).
  14: Runtime API calls and agent tool calls lower to the same durable workflow/table shapes.
```

## Open questions

1. **`EventQuery` shape for `wait_for`.** Initial proposal: fixed-record match query. CEL predicates deferred. Confirm this is sufficient for immediate use cases.

2. **`spawn_all` concurrency limit.** Default `"unbounded"`. If product needs surface a cap, add a config option to `SpawnAllInput`.

3. **`execute` async variant.** Tools that don't return synchronously (e.g., external API calls that complete via webhook). Would compose with Phase 1's `PermissionRequest`/`PermissionResponse`-style request/response pattern, or with an awakeable-like primitive. Out of scope here.

4. **`cancel_schedule` tool.** Not in the initial six. Natural complement to `schedule_me`. Would compose with workflow interruption: `cancelDispatch(scheduleId)` interrupts the `ScheduledInputWorkflow`. Small follow-up.

5. **Tool result delivery timing.** When the agent process has exited and is being relaunched (Phase 1's lifecycle policy), pending `ToolResult` events queue and are delivered on relaunch. The codec session API must support this; confirm with Phase 1 implementation.

6. **Tool input schema validation location.** The default is descriptor lookup followed by `Schema.decodeUnknown` before lowering. If a codec also validates inputs before emitting `ToolUse`, the workflow still performs host-side validation because the descriptor contract is the authority.

## Decision log

- **Why descriptors plus a single match expression, not a dynamic registry.** Tools are statically known to the runtime, but agents need a published contract. Descriptors are that contract; the match expression is the host implementation. A dynamic registry would add runtime registration semantics without changing the durable lowering model. New tools are PRs adding descriptors and match arms.
- **Why deterministic IDs for replay safety.** Workflow engines replay arms during recovery; non-deterministic IDs would create orphan executions, duplicate side effects, or deferred-resolution mismatches. Deriving IDs from `toolUseId` (which is the codec's responsibility to make stable) gives idempotency and traceability.
- **Why `DurableDeferred` is unused.** Working through each tool, the wait cases were cleaner as long-running activities. `DurableDeferred` would shine for cross-execution rendezvous (one workflow completes a deferred awaited by another), which none of these tools require.
- **Why no Trigger/Target ADT, no dispatch abstraction, no CEL utility, no `runtime-scheduling` integration.** Prior design exploration considered all of these as substrates. Working through each tool against the actual execution environment showed they compose cleanly from `@effect/workflow` primitives plus the Phase 1 event types. None of the proposed substrates earned their cost.
- **Why unknown tools are runtime errors while known tools are exhaustive.** The descriptor set is statically known to the runtime, but an agent may emit a name outside the published catalog (older agent, hallucinated tool, codec misconfiguration). Unknown names return structured `ToolResult` errors. Known names are lowered through exhaustive match arms after descriptor-schema validation.
- **Why tool failures are not workflow failures.** A failing tool is information the agent needs. Surfacing it as a workflow failure would terminate the entire context for what may be a recoverable agent-level concern (bad input, transient sandbox failure). The agent can retry, escalate, or terminate based on its own logic.
- **Why Phase 1 owns the event types.** The same `ToolUse`/`ToolResult` shapes need to be consumed by codecs (encoding/decoding wire), the workflow body (Phase 1 outer loop), and tool arms (Phase 2). One owner: Phase 1's contract module. Phase 2 imports.

## Migration

No migration needed. This is net-new functionality. Agents whose `ToolUse` events previously had no handler will start being handled. Calls to unrecognized tools that previously had no defined behavior will now return structured errors.

## Out of scope (named explicitly)

- **CEL expression predicates** on `wait_for`. Adds `where?: CelExpression<boolean>` field; integrates via predicate composition. Lands separately if/when product surfaces a need.
- **Async `execute`** variant. For sandbox tools that complete via callback rather than return. Composes with Phase 1's permission-request-shaped sync request/response pattern when needed.
- **Cron-style scheduled tools.** Would compose `Schedule.cron` to compute next-fire times and a recurring-workflow pattern. Lives in its own module; not in `toolUseToEffect`.
- **`cancel_schedule`, `cancel_wait`** tools. Compose with workflow interruption. Small additions when needed.
- **Tool result streaming.** All current tools return a single `ToolResult`. Streaming tool results (e.g., `execute` returning incremental output) is a Phase 1 protocol-level concern.
- **Protocol-specific tool-catalog mounting.** ACP/MCP/Claude/Codex presentation is Phase 1 codec/deployment work. This SDD owns the neutral descriptor set and host lowering, not each protocol's mounting mechanics.
- **Codec-specific tool semantics.** Some agents may emit `ToolUse` events with codec-specific quirks (ACP's `tool_call` vs `tool_call_update` status progression; OpenAI's parallel tool calls). The codec normalizes to a single `ToolUse` event per tool invocation. If multi-event tool lifecycles become necessary, the codec aggregates and emits one consolidated `ToolUse` per call.
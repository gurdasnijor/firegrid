/**
 * Shared Effect Schemas for Firegrid agent-tool inputs and outputs.
 *
 * `@firegrid/protocol` is the source of truth for the shape of every
 * public Firegrid agent-tool. Phase 2 builds an explicit exposure
 * manifest (`FiregridAgentTools`) over these schemas; codec catalog
 * projection uses `Schema.encodedSchema` and `Schema.annotations` to
 * derive agent-facing JSON catalogs from the same Effect Schemas
 * declared here.
 *
 * This module defines *only* the input and output shapes that the
 * canonical Firegrid agent-tool surface exposes. It does NOT:
 *   - declare descriptors (Phase 2 owns the explicit exposure manifest),
 *   - declare match-arm lowering (Phase 2 owns toolUseToEffect),
 *   - reflect every protocol row family as a tool surface.
 *
 * Anchors:
 *   - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1
 *   - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4
 *   - firegrid-scheduling-tool-bindings.PACKAGE_PLACEMENT.1
 *   - firegrid-platform-invariants.BOUNDARY.1
 */

import { Schema } from "effect"

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

/**
 * Input shape for the `sleep` tool: a non-negative integer millisecond
 * duration. Phase 2's lowering composes `DurableClock.sleep` over this.
 */
export const SleepToolInputSchema = Schema.Struct({
  durationMs: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0),
    Schema.annotations({
      title: "Duration in milliseconds",
      description: "Non-negative integer milliseconds the agent should sleep for.",
    }),
  ),
}).annotations({
  identifier: "firegrid.agentTool.sleep.input",
  title: "Sleep tool input",
  description: "Durably suspend until a duration elapses.",
})
export type SleepToolInput = Schema.Schema.Type<typeof SleepToolInputSchema>

export const SleepToolOutputSchema = Schema.Struct({
  slept: Schema.Literal(true),
}).annotations({
  identifier: "firegrid.agentTool.sleep.output",
  title: "Sleep tool output",
})
export type SleepToolOutput = Schema.Schema.Type<typeof SleepToolOutputSchema>

// ---------------------------------------------------------------------------
// wait_for
// ---------------------------------------------------------------------------

/**
 * Phase 1 `EventQuery`: a fixed-record match query against a named
 * Durable Streams-backed stream. Phase 2 may grow the predicate
 * vocabulary; for now `whereFields` is a deep-equal record match.
 */
export const EventQuerySchema = Schema.Struct({
  stream: Schema.String.pipe(Schema.minLength(1)),
  whereFields: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}).annotations({
  identifier: "firegrid.agentTool.eventQuery",
  title: "Durable event query",
  description: "Match a row in a named durable stream by equality on declared fields.",
})
export type EventQuery = Schema.Schema.Type<typeof EventQuerySchema>

export const WaitForToolInputSchema = Schema.Struct({
  eventQuery: EventQuerySchema,
  timeoutMs: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
}).annotations({
  identifier: "firegrid.agentTool.waitFor.input",
  title: "Wait-for tool input",
  description: "Wait until a matching durable event appears, optionally bounded by a timeout.",
})
export type WaitForToolInput = Schema.Schema.Type<typeof WaitForToolInputSchema>

export const WaitForToolOutputSchema = Schema.Union(
  Schema.Struct({
    matched: Schema.Literal(true),
    event: Schema.Unknown,
  }),
  Schema.Struct({
    matched: Schema.Literal(false),
    timedOut: Schema.Literal(true),
  }),
).annotations({
  identifier: "firegrid.agentTool.waitFor.output",
  title: "Wait-for tool output",
})
export type WaitForToolOutput = Schema.Schema.Type<typeof WaitForToolOutputSchema>

// ---------------------------------------------------------------------------
// spawn / spawn_all
// ---------------------------------------------------------------------------

export const SpawnOptionsSchema = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
}).annotations({
  identifier: "firegrid.agentTool.spawnOptions",
  title: "Spawn options",
})
export type SpawnOptions = Schema.Schema.Type<typeof SpawnOptionsSchema>

export const SpawnToolInputSchema = Schema.Struct({
  agentKind: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String,
  options: Schema.optional(SpawnOptionsSchema),
}).annotations({
  identifier: "firegrid.agentTool.spawn.input",
  title: "Spawn tool input",
  description: "Run a child RuntimeContextWorkflow with the given prompt and await its terminal state.",
})
export type SpawnToolInput = Schema.Schema.Type<typeof SpawnToolInputSchema>

export const WorkflowTerminalStateSchema = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Completed"), output: Schema.Unknown }),
  Schema.Struct({
    _tag: Schema.Literal("Failed"),
    error: Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({ _tag: Schema.Literal("Cancelled") }),
).annotations({
  identifier: "firegrid.agentTool.workflowTerminalState",
  title: "Child workflow terminal state",
})
export type WorkflowTerminalState = Schema.Schema.Type<typeof WorkflowTerminalStateSchema>

export const SpawnToolOutputSchema = Schema.Struct({
  childContextId: Schema.String,
  terminalState: WorkflowTerminalStateSchema,
}).annotations({
  identifier: "firegrid.agentTool.spawn.output",
  title: "Spawn tool output",
})
export type SpawnToolOutput = Schema.Schema.Type<typeof SpawnToolOutputSchema>

export const SpawnTaskSchema = Schema.Struct({
  key: Schema.optional(Schema.String),
  agentKind: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String,
  options: Schema.optional(SpawnOptionsSchema),
}).annotations({
  identifier: "firegrid.agentTool.spawnTask",
  title: "Spawn task",
})
export type SpawnTask = Schema.Schema.Type<typeof SpawnTaskSchema>

export const SpawnAllToolInputSchema = Schema.Struct({
  tasks: Schema.Array(SpawnTaskSchema).pipe(Schema.minItems(1)),
}).annotations({
  identifier: "firegrid.agentTool.spawnAll.input",
  title: "Spawn-all tool input",
  description: "Fan out child workflows; await all terminal states.",
})
export type SpawnAllToolInput = Schema.Schema.Type<typeof SpawnAllToolInputSchema>

export const SpawnAllChildResultSchema = Schema.Struct({
  key: Schema.String,
  childContextId: Schema.String,
  terminalState: WorkflowTerminalStateSchema,
})
export type SpawnAllChildResult = Schema.Schema.Type<typeof SpawnAllChildResultSchema>

export const SpawnAllToolOutputSchema = Schema.Struct({
  children: Schema.Array(SpawnAllChildResultSchema),
}).annotations({
  identifier: "firegrid.agentTool.spawnAll.output",
  title: "Spawn-all tool output",
})
export type SpawnAllToolOutput = Schema.Schema.Type<typeof SpawnAllToolOutputSchema>

// ---------------------------------------------------------------------------
// session plane
// ---------------------------------------------------------------------------

export const SessionStatusSchema = Schema.Literal(
  "created",
  "running",
  "input_required",
  "done",
  "failed",
  "aborted",
  "idle",
).annotations({
  identifier: "firegrid.agentTool.sessionStatus",
  title: "Session status",
})
export type SessionStatus = Schema.Schema.Type<typeof SessionStatusSchema>

export const SessionHandleSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  contextId: Schema.String.pipe(Schema.minLength(1)),
  status: SessionStatusSchema,
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  terminalState: Schema.optional(WorkflowTerminalStateSchema),
}).annotations({
  identifier: "firegrid.agentTool.sessionHandle",
  title: "Session handle",
  description:
    "Agent-visible handle for a RuntimeContext-backed session. In v1, " +
    "sessionId is the RuntimeContext contextId.",
})
export type SessionHandle = Schema.Schema.Type<typeof SessionHandleSchema>

export const SessionNewToolInputSchema = Schema.Struct({
  agentKind: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String.pipe(Schema.minLength(1)),
  options: Schema.optional(SpawnOptionsSchema),
}).annotations({
  identifier: "firegrid.agentTool.sessionNew.input",
  title: "Session-new tool input",
  description:
    "Create a child RuntimeContext-backed session and return its session handle.",
})
export type SessionNewToolInput = Schema.Schema.Type<
  typeof SessionNewToolInputSchema
>

export const SessionNewToolOutputSchema = Schema.Struct({
  session: SessionHandleSchema,
}).annotations({
  identifier: "firegrid.agentTool.sessionNew.output",
  title: "Session-new tool output",
})
export type SessionNewToolOutput = Schema.Schema.Type<
  typeof SessionNewToolOutputSchema
>

export const SessionPromptToolInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String.pipe(Schema.minLength(1)),
  inputId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
}).annotations({
  identifier: "firegrid.agentTool.sessionPrompt.input",
  title: "Session-prompt tool input",
  description:
    "Append a prompt to an existing RuntimeContext-backed session via host-owned ingress.",
})
export type SessionPromptToolInput = Schema.Schema.Type<
  typeof SessionPromptToolInputSchema
>

export const SessionPromptToolOutputSchema = Schema.Struct({
  appended: Schema.Literal(true),
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  inputId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.sessionPrompt.output",
  title: "Session-prompt tool output",
})
export type SessionPromptToolOutput = Schema.Schema.Type<
  typeof SessionPromptToolOutputSchema
>

export const SessionCancelToolInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  reason: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.agentTool.sessionCancel.input",
  title: "Session-cancel tool input",
  description:
    "Request cancellation of an existing RuntimeContext-backed session.",
})
export type SessionCancelToolInput = Schema.Schema.Type<
  typeof SessionCancelToolInputSchema
>

export const SessionCancelToolOutputSchema = Schema.Struct({
  cancelled: Schema.Literal(true),
  sessionId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.sessionCancel.output",
  title: "Session-cancel tool output",
})
export type SessionCancelToolOutput = Schema.Schema.Type<
  typeof SessionCancelToolOutputSchema
>

export const SessionCloseToolInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  reason: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.agentTool.sessionClose.input",
  title: "Session-close tool input",
  description: "Request closure of an existing RuntimeContext-backed session.",
})
export type SessionCloseToolInput = Schema.Schema.Type<
  typeof SessionCloseToolInputSchema
>

export const SessionCloseToolOutputSchema = Schema.Struct({
  closed: Schema.Literal(true),
  sessionId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.sessionClose.output",
  title: "Session-close tool output",
})
export type SessionCloseToolOutput = Schema.Schema.Type<
  typeof SessionCloseToolOutputSchema
>

// ---------------------------------------------------------------------------
// schedule_me
// ---------------------------------------------------------------------------

export const ScheduleMeToolInputSchema = Schema.Struct({
  when: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0),
    Schema.annotations({
      title: "Due timestamp",
      description: "Wall-clock milliseconds since the Unix epoch when the scheduled prompt should fire.",
    }),
  ),
  prompt: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.scheduleMe.input",
  title: "Schedule-me tool input",
  description: "Schedule a future prompt to the same agent context.",
})
export type ScheduleMeToolInput = Schema.Schema.Type<typeof ScheduleMeToolInputSchema>

export const ScheduleMeToolOutputSchema = Schema.Struct({
  scheduled: Schema.Literal(true),
  scheduleId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.scheduleMe.output",
  title: "Schedule-me tool output",
})
export type ScheduleMeToolOutput = Schema.Schema.Type<typeof ScheduleMeToolOutputSchema>

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * Symbolic reference to a sandbox tool. The shape stays sandbox-neutral;
 * Phase 2 routes invocations to `SandboxProvider`-backed activities.
 *
 * Note: this does NOT carry credentials, callback tokens, or transport
 * references — those remain host-side authority.
 */
export const SandboxRefSchema = Schema.Struct({
  providerName: Schema.String.pipe(Schema.minLength(1)),
  toolName: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.sandboxRef",
  title: "Sandbox tool reference",
})
export type SandboxRef = Schema.Schema.Type<typeof SandboxRefSchema>

export const LegacyExecuteToolInputSchema = Schema.Struct({
  sandbox: SandboxRefSchema,
  input: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.execute.legacyInput",
  title: "Legacy execute tool input",
  description:
    "Invoke a SandboxProvider-backed tool by sandbox-neutral reference.",
})
export type LegacyExecuteToolInput = Schema.Schema.Type<
  typeof LegacyExecuteToolInputSchema
>

export const SessionCapabilityRefSchema = Schema.Struct({
  kind: Schema.Literal("filesystem", "terminal", "external"),
  name: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.agentTool.sessionCapabilityRef",
  title: "Session capability reference",
  description:
    "Agent-visible reference to a session-bound filesystem, terminal, or external-resource capability.",
})
export type SessionCapabilityRef = Schema.Schema.Type<
  typeof SessionCapabilityRefSchema
>

export const SessionExecuteToolInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  capability: SessionCapabilityRefSchema,
  input: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.execute.sessionInput",
  title: "Session-bound execute tool input",
  description:
    "Invoke a capability scoped by session identity and host authority.",
})
export type SessionExecuteToolInput = Schema.Schema.Type<
  typeof SessionExecuteToolInputSchema
>

export const ExecuteToolInputSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  capability: Schema.optional(SessionCapabilityRefSchema),
  sandbox: Schema.optional(SandboxRefSchema),
  input: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.execute.input",
  title: "Execute tool input",
  description:
    "Invoke a session-bound capability, with a temporary compatibility bridge for legacy sandbox references.",
})
export type ExecuteToolInput = Schema.Schema.Type<typeof ExecuteToolInputSchema>

export const ExecuteToolOutputSchema = Schema.Unknown.annotations({
  identifier: "firegrid.agentTool.execute.output",
  title: "Execute tool output",
  description: "Sandbox-specific result payload; runtime validation lives at the SandboxProvider boundary.",
})
export type ExecuteToolOutput = Schema.Schema.Type<typeof ExecuteToolOutputSchema>

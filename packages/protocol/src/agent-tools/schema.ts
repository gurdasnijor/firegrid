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
import { firegridProjection } from "../projection/schema.ts"
import { defineFiregridOperation } from "../operations/schema.ts"
import { PermissionOptionSchema } from "../agent-output/schema.ts"
import { EventOffsetSchema } from "../channels/core.ts"

export {
  defineFiregridOperation,
  type FiregridOperationEntry,
} from "../operations/schema.ts"
export {
  firegridProjection,
  FiregridProjectionAnnotationId,
  getFiregridProjectionMetadata,
  type FiregridProjectionMetadata,
} from "../projection/schema.ts"
// firegrid-schema-projection-contract.CLIENT_PROJECTION.6
// Compatibility shim: runtime observation source names are protocol observation
// metadata, not agent-tool input/output schema. Keep this import path stable
// for existing bindings while callers migrate to `@firegrid/protocol/observations`.
// TODO(tf-yka4): remove after binding callers import the neutral observation module.
export {
  FiregridRuntimeObservationSourceNames,
  type FiregridRuntimeObservationSourceName,
} from "../observations/schema.ts"
// Follow-up migration should update protocol/session/client callers first.
// This re-export preserves value identity for legacy imports during the slice.
// Keep the shim local so tool schemas below remain behaviorally unchanged.

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
  examples: [{ durationMs: 1_000 }],
  ...firegridProjection({
    operationId: "sleep",
    toolName: "sleep",
    clientName: "sleep",
  }),
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
// wait_for / wait_until
// ---------------------------------------------------------------------------

export const WaitForToolMatchSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.waitFor.match",
  title: "Wait-for channel match",
  description: "Optional equality fields within the host-declared channel row.",
})
export type WaitForToolMatch = Schema.Schema.Type<typeof WaitForToolMatchSchema>

const WaitTimeoutMsSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
)

const WaitPromptSchema = Schema.String.pipe(Schema.minLength(1))

export const WaitForToolInputSchema = Schema.Struct({
  event: Schema.Struct({
    channel: Schema.String.pipe(Schema.minLength(1)),
    match: Schema.optional(WaitForToolMatchSchema),
    timeoutMs: Schema.optional(WaitTimeoutMsSchema),
  }),
  match: Schema.optional(WaitForToolMatchSchema),
  timeoutMs: Schema.optional(WaitTimeoutMsSchema),
  prompt: Schema.optional(WaitPromptSchema),
}).annotations({
  identifier: "firegrid.agentTool.waitFor.input",
  title: "Wait-for tool input",
  description:
    "Wait until a host-declared event/projection emits a matching row, optionally bounded by a timeout. With prompt, append that prompt as a new turn after the wait resolves.",
  examples: [
    {
      event: {
        channel: "session.agent_output",
        match: {
          sessionId: "ctx_child",
          afterSequence: -1,
        },
        timeoutMs: 30_000,
      },
    },
    {
      event: {
        channel: "factory.events",
      },
      match: {
        eventType: "factory.run.approved",
      },
      timeoutMs: 30_000,
      prompt: "Continue after approval.",
    },
  ],
  ...firegridProjection({
    operationId: "wait.for",
    toolName: "wait_for",
    clientName: "wait.for",
  }),
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

export const WaitUntilToolInputSchema = Schema.Struct({
  time: Schema.String.pipe(
    Schema.minLength(1),
    Schema.annotations({
      title: "Wait target time",
      description: "Absolute ISO time or relative duration such as '+2d' or '+30m'.",
    }),
  ),
  prompt: Schema.optional(WaitPromptSchema),
}).annotations({
  identifier: "firegrid.agentTool.waitUntil.input",
  title: "Wait-until tool input",
  description:
    "Wait until an absolute or relative time. With prompt, append that prompt as a new turn after the wait resolves.",
  examples: [
    { time: "+2d" },
    { time: "2026-06-03T16:00:00.000Z", prompt: "Check the build." },
  ],
  ...firegridProjection({
    operationId: "wait.until",
    toolName: "wait_until",
    clientName: "wait.until",
  }),
})
export type WaitUntilToolInput = Schema.Schema.Type<typeof WaitUntilToolInputSchema>

export const WaitUntilToolOutputSchema = Schema.Struct({
  waited: Schema.Literal(true),
  firedAt: Schema.String,
}).annotations({
  identifier: "firegrid.agentTool.waitUntil.output",
  title: "Wait-until tool output",
})
export type WaitUntilToolOutput = Schema.Schema.Type<typeof WaitUntilToolOutputSchema>

// ---------------------------------------------------------------------------
// send / wait_any
// ---------------------------------------------------------------------------

export const ChannelToolTargetSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.annotations({
    title: "Channel target",
    description: "Opaque host-declared channel name.",
  }),
).annotations({
  identifier: "firegrid.agentTool.channelTarget",
  title: "Agent tool channel target",
})
export type ChannelToolTarget = Schema.Schema.Type<typeof ChannelToolTargetSchema>

export const SendToolInputSchema = Schema.Struct({
  channel: ChannelToolTargetSchema,
  payload: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.send.input",
  title: "Send tool input",
  description: "Append a payload to an egress channel.",
  examples: [
    {
      channel: "factory.events",
      payload: { eventType: "ready", payload: { ok: true } },
    },
  ],
  ...firegridProjection({
    operationId: "channel.send",
    toolName: "send",
  }),
})
export type SendToolInput = Schema.Schema.Type<typeof SendToolInputSchema>

export const SendToolOutputSchema = Schema.Struct({
  sent: Schema.Literal(true),
  channel: ChannelToolTargetSchema,
}).annotations({
  identifier: "firegrid.agentTool.send.output",
  title: "Send tool output",
})
export type SendToolOutput = Schema.Schema.Type<typeof SendToolOutputSchema>

export const WaitAnyMatchSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.waitAny.match",
  title: "Wait-any match",
  description: "Field-equality predicates applied to one ingress channel row.",
})
export type WaitAnyMatch = Schema.Schema.Type<typeof WaitAnyMatchSchema>

export const WaitAnyDescriptorSchema = Schema.Struct({
  channel: ChannelToolTargetSchema,
  match: Schema.optional(WaitAnyMatchSchema),
}).annotations({
  identifier: "firegrid.agentTool.waitAny.descriptor",
  title: "Wait-any channel descriptor",
})
export type WaitAnyDescriptor = Schema.Schema.Type<typeof WaitAnyDescriptorSchema>

export const WaitAnyToolInputSchema = Schema.Struct({
  events: Schema.Array(WaitAnyDescriptorSchema).pipe(Schema.minItems(1)),
  timeoutMs: Schema.optional(WaitTimeoutMsSchema),
  prompt: Schema.optional(WaitPromptSchema),
}).annotations({
  identifier: "firegrid.agentTool.waitAny.input",
  title: "Wait-any tool input",
  description:
    "Race waits over multiple ingress channel descriptors. With prompt, append that prompt as a new turn after the race resolves.",
  examples: [
    {
      events: [
        { channel: "state.changes", match: { status: "ready" } },
        { channel: "factory.events", match: { eventType: "approved" } },
      ],
      timeoutMs: 30_000,
    },
  ],
  ...firegridProjection({
    operationId: "wait.any",
    toolName: "wait_any",
    clientName: "wait.any",
  }),
})
export type WaitAnyToolInput = Schema.Schema.Type<typeof WaitAnyToolInputSchema>

export const WaitAnyToolOutputSchema = Schema.Union(
  Schema.Struct({
    winnerIndex: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    channel: ChannelToolTargetSchema,
    result: Schema.Unknown,
  }),
  Schema.Struct({
    timedOut: Schema.Literal(true),
  }),
).annotations({
  identifier: "firegrid.agentTool.waitAny.output",
  title: "Wait-any tool output",
})
export type WaitAnyToolOutput = Schema.Schema.Type<typeof WaitAnyToolOutputSchema>

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
  ...firegridProjection({
    operationId: "session.spawnLegacy",
    toolName: "spawn",
  }),
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
  ...firegridProjection({
    operationId: "session.spawnAllLegacy",
    toolName: "spawn_all",
  }),
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
  examples: [
    {
      agentKind: "codex-acp",
      prompt: "Summarize the current task.",
    },
  ],
  ...firegridProjection({
    operationId: "session.create",
    toolName: "session_new",
    clientName: "sessions.create",
    cliName: "sessions create",
  }),
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
  examples: [
    {
      sessionId: "ctx_example",
      prompt: "Continue with the accepted plan.",
    },
  ],
  ...firegridProjection({
    operationId: "session.prompt",
    toolName: "session_prompt",
    clientName: "sessions.prompt",
    cliName: "sessions prompt",
  }),
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

export const SessionStatusInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  identifier: "firegrid.operation.session.status.input",
  title: "Session status input",
  description: "Read current observable status for a RuntimeContext-backed session.",
  ...firegridProjection({
    operationId: "session.status",
    clientName: "sessions.status",
    cliName: "sessions status",
  }),
})
export type SessionStatusInput = Schema.Schema.Type<typeof SessionStatusInputSchema>

export const SessionStatusOutputSchema = Schema.Struct({
  session: SessionHandleSchema,
}).annotations({
  identifier: "firegrid.operation.session.status.output",
  title: "Session status output",
})
export type SessionStatusOutput = Schema.Schema.Type<typeof SessionStatusOutputSchema>

export const SessionCancelToolInputSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  reason: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.agentTool.sessionCancel.input",
  title: "Session-cancel tool input",
  description:
    "Request cancellation of an existing RuntimeContext-backed session.",
  ...firegridProjection({
    operationId: "session.cancel",
    toolName: "session_cancel",
    clientName: "sessions.cancel",
    cliName: "sessions cancel",
  }),
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
  ...firegridProjection({
    operationId: "session.close",
    toolName: "session_close",
    clientName: "sessions.close",
    cliName: "sessions close",
  }),
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
  ...firegridProjection({
    operationId: "capability.execute",
    toolName: "execute",
  }),
})
export type ExecuteToolInput = Schema.Schema.Type<typeof ExecuteToolInputSchema>

export const ExecuteToolOutputSchema = Schema.Unknown.annotations({
  identifier: "firegrid.agentTool.execute.output",
  title: "Execute tool output",
  description: "Sandbox-specific result payload; runtime validation lives at the SandboxProvider boundary.",
})
export type ExecuteToolOutput = Schema.Schema.Type<typeof ExecuteToolOutputSchema>

// ---------------------------------------------------------------------------
// permission response
// ---------------------------------------------------------------------------

export const PermissionDecisionSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Allow"),
    optionId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Deny"),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Cancelled") }),
).annotations({
  identifier: "firegrid.agentTool.permissionDecision",
  title: "Permission decision",
})
export type PermissionDecision = Schema.Schema.Type<typeof PermissionDecisionSchema>

export const PermissionRespondInputSchema = Schema.Struct({
  contextId: Schema.String.pipe(Schema.minLength(1)),
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  decision: PermissionDecisionSchema,
  idempotencyKey: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
}).annotations({
  identifier: "firegrid.operation.permission.respond.input",
  title: "Permission response input",
  description:
    "Append a permission response to a RuntimeContext-backed session ingress.",
  examples: [
    {
      contextId: "ctx_example",
      permissionRequestId: "permission-1",
      decision: { _tag: "Allow", optionId: "allow_once" },
    },
  ],
  ...firegridProjection({
    operationId: "permission.respond",
    clientName: "permissions.respond",
  }),
})
export type PermissionRespondInput = Schema.Schema.Type<
  typeof PermissionRespondInputSchema
>

// `PermissionRespondOutputSchema` deleted per SDD_FIREGRID_PROTOCOL_
// RESPONSE_UNIFICATION phase 2. `HostPermissionRespondChannel` is
// now a `DurableEventChannel` returning `EventOffset`; the `inputId`
// cross-row reference is replaced by signal-name correlation.

// ---------------------------------------------------------------------------
// call(approval)
// ---------------------------------------------------------------------------

const ApprovalCallNonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1))
const ApprovalCallNonNegativeIntSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
)
const ApprovalCallActivityAttemptSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
)

export const ApprovalCallRequestSchema = Schema.Struct({
  decision: PermissionDecisionSchema,
  afterSequence: Schema.optional(ApprovalCallNonNegativeIntSchema),
  timeoutMs: Schema.optional(ApprovalCallNonNegativeIntSchema),
  idempotencyKey: Schema.optional(ApprovalCallNonEmptyStringSchema),
}).annotations({
  identifier: "firegrid.agentTool.call.approval.request",
  title: "Approval call request",
  description:
    "Approval-channel request: wait for a pending PermissionRequest and respond with the supplied decision.",
})
export type ApprovalCallRequest = Schema.Schema.Type<
  typeof ApprovalCallRequestSchema
>

export const ApprovalCallPermissionRequestSchema = Schema.Struct({
  contextId: ApprovalCallNonEmptyStringSchema,
  activityAttempt: ApprovalCallActivityAttemptSchema,
  sequence: ApprovalCallNonNegativeIntSchema,
  permissionRequestId: ApprovalCallNonEmptyStringSchema,
  toolUseId: ApprovalCallNonEmptyStringSchema,
  options: Schema.Array(PermissionOptionSchema),
}).annotations({
  identifier: "firegrid.agentTool.call.approval.permissionRequest",
  title: "Approval call permission request",
  description:
    "Normalized PermissionRequest selected by the approval call channel.",
})
export type ApprovalCallPermissionRequest = Schema.Schema.Type<
  typeof ApprovalCallPermissionRequestSchema
>

export const ApprovalCallOutputSchema = Schema.Union(
  Schema.Struct({
    matched: Schema.Literal(true),
    request: ApprovalCallPermissionRequestSchema,
    response: EventOffsetSchema,
  }),
  Schema.Struct({
    matched: Schema.Literal(false),
    timedOut: Schema.Literal(true),
  }),
).annotations({
  identifier: "firegrid.agentTool.call.approval.output",
  title: "Approval call output",
  description:
    "Result of waiting for and responding to a PermissionRequest via the approval channel.",
})
export type ApprovalCallOutput = Schema.Schema.Type<
  typeof ApprovalCallOutputSchema
>

export const CallToolInputSchema = Schema.Struct({
  channel: ChannelToolTargetSchema,
  request: Schema.Unknown,
}).annotations({
  identifier: "firegrid.agentTool.call.input",
  title: "Call tool input",
  description:
    "Invoke a callable channel. Registered call channels decode requests with their channel schema; approval.* targets keep the permission request/response fallback.",
  examples: [
    {
      channel: "approval.operator",
      request: { decision: { _tag: "Allow", optionId: "allow_once" } },
    },
  ],
  ...firegridProjection({
    operationId: "channel.call",
    toolName: "call",
  }),
})
export type CallToolInput = Schema.Schema.Type<typeof CallToolInputSchema>

export const CallToolOutputSchema = Schema.Unknown.annotations({
  identifier: "firegrid.agentTool.call.output",
  title: "Call tool output",
  description:
    "Call-channel response payload. Approval fallback returns the ApprovalCallOutput shape.",
})
export type CallToolOutput = Schema.Schema.Type<typeof CallToolOutputSchema>

export const FiregridAgentToolOperations = {
  sleep: defineFiregridOperation(SleepToolInputSchema, SleepToolOutputSchema),
  waitFor: defineFiregridOperation(WaitForToolInputSchema, WaitForToolOutputSchema),
  waitUntil: defineFiregridOperation(WaitUntilToolInputSchema, WaitUntilToolOutputSchema),
  waitAny: defineFiregridOperation(WaitAnyToolInputSchema, WaitAnyToolOutputSchema),
  send: defineFiregridOperation(SendToolInputSchema, SendToolOutputSchema),
  spawn: defineFiregridOperation(SpawnToolInputSchema, SpawnToolOutputSchema),
  spawnAll: defineFiregridOperation(SpawnAllToolInputSchema, SpawnAllToolOutputSchema),
  sessionCreate: defineFiregridOperation(SessionNewToolInputSchema, SessionNewToolOutputSchema),
  sessionPrompt: defineFiregridOperation(SessionPromptToolInputSchema, SessionPromptToolOutputSchema),
  sessionStatus: defineFiregridOperation(SessionStatusInputSchema, SessionStatusOutputSchema),
  sessionCancel: defineFiregridOperation(SessionCancelToolInputSchema, SessionCancelToolOutputSchema),
  sessionClose: defineFiregridOperation(SessionCloseToolInputSchema, SessionCloseToolOutputSchema),
  execute: defineFiregridOperation(ExecuteToolInputSchema, ExecuteToolOutputSchema),
  permissionRespond: defineFiregridOperation(PermissionRespondInputSchema, EventOffsetSchema),
  call: defineFiregridOperation(CallToolInputSchema, CallToolOutputSchema),
} as const

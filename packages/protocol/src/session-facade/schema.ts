import type { RuntimeEventRow } from "../launch/index.ts"
import { Either, Option, Schema } from "effect"
import {
  PermissionDecisionSchema,
} from "../agent-tools/schema.ts"
import { FiregridRuntimeObservationSourceNames } from "../observations/schema.ts"
import { PublicLaunchRuntimeIntentSchema } from "../launch/schema.ts"
import { firegridProjection } from "../projection/schema.ts"
import {
  AgentErrorEventSchema,
  AgentOutputEventSchema,
  AgentPermissionRequestEventSchema,
  AgentReadyEventSchema,
  AgentStatusEventSchema,
  AgentTerminatedEventSchema,
  AgentTextChunkEventSchema,
  AgentToolResultEventSchema,
  AgentToolUseEventSchema,
  AgentTurnCompleteEventSchema,
  AgentUnknownEventSchema,
  type AgentOutputEvent,
  type AgentOutputEventOrUnknown,
  type AgentUnknownEvent,
} from "../agent-output/index.ts"

export const FiregridSessionIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("FiregridSessionId"),
).annotations({
  identifier: "firegrid.sessionId",
  title: "Firegrid session id",
  description:
    "Public Firegrid session id. In v1 this is encoded exactly as RuntimeContext.contextId.",
})
export type FiregridSessionId = Schema.Schema.Type<typeof FiregridSessionIdSchema>

export const RuntimeContextIdSchema = FiregridSessionIdSchema.annotations({
  identifier: "firegrid.runtimeContext.contextId",
  title: "Runtime context id",
  description:
    "Durable RuntimeContext id. Public client APIs expose the same encoded value as sessionId.",
})
export type RuntimeContextId = Schema.Schema.Type<typeof RuntimeContextIdSchema>

export const SessionExternalKeySchema = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)),
  id: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionExternalKey = Schema.Schema.Type<typeof SessionExternalKeySchema>

export const SessionCreateOrLoadInputSchema = Schema.Struct({
  externalKey: SessionExternalKeySchema,
  runtime: PublicLaunchRuntimeIntentSchema,
  createdBy: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.operation.session.createOrLoad.input",
  title: "Session create-or-load input",
  description:
    "Create or load a RuntimeContext-backed session from a caller-owned external key.",
  ...firegridProjection({
    operationId: "session.createOrLoad",
    clientName: "sessions.createOrLoad",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionCreateOrLoadInput = Schema.Schema.Type<
  typeof SessionCreateOrLoadInputSchema
>

export const SessionAttachInputSchema = Schema.Struct({
  sessionId: FiregridSessionIdSchema.annotations({
    title: "Session id",
    description:
      "Public Firegrid session id. In v1 this is the same encoded value as RuntimeContext.contextId.",
  }),
}).annotations({
  identifier: "firegrid.operation.session.attach.input",
  title: "Session attach input",
  description:
    "Create a scoped client handle for an existing RuntimeContext-backed Firegrid session id.",
  ...firegridProjection({
    operationId: "session.attach",
    clientName: "sessions.attach",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionAttachDecodedInput = Schema.Schema.Type<
  typeof SessionAttachInputSchema
>
export type SessionAttachInput = Schema.Schema.Encoded<
  typeof SessionAttachInputSchema
>

export const SessionHandleReferenceSchema = Schema.Struct({
  sessionId: FiregridSessionIdSchema,
  contextId: RuntimeContextIdSchema,
}).annotations({
  identifier: "firegrid.operation.session.handleReference",
  title: "Session handle reference",
  description:
    "Serializable identity fields for a RuntimeContext-backed session handle.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionHandleReference = Schema.Schema.Type<
  typeof SessionHandleReferenceSchema
>

export const SessionHandlePromptInputSchema = Schema.Struct({
  payload: Schema.Unknown,
  inputId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  idempotencyKey: Schema.String.pipe(Schema.minLength(1)),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
}).annotations({
  identifier: "firegrid.operation.session.promptScoped.input",
  title: "Scoped session prompt input",
  description:
    "Append a prompt to a RuntimeContext-backed session without restating the context id.",
  ...firegridProjection({
    operationId: "session.prompt.scoped",
    clientName: "session.prompt",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionHandlePromptInput = Schema.Schema.Type<
  typeof SessionHandlePromptInputSchema
>

const SessionWaitInputFields = {
  afterSequence: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  timeoutMs: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
} as const

export const SessionPermissionRequestWaitInputSchema = Schema.Struct(
  SessionWaitInputFields,
).annotations({
  identifier: "firegrid.operation.session.waitForPermissionRequest.input",
  title: "Session permission request wait input",
  description:
    "Wait for a PermissionRequest observation in the scoped RuntimeContext output.",
  ...firegridProjection({
    operationId: "session.wait.forPermissionRequest",
    clientName: "session.wait.forPermissionRequest",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionPermissionRequestWaitInput = Schema.Schema.Type<
  typeof SessionPermissionRequestWaitInputSchema
>

export const SessionAgentOutputWaitInputSchema = Schema.Struct(
  SessionWaitInputFields,
).annotations({
  identifier: "firegrid.operation.session.waitForAgentOutput.input",
  title: "Session agent-output wait input",
  description:
    "Wait for a normalized agent-output observation in the scoped RuntimeContext output.",
  ...firegridProjection({
    operationId: "session.wait.forAgentOutput",
    clientName: "session.wait.forAgentOutput",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionAgentOutputWaitInput = Schema.Schema.Type<
  typeof SessionAgentOutputWaitInputSchema
>

export const SessionPermissionRespondInputSchema = Schema.Struct({
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  decision: PermissionDecisionSchema,
  idempotencyKey: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
}).annotations({
  identifier: "firegrid.operation.session.permissionRespondScoped.input",
  title: "Scoped session permission response input",
  description:
    "Append a PermissionResponse to the scoped RuntimeContext without restating the context id.",
  ...firegridProjection({
    operationId: "permission.respond.scoped",
    clientName: "session.permissions.respond",
  }),
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionPermissionRespondInput = Schema.Schema.Type<
  typeof SessionPermissionRespondInputSchema
>

export const RuntimeAgentOutputEventPayloadSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})
export type RuntimeAgentOutputEventPayload = Schema.Schema.Type<
  typeof RuntimeAgentOutputEventPayloadSchema
>

export const RuntimeAgentOutputEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("firegrid.agent-output"),
  // TFIND-030 (Q2 strict): the envelope `event` is parsed against the typed
  // protocol-owned `AgentOutputEvent` union. A non-conforming event fails
  // decode (no opaque-record pass-through). `RuntimeAgentOutputEventPayload`
  // is retained below only for back-compat consumers.
  event: AgentOutputEventSchema,
}).annotations({
  identifier: "firegrid.operation.session.agentOutputEnvelope",
  title: "Runtime agent-output envelope",
  description:
    "Protocol-owned wrapper for normalized agent-output payloads stored in RuntimeOutput event rows.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type RuntimeAgentOutputEnvelope = Schema.Schema.Type<
  typeof RuntimeAgentOutputEnvelopeSchema
>
const RuntimeAgentOutputEnvelopeJsonSchema = Schema.parseJson(
  RuntimeAgentOutputEnvelopeSchema,
)

export const RuntimePermissionOptionSchema = Schema.Struct({
  optionId: Schema.String.pipe(Schema.minLength(1)),
  kind: Schema.Literal(
    "allow_once",
    "allow_always",
    "reject_once",
    "reject_always",
  ),
  name: Schema.String.pipe(Schema.minLength(1)),
})
export type RuntimePermissionOption = Schema.Schema.Type<
  typeof RuntimePermissionOptionSchema
>

const RuntimePermissionRequestEventSchema = Schema.Struct({
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  toolUseId: Schema.String.pipe(Schema.minLength(1)),
  options: Schema.Array(RuntimePermissionOptionSchema),
})

const RuntimeAgentOutputObservationBaseFields = {
  source: Schema.Literal(FiregridRuntimeObservationSourceNames.agentOutputEvents),
  sessionId: FiregridSessionIdSchema,
  contextId: RuntimeContextIdSchema,
  activityAttempt: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
  ),
  sequence: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
} as const

const RuntimeAgentOutputObservationSupplementalFields = {
  permissionRequestId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  toolUseId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  toolName: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  options: Schema.optional(Schema.Array(RuntimePermissionOptionSchema)),
} as const

export const RuntimeAgentOutputObservationSchema = Schema.Union(
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("Ready"),
    event: AgentReadyEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("TextChunk"),
    event: AgentTextChunkEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("ToolUse"),
    event: AgentToolUseEventSchema,
  }),
  // tf-r06u.41 / DECIDE-3 — the tool-result arm mirrors ToolUse. The
  // supplemental toolUseId/toolName are populated from event.part.id/.name by
  // the emission path so a ToolResult correlates to its ToolUse without
  // decoding the part. Carries isFailure + result (e.g. {buildSha,
  // publishedVersion}) so a client-observable publish terminal is durable +
  // replay-safe by offset/sequence.
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("ToolResult"),
    event: AgentToolResultEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("PermissionRequest"),
    event: AgentPermissionRequestEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("TurnComplete"),
    event: AgentTurnCompleteEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("Status"),
    event: AgentStatusEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("Error"),
    event: AgentErrorEventSchema,
  }),
  Schema.Struct({
    ...RuntimeAgentOutputObservationBaseFields,
    ...RuntimeAgentOutputObservationSupplementalFields,
    _tag: Schema.Literal("Terminated"),
    event: AgentTerminatedEventSchema,
  }),
).annotations({
  identifier: "firegrid.operation.session.agentOutputObservation",
  title: "Runtime agent-output observation",
  description:
    "A normalized agent-output observation scoped to one RuntimeContext-backed session.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type RuntimeAgentOutputObservation = Schema.Schema.Type<
  typeof RuntimeAgentOutputObservationSchema
>

export const RuntimePermissionRequestObservationSchema = Schema.Struct({
  ...RuntimeAgentOutputObservationBaseFields,
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  toolUseId: Schema.String.pipe(Schema.minLength(1)),
  options: Schema.Array(RuntimePermissionOptionSchema),
  event: AgentPermissionRequestEventSchema,
}).annotations({
  identifier: "firegrid.operation.session.permissionRequestObservation",
  title: "Runtime permission request observation",
  description:
    "A normalized PermissionRequest observation scoped to one RuntimeContext.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type RuntimePermissionRequestObservation = Schema.Schema.Type<
  typeof RuntimePermissionRequestObservationSchema
>

export const SessionAgentOutputWaitOutputSchema = Schema.Union(
  Schema.Struct({
    matched: Schema.Literal(true),
    output: RuntimeAgentOutputObservationSchema,
  }),
  Schema.Struct({
    matched: Schema.Literal(false),
    timedOut: Schema.Literal(true),
  }),
).annotations({
  identifier: "firegrid.operation.session.waitForAgentOutput.output",
  title: "Session agent-output wait output",
  description:
    "Result of waiting for a normalized agent-output observation in the scoped RuntimeContext output.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionAgentOutputWaitOutput = Schema.Schema.Type<
  typeof SessionAgentOutputWaitOutputSchema
>

export const SessionPermissionRequestWaitOutputSchema = Schema.Union(
  Schema.Struct({
    matched: Schema.Literal(true),
    request: RuntimePermissionRequestObservationSchema,
  }),
  Schema.Struct({
    matched: Schema.Literal(false),
    timedOut: Schema.Literal(true),
  }),
).annotations({
  identifier: "firegrid.operation.session.waitForPermissionRequest.output",
  title: "Session permission request wait output",
  description:
    "Result of waiting for a PermissionRequest in the scoped RuntimeContext output.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionPermissionRequestWaitOutput = Schema.Schema.Type<
  typeof SessionPermissionRequestWaitOutputSchema
>


const runtimeAgentOutputContextIds = (
  contextId: string,
): Option.Option<{
  readonly sessionId: FiregridSessionId
  readonly contextId: RuntimeContextId
}> => {
  const sessionId = Schema.decodeUnknownEither(FiregridSessionIdSchema)(contextId)
  if (Either.isLeft(sessionId)) return Option.none()
  const runtimeContextId = Schema.decodeUnknownEither(RuntimeContextIdSchema)(contextId)
  if (Either.isLeft(runtimeContextId)) return Option.none()
  return Option.some({
    sessionId: sessionId.right,
    contextId: runtimeContextId.right,
  })
}

export const encodeRuntimeAgentOutputEnvelope = (
  event: AgentOutputEvent,
): string =>
  Schema.encodeSync(RuntimeAgentOutputEnvelopeJsonSchema)({
    type: "firegrid.agent-output",
    event,
  })

// TFIND-030 (Q2 strict): yields the typed union or `Option.none()`. A stored
// envelope whose `event` does not conform to `AgentOutputEvent` is rejected
// here rather than passed through as an opaque record.
//
// tf-8s7d: the strict path is preserved unchanged for callers that
// explicitly want the strict typed surface. New code should prefer
// `tryDecodeRuntimeAgentOutputEnvelope` (below), which adds a forgiving
// terminal `AgentUnknownEvent` arm for forward-compat with future
// `_tag` variants per the tf-ypq9 schema-evolution policy.
export const decodeRuntimeAgentOutputEnvelope = (
  raw: string,
): Option.Option<AgentOutputEvent> =>
  Option.map(
    Schema.decodeUnknownOption(RuntimeAgentOutputEnvelopeJsonSchema)(raw),
    envelope => envelope.event,
  )

// tf-8s7d — forward-compatibility two-pass decoder.
//
// Strict decode first (preserves the typed `AgentOutputEvent` surface for
// known `_tag` variants). On strict failure, attempts a permissive
// structural parse: if the row is a valid JSON envelope whose `event` is
// an object with a non-empty string `_tag`, the envelope is decoded into
// an `AgentUnknownEvent` carrying the original `_tag` (in `unknownTag`)
// and the event payload. Returns `Option.none()` only for envelopes that
// fail BOTH paths (malformed JSON, wrong outer envelope shape, or an
// event without a string `_tag`).
//
// This is the load-bearing forward-compat seam: when a newer Firegrid
// version emits a new `AgentOutputEvent` variant, older readers using
// this decoder preserve the row rather than silently drop it. The
// preserved variant is `AgentUnknownEvent` — clearly tagged so consumers
// can surface, audit, log, or drop it intentionally.
//
// Per the tf-ypq9 schema-evolution policy
// (`docs/cannon/architecture/schema-evolution-and-error-ownership.md`),
// `AgentOutputEvent` is replay-facing; this decoder is the projection
// of the "decode old and current row versions through a migration union
// before the row reaches execution code" clause for the
// future-tag-expansion case.
const PermissiveAgentOutputEnvelopeSchema = Schema.parseJson(
  Schema.Struct({
    type: Schema.Literal("firegrid.agent-output"),
    event: Schema.Struct({
      _tag: Schema.String.pipe(Schema.minLength(1)),
    }, {
      key: Schema.String,
      value: Schema.Unknown,
    }),
  }),
)

const buildAgentUnknownEvent = (
  rawEvent: { readonly _tag: string } & { readonly [k: string]: unknown },
): Option.Option<AgentUnknownEvent> => {
  const { _tag, ...rest } = rawEvent
  return Schema.decodeUnknownOption(AgentUnknownEventSchema)({
    _tag: "AgentOutputUnknown",
    unknownTag: _tag,
    ...(Object.keys(rest).length === 0 ? {} : { payload: rest }),
  })
}

export const tryDecodeRuntimeAgentOutputEnvelope = (
  raw: string,
): Option.Option<AgentOutputEventOrUnknown> => {
  const strict = decodeRuntimeAgentOutputEnvelope(raw)
  if (Option.isSome(strict)) return strict
  const permissive = Schema.decodeUnknownOption(
    PermissiveAgentOutputEnvelopeSchema,
  )(raw)
  if (Option.isNone(permissive)) return Option.none()
  return buildAgentUnknownEvent(permissive.value.event)
}

export const runtimeAgentOutputObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<RuntimeAgentOutputObservation> =>
  // tf-8s7d: use the forgiving two-pass decoder so a future `_tag`
  // variant decodes to `AgentUnknownEvent` rather than silently
  // dropping the row at the strict-decode boundary. The observation
  // layer still only surfaces KNOWN variants in its typed return
  // (`RuntimeAgentOutputObservation`); the Unknown branch returns
  // `Option.none()` here so existing consumers' exhaustive `_tag`
  // matches stay total. A future revision can promote `AgentUnknownEvent`
  // into the observation surface if a consumer needs to audit unknowns.
  Option.flatMap(tryDecodeRuntimeAgentOutputEnvelope(row.raw), (event) => {
    if (event._tag === "AgentOutputUnknown") return Option.none()
    const contextIds = runtimeAgentOutputContextIds(row.contextId)
    if (Option.isNone(contextIds)) return Option.none()
    const base = {
      source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
      sessionId: contextIds.value.sessionId,
      contextId: contextIds.value.contextId,
      activityAttempt: row.activityAttempt,
      sequence: row.sequence,
    }

    switch (event._tag) {
      case "Ready":
        return Option.some({ ...base, _tag: "Ready", event })
      case "TextChunk":
        return Option.some({ ...base, _tag: "TextChunk", event })
      case "ToolUse":
        return Option.some({
          ...base,
          _tag: "ToolUse",
          event,
          toolUseId: event.part.id,
          toolName: event.part.name,
        })
      case "ToolResult":
        // tf-r06u.41 — mirror ToolUse: lift part.id/.name into the supplemental
        // fields so a ToolResult correlates to its ToolUse by toolUseId without
        // decoding the part. isFailure + result ride inside `event.part`.
        return Option.some({
          ...base,
          _tag: "ToolResult",
          event,
          toolUseId: event.part.id,
          toolName: event.part.name,
        })
      case "PermissionRequest": {
        const decoded = Schema.decodeUnknownEither(RuntimePermissionRequestEventSchema)(event)
        if (Either.isLeft(decoded)) return Option.none()
        return Option.some({
          ...base,
          _tag: "PermissionRequest",
          event: decoded.right,
          permissionRequestId: decoded.right.permissionRequestId,
          toolUseId: decoded.right.toolUseId,
          options: decoded.right.options,
        })
      }
      case "TurnComplete":
        return Option.some({ ...base, _tag: "TurnComplete", event })
      case "Status":
        return Option.some({ ...base, _tag: "Status", event })
      case "Error":
        return Option.some({ ...base, _tag: "Error", event })
      case "Terminated":
        return Option.some({ ...base, _tag: "Terminated", event })
    }
  })

export const runtimePermissionRequestObservationFromAgentOutput = (
  observation: RuntimeAgentOutputObservation,
): Option.Option<RuntimePermissionRequestObservation> => {
  if (observation._tag !== "PermissionRequest") return Option.none()
  if (observation.permissionRequestId === undefined) return Option.none()
  if (observation.toolUseId === undefined) return Option.none()
  if (observation.options === undefined) return Option.none()
  return Option.some({
    source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
    sessionId: observation.sessionId,
    contextId: observation.contextId,
    activityAttempt: observation.activityAttempt,
    sequence: observation.sequence,
    _tag: "PermissionRequest",
    permissionRequestId: observation.permissionRequestId,
    toolUseId: observation.toolUseId,
    options: observation.options,
    event: observation.event,
  })
}

export const runtimePermissionRequestObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<RuntimePermissionRequestObservation> =>
  Option.flatMap(
    runtimeAgentOutputObservationFromRow(row),
    runtimePermissionRequestObservationFromAgentOutput,
  )

const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const utf8ToBase64Url = (bytes: Uint8Array): string => {
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const combined = (first << 16) | (second << 8) | third
    output += base64UrlAlphabet[(combined >> 18) & 0x3f]
    output += base64UrlAlphabet[(combined >> 12) & 0x3f]
    if (index + 1 < bytes.length) {
      output += base64UrlAlphabet[(combined >> 6) & 0x3f]
    }
    if (index + 2 < bytes.length) {
      output += base64UrlAlphabet[combined & 0x3f]
    }
  }
  return output
}

export const sessionContextIdForExternalKey = (
  externalKey: SessionExternalKey,
): FiregridSessionId => {
  const canonical = JSON.stringify([externalKey.source, externalKey.id])
  return Schema.decodeSync(FiregridSessionIdSchema)(
    `ctx_ext_${utf8ToBase64Url(new TextEncoder().encode(canonical))}`,
  )
}

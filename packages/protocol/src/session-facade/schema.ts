import type { RuntimeEventRow } from "../launch/index.ts"
import { Either, Option, Schema } from "effect"
import {
  FiregridRuntimeObservationSourceNames,
  PermissionDecisionSchema,
} from "../agent-tools/schema.ts"
import { PublicLaunchRuntimeIntentSchema } from "../launch/schema.ts"

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

export const SessionHandlePromptInputSchema = Schema.Struct({
  payload: Schema.Unknown,
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
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionHandlePromptInput = Schema.Schema.Type<
  typeof SessionHandlePromptInputSchema
>

export const SessionPermissionRequestWaitInputSchema = Schema.Struct({
  afterSequence: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  timeoutMs: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
}).annotations({
  identifier: "firegrid.operation.session.waitForPermissionRequest.input",
  title: "Session permission request wait input",
  description:
    "Wait for a PermissionRequest observation in the scoped RuntimeContext output.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type SessionPermissionRequestWaitInput = Schema.Schema.Type<
  typeof SessionPermissionRequestWaitInputSchema
>

export const SessionAgentOutputWaitInputSchema = Schema.Struct({
  afterSequence: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  timeoutMs: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
}).annotations({
  identifier: "firegrid.operation.session.waitForAgentOutput.input",
  title: "Session agent-output wait input",
  description:
    "Wait for a normalized agent-output observation in the scoped RuntimeContext output.",
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
  event: RuntimeAgentOutputEventPayloadSchema,
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

const RuntimeToolUseEventSchema = Schema.Struct({
  _tag: Schema.Literal("ToolUse"),
  part: Schema.Struct({
    id: Schema.String.pipe(Schema.minLength(1)),
    name: Schema.String.pipe(Schema.minLength(1)),
  }),
})

export const RuntimeAgentOutputObservationSchema = Schema.Struct({
  source: Schema.Literal(FiregridRuntimeObservationSourceNames.agentOutputEvents),
  sessionId: FiregridSessionIdSchema,
  contextId: RuntimeContextIdSchema,
  activityAttempt: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
  ),
  sequence: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  _tag: Schema.String.pipe(Schema.minLength(1)),
  event: RuntimeAgentOutputEventPayloadSchema,
  permissionRequestId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  toolUseId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  toolName: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  options: Schema.optional(Schema.Array(RuntimePermissionOptionSchema)),
}).annotations({
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
  source: Schema.Literal(FiregridRuntimeObservationSourceNames.agentOutputEvents),
  sessionId: FiregridSessionIdSchema,
  contextId: RuntimeContextIdSchema,
  activityAttempt: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
  ),
  sequence: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  toolUseId: Schema.String.pipe(Schema.minLength(1)),
  options: Schema.Array(RuntimePermissionOptionSchema),
  event: RuntimeAgentOutputEventPayloadSchema,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

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
  event: RuntimeAgentOutputEventPayload,
): string =>
  JSON.stringify(Schema.encodeUnknownSync(RuntimeAgentOutputEnvelopeSchema)({
    type: "firegrid.agent-output",
    event,
  }))

export const decodeRuntimeAgentOutputEnvelope = (
  raw: string,
): Option.Option<RuntimeAgentOutputEventPayload> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return Option.none()
  }
  const decoded = Schema.decodeUnknownEither(RuntimeAgentOutputEnvelopeSchema)(parsed)
  return Either.isRight(decoded) ? Option.some(decoded.right.event) : Option.none()
}

export const runtimeAgentOutputObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<RuntimeAgentOutputObservation> =>
  Option.flatMap(decodeRuntimeAgentOutputEnvelope(row.raw), (event) => {
    if (typeof event["_tag"] !== "string") return Option.none()
    const contextIds = runtimeAgentOutputContextIds(row.contextId)
    if (Option.isNone(contextIds)) return Option.none()
    const base = {
      source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
      sessionId: contextIds.value.sessionId,
      contextId: contextIds.value.contextId,
      activityAttempt: row.activityAttempt,
      sequence: row.sequence,
      _tag: event["_tag"],
      event,
    }
    if (event["_tag"] === "PermissionRequest") {
      const decoded = Schema.decodeUnknownEither(RuntimePermissionRequestEventSchema)(event)
      if (Either.isLeft(decoded)) return Option.none()
      return Option.some({
        ...base,
        _tag: "PermissionRequest",
        permissionRequestId: decoded.right.permissionRequestId,
        toolUseId: decoded.right.toolUseId,
        options: decoded.right.options,
      })
    }
    if (event["_tag"] === "ToolUse") {
      const decoded = Schema.decodeUnknownEither(RuntimeToolUseEventSchema)(event)
      if (Either.isLeft(decoded)) return Option.some(base)
      return Option.some({
        ...base,
        toolUseId: decoded.right.part.id,
        toolName: decoded.right.part.name,
      })
    }
    return Option.some(base)
  })

export const runtimePermissionRequestObservationFromAgentOutput = (
  observation: RuntimeAgentOutputObservation,
): Option.Option<RuntimePermissionRequestObservation> => {
  if (observation._tag !== "PermissionRequest") return Option.none()
  if (observation.permissionRequestId === undefined) return Option.none()
  if (observation.toolUseId === undefined) return Option.none()
  if (observation.options === undefined) return Option.none()
  if (!isRecord(observation.event)) return Option.none()
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

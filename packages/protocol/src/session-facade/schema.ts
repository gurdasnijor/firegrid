import { Schema } from "effect"
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

export const RuntimePermissionRequestObservationSchema = Schema.Struct({
  source: Schema.Literal(FiregridRuntimeObservationSourceNames.agentOutputEvents),
  contextId: Schema.String.pipe(Schema.minLength(1)),
  activityAttempt: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
  ),
  sequence: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  toolUseId: Schema.String.pipe(Schema.minLength(1)),
  event: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
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

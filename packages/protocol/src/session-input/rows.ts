import {
  sessionInputIdForIdempotencyKey,
  sessionInputRowId,
} from "./ids.ts"
import {
  type PublicPromptRequest,
  type SessionInputRequest,
  type SessionInputRow,
} from "./schema.ts"

const nowIso = (): string => new Date().toISOString()

export const sessionInputIdForRequest = (
  request: SessionInputRequest,
): string =>
  request.sessionInputId ??
  (request.idempotencyKey === undefined
    ? `input_${crypto.randomUUID()}`
    : sessionInputIdForIdempotencyKey(request.contextId, request.idempotencyKey))

// `request` is already validated by the API boundary
// (`Firegrid.prompt` decodes `PublicPromptRequestSchema` and passes the
// validated value in). This trusted helper rebuilds it into the internal
// `SessionInputRequest` shape without re-decoding.
export const promptToSessionInputRequest = (
  request: PublicPromptRequest,
): SessionInputRequest => ({
  contextId: request.contextId,
  kind: "message",
  authoredBy: "client",
  payload: request.payload,
  ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
})

// Trusted row constructor: `request` is already typed as
// `SessionInputRequest` (validated upstream by `Firegrid.prompt`'s
// `Schema.decodeUnknown(PublicPromptRequestSchema)`). The wire-shape row
// is built directly and constrained via `satisfies`; the durable stream
// boundary re-encodes through `SessionInputRowSchema` on append, so
// decoding here would be redundant.
export const makeSessionInputRow = (
  request: SessionInputRequest,
  options?: {
    readonly sessionInputId?: string
    readonly createdAt?: string
  },
): SessionInputRow => {
  const sessionInputId = options?.sessionInputId ?? sessionInputIdForRequest(request)
  const createdAt = options?.createdAt ?? nowIso()
  return {
    type: "firegrid.session.input",
    id: sessionInputRowId(request.contextId, sessionInputId),
    at: createdAt,
    sessionInputId,
    contextId: request.contextId,
    kind: request.kind,
    authoredBy: request.authoredBy,
    payload: request.payload,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    createdAt,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  } satisfies SessionInputRow
}

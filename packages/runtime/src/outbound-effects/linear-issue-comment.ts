import {
  ExternalEffectCallResponseSchema,
  type ExternalEffectCallRequest,
  type ExternalEffectCallResponse,
} from "@firegrid/protocol/channels"
import { Context, Effect, Layer, Schema } from "effect"

const defaultLinearGraphQlUrl = "https://api.linear.app/graphql"
export const linearIssueCommentCreateEffectId = "linear.issue.comment.create"

export class LinearOutboundError extends Schema.TaggedError<LinearOutboundError>()(
  "LinearOutboundError",
  {
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface LinearGraphQlTransportRequest {
  readonly operationName: string
  readonly query: string
  readonly variables: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
}

export interface LinearGraphQlTransportService {
  readonly execute: (
    request: LinearGraphQlTransportRequest,
  ) => Effect.Effect<unknown, LinearOutboundError>
}

export class LinearGraphQlTransport extends Context.Tag(
  "@firegrid/runtime/outbound-effects/LinearGraphQlTransport",
)<LinearGraphQlTransport, LinearGraphQlTransportService>() {}

export interface ExternalEffectOutboundAdapterService {
  readonly call: (
    request: ExternalEffectCallRequest,
  ) => Effect.Effect<ExternalEffectCallResponse, LinearOutboundError>
}

export class ExternalEffectOutboundAdapter extends Context.Tag(
  "@firegrid/runtime/outbound-effects/ExternalEffectOutboundAdapter",
)<ExternalEffectOutboundAdapter, ExternalEffectOutboundAdapterService>() {}

export interface LinearGraphQlFetchTransportOptions {
  readonly apiKey: string
  readonly apiUrl?: string
}

const LinearGraphQlRequestBodyJsonSchema = Schema.parseJson(Schema.Struct({
  operationName: Schema.String,
  query: Schema.String,
  variables: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}))

const encodeGraphQlRequestBody = (
  request: LinearGraphQlTransportRequest,
): Effect.Effect<string, LinearOutboundError> =>
  Schema.encode(LinearGraphQlRequestBodyJsonSchema)({
    operationName: request.operationName,
    query: request.query,
    variables: request.variables,
  }).pipe(
    Effect.mapError(cause =>
      new LinearOutboundError({
        op: "linear.graphql.encode",
        message: "failed to encode Linear GraphQL request body",
        cause,
      })),
  )

const fetchLinearGraphQl = (
  options: LinearGraphQlFetchTransportOptions,
  request: LinearGraphQlTransportRequest,
): Effect.Effect<Response, LinearOutboundError> =>
  Effect.gen(function*() {
    const body = yield* encodeGraphQlRequestBody(request)
    return yield* Effect.tryPromise({
      try: () =>
        globalThis.fetch(options.apiUrl ?? defaultLinearGraphQlUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            ...(request.headers ?? {}),
          },
          body,
        }),
      catch: cause =>
        new LinearOutboundError({
          op: "linear.graphql.fetch",
          message: "failed to call Linear GraphQL endpoint",
          cause,
        }),
    })
  })

const parseLinearGraphQlJson = (
  response: Response,
): Effect.Effect<unknown, LinearOutboundError> =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: cause =>
      new LinearOutboundError({
        op: "linear.graphql.decode",
        message: "failed to decode Linear GraphQL response body",
        cause,
      }),
  })

export const LinearGraphQlFetchTransportLive = (
  options: LinearGraphQlFetchTransportOptions,
) =>
  Layer.succeed(LinearGraphQlTransport, {
    execute: request =>
      Effect.gen(function*() {
        const response = yield* fetchLinearGraphQl(options, request)
        const body = yield* parseLinearGraphQlJson(response)
        if (!response.ok) {
          return yield* new LinearOutboundError({
            op: "linear.graphql.http",
            message: `Linear GraphQL request failed with HTTP ${response.status}`,
            cause: body,
          })
        }
        return body
      }),
  })

const LinearCommentSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  createdAt: Schema.String.pipe(Schema.minLength(1)),
  url: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
})

const LinearCommentCreatePayloadSchema = Schema.Struct({
  success: Schema.Boolean,
  comment: Schema.optional(LinearCommentSchema),
})

const LinearGraphQlErrorSchema = Schema.Struct({
  message: Schema.String.pipe(Schema.minLength(1)),
})

const LinearCommentCreateGraphQlResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.Struct({
    commentCreate: LinearCommentCreatePayloadSchema,
  })),
  errors: Schema.optional(Schema.Array(LinearGraphQlErrorSchema)),
})

const LinearIssueCommentPayloadSchema = Schema.Struct({
  issueId: Schema.String.pipe(Schema.minLength(1)),
  body: Schema.String.pipe(Schema.minLength(1)),
})

const linearIssueCommentCreateMutation = `
mutation FiregridLinearIssueCommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment {
      id
      createdAt
      url
    }
  }
}
`

const graphQlErrorMessage = (
  errors: ReadonlyArray<typeof LinearGraphQlErrorSchema.Type> | undefined,
) =>
  errors === undefined || errors.length === 0
    ? "Linear GraphQL commentCreate failed"
    : errors.map(error => error.message).join("; ")

const optionalHeader = (
  name: string,
  value: string | undefined,
): Readonly<Record<string, string>> =>
  value === undefined ? {} : { [name]: value }

const decodeGraphQlResponse = (
  request: ExternalEffectCallRequest,
  body: unknown,
): Effect.Effect<ExternalEffectCallResponse, LinearOutboundError> =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknown(
      LinearCommentCreateGraphQlResponseSchema,
    )(body).pipe(
      Effect.mapError(cause =>
        new LinearOutboundError({
          op: "linear.issue.comment.create.decode",
          message: "Linear commentCreate response did not match the expected shape",
          cause,
        })),
    )
    const payload = decoded.data?.commentCreate
    if (payload?.success !== true || payload.comment === undefined) {
      return yield* new LinearOutboundError({
        op: "linear.issue.comment.create",
        message: graphQlErrorMessage(decoded.errors),
        cause: body,
      })
    }
    return yield* Schema.decodeUnknown(ExternalEffectCallResponseSchema)({
      effectId: request.effectId,
      status: "completed",
      output: {
        provider: "linear",
        action: "issue.comment.create",
        commentId: payload.comment.id,
        ...(payload.comment.url === undefined ? {} : { url: payload.comment.url }),
      },
      completedAt: payload.comment.createdAt,
    }).pipe(
      Effect.mapError(cause =>
        new LinearOutboundError({
          op: "linear.issue.comment.create.external-effect-response",
          message: "failed to encode neutral external effect response",
          cause,
        })),
    )
  })

const decodeLinearIssueCommentPayload = (
  request: ExternalEffectCallRequest,
): Effect.Effect<typeof LinearIssueCommentPayloadSchema.Type, LinearOutboundError> =>
  Schema.decodeUnknown(LinearIssueCommentPayloadSchema)(request.payload).pipe(
    Effect.mapError(cause =>
      new LinearOutboundError({
        op: "linear.issue.comment.create.payload",
        message: "Linear issue comment effect payload did not match the expected shape",
        cause,
      })),
  )

const callLinearIssueCommentCreate = (
  transport: LinearGraphQlTransportService,
  request: ExternalEffectCallRequest,
): Effect.Effect<ExternalEffectCallResponse, LinearOutboundError> =>
  Effect.gen(function*() {
    const payload = yield* decodeLinearIssueCommentPayload(request)
    const body = yield* transport.execute({
      operationName: "FiregridLinearIssueCommentCreate",
      query: linearIssueCommentCreateMutation,
      variables: {
        issueId: payload.issueId,
        body: payload.body,
      },
      headers: {
        ...optionalHeader("firegrid-idempotency-key", request.idempotencyKey),
        ...optionalHeader("firegrid-correlation-id", request.correlationId),
      },
    })
    return yield* decodeGraphQlResponse(request, body)
  })

export const LinearIssueCommentExternalEffectAdapterLive = Layer.effect(
  ExternalEffectOutboundAdapter,
  Effect.gen(function*() {
    const transport = yield* LinearGraphQlTransport
    return {
      // firegrid-external-effect-channel.RUNTIME_ADAPTER.1
      call: request =>
        request.effectId === linearIssueCommentCreateEffectId
          ? callLinearIssueCommentCreate(transport, request)
          : new LinearOutboundError({
            op: "external.effect.unsupported",
            message: `unsupported external effect '${request.effectId}'`,
          }),
    } satisfies ExternalEffectOutboundAdapterService
  }),
)

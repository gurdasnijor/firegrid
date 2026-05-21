import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  ExternalEffectOutboundAdapter,
  LinearGraphQlTransport,
  LinearIssueCommentExternalEffectAdapterLive,
  linearIssueCommentCreateEffectId,
  type LinearGraphQlTransportRequest,
} from "../../src/outbound-effects/index.ts"

describe("Linear issue comment external-effect adapter", () => {
  it("firegrid-external-effect-channel.RUNTIME_ADAPTER.1 firegrid-external-effect-channel.RUNTIME_ADAPTER.2 firegrid-external-effect-channel.RUNTIME_ADAPTER.3 firegrid-external-effect-channel.VALIDATION.1 converts a neutral effect request into one Linear outbound call", async () => {
    const calls: Array<LinearGraphQlTransportRequest> = []
    const transport = Layer.succeed(LinearGraphQlTransport, {
      execute: request =>
        Effect.sync(() => {
          calls.push(request)
          return {
            data: {
              commentCreate: {
                success: true,
                comment: {
                  id: "comment_1",
                  createdAt: "2026-05-20T00:00:00.000Z",
                  url: "https://linear.app/team/issue/TF-123#comment-comment_1",
                },
              },
            },
          }
        }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const adapter = yield* ExternalEffectOutboundAdapter
        return yield* adapter.call({
          effectId: linearIssueCommentCreateEffectId,
          payload: {
            issueId: "issue_1",
            body: "Round-trip demo comment",
          },
          idempotencyKey: "idem-1",
          correlationId: "corr-1",
        })
      }).pipe(
        Effect.provide(LinearIssueCommentExternalEffectAdapterLive.pipe(
          Layer.provide(transport),
        )),
      ),
    )

    expect(result).toEqual({
      effectId: linearIssueCommentCreateEffectId,
      status: "completed",
      output: {
        provider: "linear",
        action: "issue.comment.create",
        commentId: "comment_1",
        url: "https://linear.app/team/issue/TF-123#comment-comment_1",
      },
      completedAt: "2026-05-20T00:00:00.000Z",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.operationName).toBe("FiregridLinearIssueCommentCreate")
    expect(calls[0]?.variables).toEqual({
      issueId: "issue_1",
      body: "Round-trip demo comment",
    })
    expect(calls[0]?.headers).toEqual({
      "firegrid-idempotency-key": "idem-1",
      "firegrid-correlation-id": "corr-1",
    })
  })
})

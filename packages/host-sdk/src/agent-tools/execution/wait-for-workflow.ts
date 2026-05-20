import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  type WaitForToolOutput,
  WaitForToolOutputSchema,
} from "@firegrid/protocol/agent-tools"
import {
  evaluateFieldEquals,
  FieldEqualsTriggerSchema,
  type FieldEqualsTrigger,
} from "@firegrid/runtime/durable-tools"
import { Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  ChannelRegistry,
  type ChannelRegistryService,
  type ChannelRegistration,
  type IngressChannel,
} from "../../host/channel-registry.ts"

const WaitForWorkflowPayloadSchema = Schema.Struct({
  executionId: Schema.String,
  channel: Schema.String,
  trigger: FieldEqualsTriggerSchema,
  timeoutMs: Schema.optional(Schema.Number),
})

type WaitForWorkflowPayload = Schema.Schema.Type<
  typeof WaitForWorkflowPayloadSchema
>

interface WaitForChannelRequest {
  readonly executionId: string
  readonly channel: string
  readonly trigger: FieldEqualsTrigger
  readonly timeoutMs?: number
}

export type WaitForChannelError =
  | {
    readonly _tag: "UnknownChannel"
    readonly channel: string
    readonly cause: unknown
  }
  | {
    readonly _tag: "WrongDirection"
    readonly channel: string
    readonly actual: ChannelRegistration["direction"]
  }
  | {
    readonly _tag: "WorkflowFailed"
    readonly cause: unknown
  }

interface WaitForChannelService {
  readonly waitFor: (
    request: WaitForChannelRequest,
  ) => Effect.Effect<WaitForToolOutput, WaitForChannelError>
}

export class WaitForChannel extends Context.Tag(
  "firegrid/host-sdk/WaitForChannel",
)<WaitForChannel, WaitForChannelService>() {}

export const waitForWorkflowExecutionId = (
  contextId: string,
  toolUseId: string,
): string => `wait:${contextId}:${toolUseId}`

export const WaitForWorkflow = Workflow.make({
  name: "firegrid.agent_tools.wait_for",
  payload: WaitForWorkflowPayloadSchema,
  success: WaitForToolOutputSchema,
  idempotencyKey: ({ executionId }) => executionId,
})

const ingressStreamFor = (
  channel: string,
): Effect.Effect<Stream.Stream<unknown, unknown>, unknown, ChannelRegistry> =>
  Effect.gen(function* () {
    const registry = yield* ChannelRegistry
    const registration = yield* registry.require(channel)
    if (registration.direction !== "ingress") {
      return yield* Effect.fail(
        new Error(`wait_for workflow requires an ingress channel: ${channel}`),
      )
    }
    return (registration as IngressChannel).binding.stream
  })

const validateIngressChannel = (
  registry: ChannelRegistryService,
  channel: string,
): Effect.Effect<void, WaitForChannelError> =>
  Effect.gen(function* () {
    const registration = yield* registry.require(channel).pipe(
      Effect.mapError((cause): WaitForChannelError => ({
        _tag: "UnknownChannel",
        channel,
        cause,
      })),
    )
    if (registration.direction !== "ingress") {
      return yield* Effect.fail({
        _tag: "WrongDirection",
        channel,
        actual: registration.direction,
      } satisfies WaitForChannelError)
    }
  })

const matchOrTimeoutActivityFor = ({
  executionId,
  channel,
  trigger,
  timeoutMs,
}: WaitForWorkflowPayload) =>
  Activity.make({
    name: `wait-for-workflow.match_or_timeout/${executionId}`,
    success: WaitForToolOutputSchema,
    execute: Effect.gen(function* () {
      const sourceStream = yield* ingressStreamFor(channel)
      const filteredSource = sourceStream.pipe(
        Stream.filter((row) =>
          trigger.length === 0 ? true : evaluateFieldEquals(trigger, row),
        ),
      )
      const matchSide = Stream.runHead(filteredSource).pipe(
        Effect.flatMap((first) =>
          Option.match(first, {
            onNone: () => Effect.never,
            onSome: (event) =>
              Effect.succeed<WaitForToolOutput>({ matched: true, event }),
          }),
        ),
      )
      if (timeoutMs === undefined) return yield* matchSide
      return yield* Effect.race(
        matchSide,
        Effect.sleep(Duration.millis(timeoutMs)).pipe(
          Effect.as<WaitForToolOutput>({ matched: false, timedOut: true }),
        ),
      )
    }).pipe(
      Effect.orDie,
      Effect.withSpan("firegrid.agent_tools.wait_for.match_or_timeout_activity", {
        kind: "internal",
        attributes: {
          "firegrid.workflow.execution_id": executionId,
          "firegrid.wait.channel": channel,
          "firegrid.wait.has_timeout": timeoutMs !== undefined,
        },
      }),
    ),
  })

export const WaitForWorkflowLayer = WaitForWorkflow.toLayer((payload) =>
  matchOrTimeoutActivityFor(payload).pipe(
    Effect.withSpan("firegrid.agent_tools.wait_for.workflow_body", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.execution_id": payload.executionId,
        "firegrid.wait.channel": payload.channel,
        "firegrid.wait.has_timeout": payload.timeoutMs !== undefined,
      },
    }),
  ))

export const WaitForChannelWorkflowLayer = Layer.mergeAll(
  WaitForWorkflowLayer,
  Layer.effect(
    WaitForChannel,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine
      const registry = yield* ChannelRegistry
      return WaitForChannel.of({
        waitFor: (request) =>
          Effect.gen(function* () {
            yield* validateIngressChannel(registry, request.channel)
            return yield* engine.execute(WaitForWorkflow, {
              executionId: request.executionId,
              payload: request,
            }).pipe(
              Effect.mapError((cause): WaitForChannelError => ({
                _tag: "WorkflowFailed",
                cause,
              })),
            )
          }),
      })
    }),
  ),
)

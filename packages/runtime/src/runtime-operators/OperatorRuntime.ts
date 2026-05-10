import { Context, Effect, Layer, Option } from "effect"
import type { ReactiveWorkflowOperator } from "./OperatorDescriptor.ts"
import {
  reactiveWorkflowOperatorError,
  type ReactiveWorkflowOperatorError,
  type ReactiveWorkflowOperatorRunSummary,
} from "./schema.ts"

interface ReactiveWorkflowOperatorRuntimeService {
  readonly run: <Fact, Payload, SourceError, SourceRequirements, WorkflowError, WorkflowRequirements>(
    operator: ReactiveWorkflowOperator<
      Fact,
      Payload,
      SourceError,
      SourceRequirements,
      WorkflowError,
      WorkflowRequirements
    >,
  ) => Effect.Effect<
    ReactiveWorkflowOperatorRunSummary,
    ReactiveWorkflowOperatorError,
    SourceRequirements | WorkflowRequirements
  >
}

export class ReactiveWorkflowOperatorRuntime
  extends Context.Tag("firegrid/runtime/ReactiveWorkflowOperatorRuntime")<
    ReactiveWorkflowOperatorRuntime,
    ReactiveWorkflowOperatorRuntimeService
  >()
{}

export const ReactiveWorkflowOperatorRuntimeLive = Layer.succeed(
  ReactiveWorkflowOperatorRuntime,
  ReactiveWorkflowOperatorRuntime.of({
    run: operator =>
      Effect.gen(function* () {
        const facts = yield* operator.source.scan.pipe(
          Effect.mapError(cause =>
            reactiveWorkflowOperatorError(
              "source.scan",
              "failed to scan reactive workflow operator source",
              {
                operatorId: operator.operatorId,
                sourceId: operator.source.sourceId,
                cause,
              },
            )),
        )
        const seenExecutionIds = new Set<string>()
        const executionIds: Array<string> = []
        let payloadsSelected = 0
        let duplicateInputsSkipped = 0
        let workflowExecutionsRequested = 0

        yield* Effect.forEach(facts, fact => {
          const selected = operator.select(fact)
          if (Option.isNone(selected)) return Effect.void

          payloadsSelected += 1
          const payload = selected.value
          const executionId = operator.executionId(payload)
          if (seenExecutionIds.has(executionId)) {
            duplicateInputsSkipped += 1
            return Effect.void
          }

          seenExecutionIds.add(executionId)
          executionIds.push(executionId)
          // firegrid-reactive-workflow-operators.OPERATOR.1
          // firegrid-reactive-workflow-operators.OPERATOR.2
          // firegrid-reactive-workflow-operators.REPLAY.2
          // firegrid-reactive-workflow-operators.REPLAY.3
          // firegrid-reactive-workflow-operators.WORKFLOW.5
          return operator.execute({
            executionId,
            payload,
          }).pipe(
            Effect.mapError(cause =>
              reactiveWorkflowOperatorError(
                "workflow.execute",
                "failed to execute reactive workflow operator target",
                {
                  operatorId: operator.operatorId,
                  sourceId: operator.source.sourceId,
                  executionId,
                  cause,
                },
              )),
            Effect.tap(() =>
              Effect.sync(() => {
                workflowExecutionsRequested += 1
              })),
          )
        }, { discard: true })

        return {
          operatorId: operator.operatorId,
          sourceId: operator.source.sourceId,
          factsRead: facts.length,
          payloadsSelected,
          duplicateInputsSkipped,
          workflowExecutionsRequested,
          executionIds,
        }
      }),
  }),
)

export const runReactiveWorkflowOperator = <
  Fact,
  Payload,
  SourceError,
  SourceRequirements,
  WorkflowError,
  WorkflowRequirements,
>(
  operator: ReactiveWorkflowOperator<
    Fact,
    Payload,
    SourceError,
    SourceRequirements,
    WorkflowError,
    WorkflowRequirements
  >,
): Effect.Effect<
  ReactiveWorkflowOperatorRunSummary,
  ReactiveWorkflowOperatorError,
  ReactiveWorkflowOperatorRuntime | SourceRequirements | WorkflowRequirements
> =>
  ReactiveWorkflowOperatorRuntime.pipe(
    Effect.flatMap(runtime => runtime.run(operator)),
  )

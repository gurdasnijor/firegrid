import { Response } from "@effect/ai"
import {
  evaluateFieldEquals,
  type FieldEqualsTrigger,
  type RuntimeWaitSource,
  type WaitForOptions,
  type WaitForOutcome,
} from "@firegrid/runtime/durable-tools"
import type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import { Effect, Option, Stream } from "effect"
import type { DurableTableCollectionFacade } from "effect-durable-operators"
import { makeMemoryDurableCollectionFacade } from "../effect-durable-operators/DurableTable.ts"
import {
  observationFromAgentOutput,
  outputObservationKey,
  persistAgentOutputObservation,
} from "../runtime/agent-event-pipeline/authorities/runtime-output.ts"

type AgentOutputAfterSource = Extract<
  RuntimeWaitSource,
  { readonly _tag: "AgentOutputAfter" }
>

interface PerContextOutputTarget {
  readonly _tag: "PerContextOutput"
  readonly contextId: string
  readonly activityAttempt: number
  readonly afterSequence?: number
}

type ClaimStatus = "passed" | "failed"

interface WaitForOutputFinding {
  readonly id: "wait-source-divergence"
  readonly claim: string
  readonly expected: Record<string, unknown>
  readonly actual: Record<string, unknown>
  readonly summary: string
}

interface WaitForOutputClaim {
  readonly name: string
  readonly status: ClaimStatus
  readonly target: PerContextOutputTarget
  readonly expectedTarget: PerContextOutputTarget
  readonly matched: boolean
  readonly matchedContextId?: string
  readonly matchedSequence?: number
  readonly finding?: WaitForOutputFinding
}

type TinyRuntimeOutputEvents =
  DurableTableCollectionFacade<RuntimeAgentOutputObservation, string>

const textChunk = (id: string, delta: string): AgentOutputEvent => ({
  _tag: "TextChunk",
  part: Response.textDeltaPart({ id, delta }),
})

const contextIdFromTrigger = (
  trigger: FieldEqualsTrigger,
): Option.Option<string> =>
  Option.fromNullable(
    trigger.find(predicate =>
      predicate.path.length === 1 &&
      predicate.path[0] === "contextId" &&
      typeof predicate.equals === "string",
    )?.equals as string | undefined,
  )

const outputTargetForSource = (
  source: RuntimeWaitSource,
  trigger: FieldEqualsTrigger,
): Effect.Effect<PerContextOutputTarget, string> => {
  switch (source._tag) {
    case "AgentOutput":
      return Option.match(contextIdFromTrigger(trigger), {
        onNone: () =>
          Effect.fail(
            "AgentOutput waits must carry a contextId trigger so the router can select the per-context output stream",
          ),
        onSome: contextId =>
          Effect.succeed({
            _tag: "PerContextOutput",
            contextId,
            activityAttempt: 0,
          }),
      })
    case "AgentOutputAfter":
      return Effect.succeed({
        _tag: "PerContextOutput",
        contextId: source.contextId,
        activityAttempt: source.activityAttempt,
        afterSequence: source.afterSequence,
      })
    case "RuntimeRun":
      return Effect.fail("tiny-firegrid wait_for output pipeline only models AgentOutput sources")
  }
}

const matchesTarget = (
  target: PerContextOutputTarget,
  row: RuntimeAgentOutputObservation,
): boolean =>
  row.contextId === target.contextId &&
  row.activityAttempt === target.activityAttempt &&
  (target.afterSequence === undefined || row.sequence > target.afterSequence)

const waitForOutput = (
  input: {
    readonly outputEvents: TinyRuntimeOutputEvents
    readonly options: WaitForOptions<RuntimeAgentOutputObservation>
  },
) =>
  Effect.gen(function*() {
    const target = yield* outputTargetForSource(
      input.options.source,
      input.options.trigger,
    )
    const matched = yield* input.outputEvents.rows().pipe(
      Stream.filter(row => matchesTarget(target, row)),
      Stream.filter(row => evaluateFieldEquals(input.options.trigger, row)),
      Stream.runHead,
    )

    return {
      outcome: Option.match(matched, {
        onNone: (): WaitForOutcome<RuntimeAgentOutputObservation> => ({ _tag: "Timeout" }),
        onSome: (row): WaitForOutcome<RuntimeAgentOutputObservation> => ({
          _tag: "Match",
          row,
        }),
      }),
      target,
    }
  })

const sameTarget = (
  left: PerContextOutputTarget,
  right: PerContextOutputTarget,
): boolean =>
  left.contextId === right.contextId &&
  left.activityAttempt === right.activityAttempt &&
  left.afterSequence === right.afterSequence

const targetRecord = (
  target: PerContextOutputTarget,
): Record<string, unknown> => ({
  _tag: target._tag,
  contextId: target.contextId,
  activityAttempt: target.activityAttempt,
  ...(target.afterSequence === undefined ? {} : { afterSequence: target.afterSequence }),
})

const makeClaim = (
  input: {
    readonly name: string
    readonly result: {
      readonly outcome: WaitForOutcome<RuntimeAgentOutputObservation>
      readonly target: PerContextOutputTarget
    }
    readonly expectedTarget: PerContextOutputTarget
    readonly expectedMatchedContextId: string
    readonly expectedMatchedSequence: number
  },
): WaitForOutputClaim => {
  const matched = input.result.outcome._tag === "Match"
  const matchedRow = matched ? input.result.outcome.row : undefined
  const targetMatches = sameTarget(input.result.target, input.expectedTarget)
  const rowMatches = matchedRow !== undefined &&
    matchedRow.contextId === input.expectedMatchedContextId &&
    matchedRow.sequence === input.expectedMatchedSequence
  const status: ClaimStatus = targetMatches && rowMatches ? "passed" : "failed"
  return {
    name: input.name,
    status,
    target: input.result.target,
    expectedTarget: input.expectedTarget,
    matched,
    ...(matchedRow === undefined ? {} : {
      matchedContextId: matchedRow.contextId,
      matchedSequence: matchedRow.sequence,
    }),
    ...(status === "passed"
      ? {}
      : {
        finding: {
          id: "wait-source-divergence",
          claim: input.name,
          expected: {
            target: targetRecord(input.expectedTarget),
            matchedContextId: input.expectedMatchedContextId,
            matchedSequence: input.expectedMatchedSequence,
          },
          actual: {
            target: targetRecord(input.result.target),
            matched,
            ...(matchedRow === undefined ? {} : {
              matchedContextId: matchedRow.contextId,
              matchedSequence: matchedRow.sequence,
            }),
          },
          summary:
            "wait_for selected or matched the wrong durable AgentOutput source; preserve this as a finding rather than papering over the source shape.",
        },
      }),
  }
}

export const tinyWaitForOutputPipeline = Effect.gen(function*() {
  const outputEvents = yield* makeMemoryDurableCollectionFacade(outputObservationKey)
  const rows = [
    observationFromAgentOutput({
      contextId: "ctx-a",
      activityAttempt: 0,
      sequence: 0,
      event: textChunk("ctx-a-0", "ignore"),
    }),
    observationFromAgentOutput({
      contextId: "ctx-a",
      activityAttempt: 0,
      sequence: 1,
      event: textChunk("ctx-a-1", "match-after"),
    }),
    observationFromAgentOutput({
      contextId: "ctx-b",
      activityAttempt: 0,
      sequence: 0,
      event: textChunk("ctx-b-0", "other-context"),
    }),
    observationFromAgentOutput({
      contextId: "ctx-a",
      activityAttempt: 0,
      sequence: 2,
      event: textChunk("ctx-a-2", "agent-output-match"),
    }),
    observationFromAgentOutput({
      contextId: "ctx-b",
      activityAttempt: 0,
      sequence: 1,
      event: textChunk("ctx-b-1", "agent-output-match"),
    }),
  ]

  yield* Effect.forEach(
    rows,
    row => persistAgentOutputObservation(outputEvents, row),
    { discard: true },
  )

  const agentOutputAfterSource = {
    _tag: "AgentOutputAfter",
    contextId: "ctx-a",
    activityAttempt: 0,
    afterSequence: 0,
  } satisfies AgentOutputAfterSource

  const agentOutputAfter = yield* waitForOutput({
    outputEvents,
    options: {
      name: "agent-output-after",
      source: agentOutputAfterSource,
      trigger: [{ path: ["event", "part", "delta"], equals: "match-after" }],
    },
  })
  const agentOutputInCurrentContext = yield* waitForOutput({
    outputEvents,
    options: {
      name: "agent-output-trigger-context",
      source: { _tag: "AgentOutput" },
      trigger: [
        { path: ["contextId"], equals: "ctx-a" },
        { path: ["event", "part", "delta"], equals: "agent-output-match" },
      ],
    },
  })

  const claims = [
    makeClaim({
      name: "AgentOutputAfter selects explicit source context",
      result: agentOutputAfter,
      expectedTarget: {
        _tag: "PerContextOutput",
        contextId: "ctx-a",
        activityAttempt: 0,
        afterSequence: 0,
      },
      expectedMatchedContextId: "ctx-a",
      expectedMatchedSequence: 1,
    }),
    makeClaim({
      name: "AgentOutput selects context from trigger predicate",
      result: agentOutputInCurrentContext,
      expectedTarget: {
        _tag: "PerContextOutput",
        contextId: "ctx-a",
        activityAttempt: 0,
      },
      expectedMatchedContextId: "ctx-a",
      expectedMatchedSequence: 2,
    }),
  ]
  const findings = claims.flatMap(claim =>
    claim.finding === undefined ? [] : [claim.finding])
  const claimStatus: ClaimStatus = findings.length === 0 ? "passed" : "failed"

  return {
    agentOutputAfter,
    agentOutputInCurrentContext,
    claimStatus,
    claims,
    findings,
  }
})

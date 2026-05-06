import { Firegrid, run } from "@firegrid/runtime"
import { Console, Duration, Effect, Fiber, Ref, Schedule } from "effect"
import { defineReceiverScenario } from "../definition.ts"
import { ChargeCardOperation } from "../emitters/claim-before-side-effect.ts"
import { inspectScenarioStream, type ScenarioInspection } from "../inspect.ts"

const PARTICIPANT_COUNT = 2
const POLL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 200

interface InvocationRecord {
  readonly participantId: string
  readonly sideEffectId: string
}

const buildHandlerLayer = (
  participantId: string,
  invocations: Ref.Ref<ReadonlyArray<InvocationRecord>>,
) =>
  // firegrid-runtime-process.RUNTIME_COMPOSITION.1
  // firegrid-runtime-process.RUNTIME_COMPOSITION.2
  // firegrid-runtime-process.RUNTIME_COMPOSITION.6
  // firegrid-runtime-process.READY_WORK_OPERATOR.5
  // firegrid-runtime-process.READY_WORK_OPERATOR.7
  // claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1
  // The handler closure tags the invocation with the participantId so
  // the receiver can prove that exactly one participant won the claim
  // and ran the side-effect; substrate's processReadyWorkItem
  // guarantees only the winner reaches this body.
  Firegrid.composeRuntime({
    subscribers: [],
    handlers: [
      Firegrid.handler(ChargeCardOperation, (input) =>
        Effect.gen(function* () {
          yield* Ref.update(invocations, (xs) => [
            ...xs,
            { participantId, sideEffectId: input.sideEffectId },
          ])
          return {
            sideEffectId: input.sideEffectId,
            status: "charged" as const,
          }
        }),
      ),
    ],
    provide: [],
  })

const isTerminal = (state: string): boolean =>
  state === "completed" || state === "failed" || state === "cancelled"

const findTargetTerminal = (
  inspection: ScenarioInspection,
  targetRunId: string | undefined,
) => {
  const candidates =
    targetRunId === undefined
      ? inspection.runs
      : inspection.runs.filter((r) => r.runId === targetRunId)
  return candidates.find((r) => isTerminal(r.state))
}

const pollUntilTerminal = (
  streamUrl: string,
  targetRunId: string | undefined,
) =>
  Effect.tryPromise({
    try: () => inspectScenarioStream(streamUrl),
    catch: (cause) => new Error(`inspect failed: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((inspection) => {
      const terminal = findTargetTerminal(inspection, targetRunId)
      return terminal === undefined
        ? Effect.fail(new Error("not yet terminal"))
        : Effect.succeed({ inspection, terminal })
    }),
    Effect.retry({
      times: Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS),
      schedule: Schedule.spaced(Duration.millis(POLL_INTERVAL_MS)),
    }),
  )

const runClaimBeforeSideEffectReceiver = (
  streamUrl: string,
  targetRunId?: string,
) => Effect.gen(function* () {
  const invocations = yield* Ref.make<ReadonlyArray<InvocationRecord>>([])

  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.READY_WORK_OPERATOR.1
  // firegrid-runtime-process.READY_WORK_OPERATOR.2
  // firegrid-runtime-process.READY_WORK_OPERATOR.3
  // claim-and-operator-authority.CLAIM_AUTHORITY.1
  // claim-and-operator-authority.TERMINAL_AUTHORITY.1
  // launchable-substrate-host.SCENARIOS.4
  //
  // Two app-owned participants attach to the same durable stream
  // through the typed run({connection,runtime}) API. Each participant
  // gets its own auto-generated processId via the attached boot Layer
  // so claim attribution differs across participants. The runtime
  // never authors claim or terminal events directly — substrate's
  // processReadyWorkItem arbitrates first-valid-terminal-wins and
  // exactly one participant's handler runs.
  const fibers = yield* Effect.all(
    Array.from({ length: PARTICIPANT_COUNT }, (_, i) => `participant-${i + 1}`)
      .map((participantId) =>
        Effect.fork(
          run({
            connection: { streamUrl },
            runtime: buildHandlerLayer(participantId, invocations),
          }),
        ),
      ),
  )

  const result = yield* pollUntilTerminal(streamUrl, targetRunId).pipe(
    Effect.timeout(Duration.millis(POLL_TIMEOUT_MS + 5_000)),
    Effect.ensuring(
      Effect.forEach(fibers, Fiber.interrupt, { discard: true }),
    ),
  )

  const observedInvocations = yield* Ref.get(invocations)

  const report = {
    streamUrl,
    participants: PARTICIPANT_COUNT,
    invocations: observedInvocations,
    terminalRun: result.terminal,
    counts: result.inspection.counts,
    completions: result.inspection.completions
      .filter((c) =>
        c.workId !== undefined && c.workId === result.terminal.runId
          ? true
          : false,
      ),
  }
  yield* Console.log(JSON.stringify(report, null, 2))

  if (observedInvocations.length !== 1) {
    yield* Console.error(
      `expected exactly 1 handler invocation across ${PARTICIPANT_COUNT} participants, got ${observedInvocations.length}`,
    )
    return yield* Effect.fail(
      new Error(`invocation-count: ${observedInvocations.length}`),
    )
  }

  if (result.terminal.state !== "completed") {
    yield* Console.error(
      `expected terminal run state=completed, got ${result.terminal.state}`,
    )
    return yield* Effect.fail(
      new Error(`terminal-state: ${result.terminal.state}`),
    )
  }
}).pipe(Effect.scoped)

export const claimBeforeSideEffectReceiverScenario = defineReceiverScenario({
  kind: "receiver",
  name: "claim-before-side-effect-receiver",
  run: runClaimBeforeSideEffectReceiver,
})

import { defineEmitScenario } from "../definition.ts"
import {
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  blockRunScenarioRow,
  defineScenarioRows,
  makeOperationStartedRunRow,
  makePendingCompletionScenarioRow,
  resolveCompletionScenarioRow,
  scenarioRowsFromIterable,
} from "../scenario.ts"
import { Schema } from "effect"

// firegrid-runtime-process.SCENARIOS.6
// SideEffectInput is exported so receiver-side scenarios can reuse the
// same schema-derived descriptor without redefining a parallel one.
const SideEffectInput = Schema.Struct({
  sideEffectId: Schema.String,
  target: Schema.String,
  amountCents: Schema.Number,
})

const SideEffectReadySignal = Schema.Struct({
  source: Schema.Literal("scenario"),
  reason: Schema.String,
})

export const ChargeCardOperation = Operation.define({
  name: "ChargeCard",
  input: SideEffectInput,
  output: Schema.Struct({
    sideEffectId: Schema.String,
    status: Schema.Literal("charged"),
  }),
})

const DEFAULT_RUN_ID = "run-claim-side-effect-cli-1"
const DEFAULT_COMPLETION_ID = "completion-claim-side-effect-cli-1"
const DEFAULT_SIDE_EFFECT_ID = "side-effect-charge-cli-1"
const DEFAULT_TARGET = "card-token-cli-1"
const DEFAULT_AMOUNT_CENTS = 4200

export const makeClaimBeforeSideEffectScenarioRows = (input: {
  readonly runId?: string
  readonly completionId?: string
  readonly sideEffectId?: string
  readonly target?: string
  readonly amountCents?: number
} = {}) => {
  const runId = input.runId ?? DEFAULT_RUN_ID
  const completionId = input.completionId ?? DEFAULT_COMPLETION_ID
  const sideEffectId = input.sideEffectId ?? DEFAULT_SIDE_EFFECT_ID
  const target = input.target ?? DEFAULT_TARGET
  const amountCents = input.amountCents ?? DEFAULT_AMOUNT_CENTS

  // firegrid-runtime-process.SCENARIOS.1
  // firegrid-runtime-process.SCENARIOS.6
  // claim-and-operator-authority.CLAIM_BEFORE_INVOKE.1
  // claim-and-operator-authority.CLAIM_AUTHORITY.1
  // claim-and-operator-authority.TERMINAL_AUTHORITY.1
  // launchable-substrate-host.SCENARIOS.4
  const sideEffectInput = Schema.encodeSync(SideEffectInput)({
    sideEffectId,
    target,
    amountCents,
  })
  const readySignal = Schema.encodeSync(SideEffectReadySignal)({
    source: "scenario",
    reason: "ready-for-claim-before-side-effect",
  })

  const started = makeOperationStartedRunRow({
    runId,
    operation: ChargeCardOperation,
    input: sideEffectInput,
  })
  const pending = makePendingCompletionScenarioRow({
    completionId,
    workId: runId,
    kind: "externally_resolved_awakeable",
    data: readySignal,
  })

  return [
    started,
    pending,
    blockRunScenarioRow(started, { blockedOnCompletionId: completionId }),
    resolveCompletionScenarioRow(pending, { result: sideEffectInput }),
  ] as const
}

const claimBeforeSideEffectScenarioRows = defineScenarioRows({
  name: "claim-before-side-effect",
  rows: () => scenarioRowsFromIterable(makeClaimBeforeSideEffectScenarioRows()),
})

export const claimBeforeSideEffectScenario = defineEmitScenario({
  kind: "emit",
  name: "claim-before-side-effect",
  rows: claimBeforeSideEffectScenarioRows,
})

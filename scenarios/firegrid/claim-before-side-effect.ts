#!/usr/bin/env tsx
import {
  Operation,
} from "@firegrid/substrate/descriptors"
import {
  blockRun,
  CompletionValue,
  createPendingCompletion,
  OPERATION_ENVELOPE_TAG,
  OperationEnvelopeSchema,
  resolveCompletion,
  RunValue,
  startRun,
} from "@firegrid/substrate/kernel"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "node:url"

// firegrid-runtime-process.SCENARIOS.6
// SideEffectInput is exported so receiver-side scenarios can reuse the
// same schema-derived descriptor without redefining a parallel one.
export const SideEffectInput = Schema.Struct({
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
  const operationEnvelope = Schema.encodeSync(OperationEnvelopeSchema)({
    _envelope: OPERATION_ENVELOPE_TAG,
    operation: ChargeCardOperation.name,
    payload: Schema.encodeSync(ChargeCardOperation.input)(sideEffectInput),
  })
  const runValue = Schema.encodeSync(RunValue)({
    runId,
    state: "started",
    data: operationEnvelope,
  })
  const readySignal = Schema.encodeSync(SideEffectReadySignal)({
    source: "scenario",
    reason: "ready-for-claim-before-side-effect",
  })

  const started = Effect.runSync(startRun({
    runId: runValue.runId,
    data: runValue.data,
  }))
  const pending = Effect.runSync(createPendingCompletion({
    completionId,
    workId: runId,
    kind: "externally_resolved_awakeable",
    data: readySignal,
  }))
  const startedRun = Schema.decodeUnknownSync(RunValue)(started.value)
  const pendingCompletion = Schema.decodeUnknownSync(CompletionValue)(pending.value)

  return [
    started,
    pending,
    Effect.runSync(blockRun(startedRun, { blockedOnCompletionId: completionId })),
    Effect.runSync(resolveCompletion(pendingCompletion, { result: sideEffectInput })),
  ] as const
}

export const writeClaimBeforeSideEffectScenarioRows = (
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk)
  },
) => {
  for (const row of makeClaimBeforeSideEffectScenarioRows()) {
    write(`${JSON.stringify(row)}\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeClaimBeforeSideEffectScenarioRows()
}

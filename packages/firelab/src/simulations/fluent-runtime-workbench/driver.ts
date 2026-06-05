/**
 * Blackbox acceptance driver — binds the co-located Gherkin feature against the
 * live API contract and drives each scenario over HTTP at the launched
 * fluent-runtime host. The store work happens host-side, so the verdict gates on
 * forge-proof `fluent_runtime.store.*` spans, not on anything the driver emits.
 * The driver only reaches the host through its served HTTP surface.
 */
import { FileSystem, Path } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { FiregridConfig } from "@firegrid/client-sdk/config"
import { Effect, Schedule } from "effect"
import { bindFeature, buildCatalog, concretePath, type PlannedStep, type ScenarioPlan } from "./catalog.ts"
import { WORKBENCH_PORT } from "./port.ts"

const BASE = `http://127.0.0.1:${WORKBENCH_PORT}`

const sameValue = (actual: unknown, expected: unknown): boolean =>
  actual === expected || JSON.stringify(actual) === JSON.stringify(expected)

// Back off until the launched host's HTTP listener accepts connections.
const awaitHost = Effect.tryPromise(() => fetch(`${BASE}/`)).pipe(
  Effect.retry(Schedule.exponential("20 millis").pipe(Schedule.upTo("10 seconds"))),
  Effect.asVoid,
)

interface StepState {
  readonly status: number
  readonly body: Record<string, unknown> | undefined
}

const applyStep = (
  plan: ScenarioPlan,
  state: StepState,
  step: PlannedStep,
): Effect.Effect<StepState, Error> =>
  Effect.gen(function*() {
    if (step._tag === "callOp") {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(BASE + concretePath(step.op, step.params), {
            method: step.op.method,
            headers: { "content-type": "application/json" },
            ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
          }),
        catch: (cause) => new Error(`[${plan.name}] request failed: ${String(cause)}`),
      })
      const body = yield* Effect.promise(() =>
        res.json().then(
          (b: unknown) => (b !== null && typeof b === "object" ? (b as Record<string, unknown>) : undefined),
          () => undefined,
        ))
      return { status: res.status, body }
    }
    if (step._tag === "expectStatus") {
      return state.status === step.status
        ? state
        : yield* Effect.fail(new Error(`[${plan.name}] expected status ${step.status}, got ${state.status} (body ${JSON.stringify(state.body)})`))
    }
    if (step._tag === "expectField") {
      const actual = state.body?.[step.field]
      return sameValue(actual, step.value)
        ? state
        : yield* Effect.fail(new Error(`[${plan.name}] field "${step.field}": expected ${JSON.stringify(step.value)}, got ${JSON.stringify(actual)}`))
    }
    return yield* Effect.fail(new Error(`[${plan.name}] unbound step "${step.keyword} ${step.text}"`))
  })

const runScenario = (plan: ScenarioPlan): Effect.Effect<void, Error> =>
  Effect.reduce(plan.steps, { status: 0, body: undefined } as StepState, (state, step) => applyStep(plan, state, step)).pipe(
    Effect.asVoid,
    Effect.withSpan("firelab.fluent_runtime_acceptance.scenario", {
      attributes: { "firelab.scenario": plan.name },
    }),
  )

export const fluentRuntimeWorkbenchDriver = Effect.gen(function*() {
  yield* FiregridConfig
  yield* awaitHost
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const featurePath = yield* path.fromFileUrl(new URL("./fluent-runtime.feature", import.meta.url))
  const featureText = yield* fs.readFileString(featurePath)
  const plans = bindFeature(buildCatalog(), featureText)
  yield* Effect.forEach(plans, runScenario, { discard: true })
}).pipe(
  Effect.provide(NodeContext.layer),
  Effect.withSpan("firelab.fluent_runtime_acceptance.driver"),
)

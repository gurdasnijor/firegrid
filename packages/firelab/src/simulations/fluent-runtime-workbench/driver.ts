/**
 * Acceptance driver — parses the co-located domain feature and runs each
 * scenario (background + steps) through the cucumber step registry (steps.ts),
 * whose handlers drive the typed fluent-runtime client at the launched host. The
 * store work happens host-side, so the verdict gates on forge-proof
 * `fluent_runtime.store.*` spans, not on anything the driver emits.
 */
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin"
import { IdGenerator } from "@cucumber/messages"
import { FetchHttpClient, FileSystem, Path } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { FiregridConfig } from "@firegrid/client-sdk/config"
import { Effect, Schedule } from "effect"
import { makeClient, matchStep, type World } from "./steps.ts"
import { WORKBENCH_PORT } from "./port.ts"

const BASE = `http://127.0.0.1:${WORKBENCH_PORT}`

// Back off until the launched host's HTTP listener accepts connections.
const awaitHost = Effect.tryPromise(() => fetch(`${BASE}/`)).pipe(
  Effect.retry(Schedule.exponential("20 millis").pipe(Schedule.upTo("10 seconds"))),
  Effect.asVoid,
)

const runStep = (world: World, text: string): Effect.Effect<void, Error> => {
  const matched = matchStep(text)
  if (matched === undefined) {
    return Effect.fail(new Error(`no step definition for: "${text}"`))
  }
  return matched.def.run(world, matched.args).pipe(
    Effect.mapError((cause) => new Error(`step "${text}": ${String(cause)}`)),
  )
}

export const fluentRuntimeWorkbenchDriver = Effect.gen(function*() {
  yield* FiregridConfig
  yield* awaitHost
  const client = yield* makeClient

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const featurePath = yield* path.fromFileUrl(new URL("./fluent-runtime.feature", import.meta.url))
  const featureText = yield* fs.readFileString(featurePath)

  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher())
  const children = parser.parse(featureText).feature?.children ?? []
  const background = children.flatMap((child) => (child.background ? child.background.steps : []))
  const scenarios = children.flatMap((child) => (child.scenario ? [child.scenario] : []))

  yield* Effect.forEach(scenarios, (scenario, index) => {
    const world: World = { client, ns: `sc${index}`, vars: new Map(), last: undefined }
    const allSteps = [...background, ...scenario.steps]
    return Effect.forEach(allSteps, (s) => runStep(world, s.text.trim()), { discard: true }).pipe(
      Effect.withSpan("firelab.fluent_runtime_acceptance.scenario", {
        attributes: { "firelab.scenario": scenario.name },
      }),
    )
  }, { discard: true })
}).pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(FetchHttpClient.layer),
  Effect.withSpan("firelab.fluent_runtime_acceptance.driver"),
)

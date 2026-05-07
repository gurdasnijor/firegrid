import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Scope } from "effect"
import { parseArgs } from "node:util"
import type { ReceiverScenarioDefinition, ScenarioDefinition } from "./definition.ts"

const streamUrlFromArgsOrEnv = (
  args: ReadonlyArray<string>,
): string | undefined => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      "stream-url": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })
  return values["stream-url"] ??
    process.env.DURABLE_STREAMS_URL ??
    process.env.FIREGRID_STREAM_URL
}

const createScenarioStream = (
  streamUrl: string,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await DurableStream.create({
      url: streamUrl,
      contentType: "application/json",
    })
  })

export const withScenarioTestServer = <A, E>(
  run: (input: {
    readonly server: DurableStreamTestServer
    readonly streamUrl: string
  }) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | unknown, never> =>
  Effect.gen(function* () {
    const server = yield* Effect.promise(async () => {
      const instance = new DurableStreamTestServer({ port: 0 })
      await instance.start()
      return instance
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => server.stop()).pipe(Effect.orDie),
    )
    const streamUrl =
      `${server.url}/scenarios/run-${crypto.randomUUID()}`
    yield* createScenarioStream(streamUrl)
    return yield* run({ server, streamUrl })
  }).pipe(Effect.scoped)

const runReceiverProcess = (
  scenario: ReceiverScenarioDefinition,
  streamUrl: string,
): void => {
  void Effect.runPromise(scenario.run(streamUrl)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

const runReceiverSelfTest = async (
  scenario: ReceiverScenarioDefinition,
): Promise<void> => {
  if (scenario.selfTest === undefined) {
    throw new Error(`Scenario ${scenario.name} does not define a self-test`)
  }
  const result = await Effect.runPromise(scenario.selfTest())
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

export const runScenarioCli = async (
  scenario: ScenarioDefinition,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      "self-test": { type: "boolean", default: false },
      "stream-url": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values["self-test"]) {
    await runReceiverSelfTest(scenario)
    return
  }
  const streamUrl = streamUrlFromArgsOrEnv(args)
  if (streamUrl === undefined || streamUrl.length === 0) {
    process.stderr.write(
      `Usage: pnpm --filter @firegrid/scenarios run ${scenario.name} -- --stream-url <durable-stream-url>\n`,
    )
    process.exitCode = 1
    return
  }
  runReceiverProcess(scenario, streamUrl)
}

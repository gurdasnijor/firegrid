import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Fiber, Schedule, Scope, Stream } from "effect"
import { parseArgs } from "node:util"
import type {
  EmitScenarioDefinition,
  ReceiverScenarioDefinition,
  ScenarioDefinition,
} from "./definition.ts"
import {
  inspectScenarioStream,
  type ScenarioInspection,
} from "./inspect.ts"

export const streamUrlFromArgsOrEnv = (
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

const writeScenarioRowsToNdjson = (
  scenario: EmitScenarioDefinition,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk)
  },
): void => {
  // firegrid-runtime-process.SCENARIOS.10
  // firegrid-runtime-process.SCENARIOS.15
  Effect.runSync(
    Stream.runForEach(scenario.rows.rows(), (row) =>
      Effect.sync(() => {
        write(`${JSON.stringify(row)}\n`)
      })
    ),
  )
}

export const appendRows = (
  streamUrl: string,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const stream = new DurableStream({
      url: streamUrl,
      contentType: "application/json",
    })
    for (const row of rows) {
      await stream.append(JSON.stringify(row))
    }
  })

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

export const inspect = (
  streamUrl: string,
): Effect.Effect<ScenarioInspection, unknown> =>
  Effect.promise(() => inspectScenarioStream(streamUrl))

export const pollInspection = (
  streamUrl: string,
  predicate: (inspection: ScenarioInspection) => boolean,
  input: {
    readonly times?: number
    readonly interval?: Parameters<typeof Schedule.spaced>[0]
    readonly reason?: string
  } = {},
): Effect.Effect<ScenarioInspection, unknown> =>
  inspect(streamUrl).pipe(
    Effect.filterOrFail(
      predicate,
      () => new Error(input.reason ?? "scenario not ready"),
    ),
    Effect.retry({
      times: input.times ?? 80,
      schedule: Schedule.spaced(input.interval ?? "100 millis"),
    }),
  )

const runReceiverProcess = (
  scenario: ReceiverScenarioDefinition,
  streamUrl: string,
): void => {
  // firegrid-runtime-process.SCENARIOS.15
  NodeRuntime.runMain(scenario.run(streamUrl))
}

const runReceiverSelfTest = async (
  scenario: ReceiverScenarioDefinition,
): Promise<void> => {
  if (scenario.selfTest === undefined) {
    throw new Error(`Scenario ${scenario.name} does not define a self-test`)
  }
  const result = await Effect.runPromise(scenario.selfTest())
  const report = result as {
    readonly completed?: unknown
    readonly report?: unknown
  }
  process.stdout.write(
    `${JSON.stringify(report.completed ?? report.report ?? result, null, 2)}\n`,
  )
}

const seedReceiverRows = (
  scenario: ReceiverScenarioDefinition,
  args: ReadonlyArray<string>,
): void => {
  if (scenario.seedRows === undefined) {
    throw new Error(`Scenario ${scenario.name} does not define seed rows`)
  }
  const { values } = parseArgs({
    args: [...args],
    options: {
      "when-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })
  const whenMs = values["when-ms"] === undefined
    ? undefined
    : Number(values["when-ms"])
  if (whenMs !== undefined && !Number.isFinite(whenMs)) {
    throw new Error(`Expected numeric --when-ms, received ${values["when-ms"]}`)
  }
  for (const row of scenario.seedRows({ whenMs })) {
    process.stdout.write(`${JSON.stringify(row)}\n`)
  }
}

export const runScenarioCli = async (
  scenario: ScenarioDefinition,
  args: ReadonlyArray<string>,
): Promise<void> => {
  if (scenario.kind === "emit") {
    writeScenarioRowsToNdjson(scenario)
    return
  }

  const { values } = parseArgs({
    args: [...args],
    options: {
      "seed-rows": { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      "stream-url": { type: "string" },
      "when-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values["seed-rows"]) {
    seedReceiverRows(scenario, args.filter((arg) => arg !== "--seed-rows"))
    return
  }
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

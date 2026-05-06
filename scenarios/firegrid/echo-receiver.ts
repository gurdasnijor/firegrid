#!/usr/bin/env tsx
import { NodeRuntime } from "@effect/platform-node"
import { Firegrid, run } from "@firegrid/runtime"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { EchoOperation } from "./echo.ts"

const streamUrlFromArgs = (): string | undefined => {
  const { values } = parseArgs({
    options: {
      "stream-url": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })
  return values["stream-url"] ?? process.env.DURABLE_STREAMS_URL
}

export const EchoReceiverRuntime = Firegrid.handler(EchoOperation, (input) =>
  Effect.succeed({
    message: input.message,
    length: input.message.length,
  }),
)

export const runEchoReceiver = (streamUrl: string) =>
  // firegrid-runtime-process.SCENARIOS.7
  // firegrid-runtime-process.RUNTIME_RUN_API.1
  // firegrid-runtime-process.RUNTIME_RUN_API.2
  // firegrid-runtime-process.RUNTIME_RUN_API.3
  // firegrid-runtime-process.RUNTIME_RUN_API.4
  // firegrid-runtime-process.RUNTIME_RUN_API.5
  // firegrid-runtime-process.RUNTIME_RUN_API.6
  // firegrid-runtime-process.RUNTIME_RUN_API.7
  // firegrid-runtime-process.RUNTIME_RUN_API.8
  // firegrid-runtime-process.RUNTIME_RUN_API.9
  // firegrid-runtime-process.READY_WORK_OPERATOR.7
  // firegrid-operation-messaging.RUNTIME_HANDLERS.1
  // firegrid-operation-messaging.RUNTIME_HANDLERS.2
  // firegrid-operation-messaging.RUNTIME_HANDLERS.3
  // firegrid-operation-messaging.RUNTIME_HANDLERS.4
  run({
    connection: { streamUrl },
    runtime: EchoReceiverRuntime,
  })

const main = () => {
  const streamUrl = streamUrlFromArgs()
  if (streamUrl === undefined || streamUrl.length === 0) {
    process.stderr.write(
      "Usage: pnpm --filter @firegrid/scenarios run echo-receiver -- --stream-url <durable-stream-url>\n",
    )
    process.exitCode = 1
    return
  }

  NodeRuntime.runMain(runEchoReceiver(streamUrl))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}

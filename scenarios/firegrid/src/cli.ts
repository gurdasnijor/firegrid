#!/usr/bin/env tsx
import { getScenario, listScenarioNames } from "./registry.ts"
import { inspectScenarioStream } from "./inspect.ts"
import { runScenarioCli, streamUrlFromArgsOrEnv } from "./runner.ts"

const [name, ...rawArgs] = process.argv.slice(2)
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs

if (name === undefined || name === "help" || name === "--help") {
  process.stdout.write(
    `Usage: pnpm --filter @firegrid/scenarios run <script> -- [options]\n\nScenarios:\n${["inspect", ...listScenarioNames()].sort().map((item) => `  - ${item}`).join("\n")}\n`,
  )
  process.exit(0)
}

const scenario = getScenario(name)
if (name === "inspect") {
  const streamUrl = streamUrlFromArgsOrEnv(args)
  if (streamUrl === undefined || streamUrl.length === 0) {
    process.stderr.write(
      "Usage: pnpm --filter @firegrid/scenarios run inspect -- --stream-url <durable-stream-url>\n",
    )
    process.exit(1)
  }
  const inspection = await inspectScenarioStream(streamUrl)
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
  process.exit(0)
}

if (scenario === undefined) {
  process.stderr.write(
    `Unknown scenario ${name}. Available: ${listScenarioNames().join(", ")}\n`,
  )
  process.exit(1)
}

await runScenarioCli(scenario, args).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

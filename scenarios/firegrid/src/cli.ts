#!/usr/bin/env tsx
import { getScenario, listScenarioNames } from "./registry.ts"
import { runScenarioCli } from "./runner.ts"

const [name, ...rawArgs] = process.argv.slice(2)
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs

if (name === undefined || name === "help" || name === "--help") {
  process.stdout.write(
    `Usage: pnpm --filter @firegrid/scenarios run <script> -- [options]\n\nScenarios:\n${listScenarioNames().map((item) => `  - ${item}`).join("\n")}\n`,
  )
  process.exit(0)
}

const scenario = getScenario(name)
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

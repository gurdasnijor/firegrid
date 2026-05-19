import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import {
  listSimulations,
  selectedSimulation,
} from "./runner/list.ts"
import { runSimulation } from "./runner/runtime.ts"

const simulationIdArg = Args.text({ name: "simulation-id" }).pipe(Args.optional)
const timeoutOption = Options.integer("timeout-ms").pipe(
  Options.withDescription("Abort a simulation run after this many milliseconds"),
  Options.withDefault(300_000),
)

const listCommand = Command.make("list", {}, () =>
  Effect.flatMap(listSimulations, simulations =>
    Console.log(
      simulations
        .map(simulation => `${simulation.id}\t${simulation.description}`)
        .join("\n"),
    )))

const runCommand = Command.make(
  "run",
  { simulationId: simulationIdArg, timeoutMs: timeoutOption },
  ({ simulationId, timeoutMs }) =>
    Effect.flatMap(
      selectedSimulation(simulationId),
      simulation => runSimulation(simulation, { timeoutMs }),
    ),
)

const command = Command.make("simulate").pipe(
  Command.withSubcommands([
    listCommand,
    runCommand,
  ]),
)

const cli = Command.run(command, {
  name: "Tiny Firegrid simulations",
  version: "0.0.0",
})

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)

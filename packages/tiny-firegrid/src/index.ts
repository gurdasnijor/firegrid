import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import {
  listSimulations,
  selectedSimulation,
} from "./runner/list.ts"
import { runSimulation } from "./runner/runtime.ts"
import { listRuns, showRun } from "./runner/show.ts"

// Required argument — no default-sim fallback. Implicit alphabetical-first
// selection silently picks the wrong simulation the moment someone adds an
// earlier folder; the CLI should make you name what you ran.
const simulationIdArg = Args.text({ name: "simulation-id" })
const timeoutOption = Options.integer("timeout-ms").pipe(
  Options.withDescription("Abort a simulation run after this many milliseconds"),
  Options.withDefault(300_000),
)
const consoleOption = Options.boolean("console").pipe(
  Options.withDescription(
    "Emit spans to stdout via the OTel ConsoleSpanExporter "
      + "(default: write JSONL to .simulate/runs/<runId>/trace.jsonl)",
  ),
  Options.withDefault(false),
)
const runIdArg = Args.text({ name: "run-id" }).pipe(Args.optional)

const listCommand = Command.make("list", {}, () =>
  Effect.flatMap(listSimulations, simulations =>
    Console.log(
      simulations
        .map(simulation => `${simulation.id}\t${simulation.description}`)
        .join("\n"),
    )))

const runCommand = Command.make(
  "run",
  {
    simulationId: simulationIdArg,
    timeoutMs: timeoutOption,
    consoleExporter: consoleOption,
  },
  ({ simulationId, timeoutMs, consoleExporter }) =>
    Effect.flatMap(
      selectedSimulation(simulationId),
      simulation =>
        runSimulation(simulation, {
          timeoutMs,
          console: consoleExporter,
        }),
    ),
)

const showCommand = Command.make(
  "show",
  { runId: runIdArg },
  ({ runId }) =>
    showRun(runId._tag === "Some" ? runId.value : undefined),
)

// `runs` lists past executions; `list` lists the simulation catalog. Kept
// as distinct verbs (not `list runs`) so the two questions — "what can I
// run?" vs "what have I run?" — each have one obvious command.
const runsCommand = Command.make("runs", {}, () => listRuns)

const command = Command.make("simulate").pipe(
  Command.withSubcommands([
    listCommand,
    runCommand,
    showCommand,
    runsCommand,
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

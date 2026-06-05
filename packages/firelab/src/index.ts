import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import {
  listExperiments,
  selectedExperiment,
} from "./runner/list.ts"
import { gapsReport, seamsCoverage } from "./runner/coverage-cli.ts"
import { showEvidence } from "./runner/evidence.ts"
import { runExperiment } from "./runner/runtime.ts"
import { showPerf } from "./runner/perf.ts"
import { listRuns, showRun } from "./runner/show.ts"

// Required argument — no default-sim fallback. Implicit alphabetical-first
// selection silently picks the wrong simulation the moment someone adds an
// earlier folder; the CLI should make you name what you ran.
const experimentIdArg = Args.text({ name: "simulation-id" })
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
const watchOption = Options.boolean("watch").pipe(
  Options.withDescription(
    "In addition to the periodic stderr heartbeat, emit a compact one-line "
      + "summary per completed span (interactive debugging). Only meaningful "
      + "when destination is the JSONL file; ignored under --console / OTLP.",
  ),
  Options.withDefault(false),
)
const runIdArg = Args.text({ name: "run-id" }).pipe(Args.optional)
const requiredRunIdArg = Args.text({ name: "run-id" })
const topOption = Options.integer("top").pipe(
  Options.withDescription("Number of top self-time spans to print"),
  Options.withDefault(15),
)
const idleThresholdOption = Options.integer("idle-threshold-ms").pipe(
  Options.withDescription("Minimum no-span gap duration to report"),
  Options.withDefault(5_000),
)
const findingDraftOption = Options.boolean("finding-draft").pipe(
  Options.withDescription("Emit idle-gap finding-source draft material to stderr"),
  Options.withDefault(false),
)
const findingThresholdOption = Options.integer("finding-threshold-ms").pipe(
  Options.withDescription("Minimum idle gap duration for finding-source drafts"),
  Options.withDefault(30_000),
)

const listCommand = Command.make("list", {}, () =>
  Effect.flatMap(listExperiments, experiments =>
    Console.log(
      experiments
        .map(simulation => `${simulation.id}\t${simulation.description}`)
        .join("\n"),
    )))

const runCommand = Command.make(
  "run",
  {
    experimentId: experimentIdArg,
    timeoutMs: timeoutOption,
    consoleExporter: consoleOption,
    watch: watchOption,
  },
  ({ experimentId, timeoutMs, consoleExporter, watch }) =>
    Effect.flatMap(
      selectedExperiment(experimentId),
      simulation =>
        Effect.flatMap(
          runExperiment(simulation, {
            timeoutMs,
            console: consoleExporter,
            watch,
          }),
          report =>
            // Gate the exit code on the computed verdict, then force-exit. By
            // here the sim is logically done (verdict printed, trace + latest
            // pointer flushed, scope closed). The host made dozens of
            // durable-streams HTTP calls through Node's global fetch (undici),
            // which leaves keep-alive sockets + their timers pooled; Node would
            // otherwise keep the event loop alive ~30s until they idle-time-out.
            // A CLI should exit when its work is done, so exit explicitly.
            Effect.sync(() => {
              process.exit(report !== undefined && report.gatingFailing > 0 ? 1 : 0)
            }),
        ),
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

const perfCommand = Command.make(
  "perf",
  {
    runId: requiredRunIdArg,
    top: topOption,
    idleThresholdMs: idleThresholdOption,
    findingDraft: findingDraftOption,
    findingThresholdMs: findingThresholdOption,
  },
  ({ runId, top, idleThresholdMs, findingDraft, findingThresholdMs }) =>
    showPerf(runId, {
      top,
      idleThresholdMs,
      findingDraft,
      findingThresholdMs,
    }),
)

// `seams <id> [run-id]` re-judges a past run with the simulation's coverage
// spec (the live oracle, applied offline). `gaps [run-id]` prints the
// instrumentation map for a past run.
const seamsCommand = Command.make(
  "seams",
  { experimentId: experimentIdArg, runId: runIdArg },
  ({ experimentId, runId }) =>
    seamsCoverage(experimentId, runId._tag === "Some" ? runId.value : undefined),
)

const gapsCommand = Command.make(
  "gaps",
  { runId: runIdArg },
  ({ runId }) => gapsReport(runId._tag === "Some" ? runId.value : undefined),
)

// `evidence <id> [run-id]` renders the PR trace-evidence: the verdict + (when
// the coverage spec is feature-bound) the requirement→ACID→span coverage table.
const evidenceCommand = Command.make(
  "evidence",
  { experimentId: experimentIdArg, runId: runIdArg },
  ({ experimentId, runId }) =>
    showEvidence(experimentId, runId._tag === "Some" ? runId.value : undefined),
)

const command = Command.make("simulate").pipe(
  Command.withSubcommands([
    evidenceCommand,
    gapsCommand,
    listCommand,
    perfCommand,
    runCommand,
    seamsCommand,
    showCommand,
    runsCommand,
  ]),
)

const cli = Command.run(command, {
  name: "Tiny Firegrid experiments",
  version: "0.0.0",
})

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)

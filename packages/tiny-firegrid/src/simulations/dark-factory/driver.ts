import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const promptForFactoryLoop = [
  "Drive the dark-factory section 6 loop using the Firegrid tools available in this session.",
  "The app edge has already seeded the trigger fact for this run in the darkFactory.facts CallerFact stream.",
  "Use only the available Firegrid tool surface to plan, delegate, wait for external facts, and halt honestly.",
  "When the loop reaches a terminal state, write one line beginning with DARK_FACTORY_TERMINAL.",
  "If a needed step is not expressible or cannot proceed, write one line beginning with DARK_FACTORY_FINDING and name the missing public surface.",
].join("\n")

const terminalMarker = "DARK_FACTORY_TERMINAL"
const findingMarker = "DARK_FACTORY_FINDING"
const maxWaitIterations = 20

type DarkFactoryStopReason = "terminal" | "finding" | undefined

export const darkFactoryStopReasonFromText = (
  text: string,
): DarkFactoryStopReason =>
  text.includes(terminalMarker)
    ? "terminal"
    : text.includes(findingMarker)
    ? "finding"
    : undefined

interface DarkFactoryDriverArtifact {
  readonly driverRunId: string
  readonly contextId: string
  readonly externalKey: {
    readonly source: string
    readonly id: string
  }
  readonly outcome: "terminal" | "finding" | "max_iterations"
  readonly iterations: number
  readonly afterSequence?: number
  readonly resultText: string
  readonly outputEvents: ReadonlyArray<{
    readonly sequence: number
    readonly tag: string
  }>
}

const artifactRoot = path.resolve(
  fileURLToPath(
    new URL("../../../../.simulate/dark-factory-driver/", import.meta.url),
  ),
)

const writeDriverArtifact = (
  artifact: DarkFactoryDriverArtifact,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(artifactRoot, { recursive: true })
      await writeFile(
        path.join(artifactRoot, `${artifact.driverRunId}.json`),
        JSON.stringify(artifact, null, 2) + "\n",
        "utf8",
      )
    },
    catch: cause => cause,
  })

export const darkFactoryDriver: Effect.Effect<
  void,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const driverRunId = `dark-factory-${crypto.randomUUID()}`
    const externalKey = {
      source: "tiny-firegrid.dark-factory",
      id: driverRunId,
    }
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey,
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* firegrid.sessions.prompt({
      sessionId: session.contextId,
      prompt: promptForFactoryLoop,
      inputId: `${driverRunId}:planner-prompt`,
    })
    yield* session.start()

    let resultText = ""
    let afterSequence: number | undefined
    let stopReason: DarkFactoryStopReason
    const outputEvents: Array<{ sequence: number; tag: string }> = []
    let iterations = 0
    while (stopReason === undefined && iterations < maxWaitIterations) {
      iterations += 1
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      })
      if (!next.matched) {
        continue
      }
      const observation = next.output
      afterSequence = observation.sequence
      outputEvents.push({
        sequence: observation.sequence,
        tag: observation.event._tag,
      })
      if (observation.event._tag === "TextChunk") {
        resultText += observation.event.part.delta
        stopReason = darkFactoryStopReasonFromText(resultText)
      }
    }

    yield* writeDriverArtifact({
      driverRunId,
      contextId: session.contextId,
      externalKey,
      outcome: stopReason ?? "max_iterations",
      iterations,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      resultText,
      outputEvents,
    })
  })

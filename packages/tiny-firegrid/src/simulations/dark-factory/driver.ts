import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

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

export const darkFactoryDriver: Effect.Effect<
  void,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory",
        id: "dark-factory",
      },
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
      inputId: "planner-prompt",
    })
    yield* session.start()

    while (true) {
      yield* session.wait.forAgentOutput({
        timeoutMs: 15_000,
      })
    }
  })

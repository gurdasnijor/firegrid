import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

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

// tf-v7t: per-session agent cwd. The codec-adapter writes the project-
// local `.mcp.json` + `.claude/settings.json` here before the agent
// process spawns (per the tf-s8y verdict / PR #444). The directory must
// (a) exist and (b) be distinct per run so configuration files don't
// leak across runs or pollute the repo root.
const makeAgentCwd = (): string => {
  const dir = join(
    globalThis.process.cwd(),
    ".simulate",
    "agent-cwd",
    `dark-factory-${Date.now()}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

export const darkFactoryDriver: Effect.Effect<
  void,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const cwd = makeAgentCwd()

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory",
        id: "dark-factory",
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd,
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        // tf-v7t: marker triggers the codec-adapter's MCP URL
        // materialization AND `.mcp.json` write into `cwd`. Replaces the
        // prior ACP `_meta` `-alwaysload` alias injection — tools surface
        // to the agent under natural `mcp__firegrid__<tool>` names.
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    // Wait for the host reconciler to materialize the RuntimeContext row
    // before sending the prompt (codec-adapter's URL resolution +
    // .mcp.json write happens at start, which needs the row).
    yield* session.whenReady

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

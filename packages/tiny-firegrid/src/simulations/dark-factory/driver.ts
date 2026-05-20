import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

// tf-s8y P0 spike: pinned MCP port mirrors host.ts. The driver computes
// the runtime-context MCP URL itself and writes it into the agent's
// per-session .mcp.json — bypassing the codec's ACP `_meta` /
// `-alwaysload` alias plumbing. Production would resolve the bound URL
// via FiregridRuntimeContextMcpBaseUrl; pinned port is intentional
// spike hygiene (fail loud on port collision).
const FIREGRID_SPIKE_MCP_HOST = "127.0.0.1"
const FIREGRID_SPIKE_MCP_PORT = 54321
const FIREGRID_SPIKE_MCP_BASE_PATH = "/mcp"

const promptForFactoryLoop = [
  "Drive the dark-factory section 6 loop using the Firegrid tools available in this session.",
  "The app edge has already seeded the trigger fact for this run in the darkFactory.facts CallerFact stream.",
  "Use only the available Firegrid tool surface to plan, delegate, wait for external facts, and halt honestly.",
  "When the loop reaches a terminal state, write one line beginning with DARK_FACTORY_TERMINAL.",
  "If a needed step is not expressible or cannot proceed, write one line beginning with DARK_FACTORY_FINDING and name the missing public surface.",
].join("\n")

// tf-s8y P0 spike: per-session cwd holding the agent's project-local
// MCP/settings configuration. Created BEFORE createOrLoad so the cwd
// can be passed into the runtime config; .mcp.json is written AFTER
// createOrLoad (we need session.contextId to construct the route).
const makeSpikeCwd = (): string => {
  const dir = join(
    globalThis.process.cwd(),
    ".simulate",
    "tf-s8y-spike-cwd",
    `dark-factory-${Date.now()}`,
  )
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, ".claude"), { recursive: true })
  return dir
}

// tf-s8y P0 spike: project-local SDK settings that approve every MCP
// server registered via .mcp.json in this cwd. The spike owns this dir
// so no pre-existing user state can leak in.
// `enableAllProjectMcpServers` is from
// @anthropic-ai/claude-agent-sdk@0.3.143/sdk.d.ts:4019-4021.
const writeClaudeSettings = (cwd: string): void => {
  writeFileSync(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify(
      { enableAllProjectMcpServers: true },
      null,
      2,
    ) + "\n",
  )
}

// tf-s8y P0 spike: project-local MCP server registration that
// claude-agent-sdk loads via settingSources: ["user","project","local"]
// (set by claude-agent-acp@0.36.1 acp-agent.js:1414). The `alwaysLoad`
// field is a first-class property of McpHttpServerConfig
// (@anthropic-ai/claude-agent-sdk@0.3.143/sdk.d.ts:951-961) — no
// alias workaround needed; tools surface as `mcp__firegrid__<tool>`
// rather than `mcp__firegrid-alwaysload__<tool>`.
const writeMcpJson = (cwd: string, contextId: string): void => {
  const url =
    `http://${FIREGRID_SPIKE_MCP_HOST}:${FIREGRID_SPIKE_MCP_PORT}` +
    `${FIREGRID_SPIKE_MCP_BASE_PATH}/runtime-context/` +
    encodeURIComponent(contextId)
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          firegrid: {
            type: "http",
            url,
            alwaysLoad: true,
          },
        },
      },
      null,
      2,
    ) + "\n",
  )
}

export const darkFactoryDriver: Effect.Effect<
  void,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const cwd = makeSpikeCwd()
    writeClaudeSettings(cwd)

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
        // tf-s8y P0 spike: ACP codec MCP injection DISABLED by OMITTING
        // the runtimeContextMcp marker entirely (the marker's only
        // legal value is `enabled: true`; absence = no injection per
        // codec-adapter.ts:243). The agent discovers the Firegrid MCP
        // server via the per-cwd .mcp.json written below, not via
        // _meta.claudeCode.options.mcpServers.
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    // contextId is materialized — now we can construct the route-scoped
    // MCP URL and bake it into the cwd's .mcp.json. session.start()
    // below spawns the agent process which then reads .mcp.json from
    // cwd as part of SDK boot.
    writeMcpJson(cwd, session.contextId)

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

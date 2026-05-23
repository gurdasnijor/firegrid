import {
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { AcpStdioEdgeLive } from "@firegrid/runtime/producers/codecs/acp/stdio-edge"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import { local } from "@firegrid/protocol/launch"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { elicitationHarness } from "./harness.ts"

// A REAL ACP agent (vs. acp-edge-transport's deterministic stub). This is what
// makes the sim elicit genuine tool-use behavior — at the cost of being env-gated
// (provider API key) and non-deterministic, so it is a manually-run probe, never
// part of the deterministic gate.
//
// Currently codex-acp (OpenAI), to sidestep Anthropic provider degradation. Both
// agents speak ACP and support HTTP MCP servers, so the Firegrid runtime-context
// toolset attaches identically and the prompt matrix is agent-agnostic. To switch
// back to claude-acp, restore:
//   argv: ["npx","-y","@agentclientprotocol/claude-agent-acp@0.36.1"]
//   agent label "claude-acp" + ANTHROPIC_API_KEY bindings below.
const agentAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/codex-acp",
] as const

export const acpToolElicitationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const runtimeHost = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    // Authorize the agent's provider key into the subprocess (mirrors the CLI's
    // `--secret-env`). codex-acp authenticates via OPENAI_API_KEY.
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
    })),
  )

  // Drive the real ACP stdio edge in-process: the edge reads/writes the shared
  // in-memory harness; the driver's ClientSideConnection is the other end.
  const acpEdge = AcpStdioEdgeLive({
    input: elicitationHarness.edgeInput,
    output: elicitationHarness.edgeOutput,
    runtime: ({ request }) =>
      local.jsonl({
        argv: [...agentAcpArgv],
        agent: "codex-acp",
        agentProtocol: "acp",
        cwd: request.cwd,
        envBindings: [{ name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" }],
        runtimeContextMcp: { enabled: true },
      }),
  })

  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: "127.0.0.1",
      port: 0,
      path: ensurePathInput("/mcp"),
    }),
  )

  return Layer.mergeAll(acpEdge, mcp).pipe(Layer.provideMerge(runtimeHost)) as Layer.Layer<
    FiregridHost,
    unknown,
    never
  >
}

import {
  AcpStdioEdgeLive,
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { local } from "@firegrid/protocol/launch"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { elicitationHarness } from "./harness.ts"

// The REAL claude-acp agent (vs. acp-edge-transport's deterministic stub). This
// is what makes the sim elicit genuine tool-use behavior — at the cost of being
// env-gated (ANTHROPIC_API_KEY) and non-deterministic, so it is a manually-run
// probe, never part of the deterministic gate.
const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
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
    // Authorize ANTHROPIC_API_KEY into the agent subprocess (mirrors the CLI's
    // `--secret-env ANTHROPIC_API_KEY`).
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )

  // Drive the real ACP stdio edge in-process: the edge reads/writes the shared
  // in-memory harness; the driver's ClientSideConnection is the other end.
  const acpEdge = AcpStdioEdgeLive({
    input: elicitationHarness.edgeInput,
    output: elicitationHarness.edgeOutput,
    runtime: ({ request }) =>
      local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: request.cwd,
        envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" }],
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

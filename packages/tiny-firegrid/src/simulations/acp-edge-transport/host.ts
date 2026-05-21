import {
  AcpStdioEdgeLive,
  ensurePathInput,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { local } from "@firegrid/protocol/launch"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { inMemoryAcpEdgeHarness } from "./harness.ts"

const backingAgentProgram = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let turn = 0
const write = value => process.stdout.write(JSON.stringify(value) + "\\n")
rl.on("line", line => {
  turn += 1
  let input = "unknown"
  try {
    const parsed = JSON.parse(line)
    input = parsed.correlationId || "prompt"
  } catch (_cause) {}
  write({ type: "text", messageId: "edge-message-" + turn, text: "firegrid acp edge observed " + input + " turn " + turn })
  write({ type: "turn_complete", messageId: "edge-message-" + turn, finishReason: "stop" })
})
`

export const acpEdgeTransportHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const runtimeHost = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
  )
  const acpEdge = AcpStdioEdgeLive({
    input: inMemoryAcpEdgeHarness.edgeInput,
    output: inMemoryAcpEdgeHarness.edgeOutput,
    runtime: ({ request }) =>
      local.jsonl({
        argv: [
          globalThis.process.execPath,
          "-e",
          backingAgentProgram,
        ],
        agent: "tiny-firegrid-acp-edge-backing-agent",
        agentProtocol: "stdio-jsonl",
        cwd: request.cwd,
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

import type { PublicLaunchRuntimeIntent } from "@firegrid/protocol/launch"
import { local } from "@firegrid/client-sdk/firegrid"

/**
 * Deterministic readiness fixture agent.
 *
 * The agent is a `node -e <inline script>` subprocess driven through the
 * `stdio-jsonl` codec. It emits exactly one `text` JSONL line on stdout
 * and exits (exit-code 0). The codec translates the line into a
 * `TextChunk` agent-output event; process exit yields a `Terminated`
 * agent-output event.
 *
 * Why this exact shape: the readiness smoke's load-bearing assertion
 * (step 5) is that one child's output is observable via BOTH the public
 * client method `handle.wait.forAgentOutput` AND a direct
 * `HostPlaneChannelRouter.dispatch({ verb: "wait_for", target:
 * "session.agent_output", ... })`. A deterministic single-TextChunk
 * agent makes that assertion unambiguous: the first observation after
 * `afterSequence: -1` is the TextChunk, and both observation paths
 * must return the same `sequence`.
 *
 * Production-style row emission: the rows on `session.agent_output`
 * are produced by the host's per-context runtime output writer (the
 * normal production path), driven by the real `stdio-jsonl` codec
 * reading the subprocess's stdout. No durable-table cheat on either
 * side.
 */
const fixtureAgentScript = [
  "process.stdout.write(",
  "  JSON.stringify({ type: 'text', text: 'readiness-hello', messageId: 'readiness-msg-1' }) + '\\n',",
  "  () => setTimeout(() => process.exit(0), 25),",
  ")",
].join("\n")

export const readinessFixtureAgentArgv = [
  globalThis.process.execPath,
  "-e",
  fixtureAgentScript,
] as const

export const readinessFixtureAgentRuntime: PublicLaunchRuntimeIntent =
  local.jsonl({
    argv: [...readinessFixtureAgentArgv],
    agent: "tiny-firegrid-readiness-fixture",
    agentProtocol: "stdio-jsonl",
  })

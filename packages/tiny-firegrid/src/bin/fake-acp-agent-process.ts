#!/usr/bin/env tsx
/**
 * Subprocess entrypoint for scenario 9 — runs a `FixtureAgent`
 * (in-process ACP-protocol-speaking agent) over Node's process.stdin /
 * process.stdout. Used as the spawn target for `LocalProcessSandboxProvider`
 * so the production codec adapter sees a real subprocess byte pipe
 * end-to-end, but the agent on the other side speaks real ACP without
 * needing API credentials.
 *
 * Closes the last gap in the production-flow proof: with this binary,
 * scenario 9 demonstrates `LocalProcessSandboxProvider.openBytePipe` +
 * `AcpSessionLive` + `ProductionCodecAdapterLive` against a genuine
 * child process — same code path that runs `claude-agent-acp` in
 * production, with the fake agent standing in to skip API/credentials.
 */

import * as acp from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"
import {
  CancelFixtureAgent,
  FixtureAgent,
  McpFiregridToolCallAgent,
  PermissionFixtureAgent,
} from "../simulations/unified-kernel-validation/acp-fixture-agent.ts"

const flavor = process.env["FIREGRID_FAKE_ACP_FIXTURE"] ?? "default"

const make = (connection: acp.AgentSideConnection): acp.Agent => {
  switch (flavor) {
    case "permission":
      return new PermissionFixtureAgent(connection)
    case "cancel":
      return new CancelFixtureAgent(connection)
    case "mcp":
      return new McpFiregridToolCallAgent(connection)
    default:
      return new FixtureAgent(connection)
  }
}

// Convert Node stdio (Readable / Writable) into web streams the ACP SDK
// consumes (`ndJsonStream` takes web `WritableStream` + `ReadableStream`).
const agentInput = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>
const agentOutput = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>

const stream = acp.ndJsonStream(agentOutput, agentInput)
new acp.AgentSideConnection((connection) => make(connection), stream)

// Keep the process alive; the codec closes the pipe when done.
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))

// Thin subprocess launcher for the runtime-owned `firegrid run | start | acp`
// CLI. All command-line behavior, schema decoding, durable-streams
// fallback, MCP serving, ACP edge wiring, and OTel exporter resolution
// live in `packages/runtime/src/bin/run.ts`. This module ONLY forwards
// argv, env, stdio, exit code, and signal to that subprocess.
//
// Per Shape C cutover rule "CLI must not import @firegrid/runtime or
// @effect/workflow": the launcher never imports runtime code into its
// own process. The runtime bin runs in a child node process under
// `tsx`; the CLI package therefore needs only the `tsx` dep.

import { fileURLToPath } from "node:url"
import { launchRuntimeBin } from "./launcher.ts"

const runtimeBin = fileURLToPath(
  new URL("../../../runtime/src/bin/run.ts", import.meta.url),
)

launchRuntimeBin(runtimeBin)

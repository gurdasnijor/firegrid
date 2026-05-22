import { defineSimulation } from "../../types.ts"
import { acpToolElicitationDriver } from "./driver.ts"
import { acpToolElicitationHost } from "./host.ts"

// Live ACP tool-elicitation: an in-memory ACP client drives the Firegrid stdio
// edge against a REAL claude-acp agent, replaying a curated prompt matrix
// (introspection / sleep / session_new+prompt / wait_for / send), one turn per
// span. This is the principled, framework-native replacement for the loose
// scripts/acp-drive.mjs: it reuses the runner's host composition, Effect span
// capture, and OTLP/DuckDB artifact bundle.
//
// Exercises the real ACP stdio edge (permission gate, child-session spawn, tool
// calls) that the client-SDK sims bypass. Env-gated on ANTHROPIC_API_KEY;
// non-deterministic, so run it manually:
//
//   ANTHROPIC_API_KEY=... TINY_FIREGRID_TIMEOUT="300 seconds" \
//     pnpm --filter @firegrid/tiny-firegrid simulate:run -- acp-tool-elicitation
//
// Then inspect with simulate:show / perf / duckdb.
export default defineSimulation({
  id: "acp-tool-elicitation",
  description:
    "Live ACP tool-elicitation against a real claude-acp agent through the stdio edge; replays a curated prompt matrix one turn per span. Env-gated on ANTHROPIC_API_KEY.",
  host: acpToolElicitationHost,
  driver: acpToolElicitationDriver,
})

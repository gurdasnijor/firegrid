import { defineSimulation } from "../../types.ts"
import { codecStdioJsonlLiveDriver } from "./driver.ts"
import { codecStdioJsonlLiveHost } from "./host.ts"

export default defineSimulation({
  id: "codec-stdio-jsonl-live",
  description:
    "Drives Firegrid's stdio-jsonl codec against a real codex exec --json process and records whether Codex JSONL can produce a RuntimeToolUseExecutor round trip.",
  host: codecStdioJsonlLiveHost,
  driver: codecStdioJsonlLiveDriver,
})

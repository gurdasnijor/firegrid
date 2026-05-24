import path from "node:path"
import { writeFile } from "node:fs/promises"
import { boardChannelStatus } from "./board.ts"
import { ensureRunDir, makeRunId, writeJson } from "./files.ts"
import { defaultTaskPacket } from "./task.ts"

export const initRun = async (): Promise<void> => {
  const runId = makeRunId()
  const runDir = await ensureRunDir(runId)
  const taskPath = path.join(runDir, "task.md")
  await writeFile(taskPath, defaultTaskPacket, "utf8")
  await writeJson(path.join(runDir, "manifest.json"), {
    "agent-coordination-patterns-experiment.ARMS.1": true,
    runId,
    taskPath,
    createdAt: new Date().toISOString(),
    board: boardChannelStatus,
  })
  console.log(runDir)
}

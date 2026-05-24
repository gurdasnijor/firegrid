import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export const experimentRoot = ".firegrid/agent-coordination-patterns"

export const makeRunId = (): string =>
  new Date().toISOString().replace(/[:.]/g, "-")

export const ensureRunDir = async (runId: string): Promise<string> => {
  const runDir = path.join(experimentRoot, "runs", runId)
  await mkdir(runDir, { recursive: true })
  await mkdir(path.join(runDir, "arms"), { recursive: true })
  await mkdir(experimentRoot, { recursive: true })
  const latest = path.join(experimentRoot, "latest")
  await unlink(latest).catch(() => undefined)
  await symlink(path.relative(experimentRoot, runDir), latest)
  return runDir
}

export const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export const readJson = async <A>(filePath: string): Promise<A> =>
  JSON.parse(await readFile(filePath, "utf8")) as A

export const readText = async (filePath: string): Promise<string> =>
  readFile(filePath, "utf8")

export const resolveRunDir = async (runDir: string): Promise<string> =>
  realpath(runDir)

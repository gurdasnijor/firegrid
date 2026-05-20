import { execFile } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(import.meta.dirname, "..")
const runId = "fixture-perf-idle-gap"
const runDir = path.join(packageRoot, ".simulate", "runs", runId)
const findingsDir = path.join(packageRoot, "docs", "findings")

interface SnapshotEntry {
  readonly path: string
  readonly text: string
}

const readTree = async (
  dir: string,
  prefix = "",
): Promise<ReadonlyArray<SnapshotEntry>> => {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async entry => {
        const relative = path.join(prefix, entry.name)
        if (entry.isDirectory()) return readTree(dir, relative)
        return [{
          path: relative,
          text: await readFile(path.join(dir, relative), "utf8"),
        }]
      }),
  )
  return nested.flat()
}

const span = (
  name: string,
  spanId: string,
  startSeconds: number,
  endSeconds: number,
) => ({
  name,
  traceId: "trace-fixture",
  spanId,
  kind: 0,
  startTime: [startSeconds, 0],
  endTime: [endSeconds, 0],
  duration: [endSeconds - startSeconds, 0],
  status: { code: 0 },
  attributes: {},
  events: [],
  links: [],
  resource: {},
})

describe("simulate:perf", () => {
  beforeAll(async () => {
    await mkdir(runDir, { recursive: true })
    await writeFile(
      path.join(runDir, "trace.jsonl"),
      [
        span("fixture.first", "span-1", 1_700_000_000, 1_700_000_001),
        span("fixture.second", "span-2", 1_700_000_010, 1_700_000_011),
      ].map(record => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    )
  })

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true })
  })

  it("firegrid-observability.TINY_FIREGRID_SIMULATIONS.12 emits finding drafts only to stderr and does not mutate findings files", async () => {
    const before = await readTree(findingsDir)
    const result = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "src/index.ts",
        "perf",
        runId,
        "--idle-threshold-ms",
        "1000",
        "--finding-threshold-ms",
        "2000",
        "--finding-draft",
      ],
      { cwd: packageRoot },
    )
    const after = await readTree(findingsDir)

    expect(result.stdout).toContain("top self-time spans:")
    expect(result.stdout).toContain("idle gaps:")
    expect(result.stderr).toContain("## Finding Source: simulate:perf idle gap regression")
    expect(result.stderr).toContain("Threshold: 2000ms")
    expect(after).toStrictEqual(before)
  })
})

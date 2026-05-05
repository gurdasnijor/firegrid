import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// launchable-substrate-host.NO_CONTROL_PLANE.4
// launchable-substrate-host.NO_CONTROL_PLANE.5
// launchable-substrate-host.LAB_INSPECTOR.6
//
// Source-level guard: the browser-side lab surface (every .ts and
// .tsx file under packages/lab/src) must not contain a workspace
// import of @durable-agent-substrate/host or
// @durable-agent-substrate/substrate. The ESLint boundary is the
// authoritative check; this test is a fast in-vitest backstop so
// regressions surface even if the lint step is skipped.

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, "..")

const collectSourceFiles = (dir: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  const walk = (p: string) => {
    const entries = readdirSyncSafe(p)
    for (const entry of entries) {
      if (entry.startsWith(".")) continue
      // Skip test files / test directories — this guard is about
      // the BROWSER BUNDLE surface, not test scaffolding. Tests
      // legitimately mention banned-package strings as banned-list
      // needles or in literal source-file scanning.
      if (entry === "__tests__") continue
      const child = `${p}/${entry}`
      const stat = statSyncSafe(child)
      if (stat?.isDirectory()) {
        walk(child)
      } else if (
        stat?.isFile() &&
        (child.endsWith(".ts") || child.endsWith(".tsx")) &&
        !child.endsWith(".test.ts") &&
        !child.endsWith(".test.tsx")
      ) {
        out.push(child)
      }
    }
  }
  walk(dir)
  return out
}

// Avoid top-level dynamic imports just to keep this test
// dependency-free; using node:fs synchronous APIs.
import {
  readdirSync as readdirSyncSafe,
  statSync as statSyncSafe,
} from "node:fs"

describe("lab/src browser bundle — no host/substrate workspace imports", () => {
  it("no source file under packages/lab/src imports @durable-agent-substrate/host or /substrate", () => {
    const banned = [
      '@durable-agent-substrate/host"',
      "'@durable-agent-substrate/host'",
      "@durable-agent-substrate/host`",
      '@durable-agent-substrate/substrate"',
      "'@durable-agent-substrate/substrate'",
      "@durable-agent-substrate/substrate`",
    ]
    const files = collectSourceFiles(srcRoot)
    expect(files.length).toBeGreaterThan(0)
    const offenders: Array<{ file: string; needle: string }> = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      for (const needle of banned) {
        if (text.includes(needle)) {
          offenders.push({ file, needle })
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

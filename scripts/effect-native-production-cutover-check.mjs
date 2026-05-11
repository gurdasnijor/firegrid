import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { error } from "node:console"
import process from "node:process"

// effect-native-production-cutover.GUARDRAILS.1
// effect-native-production-cutover.GUARDRAILS.2
const roots = ["packages", "apps", "scenarios"]
const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
])
const checkedExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
])
const forbidden = [
  "@firegrid/durable-streams/log",
  "@firegrid/durable-streams/producer",
  "appendJson",
  "readRetainedJson",
  "openDurableStreamProducer",
  "RuntimeCaptureJournal",
  "RuntimeCaptureJournalLive",
  "RuntimeIngressLive",
  "RuntimeIngressUnavailableLive",
]

const extensionOf = (path) => {
  const match = path.match(/\.[^.]+$/)
  return match?.[0] ?? ""
}

const walk = async (dir, files = []) => {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        await walk(join(dir, entry.name), files)
      }
      continue
    }
    if (entry.isFile()) {
      const path = join(dir, entry.name)
      if (checkedExtensions.has(extensionOf(path))) files.push(path)
    }
  }
  return files
}

const violations = []
for (const root of roots) {
  for (const file of await walk(root)) {
    const text = await readFile(file, "utf8")
    for (const token of forbidden) {
      if (text.includes(token)) violations.push({ file, token })
    }
  }
}

if (violations.length > 0) {
  error("Effect-native Durable Streams production cutover regression:")
  for (const violation of violations) {
    error(`- ${violation.file}: ${violation.token}`)
  }
  process.exit(1)
}

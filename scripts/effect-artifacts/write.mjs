import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { repoRoot } from "./project.mjs"
import { renderMarkdown } from "./report.mjs"

const outputPaths = {
  json: "docs/effect-artifact-inventory.json",
  markdown: "docs/effect-artifact-inventory.md",
}

export const writeInventory = (inventory) => {
  const jsonPath = join(repoRoot, outputPaths.json)
  const markdownPath = join(repoRoot, outputPaths.markdown)
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`)
  writeFileSync(markdownPath, renderMarkdown(inventory))
  return outputPaths
}

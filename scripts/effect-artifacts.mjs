#!/usr/bin/env node
import { log } from "node:console"
import { analyzeProject } from "./effect-artifacts/analyze.mjs"
import { buildProject } from "./effect-artifacts/project.mjs"
import { writeInventory } from "./effect-artifacts/write.mjs"

const project = buildProject()
const inventory = analyzeProject(project)
const outputs = writeInventory(inventory)

log(
  `Effect artifact inventory wrote ${inventory.summary.totalArtifacts} artifacts to ${outputs.json} and ${outputs.markdown}`,
)

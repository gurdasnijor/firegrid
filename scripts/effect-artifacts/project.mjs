import { existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import process from "node:process"
import { Project } from "ts-morph"

const repoRoot = process.cwd()

export const toRepoPath = (path) => relative(repoRoot, path).replaceAll("\\", "/")

export const buildProject = () => {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  })

  for (const workspaceRoot of ["packages", "apps"]) {
    const workspaceDir = join(repoRoot, workspaceRoot)
    if (!existsSync(workspaceDir)) continue
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const tsconfig = join(workspaceDir, entry.name, "tsconfig.json")
      if (existsSync(tsconfig)) project.addSourceFilesFromTsConfig(tsconfig)
    }
  }

  return project
}

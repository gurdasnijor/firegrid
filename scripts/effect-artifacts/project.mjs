import { existsSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import process from "node:process"
import { Project } from "ts-morph"

export const repoRoot = process.cwd()

export const toRepoPath = (path) => relative(repoRoot, path).replaceAll("\\", "/")

export const isSourcePath = (path) =>
  /^(packages|apps)\/[^/]+\/src\/.*\.(ts|tsx)$/.test(path) &&
  !path.includes("/__tests__/") &&
  !path.endsWith(".test.ts") &&
  !path.endsWith(".test.tsx")

export const workspaceOf = (path) => {
  const match = /^(packages|apps)\/([^/]+)\//.exec(path)
  return match === null ? null : `${match[1]}/${match[2]}`
}

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

export const sourceFiles = (project) =>
  project
    .getSourceFiles()
    .filter((sourceFile) => isSourcePath(toRepoPath(sourceFile.getFilePath())))

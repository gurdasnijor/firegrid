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

const physicalAreaOf = (path) => {
  const workspace = workspaceOf(path)
  if (workspace === null) return null
  const relativePath = path.slice(`${workspace}/src/`.length)
  if (relativePath === path) return null
  const firstSegment = relativePath.split("/")[0]
  return firstSegment?.replace(/\.tsx?$/, "") ?? null
}

export const architectureLayerOf = (path) => {
  const workspace = workspaceOf(path)
  const area = physicalAreaOf(path)
  if (workspace === null) return null
  if (workspace === "packages/substrate") {
    if (path.includes("/schema/state-machine.ts") || path.endsWith("/state-machine.ts")) {
      return "state-machine"
    }
    if (path.endsWith("/producer.ts") || path.endsWith("/operator.ts")) return "state-machine"
    if (
      path.endsWith("/operator-errors.ts") ||
      path.endsWith("/internal-claim.ts") ||
      path.endsWith("/waits.ts") ||
      path.endsWith("/subscribers.ts")
    ) {
      return "state-machine"
    }
    if (path.endsWith("/descriptors/append.ts")) return "state-store"
    if (path.endsWith("/stream.ts") || path.endsWith("/retained-records.ts")) {
      return "state-store"
    }
    if (
      path.endsWith("/projection.ts") ||
      path.endsWith("/projection-service.ts") ||
      path.includes("/projection/") ||
      path.endsWith("/schema/ready-work.ts")
    ) {
      return "projection"
    }
    if (
      path.includes("/schema/") ||
      path.includes("/descriptors/operation.ts") ||
      path.includes("/descriptors/event-stream.ts")
    ) {
      return "protocol"
    }
    if (path.includes("/choreography/")) return "choreography"
    if (path.includes("/event-plane/")) return "event-plane"
    if (path.includes("/facade/")) return "facade"
    if (path.includes("/kernel/")) return "kernel"
    return "substrate-root"
  }
  if (workspace === "packages/client") {
    if (area === "firegrid") return "client-public"
    if (area === "client") return "client-work-internal"
    return "client-root"
  }
  if (workspace === "packages/runtime") {
    if (area === "runtime") return "runtime-core"
    if (area === "boot") return "runtime-boot"
    return "runtime-root"
  }
  if (workspace.startsWith("apps/")) return "app"
  return workspace
}

export const sourceIdentityOf = (path) => ({
  workspace: workspaceOf(path),
  physicalArea: physicalAreaOf(path),
  architectureLayer: architectureLayerOf(path),
})

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

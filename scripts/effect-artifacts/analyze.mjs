import { Node } from "ts-morph"
import { isSourcePath, sourceFiles, toRepoPath, workspaceOf } from "./project.mjs"
import {
  declarationKind,
  declarationName,
  declarationTypeText,
  effectChannelsFromType,
  extendsText,
  exportBindingOf,
  flattenRequirements,
  importsOf,
  initializerText,
  locationOf,
  signatureOf,
} from "./types.mjs"

const roleOrder = [
  "service-tag",
  "layer",
  "schema",
  "tagged-error",
  "effect-returning",
  "service-interface",
  "plain-type",
  "constant",
  "pure-helper",
  "unknown",
]

const classify = ({ node, typeText, initText, tags }) => {
  const extText = extendsText(node)
  if (initText.includes("Context.Tag(") || extText.includes("Context.Tag(")) {
    return "service-tag"
  }
  if (typeText.includes("Layer.Layer") || initText.includes("Layer.")) return "layer"
  if (extText.includes("Data.TaggedError(")) return "tagged-error"
  if (typeText.includes("Effect.Effect<")) return "effect-returning"
  if (
    typeText.includes("Schema.") ||
    initText.includes("Schema.") ||
    initText.includes("TaggedStruct")
  ) {
    return "schema"
  }
  if (Node.isInterfaceDeclaration(node) && tags.serviceInterfaces.has(declarationName(node))) {
    return "service-interface"
  }
  if (Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) return "plain-type"
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer()
    if (
      initializer === undefined ||
      initializer.getKindName().includes("Literal") ||
      initText.startsWith("Object.freeze")
    ) {
      return "constant"
    }
    return "unknown"
  }
  if (Node.isFunctionDeclaration(node)) return "pure-helper"
  return "unknown"
}

const tagServiceInterfaceNames = (project) => {
  const serviceInterfaces = new Set()
  for (const sourceFile of sourceFiles(project)) {
    for (const node of sourceFile.getDescendants()) {
      const text = node.getText()
      if (!text.includes("Context.Tag(")) continue
      const matches = [...text.matchAll(/<[^,>]+,\s*([A-Za-z_$][\w$]*)/g)]
      for (const match of matches) serviceInterfaces.add(match[1])
    }
  }
  return { serviceInterfaces }
}

const declarationIndex = (project) => {
  const index = new Map()
  for (const sourceFile of sourceFiles(project)) {
    for (const declarations of sourceFile.getExportedDeclarations().values()) {
      for (const declaration of declarations) {
        const path = toRepoPath(declaration.getSourceFile().getFilePath())
        if (!isSourcePath(path)) continue
        const name = declarationName(declaration)
        if (!index.has(name)) {
          index.set(name, {
            name,
            ...locationOf(declaration),
            workspace: workspaceOf(path),
          })
        }
      }
    }
  }
  return index
}

const resolveRequirements = (requirements, index) =>
  requirements.map((requirement) => {
    const names = [...requirement.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0])
    const declaration = names.map((name) => index.get(name)).find(Boolean)
    return {
      text: requirement,
      declaration: declaration ?? null,
    }
  })

export const analyzeProject = (project) => {
  const tags = tagServiceInterfaceNames(project)
  const index = declarationIndex(project)
  const artifacts = []

  // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1
  // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.4
  for (const sourceFile of sourceFiles(project)) {
    const exportLocation = {
      path: toRepoPath(sourceFile.getFilePath()),
      workspace: workspaceOf(toRepoPath(sourceFile.getFilePath())),
    }
    for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
      for (const declaration of declarations) {
        const declarationSourceFile = declaration.getSourceFile()
        const declarationLocation = locationOf(declaration)
        if (!isSourcePath(declarationLocation.path)) continue
        const typeText = declarationTypeText(declaration)
        const effectChannels = effectChannelsFromType(typeText)
        const requirements = effectChannels
          ? resolveRequirements(flattenRequirements(effectChannels.requirement), index)
          : []
        const declarationWorkspace = workspaceOf(declarationLocation.path)
        const role = classify({
          node: declaration,
          typeText,
          initText: initializerText(declaration),
          tags,
        })
        const boundaryCrossings = []
        if (declarationWorkspace !== exportLocation.workspace) {
          boundaryCrossings.push({
            kind: "re-export-crosses-workspace",
            from: declarationWorkspace,
            to: exportLocation.workspace,
          })
        }
        for (const requirement of requirements) {
          const requirementWorkspace = requirement.declaration?.workspace
          if (requirementWorkspace && requirementWorkspace !== declarationWorkspace) {
            boundaryCrossings.push({
              kind: "requirement-crosses-workspace",
              from: declarationWorkspace,
              to: requirementWorkspace,
              requirement: requirement.text,
            })
          }
        }

        artifacts.push({
          exportName,
          declarationName: declarationName(declaration),
          role,
          declarationKind: declarationKind(declaration),
          exportLocation,
          declarationLocation: {
            ...declarationLocation,
            workspace: declarationWorkspace,
          },
          isReExport: declarationLocation.path !== exportLocation.path,
          exportBinding: exportBindingOf(sourceFile, exportName),
          typeText,
          signature: signatureOf(declaration),
          declaringFileImports: importsOf(declarationSourceFile),
          effect:
            effectChannels === null
              ? null
              : {
                  // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.2
                  success: effectChannels.success,
                  error: effectChannels.error,
                  requirement: effectChannels.requirement,
                  requirements,
                },
          boundaryCrossings,
        })
      }
    }
  }

  artifacts.sort(
    (left, right) =>
      roleOrder.indexOf(left.role) - roleOrder.indexOf(right.role) ||
      left.exportLocation.path.localeCompare(right.exportLocation.path) ||
      left.exportName.localeCompare(right.exportName),
  )

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    acids: [
      "firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1",
      "firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.2",
      "firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3",
      "firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.4",
      "firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.5",
    ],
    summary: summarize(artifacts),
    artifacts,
  }
}

const summarize = (artifacts) => {
  const byRole = Object.fromEntries(roleOrder.map((role) => [role, 0]))
  const byWorkspace = {}
  let reExports = 0
  let effectReturning = 0
  let boundaryCrossings = 0
  for (const artifact of artifacts) {
    byRole[artifact.role] = (byRole[artifact.role] ?? 0) + 1
    const workspace = artifact.exportLocation.workspace ?? "unknown"
    byWorkspace[workspace] = (byWorkspace[workspace] ?? 0) + 1
    if (artifact.isReExport) reExports += 1
    if (artifact.effect !== null) effectReturning += 1
    boundaryCrossings += artifact.boundaryCrossings.length
  }
  return {
    totalArtifacts: artifacts.length,
    byRole,
    byWorkspace,
    reExports,
    effectReturning,
    boundaryCrossings,
  }
}

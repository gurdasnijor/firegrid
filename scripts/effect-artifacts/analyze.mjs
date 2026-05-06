import { Node } from "ts-morph"
import { isSourcePath, sourceFiles, sourceIdentityOf, toRepoPath } from "./project.mjs"
import {
  declarationKind,
  declarationName,
  declarationTypeText,
  effectChannelsOf,
  extendsText,
  exportBindingOf,
  importsOf,
  initializerText,
  layerChannelsOf,
  locationOf,
  requirementEntriesOf,
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

const classify = ({ node, typeText, initText, tags, effectChannels, layerChannels }) => {
  const extText = extendsText(node)
  if (initText.includes("Context.Tag(") || extText.includes("Context.Tag(")) {
    return "service-tag"
  }
  if (extText.includes("Data.TaggedError(")) return "tagged-error"
  if (layerChannels !== null) return "layer"
  if (effectChannels !== null) return "effect-returning"
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
    if (node.getType().getCallSignatures().length > 0) return "pure-helper"
    if (
      initializer === undefined ||
      initializer.getKindName().includes("Literal") ||
      initText.startsWith("Object.freeze")
    ) {
      return "constant"
    }
    // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1
    // Tighter classification for variable initializers we previously
    // dropped to "unknown". The patterns below cover the recurring
    // firegrid shapes: `as const` literals, brand factories, namespace-
    // style object literals.
    const trimmed = initText.trim()
    if (/\bas\s+const\b/.test(trimmed)) return "constant"
    if (
      trimmed.startsWith("Brand.nominal") ||
      trimmed.startsWith("Brand.refined")
    ) {
      return "pure-helper"
    }
    if (trimmed.startsWith("{")) {
      return /=>|\bfunction\b/.test(trimmed) ? "pure-helper" : "constant"
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
          })
        }
      }
    }
  }
  return index
}

const allowedSubstrateLayerImports = {
  protocol: new Set(["protocol"]),
  "state-store": new Set(["protocol", "state-store"]),
  projection: new Set(["protocol", "state-store", "projection"]),
  "state-machine": new Set(["protocol", "state-store", "projection", "state-machine"]),
  choreography: new Set([
    "protocol",
    "state-store",
    "projection",
    "state-machine",
    "choreography",
  ]),
  "event-plane": new Set(["protocol", "state-store", "projection", "event-plane"]),
  facade: new Set(["protocol", "state-store", "projection", "state-machine", "facade"]),
  kernel: new Set([
    "protocol",
    "state-store",
    "projection",
    "state-machine",
    "choreography",
    "event-plane",
    "facade",
    "kernel",
    "substrate-root",
  ]),
  "substrate-root": new Set([
    "protocol",
    "state-store",
    "projection",
    "state-machine",
    "choreography",
    "event-plane",
    "facade",
    "kernel",
    "substrate-root",
  ]),
}

const isForbiddenLayerEdge = (from, to) => {
  if (from.workspace !== "packages/substrate" || to.workspace !== "packages/substrate") {
    return false
  }
  if (from.architectureLayer === null || to.architectureLayer === null) return false
  return !(
    allowedSubstrateLayerImports[from.architectureLayer]?.has(to.architectureLayer) ?? true
  )
}

const importBoundaryCrossings = (declarationLocation, imports) =>
  imports.flatMap((importDeclaration) => {
    const resolved = importDeclaration.resolvedLocation
    if (resolved === null) return []
    if (!isForbiddenLayerEdge(declarationLocation, resolved)) return []
    return [
      {
        kind: "import-crosses-forbidden-layer",
        from: declarationLocation.architectureLayer,
        to: resolved.architectureLayer,
        source: declarationLocation,
        moduleSpecifier: importDeclaration.moduleSpecifier,
        target: resolved.path,
      },
    ]
  })

const requirementBoundaryCrossings = (declarationLocation, requirements) =>
  requirements.flatMap((requirement) => {
    const requirementLocation = requirement.declaration
    if (requirementLocation === null) return []
    const crossings = []
    if (
      requirementLocation.workspace &&
      requirementLocation.workspace !== declarationLocation.workspace
    ) {
      crossings.push({
        kind: "requirement-crosses-workspace",
        from: declarationLocation.workspace,
        to: requirementLocation.workspace,
        requirement: requirement.text,
      })
    }
    if (isForbiddenLayerEdge(declarationLocation, requirementLocation)) {
      crossings.push({
        kind: "requirement-crosses-forbidden-layer",
        from: declarationLocation.architectureLayer,
        to: requirementLocation.architectureLayer,
        requirement: requirement.text,
      })
    }
    return crossings
  })

export const analyzeProject = (project) => {
  const tags = tagServiceInterfaceNames(project)
  const index = declarationIndex(project)
  const artifacts = []
  const fileBoundaryCrossings = []

  // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1
  // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.4
  for (const sourceFile of sourceFiles(project)) {
    const exportLocation = {
      path: toRepoPath(sourceFile.getFilePath()),
      ...sourceIdentityOf(toRepoPath(sourceFile.getFilePath())),
    }
    fileBoundaryCrossings.push(
      ...importBoundaryCrossings(exportLocation, importsOf(sourceFile)).map((crossing) => ({
        ...crossing,
        file: exportLocation.path,
      })),
    )
    for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
      for (const declaration of declarations) {
        const declarationSourceFile = declaration.getSourceFile()
        const declarationLocation = locationOf(declaration)
        if (!isSourcePath(declarationLocation.path)) continue
        const typeText = declarationTypeText(declaration)
        const effectChannels = effectChannelsOf(declaration)
        const effectRequirements = effectChannels
          ? requirementEntriesOf(effectChannels.requirement, effectChannels.requirementType, index)
          : []
        const layerChannels = layerChannelsOf(declaration)
        const layerRequirements = layerChannels
          ? requirementEntriesOf(layerChannels.requirement, layerChannels.requirementType, index)
          : []
        const layerProvides = layerChannels
          ? requirementEntriesOf(layerChannels.provides, layerChannels.providesType, index)
          : []
        const role = classify({
          node: declaration,
          typeText,
          initText: initializerText(declaration),
          tags,
          effectChannels,
          layerChannels,
        })
        const declaringFileImports = importsOf(declarationSourceFile)
        const boundaryCrossings = []
        if (declarationLocation.workspace !== exportLocation.workspace) {
          boundaryCrossings.push({
            kind: "re-export-crosses-workspace",
            from: declarationLocation.workspace,
            to: exportLocation.workspace,
          })
        }
        boundaryCrossings.push(
          ...requirementBoundaryCrossings(declarationLocation, effectRequirements),
          ...requirementBoundaryCrossings(declarationLocation, layerRequirements),
          ...requirementBoundaryCrossings(declarationLocation, layerProvides),
        )

        artifacts.push({
          exportName,
          declarationName: declarationName(declaration),
          role,
          declarationKind: declarationKind(declaration),
          exportLocation,
          declarationLocation,
          isReExport: declarationLocation.path !== exportLocation.path,
          exportBinding: exportBindingOf(sourceFile, exportName),
          typeText,
          signature: signatureOf(declaration),
          declaringFileImports,
          effect:
            effectChannels === null
              ? null
              : {
                  // firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.2
                  success: effectChannels.success,
                  error: effectChannels.error,
                  requirement: effectChannels.requirement,
                  extraction: effectChannels.extraction,
                  requirements: effectRequirements,
                },
          layer:
            layerChannels === null
              ? null
              : {
                  provides: layerChannels.provides,
                  error: layerChannels.error,
                  requirement: layerChannels.requirement,
                  extraction: layerChannels.extraction,
                  providedServices: layerProvides,
                  requirements: layerRequirements,
                  methods: layerChannels.methods ?? [],
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
    summary: summarize(artifacts, fileBoundaryCrossings),
    fileBoundaryCrossings,
    artifacts,
  }
}

const summarize = (artifacts, fileBoundaryCrossings = []) => {
  const byRole = Object.fromEntries(roleOrder.map((role) => [role, 0]))
  const byWorkspace = {}
  const byArchitectureLayer = {}
  const byPhysicalArea = {}
  let reExports = 0
  let effectReturning = 0
  let layerArtifacts = 0
  let boundaryCrossings = 0
  let forbiddenLayerCrossings = 0
  for (const artifact of artifacts) {
    byRole[artifact.role] = (byRole[artifact.role] ?? 0) + 1
    const workspace = artifact.exportLocation.workspace ?? "unknown"
    byWorkspace[workspace] = (byWorkspace[workspace] ?? 0) + 1
    const architectureLayer = artifact.declarationLocation.architectureLayer ?? "unknown"
    byArchitectureLayer[architectureLayer] = (byArchitectureLayer[architectureLayer] ?? 0) + 1
    const physicalArea = `${artifact.declarationLocation.workspace ?? "unknown"}:${artifact.declarationLocation.physicalArea ?? "root"}`
    byPhysicalArea[physicalArea] = (byPhysicalArea[physicalArea] ?? 0) + 1
    if (artifact.isReExport) reExports += 1
    if (artifact.effect !== null) effectReturning += 1
    if (artifact.layer !== null) layerArtifacts += 1
    boundaryCrossings += artifact.boundaryCrossings.length
    forbiddenLayerCrossings += artifact.boundaryCrossings.filter((crossing) =>
      crossing.kind.endsWith("forbidden-layer"),
    ).length
  }
  return {
    totalArtifacts: artifacts.length,
    byRole,
    byWorkspace,
    byArchitectureLayer,
    byPhysicalArea,
    reExports,
    effectReturning,
    layerArtifacts,
    boundaryCrossings,
    forbiddenLayerCrossings,
    fileBoundaryCrossings: fileBoundaryCrossings.length,
    fileForbiddenLayerCrossings: fileBoundaryCrossings.filter((crossing) =>
      crossing.kind.endsWith("forbidden-layer"),
    ).length,
  }
}

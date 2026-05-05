import { Node, SyntaxKind, TypeFormatFlags } from "ts-morph"
import {
  architectureLayerOf,
  sourceIdentityOf,
  toRepoPath,
  workspaceOf,
} from "./project.mjs"

export const locationOf = (node) => {
  const sourceFile = node.getSourceFile()
  const path = toRepoPath(sourceFile.getFilePath())
  return {
    path,
    line: sourceFile.getLineAndColumnAtPos(node.getStart()).line,
    ...sourceIdentityOf(path),
  }
}

const topLevelSplit = (input, separators) => {
  const parts = []
  let depth = 0
  let current = ""
  for (const char of input) {
    if (char === "<" || char === "(" || char === "[" || char === "{") depth += 1
    if (char === ">" || char === ")" || char === "]" || char === "}") depth -= 1
    if (depth === 0 && separators.includes(char)) {
      if (current.trim() !== "") parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  if (current.trim() !== "") parts.push(current.trim())
  return parts
}

const effectChannelsFromType = (typeText) => {
  const marker = "Effect.Effect<"
  const start = typeText.indexOf(marker)
  if (start === -1) return null
  let index = start + marker.length
  let depth = 1
  let body = ""
  while (index < typeText.length && depth > 0) {
    const char = typeText[index]
    if (char === "<") depth += 1
    if (char === ">") depth -= 1
    if (depth > 0) body += char
    index += 1
  }
  const [success = "unknown", error = "unknown", requirement = "never"] = topLevelSplit(
    body,
    [","],
  )
  return { success, error, requirement }
}

const typeTextOf = (type, node) =>
  type.getText(
    node,
    TypeFormatFlags.NoTruncation |
      TypeFormatFlags.UseFullyQualifiedType |
      TypeFormatFlags.WriteArrayAsGenericType,
  )

const callableReturnTypeOf = (node) => {
  if (Node.isFunctionDeclaration(node)) return { type: node.getReturnType(), direct: true }
  if (Node.isVariableDeclaration(node)) {
    const initializer =
      node.getInitializerIfKind(SyntaxKind.ArrowFunction) ??
      node.getInitializerIfKind(SyntaxKind.FunctionExpression)
    if (initializer !== undefined) return { type: initializer.getReturnType(), direct: true }
    const callSignature = node.getType().getCallSignatures()[0]
    if (callSignature !== undefined) {
      return { type: callSignature.getReturnType(), direct: true }
    }
    return { type: node.getType(), direct: false }
  }
  return { type: node.getType(), direct: false }
}

const genericChannelsFromType = (type, node, marker, defaults) => {
  const text = typeTextOf(type, node)
  if (!text.includes(marker)) return null
  const args = type.getTypeArguments()
  if (args.length > 0) {
    return {
      channels: defaults.map((defaultValue, index) => args[index]?.getText(node) ?? defaultValue),
      channelTypes: defaults.map((_, index) => args[index] ?? null),
      source: "type-api",
      text,
    }
  }
  const parsed = effectChannelsFromType(text)
  if (parsed !== null) {
    return {
      channels: [parsed.success, parsed.error, parsed.requirement],
      channelTypes: [null, null, null],
      source: "type-text",
      text,
    }
  }
  return {
    channels: defaults,
    channelTypes: defaults.map(() => null),
    source: "unresolved",
    text,
  }
}

export const effectChannelsOf = (node) => {
  const target = callableReturnTypeOf(node)
  if (!target.direct) return null
  const targetType = target.type
  const channels = genericChannelsFromType(targetType, node, "Effect.Effect<", [
    "unknown",
    "unknown",
    "never",
  ])
  if (channels === null) return null
  const [success, error, requirement] = channels.channels
  return {
    success,
    error,
    requirement,
    requirementType: channels.channelTypes[2],
    extraction: channels.source,
  }
}

const layerChannelsFrom = (type, node) => {
  const channels = genericChannelsFromType(type, node, "Layer.Layer<", [
    "unknown",
    "unknown",
    "unknown",
  ])
  if (channels === null) return null
  const [provides, error, requirement] = channels.channels
  return {
    provides,
    error,
    requirement,
    providesType: channels.channelTypes[0],
    requirementType: channels.channelTypes[2],
    extraction: channels.source,
  }
}

export const layerChannelsOf = (node) => {
  const target = callableReturnTypeOf(node)
  const direct = layerChannelsFrom(target.type, node)
  if (direct !== null) return direct
  const methods = node
    .getType()
    .getProperties()
    .flatMap((property) =>
      property
        .getDeclarations()
        .flatMap((declaration) =>
          declaration
            .getType()
            .getCallSignatures()
            .map((signature) => layerChannelsFrom(signature.getReturnType(), node))
            .filter(Boolean)
            .map((channels) => ({
              property: property.getName(),
              ...channels,
            })),
        ),
    )
  return methods.length === 0
    ? null
    : {
        provides: methods.map((method) => `${method.property}: ${method.provides}`).join("; "),
        error: methods.map((method) => `${method.property}: ${method.error}`).join("; "),
        requirement: methods
          .map((method) => `${method.property}: ${method.requirement}`)
          .join("; "),
        providesType: null,
        requirementType: null,
        extraction: "property-call-signatures",
        methods,
      }
}

const flattenRequirements = (requirementText) =>
  topLevelSplit(requirementText.replaceAll("\n", " "), ["|", "&"])
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "never" && part !== "unknown")

const flattenRequirementTypes = (type) => {
  if (type === null || type === undefined) return []
  const union = type.getUnionTypes()
  if (union.length > 0) return union.flatMap(flattenRequirementTypes)
  const intersection = type.getIntersectionTypes()
  if (intersection.length > 0) return intersection.flatMap(flattenRequirementTypes)
  const text = type.getText()
  if (text === "never" || text === "unknown") return []
  return [type]
}

export const requirementEntriesOf = (requirementText, requirementType, declarationIndex) => {
  const typeEntries = flattenRequirementTypes(requirementType).map((type) => {
    const declaration = [
      type.getSymbol(),
      type.getAliasSymbol(),
      ...type.getProperties().map((property) => property),
    ]
      .filter(Boolean)
      .flatMap((symbol) => symbol.getDeclarations())
      .map((declaration) => locationOf(declaration))
      .find((location) => workspaceOf(location.path) !== null)
    return {
      text: type.getText(undefined, TypeFormatFlags.NoTruncation),
      declaration: declaration ?? null,
      resolution: declaration === undefined ? "unresolved-type" : "type-symbol",
    }
  })
  if (typeEntries.length > 0) return typeEntries
  return flattenRequirements(requirementText).map((requirement) => {
    const names = [...requirement.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0])
    const declaration = names.map((name) => declarationIndex.get(name)).find(Boolean)
    return {
      text: requirement,
      declaration: declaration ?? null,
      resolution: declaration === undefined ? "unresolved-text" : "name-index",
    }
  })
}

export const declarationName = (node) => {
  if (Node.isVariableDeclaration(node)) return node.getName()
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node)
  ) {
    return node.getName() ?? "default"
  }
  return node.getText().slice(0, 80)
}

export const declarationKind = (node) => {
  if (Node.isVariableDeclaration(node)) return "variable"
  if (Node.isFunctionDeclaration(node)) return "function"
  if (Node.isClassDeclaration(node)) return "class"
  if (Node.isInterfaceDeclaration(node)) return "interface"
  if (Node.isTypeAliasDeclaration(node)) return "type"
  if (Node.isEnumDeclaration(node)) return "enum"
  return SyntaxKind[node.getKind()] ?? "unknown"
}

export const declarationTypeText = (node) => {
  if (Node.isVariableDeclaration(node)) return node.getType().getText(node)
  if (Node.isFunctionDeclaration(node)) return node.getReturnType().getText(node)
  if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
    return node.getType().getText(node)
  }
  if (Node.isTypeAliasDeclaration(node)) return node.getType().getText(node)
  return node.getType().getText(node)
}

const typeParametersOf = (node) => {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node)
  ) {
    return node.getTypeParameters().map((param) => ({
      name: param.getName(),
      constraint: param.getConstraint()?.getText() ?? null,
      default: param.getDefault()?.getText() ?? null,
      text: param.getText(),
    }))
  }
  if (Node.isVariableDeclaration(node)) {
    const initializer =
      node.getInitializerIfKind(SyntaxKind.ArrowFunction) ??
      node.getInitializerIfKind(SyntaxKind.FunctionExpression)
    return (
      initializer?.getTypeParameters().map((param) => ({
        name: param.getName(),
        constraint: param.getConstraint()?.getText() ?? null,
        default: param.getDefault()?.getText() ?? null,
        text: param.getText(),
      })) ?? []
    )
  }
  return []
}

const parametersOf = (node) => {
  const parameters = Node.isFunctionDeclaration(node)
    ? node.getParameters()
    : Node.isVariableDeclaration(node)
      ? (node.getInitializerIfKind(SyntaxKind.ArrowFunction)?.getParameters() ??
        node.getInitializerIfKind(SyntaxKind.FunctionExpression)?.getParameters() ??
        [])
      : []
  return parameters.map((param) => ({
    name: param.getName(),
    type: param.getType().getText(param),
    optional: param.isOptional(),
    rest: param.isRestParameter(),
    initializer: param.getInitializer()?.getText() ?? null,
    text: param.getText(),
  }))
}

const membersOf = (node) => {
  if (Node.isInterfaceDeclaration(node) || Node.isClassDeclaration(node)) {
    return node.getMembers().map((member) => ({
      kind: member.getKindName(),
      name: Node.isPropertySignature(member) ||
        Node.isPropertyDeclaration(member) ||
        Node.isMethodSignature(member) ||
        Node.isMethodDeclaration(member)
          ? member.getName()
          : null,
      type: member.getType().getText(member),
      text: member.getText().slice(0, 500),
    }))
  }
  return []
}

const heritageOf = (node) => {
  if (Node.isClassDeclaration(node)) {
    return {
      extends: node.getExtends()?.getText() ?? null,
      implements: node.getImplements().map((item) => item.getText()),
    }
  }
  if (Node.isInterfaceDeclaration(node)) {
    return {
      extends: node.getExtends().map((item) => item.getText()),
      implements: [],
    }
  }
  return { extends: null, implements: [] }
}

const bindingOf = (node) => {
  if (!Node.isVariableDeclaration(node)) return null
  const nameNode = node.getNameNode()
  return {
    name: node.getName(),
    bindingKind: nameNode.getKindName(),
    declarationListKind: node.getVariableStatementOrThrow().getDeclarationKind(),
    initializerKind: node.getInitializer()?.getKindName() ?? null,
    initializerText: node.getInitializer()?.getText().slice(0, 500) ?? null,
  }
}

export const importsOf = (sourceFile) =>
  sourceFile.getImportDeclarations().map((declaration) => ({
    moduleSpecifier: declaration.getModuleSpecifierValue(),
    resolvedLocation:
      declaration.getModuleSpecifierSourceFile() === undefined
        ? null
        : {
            path: toRepoPath(declaration.getModuleSpecifierSourceFileOrThrow().getFilePath()),
            workspace: workspaceOf(
              toRepoPath(declaration.getModuleSpecifierSourceFileOrThrow().getFilePath()),
            ),
            architectureLayer: architectureLayerOf(
              toRepoPath(declaration.getModuleSpecifierSourceFileOrThrow().getFilePath()),
            ),
          },
    defaultImport: declaration.getDefaultImport()?.getText() ?? null,
    namespaceImport: declaration.getNamespaceImport()?.getText() ?? null,
    namedImports: declaration.getNamedImports().map((namedImport) => ({
      name: namedImport.getName(),
      alias: namedImport.getAliasNode()?.getText() ?? null,
      isTypeOnly: namedImport.isTypeOnly(),
    })),
    isTypeOnly: declaration.isTypeOnly(),
  }))

export const exportBindingOf = (sourceFile, exportName) => {
  for (const declaration of sourceFile.getExportDeclarations()) {
    const namedExport = declaration
      .getNamedExports()
      .find((item) => (item.getAliasNode()?.getText() ?? item.getName()) === exportName)
    if (namedExport !== undefined) {
      return {
        kind: "export-declaration",
        moduleSpecifier: declaration.getModuleSpecifierValue() ?? null,
        name: namedExport.getName(),
        alias: namedExport.getAliasNode()?.getText() ?? null,
        isTypeOnly: declaration.isTypeOnly() || namedExport.isTypeOnly(),
        text: namedExport.getText(),
      }
    }
    if (declaration.isNamespaceExport()) {
      return {
        kind: "namespace-export",
        moduleSpecifier: declaration.getModuleSpecifierValue() ?? null,
        name: exportName,
        alias: null,
        isTypeOnly: declaration.isTypeOnly(),
        text: declaration.getText(),
      }
    }
  }
  return {
    kind: "local-declaration",
    moduleSpecifier: null,
    name: exportName,
    alias: null,
    isTypeOnly: false,
    text: null,
  }
}

export const signatureOf = (node) => ({
  text: Node.isVariableDeclaration(node)
    ? (node.getInitializer()?.getText().slice(0, 1000) ?? node.getText().slice(0, 1000))
    : node.getText().slice(0, 1000),
  typeParameters: typeParametersOf(node),
  parameters: parametersOf(node),
  returnType: Node.isFunctionDeclaration(node)
    ? node.getReturnType().getText(node)
    : Node.isVariableDeclaration(node)
      ? (node.getInitializerIfKind(SyntaxKind.ArrowFunction)?.getReturnType().getText(node) ??
        node.getInitializerIfKind(SyntaxKind.FunctionExpression)?.getReturnType().getText(node) ??
        null)
      : null,
  declaredType: declarationTypeText(node),
  heritage: heritageOf(node),
  members: membersOf(node),
  binding: bindingOf(node),
})

export const initializerText = (node) =>
  Node.isVariableDeclaration(node) ? (node.getInitializer()?.getText() ?? "") : ""

export const extendsText = (node) => {
  if (Node.isClassDeclaration(node)) {
    return node.getExtends()?.getText() ?? ""
  }
  return ""
}

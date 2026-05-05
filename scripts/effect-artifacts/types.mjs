import { Node, SyntaxKind } from "ts-morph"
import { toRepoPath } from "./project.mjs"

export const locationOf = (node) => {
  const sourceFile = node.getSourceFile()
  return {
    path: toRepoPath(sourceFile.getFilePath()),
    line: sourceFile.getLineAndColumnAtPos(node.getStart()).line,
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

export const effectChannelsFromType = (typeText) => {
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

export const flattenRequirements = (requirementText) =>
  topLevelSplit(requirementText.replaceAll("\n", " "), ["|", "&"])
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "never" && part !== "unknown")

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

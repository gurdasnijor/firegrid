// firegrid-remediation-hardening.STATIC_QUALITY.10
// firegrid-remediation-hardening.STATIC_QUALITY.11
// firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1
//
// AST-precise per-pattern Effect-quality metric counter. Walks the same
// ts-morph project the artifact inventory uses, so we get a single
// project crawl per CI invocation and avoid the grep-fragility class
// (comments containing the string, multi-line imports, kebab/space
// variations).
//
// The counts here feed `scripts/effect-quality-metrics-check.mjs` (CI
// gate) and `scripts/effect-quality-metrics-baseline.mjs` (ratchet
// update). The strict-zero metrics are layered with ESLint/Semgrep
// rules; the metric ratchet serves as a redundant gate plus a single
// canonical inventory file the gate workflow + the SDD reviewers can
// audit.

import { Node, SyntaxKind } from "ts-morph"
import { toRepoPath } from "./project.mjs"

const PRODUCTION_SOURCE_PREFIXES = [
  "packages/",
]

const isCodePath = (path) =>
  path.endsWith(".ts") ||
  path.endsWith(".tsx")

const isTestPath = (path) =>
  path.endsWith(".test.ts") ||
  path.endsWith(".test.tsx") ||
  path.includes("/__tests__/")

const isBinPath = (path) =>
  path.includes("/bin/")

const isScriptsPath = (path) =>
  path.startsWith("scripts/") || path.includes("/scripts/")

const isProductionSourcePath = (path) => {
  if (!isCodePath(path)) return false
  if (!PRODUCTION_SOURCE_PREFIXES.some((p) => path.startsWith(p))) return false
  if (isTestPath(path)) return false
  if (isBinPath(path)) return false
  if (isScriptsPath(path)) return false
  return path.includes("/src/")
}

const isTestSourcePath = (path) => {
  if (!isCodePath(path)) return false
  if (!PRODUCTION_SOURCE_PREFIXES.some((p) => path.startsWith(p))) return false
  return isTestPath(path)
}

const isMemberCall = (callExpression, object, property) => {
  const expr = callExpression.getExpression()
  if (!Node.isPropertyAccessExpression(expr)) return false
  return (
    expr.getExpression().getText() === object &&
    expr.getName() === property
  )
}

// Recognize `as Schema.Schema.AnyNoContext`, including chained as expressions.
const isAnyNoContextCast = (asExpression) => {
  const typeNode = asExpression.getTypeNode()
  if (typeNode === undefined) return false
  const typeText = typeNode.getText()
  return typeText.includes("Schema.Schema.AnyNoContext")
}

const isOrDieOrDie = (callExpression) =>
  isMemberCall(callExpression, "Effect", "orDie") ||
  isMemberCall(callExpression, "Layer", "orDie") ||
  isMemberCall(callExpression, "Effect", "die") ||
  isMemberCall(callExpression, "Effect", "dieMessage")

// `Effect.provide(<X>Live(...))` heuristic: matches `Effect.provide` as
// callee and the first argument is a CallExpression whose own callee
// ends in `Live`.
const isPerCallLayerProvide = (callExpression) => {
  if (!isMemberCall(callExpression, "Effect", "provide")) return false
  const args = callExpression.getArguments()
  if (args.length === 0) return false
  const arg = args[0]
  if (!Node.isCallExpression(arg)) return false
  const argCallee = arg.getExpression()
  const argCalleeText = argCallee.getText()
  return /Live\b/.test(argCalleeText)
}

const isErrorSuperClass = (classDeclaration) => {
  const superClass = classDeclaration.getExtends()
  if (superClass === undefined) return false
  return superClass.getText() === "Error"
}

const isDataTaggedErrorSuperClass = (classDeclaration) => {
  const superClass = classDeclaration.getExtends()
  if (superClass === undefined) return false
  return superClass.getText().startsWith("Data.TaggedError(")
}

const isNewDurableStream = (newExpression) => {
  const expr = newExpression.getExpression()
  return expr.getText() === "DurableStream"
}

const isProcessDotEnv = (propertyAccess) => {
  if (!Node.isIdentifier(propertyAccess.getExpression())) {
    return false
  }
  return (
    propertyAccess.getExpression().getText() === "process" &&
    propertyAccess.getName() === "env"
  )
}

const isNodeCryptoImport = (importDeclaration) => {
  const spec = importDeclaration.getModuleSpecifierValue()
  return spec === "node:crypto" || spec === "crypto"
}

export const computeQualityMetrics = (project) => {
  const metrics = {
    extendsErrorCount: 0,
    processEnvOutsideBinCount: 0,
    throwOutsideBinScriptCount: 0,
    forOfInPackageSourceCount: 0,
    anyNoContextCastCount: 0,
    nodeCryptoImportCount: 0,
    dataTaggedErrorDeclarationCount: 0,
    newDurableStreamSiteCount: 0,
    perCallLayerProvideSiteCount: 0,
    effectOrDieSiteCount: 0,
  }

  // Walk every project source file (including tests) and apply our own
  // production-vs-test discriminator, since the artifact inventory's
  // `sourceFiles` helper filters tests out before reaching here.
  for (const sourceFile of project.getSourceFiles()) {
    const path = toRepoPath(sourceFile.getFilePath())
    const isProduction = isProductionSourcePath(path)
    const isTest = isTestSourcePath(path)
    if (!isProduction && !isTest) continue

    if (isTest) continue

    // Production-source metrics.
    sourceFile.forEachDescendant((node) => {
      if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
        if (isErrorSuperClass(node)) {
          metrics.extendsErrorCount += 1
        }
        if (isDataTaggedErrorSuperClass(node)) {
          metrics.dataTaggedErrorDeclarationCount += 1
        }
      }
      if (Node.isPropertyAccessExpression(node) && isProcessDotEnv(node)) {
        metrics.processEnvOutsideBinCount += 1
      }
      if (Node.isThrowStatement(node)) {
        metrics.throwOutsideBinScriptCount += 1
      }
      if (
        node.getKind() === SyntaxKind.ForOfStatement
      ) {
        metrics.forOfInPackageSourceCount += 1
      }
      if (Node.isAsExpression(node) && isAnyNoContextCast(node)) {
        metrics.anyNoContextCastCount += 1
      }
      if (Node.isImportDeclaration(node) && isNodeCryptoImport(node)) {
        metrics.nodeCryptoImportCount += 1
      }
      if (Node.isNewExpression(node) && isNewDurableStream(node)) {
        metrics.newDurableStreamSiteCount += 1
      }
      if (Node.isCallExpression(node)) {
        if (isPerCallLayerProvide(node)) {
          metrics.perCallLayerProvideSiteCount += 1
        }
        if (isOrDieOrDie(node)) {
          metrics.effectOrDieSiteCount += 1
        }
      }
    })
  }

  return metrics
}

export const STRICT_ZERO_METRICS = new Set([
  "extendsErrorCount",
  "processEnvOutsideBinCount",
])

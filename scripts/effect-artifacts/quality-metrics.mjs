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

// ---------------------------------------------------------------------------
// Detectors relocated from the retired Semgrep ruleset (Semgrep retirement,
// consolidation phase 2). The rules below had live findings, so they ride the
// count-ratchet (grandfather current, fail on increase) instead of zero-tolerance
// ESLint. Pure footprint guards (0 findings) ported to ESLint `local/sg-*`.
// ---------------------------------------------------------------------------

const calleeProperty = (callExpression) => {
  const expr = callExpression.getExpression()
  return Node.isPropertyAccessExpression(expr) ? expr.getName() : undefined
}

// True when `node` is lexically inside an `Object.method(...)` call (e.g.
// Effect.gen / Effect.sync) — the Semgrep pattern-inside / pattern-not-inside.
const isInsideMemberCall = (node, object, property) =>
  node
    .getAncestors()
    .some((anc) => Node.isCallExpression(anc) && isMemberCall(anc, object, property))

// firegrid-no-unclassified-workflow-make (C2 admission guard; baselined owners).
const isWorkflowMake = (callExpression) => isMemberCall(callExpression, "Workflow", "make")

// firegrid-no-effect-run-in-library.
const EFFECT_RUN_METHODS = ["runPromise", "runPromiseExit", "runSync", "runSyncExit", "runFork"]
const isEffectRunCall = (callExpression) =>
  EFFECT_RUN_METHODS.some((method) => isMemberCall(callExpression, "Effect", method))

// firegrid-no-new-date-iso-in-library: `new Date().toISOString()` (no args).
const isNewDateToISOString = (callExpression) => {
  if (calleeProperty(callExpression) !== "toISOString") return false
  const access = callExpression.getExpression()
  const receiver = access.getExpression()
  return (
    Node.isNewExpression(receiver) &&
    receiver.getExpression().getText() === "Date" &&
    receiver.getArguments().length === 0
  )
}

// firegrid-prefer-match-tag-over-switch: `switch (x._tag) { ... }`.
const isSwitchOnTag = (switchStatement) => {
  const expr = switchStatement.getExpression()
  return Node.isPropertyAccessExpression(expr) && expr.getName() === "_tag"
}

// firegrid-no-manual-tagged-error-type: a type alias / interface with a
// `readonly _tag: "literal"` member (reimplements Data/Schema.TaggedError).
const hasReadonlyTagLiteralMember = (members) =>
  members.some((member) => {
    if (!Node.isPropertySignature(member)) return false
    if (member.getName() !== "_tag" || !member.isReadonly()) return false
    const typeNode = member.getTypeNode()
    return (
      typeNode !== undefined &&
      Node.isLiteralTypeNode(typeNode) &&
      Node.isStringLiteral(typeNode.getLiteral())
    )
  })
const isManualTaggedErrorType = (node) => {
  if (Node.isInterfaceDeclaration(node)) {
    return hasReadonlyTagLiteralMember(node.getMembers())
  }
  if (Node.isTypeAliasDeclaration(node)) {
    const typeNode = node.getTypeNode()
    return (
      typeNode !== undefined &&
      Node.isTypeLiteral(typeNode) &&
      hasReadonlyTagLiteralMember(typeNode.getMembers())
    )
  }
  return false
}

// firegrid-tryPromise-single-await: an Effect.tryPromise whose `try` body awaits
// more than once (collapses distinct failures into one catch).
const isTryPromiseMultiAwait = (callExpression) => {
  if (!isMemberCall(callExpression, "Effect", "tryPromise")) return false
  const arg = callExpression.getArguments()[0]
  if (arg === undefined || !Node.isObjectLiteralExpression(arg)) return false
  const tryProp = arg.getProperty("try")
  if (tryProp === undefined || !Node.isPropertyAssignment(tryProp)) return false
  const fn = tryProp.getInitializer()
  if (fn === undefined || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) return false
  let awaitCount = 0
  fn.forEachDescendant((descendant) => {
    if (Node.isAwaitExpression(descendant)) awaitCount += 1
  })
  return awaitCount >= 2
}

// `void <promise>.then(...)` / `void <promise>.then(...).catch(...)`.
const isVoidThenPromise = (node) => {
  if (!Node.isVoidExpression(node)) return false
  let expr = node.getExpression()
  if (Node.isCallExpression(expr) && calleeProperty(expr) === "catch") {
    const inner = expr.getExpression()
    if (Node.isPropertyAccessExpression(inner)) {
      expr = inner.getExpression()
    }
  }
  return Node.isCallExpression(expr) && calleeProperty(expr) === "then"
}

// `$P.then(...).catch(...)` or `$P.catch(...).then(...)` chain.
const isPromiseThenCatchChain = (callExpression) => {
  const outer = calleeProperty(callExpression)
  if (outer !== "then" && outer !== "catch") return false
  const access = callExpression.getExpression()
  if (!Node.isPropertyAccessExpression(access)) return false
  const innerCall = access.getExpression()
  if (!Node.isCallExpression(innerCall)) return false
  const inner = calleeProperty(innerCall)
  return (outer === "then" && inner === "catch") || (outer === "catch" && inner === "then")
}

// firegrid-mutable-state-in-effect-gen: `map.set/delete/clear(...)` inside an
// Effect.gen body but not inside an Effect.sync wrapper.
const MUTABLE_MAP_METHODS = new Set(["set", "delete", "clear"])
const mutableMapReceiverPattern = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)?$/u
const isMutableMapCall = (callExpression) => {
  const method = calleeProperty(callExpression)
  if (method === undefined || !MUTABLE_MAP_METHODS.has(method)) return false
  const access = callExpression.getExpression()
  if (!Node.isPropertyAccessExpression(access)) return false
  if (!mutableMapReceiverPattern.test(access.getExpression().getText())) return false
  const argCount = callExpression.getArguments().length
  if (method === "set") return argCount === 2
  if (method === "delete") return argCount === 1
  return argCount === 0
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
    // Relocated from Semgrep (rules with live findings; count-ratchet).
    workflowMakeSiteCount: 0,
    effectRunInLibraryCount: 0,
    newDateIsoCount: 0,
    switchOnTagCount: 0,
    manualTaggedErrorTypeCount: 0,
    tryPromiseMultiAwaitCount: 0,
    mutableStateInEffectGenCount: 0,
    fireAndForgetVoidPromiseCount: 0,
    detachedPromiseInEffectSyncCount: 0,
    promiseThenCatchChainCount: 0,
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
      if (Node.isSwitchStatement(node) && isSwitchOnTag(node)) {
        metrics.switchOnTagCount += 1
      }
      if (isManualTaggedErrorType(node)) {
        metrics.manualTaggedErrorTypeCount += 1
      }
      if (Node.isVoidExpression(node) && isVoidThenPromise(node)) {
        if (isInsideMemberCall(node, "Effect", "sync")) {
          metrics.detachedPromiseInEffectSyncCount += 1
        } else {
          metrics.fireAndForgetVoidPromiseCount += 1
        }
      }
      if (Node.isCallExpression(node)) {
        if (isPerCallLayerProvide(node)) {
          metrics.perCallLayerProvideSiteCount += 1
        }
        if (isOrDieOrDie(node)) {
          metrics.effectOrDieSiteCount += 1
        }
        if (isWorkflowMake(node)) {
          metrics.workflowMakeSiteCount += 1
        }
        if (isEffectRunCall(node)) {
          metrics.effectRunInLibraryCount += 1
        }
        if (isNewDateToISOString(node)) {
          metrics.newDateIsoCount += 1
        }
        if (isTryPromiseMultiAwait(node)) {
          metrics.tryPromiseMultiAwaitCount += 1
        }
        if (
          isMutableMapCall(node) &&
          isInsideMemberCall(node, "Effect", "gen") &&
          !isInsideMemberCall(node, "Effect", "sync")
        ) {
          metrics.mutableStateInEffectGenCount += 1
        }
        if (isPromiseThenCatchChain(node) && !isInsideMemberCall(node, "Effect", "sync")) {
          metrics.promiseThenCatchChainCount += 1
        }
      }
    })
  }

  return metrics
}

export const STRICT_ZERO_METRICS = new Set([
  "extendsErrorCount",
  "processEnvOutsideBinCount",
  // firegrid-no-detached-promise-in-effect-sync was an ERROR rule with zero
  // live findings; lock it at zero so a new detached promise inside Effect.sync
  // fails the ratchet (it cannot be ESLint-ported faithfully — pattern-inside).
  "detachedPromiseInEffectSyncCount",
])

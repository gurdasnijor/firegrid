import effect from "@effect/eslint-plugin"
import js from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import globals from "globals"
import tseslint from "typescript-eslint"

const riskyEffectRuntimeCalls = [
  {
    selector: "CallExpression[callee.object.name='Effect'][callee.property.name='runPromise']",
    message: "Effect.runPromise belongs at runtime boundaries or in tests; keep library code Effect-native.",
  },
  {
    selector: "CallExpression[callee.object.name='Effect'][callee.property.name='runPromiseExit']",
    message: "Effect.runPromiseExit belongs at runtime boundaries or in tests; keep library code Effect-native.",
  },
  {
    selector: "CallExpression[callee.object.name='Effect'][callee.property.name='runSync']",
    message: "Effect.runSync belongs at explicit runtime boundaries; keep library code Effect-native.",
  },
  {
    selector: "CallExpression[callee.object.name='Effect'][callee.property.name='runFork']",
    message: "Effect.runFork creates an unmanaged fiber unless it is scoped very deliberately.",
  },
]

const effectDebtGuardrails = [
  {
    selector: "CallExpression[callee.object.name='Effect'][callee.property.name='orDie']",
    message: "Effect.orDie collapses typed errors into defects; prefer typed errors unless this is a documented crash boundary.",
  },
  {
    selector: "CallExpression[callee.object.name='Layer'][callee.property.name='orDie']",
    message: "Layer.orDie collapses acquisition errors into defects; prefer typed errors unless this is a documented crash boundary.",
  },
  {
    selector: "CallExpression[callee.object.name='Effect'][callee.property.name='die']",
    message: "Effect.die should represent an unexpected defect, not ordinary domain failure.",
  },
]

const restrictedInternalPackage = (name, message) => ({ name, message })
const productImplementationDurableTableMessage =
  "Consume declared DurableTable services; do not import the operators package in product implementation code."
const nodeProcessImportMessage =
  "Do not import node:process from product source; use @effect/platform / @effect/platform-node runtime boundaries instead."

// Raw node: I/O builtins banned from product source — use the @effect/platform
// services (provided by NodeContext.layer at the CLI/runtime boundary). Genuine
// boundaries (bin entrypoints, the OTel-node integration) are scoped out / escape-
// hatched with a documented reason. tf-636o.
const rawNodeIoImportMessages = {
  "node:fs": "Use @effect/platform FileSystem (`yield* FileSystem.FileSystem`) instead of node:fs.",
  "node:fs/promises": "Use @effect/platform FileSystem (`yield* FileSystem.FileSystem`) instead of node:fs/promises.",
  "node:path": "Use @effect/platform Path (`yield* Path.Path`) instead of node:path.",
  "node:url": "Use @effect/platform Path (`fromFileUrl` / `toFileUrl`) instead of node:url.",
  "node:child_process": "Use @effect/platform Command (`Command.make` / `Command.string`) instead of node:child_process.",
}
const legacyDurableAgentSubstrateImportPatterns = [
  {
    group: [
      "@durable-agent-substrate/*",
      "@durable-agent-substrate/*/*",
    ],
    message:
      "firegrid-package-migration.COMPATIBILITY.1: active imports use Firegrid package names only.",
  },
  {
    group: [
      "**/repos/*",
      "**/repos/**",
    ],
    message:
      "repos/** is read-only vendored reference material. Import from real package deps (effect, @effect/*) resolved through node_modules; see AGENTS.md.",
  },
]
const upstreamDurableStreamsImportPatterns = [
  {
    group: [
      "@durable-streams/*",
      "@durable-streams/*/*",
    ],
    message:
      "firegrid-architecture-boundary.DEPENDENCY_GRAPH.7: product/runtime/client/protocol source must not import upstream Durable Streams packages directly; use DurableTable, effect-durable-streams, or a documented infrastructure boundary.",
  },
]
const historicalFiregridDurableStreamsImportPatterns = [
  {
    group: [
      "@firegrid/durable-streams",
      "@firegrid/durable-streams/*",
      "@firegrid/durable-streams/*/*",
    ],
    message:
      "firegrid-architecture-boundary.DEPENDENCY_GRAPH.9: do not import the historical @firegrid/durable-streams package; use DurableTable for durable state or effect-durable-streams for raw fact streams.",
  },
]
const tsOnly = (configs) =>
  configs.map((config) => ({
    ...config,
    files: [
      "src/**/*.ts",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "apps/**/*.ts",
      "apps/**/*.tsx",
    ],
  }))
const relativeJsSpecifierPattern = /^\.{1,2}\/.*\.js$/u
const rewriteJsSpecifierToTs = (specifier) => specifier.replace(/\.js$/u, ".ts")
const durableAuthorityNamePattern =
  /(?:cache|registry|registries|runs|claims|completions|pending|subscribers|eventplanes?|eventPlane)/u
const hostAuthorityRegistryNamePattern =
  /(?:(?:run|completion|claim|eventPlane).*(?:cache|registry)|(?:cache|registry).*(?:run|completion|claim|eventPlane))/u
const controlPlaneImportPattern =
  /^(?:node:)?https?$|^(?:express|fastify|hono|koa)$|^@hono\/node-server$|^@effect\/platform\/HttpServer/u
const pollingAllowComment = "durable-lint-allow-polling"
const timerAllowComment = "durable-lint-allow-timer"
const cacheAllowComment = "durable-lint-allow-cache"
const controlPlaneAllowComment = "durable-lint-allow-control-plane"
// firegrid-remediation-hardening.STATIC_QUALITY.10
const extendsErrorAllowComment = "effect-quality-allow-extends-error"
const processEnvAllowComment = "effect-quality-allow-process-env"
// Pure value-builders / non-durable metadata / CLI filename stamps may default
// to wall-clock at a documented boundary; durable Effect code must read Clock.
const wallClockAllowComment = "effect-quality-allow-wall-clock"
// C2 / WORKFLOW_ADMISSION: every production `Workflow.make` is an owned durable
// workflow that must be SDD-justified in docs/workflow-make-admission-ledger.md.
// The admission comment is the per-site gate (replaces the retired count ratchet).
const workflowMakeAdmissionComment = "workflow-make-admission"

const getStaticPropertyName = (node) => {
  if (node?.type !== "MemberExpression" || node.computed) {
    return undefined
  }

  return node.property.type === "Identifier" ? node.property.name : undefined
}

const getCallMember = (node) => {
  if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") {
    return undefined
  }

  const objectName = node.callee.object.type === "Identifier" ? node.callee.object.name : undefined
  const propertyName = getStaticPropertyName(node.callee)
  return objectName != null && propertyName != null ? { objectName, propertyName } : undefined
}

const getCallName = (node) => {
  if (node?.type !== "CallExpression") {
    return undefined
  }

  if (node.callee.type === "Identifier") {
    return node.callee.name
  }

  return getStaticPropertyName(node.callee)
}

const isFixedDurationExpression = (node) => {
  if (node == null) {
    return false
  }

  if (node.type === "Literal") {
    return true
  }

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return true
  }

  const member = getCallMember(node)
  return member?.objectName === "Duration" && node.arguments[0]?.type === "Literal"
}

const isNewOf = (node, names) =>
  node?.type === "NewExpression" && node.callee.type === "Identifier" && names.has(node.callee.name)

const isTopLevelDeclaration = (node) => {
  const parent = node.parent
  const grandparent = parent?.parent
  return parent?.type === "Program" || grandparent?.type === "Program"
}

// Walk ancestors for an enclosing `Object.method(...)` call (e.g. inside
// `Effect.sync(() => …)` / `Effect.gen(…)`) — the ESLint-AST analogue of the
// retired ratchet's `isInsideMemberCall` pattern-inside check.
const hasMemberCallAncestor = (node, objectName, propertyName) => {
  let current = node.parent
  while (current != null) {
    if (
      current.type === "CallExpression" &&
      current.callee?.type === "MemberExpression" &&
      !current.callee.computed &&
      current.callee.object?.type === "Identifier" &&
      current.callee.object.name === objectName &&
      current.callee.property?.type === "Identifier" &&
      current.callee.property.name === propertyName
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

const hasLoopAncestor = (node) => {
  let current = node.parent

  while (current != null) {
    if (
      current.type === "WhileStatement" ||
      current.type === "DoWhileStatement" ||
      current.type === "ForStatement" ||
      current.type === "ForInStatement" ||
      current.type === "ForOfStatement"
    ) {
      return true
    }

    current = current.parent
  }

  return false
}

// firegrid-remediation-hardening.STATIC_QUALITY.14 — relocated from the retired
// ast-grep rule pack. OpenTelemetry hrtime tuples [seconds, nanos] need bigint
// arithmetic to preserve precision; direct Number() math on index [0] loses
// precision past ~2^53 ns (~26h). Flags any `<x>.{startTime,endTime,duration}[0]`
// used as the left operand of a `*` (the reach-around the trace.ts helpers).
// Ported Semgrep `pattern-regex` enforcement (Semgrep retirement, consolidation
// phase 2). These rules scan source TEXT for banned shapes, mirroring Semgrep's
// text-regex semantics exactly (the same regexes, applied to the same source),
// with per-rule file scoping handled by ESLint's native `files`/`ignores` on the
// enabling config block. One shared rule implementation is registered under
// several distinct ids so overlapping scopes don't collide on ESLint's per-rule
// config merge; each enabling block passes that scope's pattern list via options.
const buildScanFlags = (flags) => Array.from(new Set(`${flags ?? ""}g`)).join("")
const makeSourceRegexBanRule = () => ({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow source-text shapes ported from the retired Semgrep ruleset.",
    },
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            flags: { type: "string" },
            message: { type: "string" },
          },
          required: ["pattern", "message"],
          additionalProperties: false,
        },
      },
    ],
    messages: { banned: "{{message}}" },
  },
  create(context) {
    const entries = context.options[0] ?? []
    return {
      "Program:exit"() {
        const text = context.sourceCode.getText()
        for (const { pattern, flags, message } of entries) {
          const re = new RegExp(pattern, buildScanFlags(flags))
          let match
          while ((match = re.exec(text)) !== null) {
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(match.index),
                end: context.sourceCode.getLocFromIndex(match.index + match[0].length),
              },
              messageId: "banned",
              data: { message },
            })
            if (match.index === re.lastIndex) {
              re.lastIndex += 1
            }
          }
        }
      },
    }
  },
})
// One shared implementation, registered under distinct ids (below) so that a
// file matching several scope blocks gets each scope's full pattern list.
const sourceRegexBanRule = makeSourceRegexBanRule()

const hrtimeTupleProperties = new Set(["startTime", "endTime", "duration"])
const isHrtimeTupleIndexZero = (node) =>
  node?.type === "MemberExpression" &&
  node.computed &&
  node.property?.type === "Literal" &&
  node.property.value === 0 &&
  node.object?.type === "MemberExpression" &&
  !node.object.computed &&
  node.object.property?.type === "Identifier" &&
  hrtimeTupleProperties.has(node.object.property.name)

const hasNearbyAllowComment = (context, node, allowedTags) => {
  if (node?.loc == null) {
    return false
  }

  return context.sourceCode
    .getAllComments()
    .some(
      (comment) =>
        allowedTags.some((tag) => comment.value.includes(tag)) &&
        comment.loc.end.line >= node.loc.start.line - 2 &&
        comment.loc.end.line <= node.loc.start.line,
    )
}

const local = {
  rules: {
    "no-node-process-import": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow direct node:process imports from product source.",
        },
        schema: [],
        messages: {
          noNodeProcess: nodeProcessImportMessage,
        },
      },
      create(context) {
        const report = (node) => {
          if (node?.source?.value === "node:process") {
            context.report({ node, messageId: "noNodeProcess" })
          }
        }

        return {
          ImportDeclaration: report,
          ExportAllDeclaration: report,
          ExportNamedDeclaration: report,
        }
      },
    },
    "no-raw-node-io": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow raw node:fs/path/url/child_process in product source; use @effect/platform services.",
        },
        schema: [],
        messages: { noRawNodeIo: "{{guidance}}" },
      },
      create(context) {
        const report = (node) => {
          const source = node?.source?.value
          if (
            typeof source === "string" &&
            Object.prototype.hasOwnProperty.call(rawNodeIoImportMessages, source)
          ) {
            context.report({
              node,
              messageId: "noRawNodeIo",
              data: { guidance: rawNodeIoImportMessages[source] },
            })
          }
        }
        return {
          ImportDeclaration: report,
          ExportAllDeclaration: report,
          ExportNamedDeclaration: report,
        }
      },
    },
    "relative-ts-extensions": {
      meta: {
        type: "problem",
        fixable: "code",
        docs: {
          description: "Require relative TypeScript source imports to use .ts extensions.",
        },
        schema: [],
        messages: {
          useTsExtension:
            "Use a .ts extension for relative source imports; TypeScript rewrites these to .js during build.",
        },
      },
      create(context) {
        const report = (node) => {
          if (node == null || typeof node.value !== "string" || !relativeJsSpecifierPattern.test(node.value)) {
            return
          }

          context.report({
            node,
            messageId: "useTsExtension",
            fix(fixer) {
              const raw = context.sourceCode.getText(node)
              const quote = raw[0] === "'" ? "'" : "\""
              return fixer.replaceText(node, `${quote}${rewriteJsSpecifierToTs(node.value)}${quote}`)
            },
          })
        }

        return {
          ImportDeclaration(node) {
            report(node.source)
          },
          ExportAllDeclaration(node) {
            report(node.source)
          },
          ExportNamedDeclaration(node) {
            report(node.source)
          },
          ImportExpression(node) {
            report(node.source)
          },
          TSImportType(node) {
            report(node.argument)
          },
        }
      },
    },
    "no-production-js-timers": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow production JS timers that can become fixed polling loops.",
        },
        schema: [],
        messages: {
          noTimer:
            "Avoid JS timers in production runtime code; use durable subscriptions, deadline-derived Effects, or a reviewed escape comment.",
        },
      },
      create(context) {
        const timerNames = new Set(["setInterval", "setTimeout", "setImmediate"])

        return {
          CallExpression(node) {
            if (!timerNames.has(getCallName(node)) || hasNearbyAllowComment(context, node, [timerAllowComment, pollingAllowComment])) {
              return
            }

            context.report({ node, messageId: "noTimer" })
          },
        }
      },
    },
    "no-fixed-polling": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow fixed polling primitives and sleep-in-loop scans in production durable runtime code.",
        },
        schema: [],
        messages: {
          noPolling:
            "Avoid fixed polling in durable runtime code; drive work from durable subscriptions, state folds, or explicit deadlines.",
        },
      },
      create(context) {
        const bannedMembers = new Map([
          ["Schedule", new Set(["fixed", "recurs", "spaced"])],
          ["Stream", new Set(["tick"])],
        ])

        return {
          CallExpression(node) {
            const member = getCallMember(node)
            if (member == null || hasNearbyAllowComment(context, node, [pollingAllowComment])) {
              return
            }

            if (bannedMembers.get(member.objectName)?.has(member.propertyName)) {
              context.report({ node, messageId: "noPolling" })
              return
            }

            if (
              member.objectName === "Effect" &&
              member.propertyName === "sleep" &&
              hasLoopAncestor(node) &&
              isFixedDurationExpression(node.arguments[0])
            ) {
              context.report({ node, messageId: "noPolling" })
            }
          },
        }
      },
    },
    "no-module-durable-cache": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow module-scope mutable durable-state caches in production code.",
        },
        schema: [],
        messages: {
          noTopLevelLet:
            "Avoid module-scope mutable state in durable runtime code; derive restart state from Durable Streams/State.",
          noDurableCache:
            "Avoid module-scope durable-authority caches or registries; durable state must remain the source of truth.",
        },
      },
      create(context) {
        const cacheConstructors = new Set(["Map", "Set", "WeakMap", "WeakSet"])
        const isCacheInitializer = (node) =>
          isNewOf(node, cacheConstructors) || node?.type === "ArrayExpression" || node?.type === "ObjectExpression"

        return {
          VariableDeclaration(node) {
            if (!isTopLevelDeclaration(node) || hasNearbyAllowComment(context, node, [cacheAllowComment])) {
              return
            }

            if (node.kind === "let") {
              context.report({ node, messageId: "noTopLevelLet" })
              return
            }

            for (const declarator of node.declarations) {
              const name = declarator.id.type === "Identifier" ? declarator.id.name : undefined
              if (
                name != null &&
                durableAuthorityNamePattern.test(name) &&
                isCacheInitializer(declarator.init)
              ) {
                context.report({ node: declarator, messageId: "noDurableCache" })
              }
            }
          },
        }
      },
    },
    "no-host-authority-registry": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow host-owned run/completion/claim/event-plane registry names.",
        },
        schema: [],
        messages: {
          noRegistry:
            "Host code must not define durable-authority registries/caches for runs, completions, claims, or event planes.",
        },
      },
      create(context) {
        const reportName = (node, name) => {
          if (
            typeof name === "string" &&
            hostAuthorityRegistryNamePattern.test(name) &&
            !hasNearbyAllowComment(context, node, [cacheAllowComment])
          ) {
            context.report({ node, messageId: "noRegistry" })
          }
        }

        return {
          VariableDeclarator(node) {
            reportName(node, node.id.type === "Identifier" ? node.id.name : undefined)
          },
          FunctionDeclaration(node) {
            reportName(node, node.id?.name)
          },
          ClassDeclaration(node) {
            reportName(node, node.id?.name)
          },
        }
      },
    },
    "no-hidden-control-plane": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow hidden HTTP/control-plane imports in production packages.",
        },
        schema: [],
        messages: {
          noControlPlane:
            "Avoid hidden HTTP/control-plane surfaces in production packages; add a reviewed escape comment if this is intentional.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (
              typeof node.source.value === "string" &&
              controlPlaneImportPattern.test(node.source.value) &&
              !hasNearbyAllowComment(context, node, [controlPlaneAllowComment])
            ) {
              context.report({ node: node.source, messageId: "noControlPlane" })
            }
          },
        }
      },
    },
    "simulation-host-real-firegrid-host": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Require tiny-firegrid simulation hosts to compose the real @firegrid/runtime FiregridRuntime factory.",
        },
        schema: [],
        messages: {
          missingFactoryImport:
            "Simulation host.ts must import FiregridRuntime from @firegrid/runtime/unified and compose that real factory.",
          missingFactoryCall:
            "Simulation host.ts must call the imported @firegrid/runtime/unified FiregridRuntime factory.",
        },
      },
      create(context) {
        let importedFactoryLocalName
        let calledFactory = false

        return {
          ImportDeclaration(node) {
            if (node.source.value !== "@firegrid/runtime/unified") {
              return
            }

            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                specifier.imported.name === "FiregridRuntime"
              ) {
                importedFactoryLocalName = specifier.local.name
              }
            }
          },
          CallExpression(node) {
            if (
              importedFactoryLocalName !== undefined &&
              node.callee.type === "Identifier" &&
              node.callee.name === importedFactoryLocalName
            ) {
              calledFactory = true
            }
          },
          "Program:exit"(node) {
            if (importedFactoryLocalName === undefined) {
              context.report({ node, messageId: "missingFactoryImport" })
            } else if (!calledFactory) {
              context.report({ node, messageId: "missingFactoryCall" })
            }
          },
        }
      },
    },
    // firegrid-remediation-hardening.STATIC_QUALITY.10
    // firegrid-remediation-hardening.EFFECT_CONSISTENCY.2
    "no-extends-error": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow class extends Error declarations in package source; use Data.TaggedError.",
        },
        schema: [],
        messages: {
          noExtendsError:
            "Use Data.TaggedError(\"...\")<...>{} instead of class extends Error. Domain errors must be tagged for catchTag/Match.tag/Schema.is to work. The repo policy keeps Data.TaggedError; growth of class extends Error is blocked here.",
        },
      },
      create(context) {
        const isErrorSuper = (node) =>
          node?.type === "Identifier" && node.name === "Error"
        const visit = (node) => {
          if (
            node?.superClass != null &&
            isErrorSuper(node.superClass) &&
            !hasNearbyAllowComment(context, node, [extendsErrorAllowComment])
          ) {
            context.report({ node, messageId: "noExtendsError" })
          }
        }
        return {
          ClassDeclaration: visit,
          ClassExpression: visit,
        }
      },
    },
    // firegrid-remediation-hardening.STATIC_QUALITY.10
    "no-process-env-outside-bin": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow process.env reads outside bin/ and scripts/; use @effect/platform Config or boundary-injected configuration.",
        },
        schema: [],
        messages: {
          noProcessEnv:
            "process.env reads belong at the binary entry boundary (bin/) or in tooling scripts (scripts/). In application code use Config.string / Config.option / Config.redacted, or accept config as an explicit parameter.",
        },
      },
      create(context) {
        const isGlobalThisProcess = (object) =>
          object?.type === "MemberExpression" &&
          !object.computed &&
          object.object?.type === "Identifier" &&
          object.object.name === "globalThis" &&
          object.property?.type === "Identifier" &&
          object.property.name === "process"
        // Semgrep matched `globalThis.process.env.X` / `[X]` (a trailing access),
        // not a bare `globalThis.process.env` value passed around; mirror that so
        // the port neither weakens nor over-reaches. The direct `process.env`
        // form keeps the existing any-access behavior.
        const hasTrailingAccess = (node) =>
          node.parent?.type === "MemberExpression" && node.parent.object === node

        return {
          MemberExpression(node) {
            if (
              node.property?.type !== "Identifier" ||
              node.property.name !== "env" ||
              hasNearbyAllowComment(context, node, [processEnvAllowComment])
            ) {
              return
            }
            if (node.object?.type === "Identifier" && node.object.name === "process") {
              context.report({ node, messageId: "noProcessEnv" })
            } else if (isGlobalThisProcess(node.object) && hasTrailingAccess(node)) {
              context.report({ node, messageId: "noProcessEnv" })
            }
          },
        }
      },
    },
    // Ported Semgrep `firegrid-no-date-now` (ERROR): Date.now() is not
    // replay-safe; use Clock.currentTimeMillis. AST-precise (no comment/string
    // false positives), matching Semgrep's `pattern: Date.now()`.
    "no-date-now": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow Date.now() in library code; use Clock.currentTimeMillis or a caller-resolved timestamp.",
        },
        schema: [],
        messages: {
          noDateNow:
            "Date.now() is not replay-safe. Use Clock.currentTimeMillis inside Effect code or accept a timestamp resolved by the caller's Effect scope.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.object?.type === "Identifier" &&
              callee.object.name === "Date" &&
              callee.property?.type === "Identifier" &&
              callee.property.name === "now" &&
              node.arguments.length === 0
            ) {
              context.report({ node, messageId: "noDateNow" })
            }
          },
        }
      },
    },
    // Relocated from the effect-quality ts-morph ratchet (`newDateIsoCount`).
    // `new Date().toISOString()` (no-arg) reads wall-clock outside Effect, so it
    // is not replay-safe; durable code must read `Clock.currentTimeMillis` and
    // format `new Date(millis).toISOString()`. Pure value-builders / non-durable
    // metadata / CLI filename stamps escape-hatch with the documented allow
    // comment (matches the ratchet's AST-precise detector — no string/comment FPs).
    "no-new-date-iso": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow `new Date().toISOString()` (no-arg) in library code; read Clock.currentTimeMillis and format `new Date(millis).toISOString()`.",
        },
        schema: [],
        messages: {
          noNewDateIso:
            "`new Date().toISOString()` reads wall-clock and is not replay-safe. Read `yield* Clock.currentTimeMillis` (or `DateTime.now`) inside Effect code and format `new Date(millis).toISOString()`. Pure value-builders / CLI stamps may escape-hatch with `// effect-quality-allow-wall-clock`.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              callee.property?.type !== "Identifier" ||
              callee.property.name !== "toISOString" ||
              node.arguments.length !== 0
            ) {
              return
            }
            const receiver = callee.object
            if (
              receiver?.type === "NewExpression" &&
              receiver.callee?.type === "Identifier" &&
              receiver.callee.name === "Date" &&
              receiver.arguments.length === 0 &&
              !hasNearbyAllowComment(context, node, [wallClockAllowComment])
            ) {
              context.report({ node, messageId: "noNewDateIso" })
            }
          },
        }
      },
    },
    // Relocated from the effect-quality ratchet (`nodeCryptoImportCount`). Node's
    // crypto RNG is not replay-safe; use a deterministic / Effect-resolved source.
    "no-node-crypto-import": {
      meta: {
        type: "problem",
        docs: { description: "Disallow node:crypto / crypto imports in library code (non-replay-safe RNG)." },
        schema: [],
        messages: {
          noNodeCrypto:
            "node:crypto / crypto is not replay-safe. Use a deterministic id/hash helper or an Effect-resolved randomness source instead.",
        },
      },
      create(context) {
        const report = (node) => {
          const source = node?.source?.value
          if (source === "node:crypto" || source === "crypto") {
            context.report({ node, messageId: "noNodeCrypto" })
          }
        }
        return { ImportDeclaration: report, ExportAllDeclaration: report, ExportNamedDeclaration: report }
      },
    },
    // Relocated from the effect-quality ratchet (`newDurableStreamSiteCount`).
    // Direct `new DurableStream(...)` bypasses the DurableTable / declared-service
    // boundary; construct streams through the supported factories.
    "no-new-durable-stream": {
      meta: {
        type: "problem",
        docs: { description: "Disallow direct `new DurableStream(...)`; use the supported factories." },
        schema: [],
        messages: {
          noNewDurableStream:
            "Do not construct `new DurableStream(...)` directly; go through DurableTable / the declared stream factories.",
        },
      },
      create(context) {
        return {
          NewExpression(node) {
            if (node.callee?.type === "Identifier" && node.callee.name === "DurableStream") {
              context.report({ node, messageId: "noNewDurableStream" })
            }
          },
        }
      },
    },
    // Relocated from the effect-quality ratchet (`forOfInPackageSourceCount`).
    // Effect-native source prefers Array/Stream/Chunk combinators over imperative
    // `for…of` iteration.
    "no-for-of-in-source": {
      meta: {
        type: "problem",
        docs: { description: "Disallow imperative for…of in library source; use Array/Stream/Chunk combinators." },
        schema: [],
        messages: {
          noForOf:
            "Avoid imperative `for…of` in library source; use Array/Stream/Chunk combinators (Effect-native iteration).",
        },
      },
      create(context) {
        return {
          ForOfStatement(node) {
            context.report({ node, messageId: "noForOf" })
          },
        }
      },
    },
    // Relocated from the effect-quality ratchet (`anyNoContextCastCount`). Casting
    // to `Schema.Schema.AnyNoContext` launders away the schema's real context.
    "no-any-no-context-cast": {
      meta: {
        type: "problem",
        docs: { description: "Disallow `as …Schema.AnyNoContext` casts (type laundering)." },
        schema: [],
        messages: {
          noAnyNoContextCast:
            "Do not cast to `Schema.Schema.AnyNoContext`; carry the schema's real context type instead of laundering it.",
        },
      },
      create(context) {
        return {
          TSAsExpression(node) {
            const text = context.sourceCode.getText(node.typeAnnotation)
            if (text.includes("Schema.Schema.AnyNoContext")) {
              context.report({ node, messageId: "noAnyNoContextCast" })
            }
          },
        }
      },
    },
    // Relocated from the effect-quality ratchet (`detachedPromiseInEffectSyncCount`,
    // STRICT_ZERO). A `void <promise>.then(...)` inside `Effect.sync(...)` detaches
    // an unmanaged promise from the Effect runtime (no interruption / error
    // propagation). Ancestor-walking (the ratchet's pattern-inside semantics).
    "no-detached-promise-in-effect-sync": {
      meta: {
        type: "problem",
        docs: { description: "Disallow `void <promise>.then(...)` inside Effect.sync (detached unmanaged promise)." },
        schema: [],
        messages: {
          noDetachedPromise:
            "Detached `void <promise>.then(...)` inside Effect.sync escapes the Effect runtime. Model the async work as an Effect (Effect.promise / Effect.tryPromise) and fork it with the runtime instead.",
        },
      },
      create(context) {
        return {
          UnaryExpression(node) {
            if (node.operator !== "void") return
            let arg = node.argument
            if (
              arg?.type === "CallExpression" &&
              arg.callee?.type === "MemberExpression" &&
              !arg.callee.computed &&
              arg.callee.property?.type === "Identifier" &&
              arg.callee.property.name === "catch" &&
              arg.callee.object?.type === "CallExpression"
            ) {
              arg = arg.callee.object
            }
            const isThenCall =
              arg?.type === "CallExpression" &&
              arg.callee?.type === "MemberExpression" &&
              !arg.callee.computed &&
              arg.callee.property?.type === "Identifier" &&
              arg.callee.property.name === "then"
            if (isThenCall && hasMemberCallAncestor(node, "Effect", "sync")) {
              context.report({ node, messageId: "noDetachedPromise" })
            }
          },
        }
      },
    },
    // Re-homed C2 / WORKFLOW_ADMISSION guard from the retired effect-quality
    // ratchet (`workflowMakeSiteCount`). Was a grandfathered COUNT (fail-on-
    // increase) — now a per-site annotation gate: every production `Workflow.make`
    // must carry a nearby `// workflow-make-admission` comment, forcing a net-new
    // owner workflow to add its ledger justification. Pins the finding to
    // path+line (which the count ratchet could not). See
    // docs/workflow-make-admission-ledger.md.
    "no-unclassified-workflow-make": {
      meta: {
        type: "problem",
        docs: { description: "Require a workflow-make-admission ledger annotation on every production Workflow.make." },
        schema: [],
        messages: {
          noUnclassified:
            "Net-new `Workflow.make` is an owned durable workflow (C2 / WORKFLOW_ADMISSION). SDD-justify it in docs/workflow-make-admission-ledger.md and annotate this site with `// workflow-make-admission`.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.object?.type === "Identifier" &&
              callee.object.name === "Workflow" &&
              callee.property?.type === "Identifier" &&
              callee.property.name === "make" &&
              !hasNearbyAllowComment(context, node, [workflowMakeAdmissionComment])
            ) {
              context.report({ node, messageId: "noUnclassified" })
            }
          },
        }
      },
    },
    // firegrid-remediation-hardening.STATIC_QUALITY.14 (relocated from ast-grep)
    "hrtime-number-arithmetic": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow OpenTelemetry hrtime tuple arithmetic in number space; use the nsFromHrTime / startNs / endNs bigint helpers.",
        },
        schema: [],
        messages: {
          noHrtimeMath:
            "hrtime tuple arithmetic in number space — use nsFromHrTime / startNs / endNs (precision loss above ~26h).",
        },
      },
      create(context) {
        return {
          BinaryExpression(node) {
            if (node.operator === "*" && isHrtimeTupleIndexZero(node.left)) {
              context.report({ node, messageId: "noHrtimeMath" })
            }
          },
        }
      },
    },
    // tf-0awo.21 §6: ban the `as unknown as T` double-launder cast (matches the
    // inner `… as unknown`). A distinct rule id (not no-restricted-syntax) so a
    // tier-scoped enabling block never clobbers the shared no-restricted-syntax
    // config via ESLint's per-rule last-wins merge.
    "no-launder-cast": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow `as unknown as T` casts; drive residual requirements to never and orDie infra errors at their boundary so composition is launchable by construction.",
        },
        schema: [],
        messages: {
          noLaunderCast:
            "Do not launder types through `as unknown as`. Make the composition type-correct (drive residual R to `never`, orDie infra errors at their boundary) instead of asserting the shape (tf-0awo.21 §6).",
        },
      },
      create(context) {
        return {
          TSAsExpression(node) {
            if (node.typeAnnotation?.type === "TSUnknownKeyword") {
              context.report({ node, messageId: "noLaunderCast" })
            }
          },
        }
      },
    },
    // Ported Semgrep source-regex rules (Semgrep retirement). Each id shares the
    // one `sourceRegexBanRule` implementation; the enabling config block sets the
    // file scope (matching the original Semgrep `paths`) and passes that rule's
    // pattern list via options. One id per original Semgrep rule so each keeps its
    // exact scope and distinct ids never collide on ESLint's per-rule config merge.
    "sg-no-inline-stream-url-construction": sourceRegexBanRule,
    "sg-no-filesystem-in-runtime-package": sourceRegexBanRule,
    "sg-no-host-id-env-authority": sourceRegexBanRule,
    "sg-runtime-context-workflow-requires-local-authority": sourceRegexBanRule,
    "sg-no-replay-path-output-scan": sourceRegexBanRule,
    "sg-runtime-owned-table-writes-use-authorities": sourceRegexBanRule,
    "sg-runtime-subscribers-transforms-no-table-facades": sourceRegexBanRule,
    "sg-runtime-no-exported-authority-singletons": sourceRegexBanRule,
    "sg-runtime-no-custom-authority-wrapper-types": sourceRegexBanRule,
    "sg-runtime-no-authority-static-helper-calls": sourceRegexBanRule,
    "sg-runtime-no-singleton-authority-specifiers": sourceRegexBanRule,
    "sg-runtime-no-second-durable-capability-provider": sourceRegexBanRule,
    "sg-runtime-no-source-collection-handle-in-static-subscriber-contract": sourceRegexBanRule,
    "sg-runtime-no-table-service-yield-outside-providers": sourceRegexBanRule,
    "sg-runtime-no-authority-registry-surface": sourceRegexBanRule,
    "sg-runtime-host-no-direct-source-collection-registration": sourceRegexBanRule,
    "sg-runtime-no-host-internal-imports-outside-host": sourceRegexBanRule,
    "sg-runtime-no-runtime-errors-imports-outside-runtime": sourceRegexBanRule,
    "sg-runtime-no-old-singleton-authority-tag-keys": sourceRegexBanRule,
    "sg-runtime-no-table-type-parameters-outside-authorities": sourceRegexBanRule,
    "sg-runtime-no-exported-authority-registry-api": sourceRegexBanRule,
    "sg-factory-exported-contracts-use-schema": sourceRegexBanRule,
    "sg-no-random-durable-identity": sourceRegexBanRule,
    "sg-no-raw-stream-authority-string-schema": sourceRegexBanRule,
    "sg-no-inline-tagged-error-fail": sourceRegexBanRule,
    "sg-no-mutable-identity-let": sourceRegexBanRule,
    "sg-match-should-be-exhaustive": sourceRegexBanRule,
    "sg-c4-no-new-durable-deferred-runtime-wait": sourceRegexBanRule,
    "sg-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools": sourceRegexBanRule,
    "sg-c7-no-edge-local-terminal-synthesis": sourceRegexBanRule,
    "sg-shape-c-no-workflow-engine-in-runtime-context-subscriber": sourceRegexBanRule,
    "sg-transforms-purity-import-boundary": sourceRegexBanRule,
    "sg-shape-c-runtime-context-no-workflow-machinery": sourceRegexBanRule,
    "sg-composition-no-legacy-imports": sourceRegexBanRule,
    "sg-host-sdk-imports": sourceRegexBanRule,
    "sg-no-numbered-runtime-subpath": sourceRegexBanRule,
  },
}

// Test-file ignores shared by the ported-Semgrep blocks (the original rules all
// excluded `**/*.test.{ts,tsx}` and `**/__tests__/**`).
const portedSemgrepTestIgnores = [
  "packages/**/*.test.ts",
  "packages/**/*.test.tsx",
  "packages/**/src/__tests__/**/*.ts",
  "packages/**/src/__tests__/**/*.tsx",
  "apps/**/*.test.ts",
  "apps/**/*.test.tsx",
  "apps/**/src/__tests__/**/*.ts",
  "apps/**/src/__tests__/**/*.tsx",
]

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "**/dist/**",
      "**/.next/**",
      "apps/**/next-env.d.ts",
      ".worktrees/**",
      "repos/**",
    ],
  },
  js.configs.recommended,
  // firegrid-remediation-hardening.STATIC_QUALITY.7
  ...tsOnly(tseslint.configs.recommendedTypeChecked),
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      "src/**/*.ts",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "apps/**/*.ts",
      "apps/**/*.tsx",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@effect": effect,
      "@stylistic": stylistic,
      local,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "warn",
        {
          allowBoolean: true,
          allowNever: true,
          allowNullish: true,
          allowNumber: true,
        },
      ],
      "@typescript-eslint/no-base-to-string": "warn",
      "local/relative-ts-extensions": "error",
      "local/no-node-process-import": "error",
      "local/hrtime-number-arithmetic": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/types",
              "Do not introduce a shared types package unless the specs explicitly justify it.",
            ),
          ],
          patterns: legacyDurableAgentSubstrateImportPatterns,
        },
      ],
      "no-restricted-syntax": [
        "warn",
        ...riskyEffectRuntimeCalls,
        ...effectDebtGuardrails,
      ],
      "no-unused-labels": "warn",
      "no-useless-assignment": "warn",
      "require-yield": "off",
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/eol-last": ["error", "always"],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      "@stylistic/semi": ["error", "never"],
    },
  },
  {
    files: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
    ignores: [
      "packages/effect-durable-operators/src/**/*.ts",
      "packages/effect-durable-streams/src/**/*.ts",
      "packages/**/src/__tests__/**/*.ts",
      "apps/**/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    rules: {
      "local/no-fixed-polling": "warn",
      "local/no-module-durable-cache": "warn",
      "local/no-production-js-timers": "error",
      "no-restricted-syntax": [
        "warn",
        ...effectDebtGuardrails,
      ],
    },
  },
  {
    files: [
      "packages/**/src/**/*.ts",
      "packages/**/src/**/*.tsx",
      "apps/**/src/**/*.ts",
      "apps/**/src/**/*.tsx",
    ],
    ignores: [
      "packages/effect-durable-operators/src/**/*.ts",
      "packages/effect-durable-streams/src/**/*.ts",
      "packages/**/src/__tests__/**/*.ts",
      "apps/**/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
          ],
        },
      ],
    },
  },
  {
    // firegrid-remediation-hardening.STATIC_QUALITY.4
    // @effect/eslint-plugin@0.3.2 ships only `dprint` and
    // `no-import-from-barrel-package`; dprint conflicts with this repo's
    // stylistic formatter stack, so the applicable package-boundary rule is
    // enabled explicitly for production package source.
    files: [
      "packages/**/src/**/*.ts",
      "packages/**/src/**/*.tsx",
      "apps/**/src/**/*.ts",
      "apps/**/src/**/*.tsx",
    ],
    ignores: [
      "packages/**/src/__tests__/**/*.ts",
      "apps/**/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    rules: {
      "@effect/no-import-from-barrel-package": [
        "warn",
        {
          packageNames: [
            "@firegrid/client-sdk",
            "@firegrid/substrate",
            "@firegrid/runtime",
          ],
        },
      ],
      // firegrid-remediation-hardening.STATIC_QUALITY.10
      // firegrid-remediation-hardening.EFFECT_CONSISTENCY.2
      "local/no-extends-error": "error",
      // firegrid-remediation-hardening.STATIC_QUALITY.10
      "local/no-process-env-outside-bin": "error",
      // ported from Semgrep firegrid-no-date-now (ERROR)
      "local/no-date-now": "error",
      // relocated from the effect-quality ratchet (newDateIsoCount)
      "local/no-new-date-iso": "error",
      // relocated from the effect-quality ratchet (nodeCryptoImportCount) — kept
      // in this src-scoped block (not the broad base block) so test fixtures may
      // still use crypto, matching the ratchet's production-source-only scope.
      "local/no-node-crypto-import": "error",
      // relocated from the effect-quality ratchet (newDurableStreamSiteCount,
      // forOfInPackageSourceCount, anyNoContextCastCount,
      // detachedPromiseInEffectSyncCount — the last was the ratchet's STRICT_ZERO)
      "local/no-new-durable-stream": "error",
      "local/no-for-of-in-source": "error",
      "local/no-any-no-context-cast": "error",
      "local/no-detached-promise-in-effect-sync": "error",
      // re-homed C2 / WORKFLOW_ADMISSION guard (was ratchet workflowMakeSiteCount)
      "local/no-unclassified-workflow-make": "error",
    },
  },
  {
    files: ["packages/{client-sdk,runtime}/src/**/*.ts"],
    ignores: ["packages/**/src/__tests__/**/*.ts", "packages/**/*.test.ts"],
    rules: {
      "local/no-hidden-control-plane": "error",
    },
  },
  {
    files: ["packages/tiny-firegrid/src/simulations/*/driver.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./*", "../*"],
              message:
                "Simulation drivers must be airgapped from local host/scenario code; import only @firegrid/client-sdk and effect.",
            },
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: ["@firegrid/host-sdk", "@firegrid/host-sdk/*"],
              message: "Drivers run on the client side; no host imports.",
            },
            {
              group: ["@firegrid/runtime", "@firegrid/runtime/*"],
              message: "Drivers cannot reach into runtime internals.",
            },
            {
              group: ["@firegrid/protocol", "@firegrid/protocol/*"],
              message:
                "Drivers use @firegrid/client-sdk only. If you need missing behavior, add it to the public client surface.",
            },
            {
              group: ["effect-durable-operators", "effect-durable-operators/*"],
              message: "Drivers do not touch durable tables directly. The host owns those.",
            },
            {
              group: ["@effect/workflow", "@effect/workflow/*"],
              message: "Drivers must use the public client surface, not workflow internals.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/tiny-firegrid/src/simulations/*/host.ts"],
    rules: {
      "local/simulation-host-real-firegrid-host": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@firegrid/client-sdk", "@firegrid/client-sdk/*"],
              message: "Hosts do not use the client. They provide it.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression[typeAnnotation.typeName.name='FiregridHost'], TSAsExpression[typeAnnotation.typeArguments.params.0.typeName.name='FiregridHost']",
          message:
            "Simulation hosts must provide the real FiregridHost factory Layer; do not cast no-op Layers to FiregridHost.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message:
            "Simulation hosts must not use as unknown as to forge FiregridHost evidence.",
        },
        {
          selector:
            "MemberExpression[object.name='Effect'][property.name=/^run(Promise|PromiseExit|Sync|SyncExit)$/]",
          message:
            "tiny-firegrid sims must not self-run effects. Export a driver; the runner executes it.",
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='exit']",
          message:
            "tiny-firegrid sims must not call process.exit. Drivers return; the runner owns process lifecycle.",
        },
        {
          selector:
            "Property[key.name='claimStatus'], Property[key.value='claimStatus']",
          message:
            "Simulations emit traces; claimStatus verdicts belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "Property[key.name='findings'][value.type='ArrayExpression'], Property[key.value='findings'][value.type='ArrayExpression']",
          message:
            "Simulations emit traces; findings arrays belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "TSAsExpression[typeAnnotation.typeName.name='FiregridHost'], TSAsExpression[typeAnnotation.typeArguments.params.0.typeName.name='FiregridHost']",
          message:
            "Simulation hosts must provide the real FiregridHost factory Layer; do not cast no-op Layers to FiregridHost.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message:
            "Simulation hosts must not use as unknown as to forge FiregridHost evidence.",
        },
        {
          selector:
            "ImportSpecifier[imported.name='makeRecorderAdapter'], ImportSpecifier[imported.name='RuntimeContextSessionAdapter']",
          message:
            "Simulations must exercise production code; do not import recorder adapters or stub RuntimeContextSessionAdapter Lives.",
        },
        {
          selector:
            "ImportDeclaration[source.value=/fake-codec|fake-sandbox|acp-sandbox-fake|production-flow-scenario|production-flow-acp-scenario/]",
          message:
            "Simulations must not import fake codec/sandbox paths or narrowed fake production-flow variants.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Layer'][callee.property.name='succeed'] > Identifier[name='RuntimeContextSessionAdapter']",
          message:
            "Simulations must not provide stubbed RuntimeContextSessionAdapter Lives.",
        },
      ],
    },
  },
  {
    files: ["packages/tiny-firegrid/src/simulations/*/index.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration:not([source.value='../../types.ts']):not([source.value='./driver.ts']):not([source.value='./host.ts'])",
          message:
            "Simulation index.ts may only import ../../types.ts, ./driver.ts, and ./host.ts.",
        },
      ],
    },
  },
  {
    files: ["packages/tiny-firegrid/src/simulations/*/host.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression[typeAnnotation.typeName.name='FiregridHost'], TSAsExpression[typeAnnotation.typeArguments.params.0.typeName.name='FiregridHost']",
          message:
            "Simulation hosts must provide the real FiregridHost factory Layer; do not cast no-op Layers to FiregridHost.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message:
            "Simulation hosts must not use as unknown as to forge FiregridHost evidence.",
        },
        {
          selector:
            "MemberExpression[object.name='Effect'][property.name=/^run(Promise|PromiseExit|Sync|SyncExit)$/]",
          message:
            "tiny-firegrid sims must not self-run effects. Export a driver; the runner executes it.",
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='exit']",
          message:
            "tiny-firegrid sims must not call process.exit. Drivers return; the runner owns process lifecycle.",
        },
        {
          selector:
            "Property[key.name='claimStatus'], Property[key.value='claimStatus']",
          message:
            "Simulations emit traces; claimStatus verdicts belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "Property[key.name='findings'][value.type='ArrayExpression'], Property[key.value='findings'][value.type='ArrayExpression']",
          message:
            "Simulations emit traces; findings arrays belong in prose findings, not code artifacts.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: ["@firegrid/client-sdk", "@firegrid/client-sdk/*"],
              message: "Hosts do not use the client. They provide it.",
            },
          ],
        },
      ],
    },
  },
  {
    // tf-r06u.24 R4 — no standalone-script shape in tiny-firegrid/src. A sim is
    // a folder exporting a host(env)+driver run BY the runner (→ trace → prose
    // finding), never a script that self-runs an Effect and prints a verdict.
    // `Effect.runPromise*`/`runSync*` is the standalone-script signal and has
    // zero legitimate use in src (the CLI entry uses NodeRuntime.runMain), so
    // it is banned src-wide. (`process.exit` is banned only under simulations/
    // below — bin/ spawn targets and the runner legitimately exit.)
    files: ["packages/tiny-firegrid/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='Effect'][property.name=/^run(Promise|PromiseExit|Sync|SyncExit)$/]",
          message:
            "tiny-firegrid/src must not self-run effects. Export a host(env)+driver; the runner executes the sim (simulate run) and emits the trace. A spike that needs to drive a private seam belongs in the owning package's test/ (docs/findings/tf-r06u-25-tiny-firegrid-asset-inventory.md).",
        },
      ],
    },
  },
  {
    // tf-636o: ban raw node: I/O builtins in product source — use the
    // @effect/platform services (FileSystem / Path / Command), provided by
    // NodeContext.layer at the CLI/runtime boundary. A custom rule (not
    // no-restricted-imports) so it composes with the per-package import blocks
    // rather than clobbering them under flat-config rule-merge. Bin entrypoints
    // and tests are scoped out (genuine node boundaries); the one remaining
    // boundary (the OTel-node file exporter) carries a documented escape-hatch.
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    ignores: [
      "**/bin/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/__tests__/**",
    ],
    plugins: { local },
    rules: {
      "local/no-raw-node-io": "error",
    },
  },
  {
    // tf-r06u.24 R4 (cont.) — no process.exit inside a sim. Drivers signal
    // completion by returning; the runner owns process lifecycle. (bin/ spawn
    // targets + runner/ are infra and may exit, so this is simulations-scoped.)
    files: ["packages/tiny-firegrid/src/simulations/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='Effect'][property.name=/^run(Promise|PromiseExit|Sync|SyncExit)$/]",
          message:
            "tiny-firegrid sims must not self-run effects. Export a driver; the runner executes it.",
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='exit']",
          message:
            "tiny-firegrid sims must not call process.exit. Drivers return; the runner owns process lifecycle.",
        },
        {
          selector:
            "Property[key.name='claimStatus'], Property[key.value='claimStatus']",
          message:
            "Simulations emit traces; claimStatus verdicts belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "Property[key.name='findings'][value.type='ArrayExpression'], Property[key.value='findings'][value.type='ArrayExpression']",
          message:
            "Simulations emit traces; findings arrays belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "TSAsExpression[typeAnnotation.typeName.name='FiregridHost'], TSAsExpression[typeAnnotation.typeArguments.params.0.typeName.name='FiregridHost']",
          message:
            "Simulation hosts must provide the real FiregridHost factory Layer; do not cast no-op Layers to FiregridHost.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message:
            "Simulation hosts must not use as unknown as to forge FiregridHost evidence.",
        },
        {
          selector:
            "ImportSpecifier[imported.name='makeRecorderAdapter'], ImportSpecifier[imported.name='RuntimeContextSessionAdapter']",
          message:
            "Simulations must exercise production code; do not import recorder adapters or stub RuntimeContextSessionAdapter Lives.",
        },
        {
          selector:
            "ImportDeclaration[source.value=/fake-codec|fake-sandbox|acp-sandbox-fake|production-flow-scenario|production-flow-acp-scenario/]",
          message:
            "Simulations must not import fake codec/sandbox paths or narrowed fake production-flow variants.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Layer'][callee.property.name='succeed'] > Identifier[name='RuntimeContextSessionAdapter']",
          message:
            "Simulations must not provide stubbed RuntimeContextSessionAdapter Lives.",
        },
      ],
    },
  },
  {
    files: ["packages/tiny-firegrid/test/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Property[key.name='claimStatus'], Property[key.value='claimStatus']",
          message:
            "Simulations emit traces; claimStatus verdicts belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "Property[key.name='findings'][value.type='ArrayExpression'], Property[key.value='findings'][value.type='ArrayExpression']",
          message:
            "Simulations emit traces; findings arrays belong in prose findings, not code artifacts.",
        },
      ],
    },
  },
  {
    files: ["packages/tiny-firegrid/src/simulations/*/driver.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration:not([source.value=/^(effect($|\\/)|@firegrid\\/client-sdk($|\\/))/])",
          message:
            "Simulation drivers may import only @firegrid/client-sdk and effect.",
        },
        {
          selector:
            "MemberExpression[object.name='Effect'][property.name=/^run(Promise|PromiseExit|Sync|SyncExit)$/]",
          message:
            "tiny-firegrid sims must not self-run effects. Export a driver; the runner executes it.",
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='exit']",
          message:
            "tiny-firegrid sims must not call process.exit. Drivers return; the runner owns process lifecycle.",
        },
        {
          selector:
            "Property[key.name='claimStatus'], Property[key.value='claimStatus']",
          message:
            "Simulations emit traces; claimStatus verdicts belong in prose findings, not code artifacts.",
        },
        {
          selector:
            "Property[key.name='findings'][value.type='ArrayExpression'], Property[key.value='findings'][value.type='ArrayExpression']",
          message:
            "Simulations emit traces; findings arrays belong in prose findings, not code artifacts.",
        },
      ],
    },
  },
  {
    files: ["packages/substrate/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/client-sdk",
              "Substrate must not depend on the client package.",
            ),
            restrictedInternalPackage(
              "@firegrid/runtime",
              "Substrate must not depend on the runtime package.",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Substrate must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Substrate owns its durable schemas; do not introduce a shared types package.",
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "apps/*",
                "apps/*/*",
                "../apps/*",
                "../apps/*/*",
                "../../apps/*",
                "../../apps/*/*",
                "../../../apps/*",
                "../../../apps/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/client-sdk/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/runtime",
              "client-sdk must not depend on the runtime package; runtime → client-sdk is an architecture defect and the reverse direction must not exist either.",
            ),
            restrictedInternalPackage(
              "@firegrid/host-sdk",
              "client-sdk is a browser/edge-safe sibling projection; it must not import host-sdk (firegrid-host-sdk.PACKAGE_GRAPH.3).",
            ),
            restrictedInternalPackage(
              "@firegrid/cli",
              "client-sdk must not import the CLI binding (firegrid-host-sdk.PACKAGE_GRAPH.3/5).",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Client must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Client should reuse substrate-owned schemas directly.",
            ),
            restrictedInternalPackage(
              "effect-durable-operators",
              productImplementationDurableTableMessage,
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "apps/*",
                "apps/*/*",
                "../apps/*",
                "../apps/*/*",
                "../../apps/*",
                "../../apps/*/*",
                "../../../apps/*",
                "../../../apps/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
            },
          ],
        },
      ],
    },
  },
  {
    // firegrid-host-sdk.PACKAGE_GRAPH.5: the CLI binds over host-sdk +
    // client-sdk + protocol; it must not reach into runtime substrate.
    files: ["packages/cli/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/runtime",
              "@firegrid/cli must bind over @firegrid/host-sdk and @firegrid/client-sdk, not import the runtime substrate directly (firegrid-host-sdk.PACKAGE_GRAPH.5).",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "The CLI must not depend on the lab app.",
            ),
          ],
          patterns: [
            {
              group: ["@firegrid/runtime", "@firegrid/runtime/*"],
              message:
                "@firegrid/cli must bind over @firegrid/host-sdk and @firegrid/client-sdk, not @firegrid/runtime substrate (firegrid-host-sdk.PACKAGE_GRAPH.5).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/lab/src/**/*.ts", "apps/lab/src/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/substrate",
              "Lab UI must compose through the client package; substrate is the durable kernel.",
            ),
            restrictedInternalPackage(
              "@firegrid/runtime",
              "Lab UI must not depend on the Firegrid runtime; the only contract is the stream URL injected by the runtime process.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Lab UI must not depend on a shared types package.",
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "packages/*",
                "packages/*/*",
                "../../packages/*",
                "../../packages/*/*",
                "../../../packages/*",
                "../../../packages/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: apps must depend on packages through public workspace package entrypoints.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: [
      "packages/runtime/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
    ],
    rules: {
      "local/no-host-authority-registry": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/client-sdk",
              "Runtime → client is an architecture defect; the runtime must not import the app-facing client package.",
            ),
            restrictedInternalPackage(
              "@firegrid/host-sdk",
              "firegrid-host-sdk.PACKAGE_GRAPH.2: runtime must not import host-sdk. Runtime owns the narrow RuntimeToolUseExecutor capability tag; host-sdk provides the live layer (firegrid-host-sdk.TOOL_EXECUTOR_SEAM).",
            ),
            restrictedInternalPackage(
              "@firegrid/cli",
              "firegrid-host-sdk.PACKAGE_GRAPH.5: no package may import the CLI binding.",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Runtime must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Runtime owns its lifecycle/config types only; do not introduce a shared types package.",
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "apps/*",
                "apps/*/*",
                "../apps/*",
                "../apps/*/*",
                "../../apps/*",
                "../../apps/*/*",
                "../../../apps/*",
                "../../../apps/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
            },
          ],
        },
      ],
    },
  },
  {
    // Shape C cutover binary boundary: `packages/runtime/src/bin/**` is the
    // runtime-owned process composition tier. It sits ABOVE both runtime
    // substrate AND client-sdk, composing direct firegrid run/start/acp
    // binaries. Override the
    // runtime-wide no-restricted-imports block so the bin entries may:
    //   - reach the public `@firegrid/client-sdk/firegrid` facade for
    //     sessions.createOrLoad (the same dispatch path public clients use);
    //   - reach the local-dev `@durable-streams/server` fallback for
    //     `firegrid run` when DURABLE_STREAMS_BASE_URL is absent (tf-yxdd
    //     disposition (a)).
    // host-sdk / cli / lab / types restrictions still apply.
    files: ["packages/runtime/src/bin/**/*.ts"],
    rules: {
      // tf-0awo.21 §6: bin/ is the cleaned launchability tier — bin/acp.ts no
      // longer forges a launchable Layer with `as unknown as`. Lock the
      // double-launder cast out so it cannot return. Rollout to the rest of
      // runtime/src (channel-bindings.ts, mcp-host/toolkit.ts) + tests is tracked
      // follow-up; those pre-existing bridges are out of this phase's scope.
      "local/no-launder-cast": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/host-sdk",
              "firegrid-host-sdk.PACKAGE_GRAPH.2: runtime must not import host-sdk. Runtime owns the narrow RuntimeToolUseExecutor capability tag; host-sdk provides the live layer (firegrid-host-sdk.TOOL_EXECUTOR_SEAM).",
            ),
            restrictedInternalPackage(
              "@firegrid/cli",
              "firegrid-host-sdk.PACKAGE_GRAPH.5: no package may import the CLI binding.",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Runtime must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Runtime owns its lifecycle/config types only; do not introduce a shared types package.",
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "apps/*",
                "apps/*/*",
                "../apps/*",
                "../apps/*/*",
                "../../apps/*",
                "../../apps/*/*",
                "../../../apps/*",
                "../../../apps/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
            },
          ],
        },
      ],
    },
  },
  {
    // firegrid-host-sdk.PACKAGE_GRAPH.4 / .5: host-sdk is a sibling
    // projection over @firegrid/protocol and may compose @firegrid/runtime,
    // but must not import the client-sdk session plane or the CLI binding.
    files: ["packages/host-sdk/src/**/*.ts"],
    ignores: [
      "packages/host-sdk/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/client-sdk",
              "firegrid-host-sdk.PACKAGE_GRAPH.4: host-sdk must not import the client-sdk session plane; they are sibling projections over @firegrid/protocol.",
            ),
            restrictedInternalPackage(
              "@firegrid/cli",
              "firegrid-host-sdk.PACKAGE_GRAPH.5: no package may import the CLI binding.",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Host-sdk must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Host-sdk reuses protocol/runtime schemas; do not introduce a shared types package.",
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "apps/*",
                "apps/*/*",
                "../apps/*",
                "../apps/*/*",
                "../../apps/*",
                "../../apps/*/*",
                "../../../apps/*",
                "../../../apps/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/runtime/src/runtime-host/**/*.ts",
      "packages/runtime/src/providers/**/*.ts",
      "packages/runtime/src/runtime-ingress/**/*.ts",
    ],
    ignores: [
      "packages/**/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='effect-durable-operators'][importKind!='type']",
          message:
            "Runtime host code may import only the DurableTableHeaders type from effect-durable-operators.",
        },
        {
          selector:
            "ImportDeclaration[source.value='effect-durable-operators'] ImportSpecifier[imported.name!='DurableTableHeaders']",
          message:
            "Runtime host code may import only the DurableTableHeaders type from effect-durable-operators.",
        },
      ],
    },
  },
  {
    // firegrid-event-streams.SCHEMA_OWNERSHIP.2
    // The EventStream materializer must not write substrate authority
    // rows. Operation handlers terminalize runs via state-machine
    // builders, so this restriction is scoped to the materializer
    // file rather than the whole runtime package.
    //
    // Two layers of enforcement:
    //   • `no-restricted-imports` bans named imports of every state-
    //     machine builder (and `DurableWaits`) from
    //     `@firegrid/substrate`.
    //   • `no-restricted-syntax` bans default and namespace imports
    //     from the substrate root for this file. A namespace import
    //     would otherwise let the file reach the same banned builders
    //     via member access (e.g. `Substrate.completeRun`); blocking
    //     the import shape itself closes that hole.
    files: [
      "packages/runtime/src/internal/event-stream-materializer.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/client-sdk",
              "Runtime → client is an architecture defect.",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Runtime must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Runtime owns its lifecycle/config types only.",
            ),
            {
              name: "@firegrid/substrate",
              importNames: [
                "completeRun",
                "failRun",
                "cancelRun",
                "cancelCompletion",
                "resolveCompletion",
                "blockRun",
                "startRun",
                "createPendingCompletion",
                "DurableWaits",
              ],
              message:
                "EventStream materializer must not write substrate authority rows; durable downstream writes belong in the materializer Effect's body via runtime-allowed surfaces, not in the materializer module itself.",
            },
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
            {
              group: [
                "apps/*",
                "apps/*/*",
                "../apps/*",
                "../apps/*/*",
                "../../apps/*",
                "../../apps/*/*",
                "../../../apps/*",
                "../../../apps/*/*",
              ],
              message:
                "firegrid-architecture-boundary.DEPENDENCY_GRAPH.6: reusable packages must not import workspace apps.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...effectDebtGuardrails,
        {
          selector:
            "ImportDeclaration[source.value='@firegrid/substrate'] > ImportNamespaceSpecifier",
          message:
            "EventStream materializer must not use namespace imports from @firegrid/substrate; namespace imports defeat the named-import authority guard. Import the specific names you need.",
        },
        {
          selector:
            "ImportDeclaration[source.value='@firegrid/substrate'] > ImportDefaultSpecifier",
          message:
            "EventStream materializer must not use a default import from @firegrid/substrate.",
        },
      ],
    },
  },
  {
    files: [
      "packages/protocol/src/**/*.ts",
      "apps/flamecast/src/**/*.ts",
      "apps/flamecast/src/**/*.tsx",
    ],
    ignores: [
      "packages/**/src/__tests__/**/*.ts",
      "apps/**/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...upstreamDurableStreamsImportPatterns,
            ...historicalFiregridDurableStreamsImportPatterns,
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/**/src/__tests__/**/*.ts",
      "apps/**/src/__tests__/**/*.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-syntax": [
        "warn",
        ...effectDebtGuardrails,
      ],
    },
  },
  {
    // process.env belongs at the binary entry boundary: bin/ entry points
    // (spawn targets, CLI mains) read boundary configuration from env. Mirrors
    // the semgrep `firegrid-no-process-env-outside-bin` path exclusion of
    // `packages/*/src/bin/**` and the rule's own stated intent.
    files: ["packages/*/src/bin/**/*.ts"],
    rules: {
      "local/no-process-env-outside-bin": "off",
      "local/no-date-now": "off",
      "local/no-new-date-iso": "off",
    },
  },

  // ===========================================================================
  // Ported Semgrep rules (Semgrep retirement, consolidation phase 2). Each block
  // mirrors one `.semgrep.yml` rule's `paths` (via files/ignores) and `pattern`/
  // `pattern-regex` (via the shared source-regex scanner, using Semgrep's exact
  // regexes). Rules that had live findings (workflow-make + advisory WARNINGs)
  // moved to the effect-quality ts-morph count ratchet instead; see
  // scripts/effect-artifacts/quality-metrics.mjs.
  // ===========================================================================

  // host-sdk runtime/substrate import bans (firegrid-host-sdk-no-*).
  {
    files: ["packages/host-sdk/src/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-host-sdk-imports": [
        "error",
        [
          { pattern: 'from\\s+"@firegrid/runtime/kernel"', message: "host-sdk must not import @firegrid/runtime/kernel (runtime-internal mixed barrel). Use a narrow semantic subpath." },
          { pattern: 'from\\s+"@firegrid/runtime/_archive', message: "host-sdk must not import @firegrid/runtime/_archive/* (time-boxed holding pen pending deletion)." },
          { pattern: 'from\\s+"@firegrid/runtime/workflow-engine[/"]', message: "host-sdk must not import @firegrid/runtime/workflow-engine (Wave D legacy bridge root). Use a Shape D subscriber subpath." },
          { pattern: 'from\\s+"@firegrid/runtime/streams[/"]', message: "host-sdk must not import @firegrid/runtime/streams (Wave D-D legacy bridge root). Use route-based observation." },
          { pattern: 'from\\s+"@effect/workflow', message: "host-sdk must not import @effect/workflow; workflow machinery is owned by runtime Shape D layers." },
          { pattern: 'from\\s+"@firegrid/runtime"', message: "host-sdk must not import the @firegrid/runtime root barrel; use narrow semantic subpaths." },
        ],
      ],
    },
  },

  // Numbered runtime subpaths are not part of the target tree (firegrid-no-numbered-runtime-subpath).
  {
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-no-numbered-runtime-subpath": [
        "error",
        [{ pattern: 'from\\s+"@firegrid/runtime/[1-7]-', message: "Numbered runtime subpaths are not part of the target tree; use semantic subpaths (@firegrid/runtime/tables/..., /subscribers/..., etc.)." }],
      ],
    },
  },

  // runtime package must not touch the local filesystem (firegrid-no-filesystem-in-runtime-package).
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: [...portedSemgrepTestIgnores, "packages/runtime/src/bin/**"],
    rules: {
      "local/sg-no-filesystem-in-runtime-package": [
        "error",
        [
          { pattern: 'from\\s+["\'](?:node:fs|node:fs/promises|fs|fs/promises)["\']', message: "packages/runtime source must not use the local filesystem (node:fs)." },
          { pattern: 'from\\s+["\'](?:node:os|node:path|path)["\']', message: "packages/runtime source must not import node:os/node:path." },
          { pattern: 'import\\s*\\{[^}]*\\bFileSystem\\b[^}]*\\}\\s*from\\s+["\']@effect/platform["\']', message: "packages/runtime source must not import FileSystem from @effect/platform." },
          { pattern: 'import\\s*\\{[^}]*\\b(?:FileSystem|NodeFileSystem)\\b[^}]*\\}\\s*from\\s+["\']@effect/platform-node["\']', message: "packages/runtime source must not import FileSystem/NodeFileSystem from @effect/platform-node." },
          { pattern: 'require\\(["\'](?:node:fs|node:fs/promises|fs|fs/promises)["\']\\)', message: "packages/runtime source must not require the filesystem." },
          { pattern: '\\bFileSystem\\.FileSystem\\b', message: "packages/runtime source must not use FileSystem.FileSystem." },
          { pattern: '\\bNodeFileSystem\\.layer\\b', message: "packages/runtime source must not use NodeFileSystem.layer." },
        ],
      ],
    },
  },

  // Library-wide identity/authority bans (firegrid-no-host-id-env-authority, firegrid-no-random-durable-identity).
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx", "src/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-no-host-id-env-authority": [
        "error",
        [
          { pattern: 'Config\\.string\\(\\s*["\']FIREGRID_HOST_ID["\']\\s*\\)', message: "Host identity must not be sourced from FIREGRID_HOST_ID env/Config; model host authority explicitly." },
          { pattern: '(?:globalThis\\.)?process\\.env(?:\\.FIREGRID_HOST_ID|\\[\\s*["\']FIREGRID_HOST_ID["\']\\s*\\])', message: "Host identity must not be sourced from FIREGRID_HOST_ID env; model host authority explicitly." },
          { pattern: 'import\\.meta\\.env(?:\\.VITE_FIREGRID_HOST_ID|\\[\\s*["\']VITE_FIREGRID_HOST_ID["\']\\s*\\])', message: "Host identity must not be sourced from VITE_FIREGRID_HOST_ID; model host authority explicitly." },
        ],
      ],
      "local/sg-no-random-durable-identity": [
        "error",
        [{ pattern: '((hostId|workerId|durableExecutionId)\\s*[:=]\\s*crypto\\.randomUUID\\(\\)|`(host|worker|durableExecution)[_-]\\$\\{crypto\\.randomUUID\\(\\)\\}`)', message: "Durable identity generated from crypto.randomUUID(); identity must come from stable config/storage." }],
      ],
    },
  },

  // Inline durable-stream URL/namespace construction (firegrid-no-inline-stream-url-construction).
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx"],
    ignores: [
      ...portedSemgrepTestIgnores,
      "packages/*/src/runtime-host/internal/**",
      "packages/*/src/host-context-authority/**",
      "packages/runtime/src/agent-tools/mcp-host.ts",
      "packages/*/src/**/schema.ts",
      "packages/*/src/**/table.ts",
      "packages/runtime/src/workflow-engine/internal/table.ts",
    ],
    rules: {
      "local/sg-no-inline-stream-url-construction": [
        "error",
        [
          { pattern: '\\$\\{[^}]+\\}\\.firegrid\\.host\\.\\$\\{[^}]+\\}\\.(runtime|runtimeIngress|runtimeOutput|workflow|durableTools|verifiedWebhook|agentTools)', message: "Inline durable stream URL/namespace construction; authority strings must come from schema/table encoders." },
          { pattern: '\\$\\{[^}]+\\}\\.firegrid\\.(runtime|workflow|runtimeIngress|runtimeOutput|durableTools|verifiedWebhook|agentTools)', message: "Inline durable stream URL/namespace construction; authority strings must come from schema/table encoders." },
          { pattern: '"firegrid\\.(runtime|workflow|runtimeIngress|runtimeOutput|durableTools|verifiedWebhook|agentTools)"', message: "Inline durable stream namespace literal; authority strings must come from schema/table encoders." },
        ],
      ],
    },
  },

  // Raw Schema.String stream-authority (firegrid-no-raw-stream-authority-string-schema).
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-no-raw-stream-authority-string-schema": [
        "error",
        [{ pattern: 'Schema\\.String\\.pipe\\(\\s*streamAuthority\\s*\\)', message: "Raw Schema.String annotated as stream authority accepts invalid strings; use the canonical validated transform." }],
      ],
    },
  },

  // Inline tagged-error fail / mutable identity let / non-exhaustive Match
  // (firegrid-no-inline-tagged-error-fail, firegrid-no-mutable-identity-let,
  // firegrid-match-should-be-exhaustive — advisory WARNINGs with 0 live findings,
  // promoted to blocking ESLint).
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-no-inline-tagged-error-fail": [
        "error",
        [{ pattern: 'Effect\\.fail\\(\\s*\\{[^}]*\\b_tag\\s*:\\s*["\']', message: "Inline tagged-error object passed to Effect.fail; use a Data.TaggedError or Schema.TaggedError class." }],
      ],
      "local/sg-no-mutable-identity-let": [
        "error",
        [{ pattern: '\\blet\\s+[A-Za-z0-9_]*(?:sessionId|contextId|hostId)[A-Za-z0-9_]*(?:\\s*:\\s*string)?\\s*=\\s*""', message: "let declaration for an identity field initialized to a placeholder; sequence initialization so the identity is const before first use." }],
      ],
      "local/sg-match-should-be-exhaustive": [
        "error",
        [{ pattern: 'Match\\.value\\([^)]*\\)\\.pipe\\(\\s*(?:[^()]|\\([^)]*\\)|\\n)*Match\\.tag\\([^)]*\\),\\s*\\)', message: "Match expression does not end with Match.exhaustive or Match.orElse." }],
      ],
    },
  },

  // RuntimeContext workflow execution requires local authority (firegrid-runtime-context-workflow-requires-local-authority).
  {
    files: ["packages/runtime/src/**/*.ts", "apps/*/src/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-runtime-context-workflow-requires-local-authority": [
        "error",
        [{ pattern: '\\.execute\\(\\s*RuntimeContextWorkflow\\b', message: "Direct RuntimeContextWorkflow execution bypasses local context authority; resolve through requireLocalContext." }],
      ],
    },
  },

  // No live table scans on the workflow replay path (firegrid-no-replay-path-output-scan).
  {
    files: ["packages/runtime/src/workflow-engine/workflows/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-no-replay-path-output-scan": [
        "error",
        [
          { pattern: 'yield\\*\\s+RuntimeAgentOutputAfterEvents\\b', message: "Live output-after read on the workflow replay path; use the durable output cursor or a memoized Activity (tf-7kq8)." },
          { pattern: '\\.toArray\\b', message: "Full collection materialization on the workflow replay path; use the durable output cursor or a memoized Activity (tf-7kq8)." },
          { pattern: '\\.query\\s*\\(', message: "DurableTable query on the workflow replay path; use the durable output cursor or a memoized Activity (tf-7kq8)." },
        ],
      ],
    },
  },

  // Runtime authority surface bans, runtime/src-wide with no extra excludes
  // (firegrid-runtime-no-exported-authority-singletons / -custom-authority-wrapper-types /
  // -authority-static-helper-calls / -singleton-authority-specifiers / -authority-registry-surface /
  // -old-singleton-authority-tag-keys / -exported-authority-registry-api).
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-runtime-no-exported-authority-singletons": [
        "error",
        [{ pattern: '\\bexport\\s+(?:class\\s+(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore|Runtime[A-Za-z0-9_]*Authority)\\b|const\\s+(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore)\\s*=)', message: "Runtime authority module-singleton class/object exported; expose split Context.Tag capabilities and provider Layers." }],
      ],
      "local/sg-runtime-no-custom-authority-wrapper-types": [
        "error",
        [{ pattern: '\\bRuntimeAuthority(?:Command|Read|Sink)?\\b', message: "Custom RuntimeAuthority wrapper type; use stock Effect capability surfaces directly." }],
      ],
      "local/sg-runtime-no-authority-static-helper-calls": [
        "error",
        [{ pattern: '\\b(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore)\\.(?:sources|[A-Za-z0-9_]*(?:To|In|FromTable))\\s*\\(', message: "Static runtime authority helper call; use the split Effect capability tag or a SourceCollectionHandle derived from a Stream capability." }],
      ],
      "local/sg-runtime-no-singleton-authority-specifiers": [
        "error",
        [{ pattern: '\\b(?:import|export)(?:\\s+type)?\\s*(?:\\{[^}]*\\b(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore)\\b[^}]*\\}|(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore)\\b|\\*\\s+as\\s+(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore)\\b)', message: "Old singleton runtime authority name in an import/export surface; use split Effect capability tags." }],
      ],
      "local/sg-runtime-no-authority-registry-surface": [
        "error",
        [{ pattern: '(?:packages/runtime/src/authorities/registry\\.ts|["\'][^"\']*registry(?:\\.ts)?["\']|\\b[A-Za-z0-9_]*Authority[A-Za-z0-9_]*Registry[A-Za-z0-9_]*\\b)', message: "AuthorityRegistry production surface; keep registry metadata review/test-only." }],
      ],
      "local/sg-runtime-no-old-singleton-authority-tag-keys": [
        "error",
        [{ pattern: 'Context\\.Tag\\s*\\(\\s*["\']@firegrid/runtime/(?:RuntimeOutputJournal|RuntimeIngressAppender|RuntimeIngressDeliveryTracker|RuntimeControlPlaneRecorder|DurableWaitStore)["\']\\s*\\)', message: "Old singleton runtime authority Context.Tag key; use split capability tags." }],
      ],
      "local/sg-runtime-no-exported-authority-registry-api": [
        "error",
        [{ pattern: '\\b(?:export\\s+(?:const|interface|type)\\s+RuntimeAuthorityRegistry\\w*|RuntimeAuthorityRegistry(?:ByCapabilityTag|ByCollection|Entry)?\\b)', message: "RuntimeAuthorityRegistry production API exported; keep review-only registry metadata out of production exports." }],
      ],
    },
  },

  // Runtime-owned table writes must use authorities (firegrid-runtime-owned-table-writes-use-authorities).
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: [
      ...portedSemgrepTestIgnores,
      "packages/runtime/src/authorities/**",
      "packages/runtime/src/producers/**",
      "packages/runtime/src/tables/**",
      "packages/runtime/src/channels/**",
      "packages/runtime/src/control-plane/**",
      "packages/runtime/src/durable-tools/internal/durable-wait-store.ts",
    ],
    rules: {
      "local/sg-runtime-owned-table-writes-use-authorities": [
        "error",
        [{ pattern: '\\.(contexts|runs|events|logs|inputs|deliveries|waits|completions)\\.(insert|insertOrGet|upsert|delete)\\s*\\(', message: "Runtime-owned DurableTable writes must go through the owning runtime authority module." }],
      ],
    },
  },

  // No second durable-capability provider (firegrid-runtime-no-second-durable-capability-provider).
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: [
      ...portedSemgrepTestIgnores,
      "packages/runtime/src/authorities/**",
      "packages/runtime/src/producers/**",
      "packages/runtime/src/tables/**",
      "packages/runtime/src/channels/**",
      "packages/runtime/src/control-plane/**",
    ],
    rules: {
      "local/sg-runtime-no-second-durable-capability-provider": [
        "error",
        [{ pattern: 'Layer\\.(?:succeed|effect)\\s*\\(\\s*(?:RuntimeEventAppendAndGet|RuntimeAgentOutputSink|RuntimeOutputEvents|RuntimeAgentOutputEvents|RuntimeLogLineAppendAndGet|RuntimeLogLineSink|RuntimeOutputLogs|RuntimeIngressAppendAndGet|RuntimeIngressInputStream|RuntimeIngressDeliveryClaimAndComplete|RuntimeContextInsert|RuntimeContextRead|RuntimeRunAppendAndGet)\\b', message: "Durable capability tag provided outside its authority module; use the owning provider layer." }],
      ],
    },
  },

  // No runtime table-service yield outside providers (firegrid-runtime-no-table-service-yield-outside-providers).
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: [
      ...portedSemgrepTestIgnores,
      "packages/runtime/src/authorities/**",
      "packages/runtime/src/producers/**",
      "packages/runtime/src/tables/**",
      "packages/runtime/src/channels/**",
      "packages/runtime/src/control-plane/**",
      "packages/runtime/src/kernel/**",
      "packages/runtime/src/host/index.ts",
      "packages/runtime/src/host/observation-sources.ts",
      "packages/runtime/src/agent-tools/mcp-host.ts",
      "packages/runtime/src/durable-tools/DurableToolsWaitFor.ts",
      "packages/runtime/src/durable-tools/internal/table.ts",
    ],
    rules: {
      "local/sg-runtime-no-table-service-yield-outside-providers": [
        "error",
        [{ pattern: 'yield\\*\\s+(?:RuntimeOutputTable|RuntimeIngressTable|RuntimeControlPlaneTable|DurableToolsTable)\\b', message: "Runtime-owned DurableTable service yielded outside provider internals or host composition." }],
      ],
    },
  },

  // No runtime table type-parameters outside authorities (firegrid-runtime-no-table-type-parameters-outside-authorities).
  {
    files: ["packages/runtime/src/**/*.ts"],
    ignores: [
      ...portedSemgrepTestIgnores,
      "packages/runtime/src/authorities/**",
      "packages/runtime/src/producers/**",
      "packages/runtime/src/tables/**",
      "packages/runtime/src/channels/**",
      "packages/runtime/src/control-plane/**",
      "packages/runtime/src/durable-tools/internal/durable-wait-store.ts",
      "packages/runtime/src/durable-tools/internal/table.ts",
    ],
    rules: {
      "local/sg-runtime-no-table-type-parameters-outside-authorities": [
        "error",
        [{ pattern: '(?:Runtime(?:ControlPlane|Output|Ingress)Table|DurableToolsTable)\\[["\']Type["\']\\]', message: "Runtime production component accepts a runtime-owned DurableTable service; use Effect capability tags." }],
      ],
    },
  },

  // Subscribers/transforms must not own table facades or SourceCollectionHandle
  // (firegrid-runtime-subscribers-transforms-no-table-facades, firegrid-runtime-no-source-collection-handle-in-static-subscriber-contract).
  {
    files: ["packages/runtime/src/subscribers/**/*.ts", "packages/runtime/src/transforms/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-runtime-subscribers-transforms-no-table-facades": [
        "error",
        [{ pattern: 'Runtime(?:ControlPlane|Output|Ingress)Table\\[["\']Type["\']\\]', message: "Subscribers and transforms must not accept runtime-owned DurableTable facades; use read/observation handles plus authority APIs." }],
      ],
      "local/sg-runtime-no-source-collection-handle-in-static-subscriber-contract": [
        "error",
        [{ pattern: '\\bSourceCollectionHandle\\b', message: "SourceCollectionHandle in static subscriber/transform contract; use a Stream capability tag." }],
      ],
    },
  },

  // No direct source-collection registration (firegrid-runtime-host-no-direct-source-collection-registration).
  {
    files: ["packages/**/src/**/*.ts", "apps/**/src/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-runtime-host-no-direct-source-collection-registration": [
        "error",
        [
          { pattern: 'import\\s*\\{[^}]*\\b(?:SourceCollections|sourceCollectionStreamHandle)\\b[^}]*\\}\\s*from', message: "Production code must not import SourceCollections / sourceCollectionStreamHandle (rejected wait-source registry)." },
          { pattern: 'yield\\*\\s+SourceCollections\\b', message: "Production code must not yield SourceCollections (rejected wait-source registry)." },
          { pattern: 'sourceCollectionStreamHandle\\s*\\(', message: "Production code must not call sourceCollectionStreamHandle (rejected wait-source registry)." },
          { pattern: '\\bregisterRuntimeHostAppSource\\b', message: "Production code must not use registerRuntimeHostAppSource (rejected wait-source registry)." },
        ],
      ],
    },
  },

  // Runtime host internals not imported outside host/ (firegrid-runtime-no-host-internal-imports-outside-host).
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    ignores: [...portedSemgrepTestIgnores, "packages/runtime/src/host/**"],
    rules: {
      "local/sg-runtime-no-host-internal-imports-outside-host": [
        "error",
        [{ pattern: '^\\s*(?:import|export)(?:\\s+type)?[^\\n]*\\sfrom\\s*["\'][^"\']*(?:^|/|\\.{1,2}/)host/(?:agent-tool-host-live|commands|config|config-live|host-owned-durable-tools|internal/[^"\']*|layers|raw-process-runtime|runtime-context-workflow|runtime-substrate|sync-run|types)(?:\\.ts)?["\']', flags: "m", message: "Direct import from a runtime host implementation file; use the host barrel (host/index.ts) or the public runtime-host subpath." }],
      ],
    },
  },

  // runtime-errors.ts is runtime-internal (firegrid-runtime-no-runtime-errors-imports-outside-runtime).
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    ignores: [...portedSemgrepTestIgnores, "packages/runtime/src/**"],
    rules: {
      "local/sg-runtime-no-runtime-errors-imports-outside-runtime": [
        "error",
        [{ pattern: '^\\s*(?:import|export)(?:\\s+type)?[^\\n]*\\sfrom\\s*["\'](?:[^"\']*/runtime-errors(?:\\.ts)?|packages/runtime/src/runtime-errors(?:\\.ts)?|@firegrid/runtime/[^"\']*runtime-errors(?:\\.ts)?)["\']', flags: "m", message: "runtime-errors.ts is runtime-internal; external packages must use public @firegrid/runtime exports." }],
      ],
    },
  },

  // tf-zchu / Shape-C runtime design constraint guards (C4/C6/C7 + shape-c subscriber).
  {
    files: [
      "packages/runtime/src/workflow-engine/workflows/**/*.ts",
      "packages/runtime/src/sources/**/*.ts",
      "packages/runtime/src/producers/**/*.ts",
      "packages/runtime/src/subscribers/**/*.ts",
      "packages/runtime/src/tables/**/*.ts",
      "packages/runtime/src/transforms/**/*.ts",
      "packages/runtime/src/events/**/*.ts",
      "packages/runtime/src/capabilities/**/*.ts",
      "packages/runtime/src/control-plane/**/*.ts",
      "packages/runtime/src/channels/**/*.ts",
    ],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-c4-no-new-durable-deferred-runtime-wait": [
        "error",
        [{ pattern: '\\bDurableDeferred\\.[A-Za-z]+\\s*\\(', message: "New DurableDeferred use on a RuntimeContext input/tool/permission/child-session path (C4). Async waits are durable completions keyed by domain identity." }],
      ],
    },
  },
  {
    files: ["packages/protocol/src/agent-tools/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools": [
        "error",
        [
          { pattern: '\\bChildOutput[A-Za-z0-9_]*\\b', message: "Agent-tool protocol must not invent a ChildOutput* observation stack (C6); reuse the router-backed SessionAgentOutputChannel schema." },
          { pattern: '\\bsession_read\\b', message: "Agent-tool protocol must not add a session_read protocol (C6); reuse the router-backed SessionAgentOutputChannel schema." },
          { pattern: '\\bsessionRead[A-Za-z0-9_]*\\b', message: "Agent-tool protocol must not add a sessionRead* protocol (C6); reuse the router-backed SessionAgentOutputChannel schema." },
          { pattern: '\\b(cursor|eventTag|event_tag)\\s*:\\s*Schema\\.', message: "Agent-tool protocol must not add source-specific cursor/event-tag schema fields (C6); cursors are source coordinates owned by the source." },
        ],
      ],
    },
  },
  {
    files: ["packages/host-sdk/src/host/acp-stdio-edge.ts", "packages/host-sdk/src/host/*edge*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-c7-no-edge-local-terminal-synthesis": [
        "error",
        [{ pattern: '_tag:\\s*["\']Done["\']', message: "Edge-local terminal completion synthesis (C7); bind terminal completion to durable runtime result state, do not construct a terminal Done at the edge." }],
      ],
    },
  },
  {
    files: ["packages/runtime/src/subscribers/runtime-context/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-shape-c-no-workflow-engine-in-runtime-context-subscriber": [
        "error",
        [
          { pattern: '\\bActivity\\.make\\s*\\(', message: "Shape C RuntimeContext subscriber names workflow execution machinery (Activity.make); move to a Shape D landing." },
          { pattern: '\\bWorkflow\\.suspend\\s*\\(', message: "Shape C RuntimeContext subscriber names workflow execution machinery (Workflow.suspend); move to a Shape D landing." },
          { pattern: '\\bWorkflow\\.execute\\s*\\(', message: "Shape C RuntimeContext subscriber names workflow execution machinery (Workflow.execute); move to a Shape D landing." },
          { pattern: '\\bWorkflowEngine\\.WorkflowEngine\\b', message: "Shape C RuntimeContext subscriber R must not name WorkflowEngine.WorkflowEngine; move to a Shape D landing." },
          { pattern: '\\bWorkflowEngine\\.WorkflowInstance\\b', message: "Shape C RuntimeContext subscriber R must not name WorkflowEngine.WorkflowInstance; move to a Shape D landing." },
        ],
      ],
    },
  },
  {
    files: ["packages/runtime/src/subscribers/runtime-context/**/*.ts", "packages/runtime/src/subscribers/runtime-context-session/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-shape-c-runtime-context-no-workflow-machinery": [
        "error",
        [
          { pattern: 'from\\s+"@effect/workflow', message: "Shape C runtime-context subscribers must not import @effect/workflow; Shape D folders own that machinery." },
          { pattern: '\\bWorkflowEngine\\.WorkflowEngine\\b', message: "Shape C runtime-context subscribers must not name WorkflowEngine.WorkflowEngine." },
          { pattern: '\\bWorkflowEngine\\.WorkflowInstance\\b', message: "Shape C runtime-context subscribers must not name WorkflowEngine.WorkflowInstance." },
          { pattern: '\\bActivity\\.make\\s*\\(', message: "Shape C runtime-context subscribers must not call Activity.make." },
          { pattern: '\\bWorkflow\\.suspend\\s*\\(', message: "Shape C runtime-context subscribers must not call Workflow.suspend." },
          { pattern: '\\bWorkflow\\.execute\\s*\\(', message: "Shape C runtime-context subscribers must not call Workflow.execute." },
          { pattern: '\\bDurableDeferred\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(', message: "Shape C runtime-context subscribers must not use DurableDeferred.*; Shape D folders own that machinery." },
          { pattern: '\\bDurableClock\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(', message: "Shape C runtime-context subscribers must not use DurableClock.*; Shape D folders own that machinery." },
        ],
      ],
    },
  },

  // transforms/ purity (symbol-level) — firegrid-transforms-purity-import-boundary.
  {
    files: ["packages/runtime/src/transforms/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-transforms-purity-import-boundary": [
        "error",
        [
          { pattern: 'import\\s+(?:type\\s+)?\\{[^}]*\\bEffect\\b[^}]*\\}\\s*from\\s*"effect"', flags: "s", message: "transforms/ is pure: do not import the effectful runtime tag Effect from \"effect\"." },
          { pattern: 'import\\s+(?:type\\s+)?\\{[^}]*\\bLayer\\b[^}]*\\}\\s*from\\s*"effect"', flags: "s", message: "transforms/ is pure: do not import Layer from \"effect\"." },
          { pattern: 'import\\s+(?:type\\s+)?\\{[^}]*\\bContext\\b[^}]*\\}\\s*from\\s*"effect"', flags: "s", message: "transforms/ is pure: do not import Context from \"effect\"." },
          { pattern: 'import\\s+(?:type\\s+)?\\{[^}]*\\bStream\\b[^}]*\\}\\s*from\\s*"effect"', flags: "s", message: "transforms/ is pure: do not import Stream from \"effect\"." },
          { pattern: 'import\\s+(?:type\\s+)?\\{[^}]*\\bScope\\b[^}]*\\}\\s*from\\s*"effect"', flags: "s", message: "transforms/ is pure: do not import Scope from \"effect\"." },
          { pattern: 'from\\s+"@effect/workflow', message: "transforms/ is pure: do not import @effect/workflow." },
          { pattern: '\\bActivity\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(', message: "transforms/ is pure: do not name Activity.* I/O capability calls." },
          { pattern: '\\bWorkflow\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(', message: "transforms/ is pure: do not name Workflow.* I/O capability calls." },
          { pattern: '\\bDurableDeferred\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(', message: "transforms/ is pure: do not name DurableDeferred.* I/O capability calls." },
          { pattern: '\\bDurableClock\\.[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(', message: "transforms/ is pure: do not name DurableClock.* I/O capability calls." },
          { pattern: ':\\s*Effect\\.Effect\\s*<', message: "transforms/ is pure: exports must not return Effect.Effect<...>." },
        ],
      ],
    },
  },

  // composition/ must not import legacy body-driver symbols (firegrid-composition-no-legacy-imports).
  {
    files: ["packages/runtime/src/composition/**/*.ts"],
    ignores: portedSemgrepTestIgnores,
    rules: {
      "local/sg-composition-no-legacy-imports": [
        "error",
        [
          { pattern: '\\bRuntimeContextWorkflowNative(?:Layer)?\\b', message: "composition/ must not import the legacy body driver RuntimeContextWorkflowNative(Layer)." },
          { pattern: '\\bexecuteRuntimeContextWorkflow\\b', message: "composition/ must not import executeRuntimeContextWorkflow (legacy body driver)." },
          { pattern: '\\bRuntimeContextWorkflowRuntime\\b', message: "composition/ must not import RuntimeContextWorkflowRuntime (legacy body driver)." },
          { pattern: 'from\\s+"[^"]*runtime-input-deferred', message: "composition/ must not import the legacy per-sequence input mailbox (runtime-input-deferred)." },
          { pattern: 'from\\s+"@firegrid/runtime/kernel', message: "composition/ must not import the runtime kernel barrel." },
          { pattern: 'from\\s+"@firegrid/runtime/_archive', message: "composition/ must not import _archive/." },
        ],
      ],
    },
  },

  // factory app exported contracts must be Schema-backed (firegrid-factory-exported-contracts-use-schema).
  {
    files: ["apps/factory/src/**/*.ts", "apps/factory/src/**/*.tsx"],
    ignores: [...portedSemgrepTestIgnores, "apps/factory/src/bin/**"],
    rules: {
      "local/sg-factory-exported-contracts-use-schema": [
        "error",
        [{ pattern: '\\bexport\\s+(interface\\s+[A-Za-z_$][A-Za-z0-9_$]*|type\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*=\\s*\\{)', message: "Exported factory app contracts must be Effect Schema-backed (Schema.Struct + Schema.Schema.Type), not raw interfaces/object-literal type aliases." }],
      ],
    },
  },
)

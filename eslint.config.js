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
        return {
          MemberExpression(node) {
            if (
              node.object?.type === "Identifier" &&
              node.object.name === "process" &&
              node.property?.type === "Identifier" &&
              node.property.name === "env" &&
              !hasNearbyAllowComment(context, node, [processEnvAllowComment])
            ) {
              context.report({ node, messageId: "noProcessEnv" })
            }
          },
        }
      },
    },
  },
}

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
          ],
        },
      ],
    },
  },
  {
    files: ["packages/tiny-firegrid/src/simulations/*/host.ts"],
    rules: {
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
    // runtime-owned process composition tier (formerly @firegrid/cli's
    // responsibility). It sits ABOVE both runtime substrate AND client-sdk,
    // composing both into the firegrid run/start/acp binaries. The thin
    // @firegrid/cli launcher subprocesses into it. Override the
    // runtime-wide no-restricted-imports block so the bin entries may:
    //   - reach the public `@firegrid/client-sdk/firegrid` facade for
    //     sessions.createOrLoad (the same dispatch path public clients use);
    //   - reach the local-dev `@durable-streams/server` fallback for
    //     `firegrid run` when DURABLE_STREAMS_BASE_URL is absent (tf-yxdd
    //     disposition (a)).
    // host-sdk / cli / lab / types restrictions still apply.
    files: ["packages/runtime/src/bin/**/*.ts"],
    rules: {
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
    },
  },
)

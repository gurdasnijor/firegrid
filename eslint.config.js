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
const legacyDurableAgentSubstrateImportPatterns = [
  {
    group: [
      "@durable-agent-substrate/*",
      "@durable-agent-substrate/*/*",
    ],
    message:
      "firegrid-package-migration.COMPATIBILITY.1: active imports use Firegrid package names only.",
  },
]
const tsOnly = (configs) =>
  configs.map((config) => ({
    ...config,
    files: [
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "test-support/**/*.ts",
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
  },
}

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "**/dist/**",
      ".worktrees/**",
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
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "test-support/**/*.ts",
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
            "@firegrid/client",
            "@firegrid/substrate",
            "@firegrid/runtime",
          ],
        },
      ],
    },
  },
  {
    files: ["packages/{client,runtime}/src/**/*.ts"],
    ignores: ["packages/**/src/__tests__/**/*.ts", "packages/**/*.test.ts"],
    rules: {
      "local/no-hidden-control-plane": "error",
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
              "@firegrid/client",
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
    files: ["packages/client/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/runtime",
              "Client must not depend on the runtime package; runtime → client is an architecture defect and the reverse direction must not exist either.",
            ),
            restrictedInternalPackage(
              "@firegrid/lab",
              "Client must not depend on the lab app.",
            ),
            restrictedInternalPackage(
              "@firegrid/types",
              "Client should reuse substrate-owned schemas directly.",
            ),
          ],
          patterns: [
            ...legacyDurableAgentSubstrateImportPatterns,
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
              "@firegrid/client",
              "Runtime → client is an architecture defect; the runtime must not import the app-facing client package.",
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
      "packages/runtime/src/runtime/internal/event-stream-materializer.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@firegrid/client",
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
)

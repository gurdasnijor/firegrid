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
const tsOnly = (configs) =>
  configs.map((config) => ({
    ...config,
    files: ["packages/**/*.ts", "test-support/**/*.ts"],
  }))
const relativeJsSpecifierPattern = /^\.{1,2}\/.*\.js$/u
const rewriteJsSpecifierToTs = (specifier) => specifier.replace(/\.js$/u, ".ts")

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
  ...tsOnly(tseslint.configs.recommendedTypeChecked),
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["packages/**/*.ts", "test-support/**/*.ts"],
    languageOptions: {
      globals: globals.node,
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
              "@durable-agent-substrate/types",
              "Do not introduce a shared types package unless the specs explicitly justify it.",
            ),
          ],
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
    files: ["packages/**/src/**/*.ts"],
    ignores: ["packages/**/src/__tests__/**/*.ts", "packages/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        ...effectDebtGuardrails,
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
              "@durable-agent-substrate/client",
              "Substrate must not depend on the client package.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/host",
              "Substrate must not depend on the host package.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/lab",
              "Substrate must not depend on lab code.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/types",
              "Substrate owns its durable schemas; do not introduce a shared types package.",
            ),
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
              "@durable-agent-substrate/host",
              "Client must expose curated application handles, not depend on host lifecycle code.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/lab",
              "Client must not depend on lab scenarios.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/types",
              "Client should reuse substrate-owned schemas directly.",
            ),
          ],
        },
      ],
    },
  },
  {
    files: ["packages/lab/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@durable-agent-substrate/substrate",
              "Lab scenarios should compose through the public client package.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/host",
              "Lab scenarios should not become a host control plane.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/types",
              "Lab scenarios should not depend on a shared types package.",
            ),
          ],
        },
      ],
    },
  },
  {
    files: ["packages/host/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            restrictedInternalPackage(
              "@durable-agent-substrate/lab",
              "Host lifecycle code must not depend on lab scenarios.",
            ),
            restrictedInternalPackage(
              "@durable-agent-substrate/types",
              "Host owns lifecycle/config/profile types only; do not introduce a shared types package.",
            ),
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/src/__tests__/**/*.ts", "packages/**/*.test.ts"],
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

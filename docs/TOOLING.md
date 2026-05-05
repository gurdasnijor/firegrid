# Tooling

This repo standardizes TypeScript hygiene on ESLint plus the Effect language service.

## ESLint

Run:

```sh
pnpm run lint
```

Autofix formatting and safe lint fixes:

```sh
pnpm run format
```

The ESLint config intentionally keeps one stack for formatting, type-aware linting, Effect guardrails, and package-boundary checks. Current Effect defect-boundary debt such as `Effect.orDie` and `Layer.orDie` is reported as warnings so the lint setup can land before the behavioral refactor.

The repo also carries local durable-authority guardrails. These do not prove distributed correctness; they catch shapes that commonly bypass durable state:

- `local/no-production-js-timers` errors on production `setInterval`, `setTimeout`, and `setImmediate`.
- `local/no-hidden-control-plane` errors on HTTP/control-plane imports in host/client production paths.
- `local/no-module-durable-cache` warns on module-scope mutable durable-state caches or registries.
- `local/no-fixed-polling` warns on fixed schedules, stream ticks, and `Effect.sleep` inside loops.
- `local/no-host-authority-registry` warns on host-owned run/completion/claim/event-plane registry names.

Reviewed production exceptions should use a nearby escape comment with a reason, for example:

```ts
// durable-lint-allow-polling: subscription deadline fallback with bounded scope
```

## Build

Run:

```sh
pnpm run build
```

Each package emits production JavaScript into its local `dist` directory from `src`, excluding tests. Declaration emit is intentionally off for the first build baseline because the current substrate schemas need explicit exported type annotations before portable declaration generation can pass.

Source files use relative `.ts` import/export specifiers. TypeScript's `rewriteRelativeImportExtensions` rewrites those to `.js` in `dist`, so source stays TypeScript-native while emitted ESM remains runnable by Node. ESLint enforces and autofixes this convention.

## Effect Devtools

The repo installs `@effect/language-service` at the workspace root and enables it in each package tsconfig. Editors must use the workspace TypeScript version for the plugin to load.

For VS Code and Cursor, this repo recommends the Effect Dev Tools extension and configures:

```json
{
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

Build-time Effect diagnostics are available after patching the local TypeScript install:

```sh
pnpm run effect:patch
```

This is intentionally opt-in for now: the current codebase has existing Effect diagnostics that should be fixed in a dedicated refactor before the patch becomes part of the default install/check path. Use `pnpm run effect:unpatch` to restore the normal TypeScript compiler.

The runtime tracer dependency `@effect/experimental` is not installed yet. Add it when there is a concrete app/runtime entrypoint that should connect to the editor DevTools tracer.

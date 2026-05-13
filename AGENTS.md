# Agent Instructions

## Vendored Reference Repositories

This repository vendors selected upstream sources under `repos/` as read-only
reference material via `git subtree --squash`. They are not part of the build
graph and must not be imported from product code.

Currently vendored:

- `repos/effect/` — Effect-TS source repo (`Effect-TS/effect`, `main`,
  squash-imported). See `repos/effect/AGENTS.md` and the package sources for
  authoritative examples of idiomatic Effect APIs and patterns.

### Rules

Use vendored repositories as read-only reference material when working with
related libraries. Prefer examples and patterns from the vendored source code
over generated guesses or web search results. Do not edit files under `repos/`
unless explicitly asked. Do not import from `repos/` — application code should
continue importing from normal package dependencies (`effect`, `@effect/*`,
etc.) resolved through `node_modules`.

When you need to confirm an Effect API signature, behavior, or idiom, read the
relevant file under `repos/effect/packages/effect/src/` (or the appropriate
sibling package) before relying on training knowledge or web search.

### Updating the vendored Effect source

```bash
git subtree pull \
  --prefix=repos/effect \
  https://github.com/Effect-TS/effect.git \
  main \
  --squash
```

Run this as a standalone PR — never bundle a `repos/effect` refresh with
product changes.

### Why these files are excluded from tooling

- ESLint ignores `repos/**` so vendored source does not pollute lint output and
  cannot drift our rule set.
- `no-restricted-imports` blocks `repos/**` paths so a stray import from
  product code fails the build.
- VS Code excludes `repos/**` from search, file watching, and TypeScript /
  JavaScript auto-import suggestions so the upstream symbols never appear as
  import candidates while you write product code.

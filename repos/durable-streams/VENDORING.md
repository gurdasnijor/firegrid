# Vendored: gurdasnijor/durable-streams — TypeScript packages + docs (partial)

Read-only reference material for agents, **not** a dependency. `repos/**` is
excluded from all gates (eslint, knip, typecheck, dep-cruiser) and from the pnpm
workspace; never import from here.

This is a plain vendored copy, **not** a `git subtree` or submodule.

## What firegrid actually depends on (separate from this reference)

The runtime dependency `@durable-streams/server` is pinned in the root
`package.json` via a git URL at this same commit:

```
github:gurdasnijor/durable-streams#4a5efcf35d67bf16697b2f965860cffdebde1dcb&path:/packages/server
```

This vendored tree is only the source the agents read; the build comes from the
git pin above.

## Source

- Upstream: https://github.com/gurdasnijor/durable-streams
- Commit: `4a5efcf35d67bf16697b2f965860cffdebde1dcb` (`build: include server dist for Firegrid git pin`)
- Package versions at this commit: `@durable-streams/server@0.3.7`, `@durable-streams/client@0.2.6`

## Scope (TypeScript + docs subset)

The full upstream is a polyglot monorepo (Go/Rust/Swift/Java/PHP/Ruby/Python/.NET/Elixir
clients + build artifacts). Only the TypeScript-relevant surface and reference docs
are vendored.

**Included packages:** `server`, `client`, `state`, `cli`, `proxy`, `benchmarks`,
`aisdk-transport`, `tanstack-ai-transport`, `y-durable-streams`,
`client-conformance-tests`, `server-conformance-tests`.

**Included root material:** `PROTOCOL.md`, `README.md`, `AGENTS.md` (+ `CLAUDE.md`
symlink), `CLIENT_MATURITY.md`, `IMPLEMENTATION_TESTING.md`, `LICENSE`, `docs/`,
`examples/`, `scripts/`, and TS config (`tsconfig.json`, `vitest.config.ts`,
`eslint.config.js`, `package.json`, `pnpm-workspace.yaml`).

**Excluded:** all non-TS language clients (`caddy-plugin`, `client-dotnet`,
`client-elixir`, `client-go`, `client-java`, `client-php`, `client-py`,
`client-rb`, `client-rust`, `client-swift`), build output (`dist/`, `target/`,
`.build/`, `node_modules/`), and `pnpm-lock.yaml`.

> Prior vendor (superseded): `durable-streams/durable-streams` PR #317 —
> `packages/coding-agents` + `docs/superpowers/specs`. Those paths no longer
> exist in this upstream.

## Refresh

```sh
SHA=4a5efcf35d67bf16697b2f965860cffdebde1dcb   # update to the new commit
git clone https://github.com/gurdasnijor/durable-streams /tmp/ds-new
git -C /tmp/ds-new checkout "$SHA"

DST=repos/durable-streams
rm -rf "$DST" && mkdir -p "$DST/packages"

for p in server client state cli proxy benchmarks aisdk-transport \
         tanstack-ai-transport y-durable-streams \
         client-conformance-tests server-conformance-tests; do
  rsync -a --exclude dist --exclude node_modules --exclude target \
           --exclude .build --exclude '*.tsbuildinfo' \
           "/tmp/ds-new/packages/$p" "$DST/packages/"
done

for f in AGENTS.md CLIENT_MATURITY.md IMPLEMENTATION_TESTING.md PROTOCOL.md \
         README.md LICENSE tsconfig.json package.json pnpm-workspace.yaml \
         vitest.config.ts eslint.config.js; do
  cp -p "/tmp/ds-new/$f" "$DST/$f"
done
cp -P "/tmp/ds-new/CLAUDE.md" "$DST/CLAUDE.md"   # symlink -> AGENTS.md

for d in docs examples scripts; do
  rsync -a --exclude node_modules --exclude dist --exclude .build \
           --exclude target "/tmp/ds-new/$d" "$DST/"
done

# then update the Commit + versions above, and the git pin in the root package.json.
```

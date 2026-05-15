# Agent Instructions

## The CLI Is The Harness

Every Firegrid smoke goes through the unified CLI in `src/run.ts`:

```
pnpm firegrid -- run -- <agent argv>
pnpm firegrid -- start [-- <agent argv>]
```

Scenarios under `scenarios/firegrid/` spawn the CLI and assert on its
stdout / exit code. They do **not** instantiate `AcpAgentAdapter`,
`AcpCodec`, `FiregridMcpServerLayer`, or any other adapter / host
layer directly; they do not parse `firegrid.start.ready` JSON to wire
something else around it; they do not spawn `npx ...` to talk a
protocol that the CLI is supposed to own.

If a smoke cannot be expressed through the CLI today, the missing
piece is **product surface** — extend `src/run.ts` (and the launch
schema it consumes), not the test code. Examples that have come up:

- "the CLI should thread `mcpServers` into the spawned agent's
  session" → extend `runCommand` and the agent-lowering path in
  `src/run.ts`; do not duplicate that wiring in a scratch test
- "the CLI should default-attach Firegrid MCP for ACP agents" →
  launch normalization layer in `src/run.ts`; not a test fixture
- "spawn an ACP agent and observe a tool call" → add the agent
  intent to the launch schema and have `executeRun` drive it; do
  not stand up a `child_process.spawn` harness in a test file

Hard rules:

- **No `scratch-*.ts` files** in any worktree. If you need throwaway
  orchestration, extend the CLI. The CLI is reusable; a scratch
  isn't.
- **No `child_process.spawn` for product processes in test files.**
  The exception is wrapping `pnpm firegrid -- ...` itself in a
  scenario (see `scenarios/firegrid/src/tracer-019-sync-run.test.ts`
  for the canonical shape).
- **No private adapter wiring in tests.** Adapter and host layer
  composition belongs in `src/run.ts` or `src/host.ts`. Tests treat
  them as implementation details of the CLI surface.

See `docs/contributing/architecture-map.md` for "where does X
live" and the current list of known CLI gaps. Before extending
the CLI for a new smoke, check that doc; the gap may already be
tracked there with a recommended scope.

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

Before writing or modifying Effect code, read `@repos/effect/AGENTS.md` (the
upstream Effect contributor guide). It encodes the code-style, naming, and
"look at existing code to learn established patterns" expectations that the
maintainers apply to the library itself, and those are the strongest available
signal for what idiomatic Effect looks like. If/when this repository moves to
a vendored Effect v4 subtree, also read `@repos/effect/LLMS.md`.

When you need to confirm an Effect API signature, behavior, or idiom, read the
relevant file under `repos/effect/packages/effect/src/` (or the appropriate
sibling package) before relying on training knowledge or web search.

### Optional: agent-patterns/

You may distill recurring patterns you discover while reading `repos/effect`
into focused notes under `agent-patterns/` (e.g. `agent-patterns/effect-schema.md`
with constructors/combinators, encoding/decoding examples, transformation
patterns, error-handling patterns). Do this on demand, when a pattern keeps
recurring across product code — not speculatively. Keep each note short and
link back to the canonical file in `repos/effect/`.

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

## Worktrees and Lockfiles

Each git worktree is its own pnpm workspace root because `pnpm-workspace.yaml`
sits at the worktree root and `pnpm-lock.yaml` is checked in. That means:

- `pnpm add` / `pnpm remove` from inside a worktree mutates **that worktree's**
  `pnpm-lock.yaml`, not the main checkout's. The two trees can resolve
  different transitive versions until you push and the lockfiles diverge in
  history.
- If a typecheck or test that passes on `main` starts failing inside a
  worktree, first confirm the worktree lockfile matches main:
  `md5 pnpm-lock.yaml <main-checkout-or-other-worktree>/pnpm-lock.yaml`.
- To revert a stray lockfile mutation: `git restore pnpm-lock.yaml` then
  `pnpm install --frozen-lockfile`.

If the harness places you in a fresh worktree (`.claude/worktrees/<name>/`),
the branch is auto-named `worktree-<name>`. Rename it before pushing if you
want a more descriptive branch (`git branch -m worktree-foo opus/foo-pr1`).

## Effect / `@effect/*` Version Pins

`packages/runtime/src/workflow-engine/internal/engine-runtime.ts` is written
against the API shapes of the currently-pinned `effect` (root) and
`@effect/workflow` (runtime package). Minor version bumps have introduced
typing regressions in the past — notably:

- `effect` 3.18 → 3.21 changed inference around `Option.getOrUndefined` and
  related helpers in ways that broke the workflow-engine adapter.
- Adding `@effect/vitest` to a workspace package pulls in its own `effect`
  range, which can elevate the resolved `effect` version repo-wide.

Treat `effect`, `@effect/workflow`, `@effect/experimental`, `@effect/platform`,
`@effect/rpc`, and `@effect/vitest` as version-coupled. Do not loosen ranges
casually. Bumps land as **standalone PRs** that update the lockfile and any
adapter code together, never bundled with product changes.

## Preflight Before Pushing

CI runs `lint`, `lint:dead`, `lint:dup`, `lint:deps`, `lint:effect-quality`,
`lint:semgrep`, `lint:semgrep:test`, `typecheck`, and the full test suite. The
root `package.json` chains all of these as `pnpm run verify`. Run it before
pushing if you've touched code; CI feedback is slow and the Effect-quality
metric in particular is easy to miss locally:

```bash
pnpm run verify
```

If you've only touched docs/specs:

```bash
pnpm run check:specs && pnpm run check:docs
```

The Effect-quality metric ratchet (`lint:effect-quality`) refuses regressions
in counts like `forOfInPackageSourceCount`, `processEnvOutsideBinCount`, and
`anyNoContextCastCount`. See `docs/contributing/effect-quality-metrics.md` for
the full list, what each metric counts, and how to fix common regressions.

## Coordinator Cadence via cmux

Coordinator handoffs and review feedback for Firegrid agent work flow through
a cmux surface in the team's workspace. To send the coordinator an update:

```bash
cmux list-pane-surfaces                # find the coordinator surface
cmux send --surface surface:<n> 'message text'
cmux send-key --surface surface:<n> Return
```

Use this for spec PR opens, implementation PR opens, CI status, and review
responses. Don't broadcast every commit — coordinator updates are
review-shaped, not progress-shaped. See `docs/contributing/acai-walkthrough.md`
for the end-to-end review cadence Firegrid PRs follow.

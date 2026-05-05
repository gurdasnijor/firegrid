# Firegrid Lead Architect Handoff - 2026-05-05

This handoff is for the next lead architect session. It captures repo state,
design context, coordination workflow, and immediate backlog as of the end of
the current session.

## Current Snapshot

Repo path:

```sh
/Users/gnijor/gurdasnijor/durable-agent-substrate
```

Remote:

```sh
github.com/gurdasnijor/firegrid
```

The remote was renamed from `durable-agent-substrate`; Git may still print a
repository-moved warning on push/pull. The local directory name is still
`durable-agent-substrate`.

Current main:

```sh
c9082d1 fix(repo): make lab dev shortcut runnable
```

Primary checkout status at handoff:

```sh
## main...origin/main
?? docs/REVIEW_FEATURE_ORGANIZATION_FIREGRID.md
```

The untracked review file is intentional and should not be committed unless the
user explicitly asks to convert it into canonical docs/specs.

Recent merged work:

- `d55d6af` - PR #10: runtime `Firegrid.eventStream` materializer.
- `adbc61c` - PR #12: safe `isEventStreamStateRow` predicate guard.
- `4d257e1` - PR #11: lab typed EventStream workbench and browser-safe client subpath.
- `c9082d1` - direct main fix: `pnpm dev:lab` and `pnpm bootstrap` work locally.

Current stashes worth knowing about:

```sh
stash@{Tue May 5 02:54:48 2026}: On firegrid-eventstream-skeleton: wip-before-restoring-main-checkout-2026-05-05
stash@{Mon May 4 21:53:14 2026}: On main: draft typed invocation boundary SDD
stash@{Mon May 4 16:44:48 2026}: On design/launchable-substrate-host: wip phase13 slice4 host before main consolidation
stash@{Mon May 4 01:46:06 2026}: On main: architect supporting docs before event-plane main sync
```

Do not pop these casually. The first stash contains tracked WIP from cleaning up
the main checkout after PR #10. The docs/spec ideas in that stash may already be
partly superseded.

## Must-Read Process

This project uses Acai spec-driven development. Load the repo-local skill before
planning, reviewing, or editing:

```sh
.agents/skills/acai/SKILL.md
```

Key process rules:

- Specs live under `features/<product>/*.feature.yaml`.
- Specs are the source of truth for acceptance criteria.
- Stable requirement IDs are called ACIDs, for example
  `firegrid-event-streams.CLIENT_API.1`.
- Use full ACID references only. Do not write partial refs such as `.1` or
  `CLIENT_API.1`.
- Tests should include full ACID refs in names when they directly prove a
  requirement.
- Important code comments may include full ACID refs when they explain why a
  boundary exists.
- Do not run `acai push --all` unless the user explicitly approves it.

The repo currently validates spec syntax with:

```sh
pnpm check:specs
```

## Canonical Docs And Specs

Start with:

```sh
docs/README.md
```

Canonical design docs:

- `docs/SDD_FIREGRID_ARCHITECTURE_AND_INVOCATION_BOUNDARY.md`
- `docs/SDD_DURABLE_AGENT_RUNTIME_LAB.md`
- `docs/SDD_DURABLE_AGENT_SUBSTRATE.md`
- `docs/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md`
- `docs/SDD_CHOREOGRAPHY_FACADE.md`
- `docs/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md`

Canonical Firegrid specs:

- `features/firegrid/firegrid-architecture-boundary.feature.yaml`
- `features/firegrid/firegrid-operation-messaging.feature.yaml`
- `features/firegrid/firegrid-event-streams.feature.yaml`
- `features/firegrid/firegrid-runtime-process.feature.yaml`
- `features/firegrid/firegrid-package-migration.feature.yaml`

Runtime lab / integration validation specs:

- `features/durable-agent-runtime-lab/runtime-lab-inspector.feature.yaml`
- `features/durable-agent-runtime-lab/acp-event-plane-runtime-validation.feature.yaml`
- `features/durable-agent-runtime-lab/fireline-firepixel-adapter-fit.feature.yaml`
- `features/durable-agent-runtime-lab/runtime-stress-and-restart.feature.yaml`

Legacy substrate kernel specs remain active:

- `features/durable-agent-substrate/*.feature.yaml`

Do not move/rename old specs casually. The current guidance is to keep legacy
specs stable for Acai traceability and use `features/firegrid/` for new Firegrid
work.

## Package Map

Current workspace packages:

- `packages/substrate` - durable kernel: rows, state machine, waits,
  subscribers, descriptors, projection rebuilds.
- `packages/client` - app-facing Firegrid client plus legacy low-level client.
- `packages/runtime` - `@firegrid/runtime`; server-side runtime process and
  runtime Layers.
- `apps/lab` - `@firegrid/lab`; browser lab/inspector app.

Naming is mid-migration:

- Runtime is already `@firegrid/runtime`.
- Lab is `@firegrid/lab`.
- Client and substrate still use old package names:
  `@durable-agent-substrate/client` and
  `@durable-agent-substrate/substrate`.

The desired direction is Firegrid vocabulary, but package migration is a
separate spec track. Do not do a broad rename without a focused migration plan.

## Architecture Boundaries

The most important boundary decisions:

- Runtime must not depend on app-facing client.
- Browser lab must not import runtime or substrate root.
- Browser-safe client EventStream APIs live under:

  ```ts
  @durable-agent-substrate/client/firegrid
  ```

- Browser-safe descriptor imports use:

  ```ts
  @durable-agent-substrate/substrate/descriptors
  ```

- The substrate root barrel is not browser-safe; it pulls Node/server-oriented
  internals.
- `withHost` was removed. The runtime process now injects
  `DURABLE_STREAMS_URL` / `VITE_DURABLE_STREAMS_URL` into child processes.
- `client.work.declare` is legacy/kernel-ish vocabulary and should not be the
  app-facing operation-start surface. The app-facing surface is
  `FiregridClient.send/call/result/observe`.

## EventStream Protocol Correction

A major issue was caught and fixed this session.

Wrong shape:

```ts
{ _envelope: "firegrid/event@1", stream, event }
```

That raw row must not be appended to the same stream consumed by
`@durable-streams/state`, because the state package materializes State Protocol
rows, not arbitrary JSON.

Correct shape:

```ts
{
  type: "firegrid.event",
  key: "<stream-name>:<event-id>",
  value: {
    _envelope: "firegrid/event@1",
    stream: "<stream-name>",
    event: encodedEvent
  },
  headers: { operation: "insert" }
}
```

The implementation now uses schema/state helpers rather than hand-built rows:

- `packages/substrate/src/descriptors/event-stream.ts`
- `packages/substrate/src/schema/state.ts`
- `packages/substrate/src/schema/rows.ts`

Important helper:

```ts
makeEventStreamStateRow(...)
```

Do not reintroduce an `openSubstrateDb` fetch filter to hide invalid rows. That
was explicitly rejected as hiding a protocol violation. Ground any future work
against the upstream state docs:

```text
https://github.com/durable-streams/durable-streams/tree/main/packages/state
https://github.com/durable-streams/durable-streams/tree/main/packages/state#event-helpers
```

## Current Implemented Surfaces

Already landed:

- `Operation.define`
- `EventStream.define`
- `OperationHandle`
- `FiregridClient.send`
- `FiregridClient.result`
- `FiregridClient.call`
- `FiregridClient.observe`
- `FiregridClient.emit`
- `FiregridClient.events`
- `Firegrid.handler`
- `Firegrid.eventStream`
- Browser-safe `@durable-agent-substrate/client/firegrid`
- Lab typed EventStream workbench
- Runtime `firegrid` / `fg` bin in `packages/runtime`
- Repo shortcut `pnpm dev:lab`

Do not ask another agent to "implement descriptors" or "implement
FiregridClient events" without first checking ground truth. Those foundations
already exist.

## Running The Lab

From the repo root:

```sh
pnpm bootstrap
pnpm dev:lab
```

`pnpm bootstrap` is an alias for `pnpm install`.

`pnpm dev:lab` launches:

1. embedded Firegrid runtime / Durable Streams server
2. Vite lab dev server

Expected output includes:

```text
http://127.0.0.1:<port>/substrate/firegrid
firegrid dev: embedded Durable Streams ready; spawning child
VITE v6.4.2 ready
Local: http://localhost:4439/
```

The lab receives `VITE_DURABLE_STREAMS_URL` from the runtime process.

If the lab cannot resolve dependencies, run:

```sh
pnpm bootstrap
```

The previous broken command was:

```sh
pnpm --filter @firegrid/runtime exec firegrid ...
```

That does not work locally because pnpm does not link a package's own `bin` into
its own `node_modules/.bin`. Use the package script:

```sh
pnpm --filter @firegrid/runtime run firegrid dev -- pnpm --filter @firegrid/lab dev
```

## Validation Commands

Common checks:

```sh
pnpm check
pnpm lint
pnpm check:specs
pnpm check:docs
pnpm typecheck
pnpm test
pnpm -w run effect:diagnostics
```

For PR review, the user prefers GitHub CI as the authoritative check. Do not
duplicate long local runs unless you need to reproduce/debug.

Useful targeted checks:

```sh
pnpm --filter @durable-agent-substrate/substrate test
pnpm --filter @durable-agent-substrate/client test
pnpm --filter @firegrid/runtime test
pnpm --filter @firegrid/lab test
pnpm --filter @firegrid/lab build:web
```

GitHub PR checks:

```sh
gh pr view <number> --repo gurdasnijor/firegrid --json state,mergeable,statusCheckRollup
gh pr checks <number> --repo gurdasnijor/firegrid
gh pr merge <number> --repo gurdasnijor/firegrid --merge --delete-branch
```

## cmux Coordination

The user uses cmux surfaces for multi-agent work.

Known surfaces from this session:

- User / coordinator surface: `workspace:2 surface:33`
- Agent 1: `workspace:2 surface:37`
- Agent 2: `workspace:2 surface:54`

Send messages with:

```sh
cmux send --workspace workspace:2 --surface surface:37 $'MESSAGE'
cmux send-key --workspace workspace:2 --surface surface:37 Enter
```

and for Agent 2:

```sh
cmux send --workspace workspace:2 --surface surface:54 $'MESSAGE'
cmux send-key --workspace workspace:2 --surface surface:54 Enter
```

Coordination rules that worked:

- Agents should use dedicated worktrees.
- Agents should inspect specs and ground truth code before implementing.
- Agents should post "already exists vs missing" packets before coding.
- Agents should report SHA, tests, ACID claims, and push posture.
- Agents should not push or run `acai push --all` without explicit approval.
- When multiple agents touch shared helpers, merge in dependency order and
  rebase dependents immediately.

Recent lesson: PR #10 was done in the primary checkout, which left main on a PR
branch. Avoid that. Keep the primary checkout on `main`; create worktrees for
feature branches.

## Open / Next Work

Recommended next feature tracks, in priority order:

1. ACP runtime validation.
   - Use ACP TypeScript SDK examples as an ACP EventStream generator.
   - Define ACP EventStream descriptors.
   - Emit ACP session/client/agent events through `FiregridClient.emit`.
   - Materialize them through `Firegrid.eventStream`.
   - Prove `waitFor` / runtime primitives can operate against those projections.
   - Specs: `features/durable-agent-runtime-lab/acp-event-plane-runtime-validation.feature.yaml`.

2. Operation scheduling and runtime correctness.
   - Delayed/scheduled `FiregridClient.send`.
   - Claim arbitration for multiple runtimes.
   - Idempotency and restart behavior.
   - Handler error semantics.
   - Specs: `features/firegrid/firegrid-operation-messaging.feature.yaml` and
     `features/durable-agent-runtime-lab/runtime-stress-and-restart.feature.yaml`.

3. Materialization reuse cleanup.
   - Avoid divergent live-follow/filter/decode code between
     `FiregridClient.events` and `Firegrid.eventStream`.
   - There are feature constraints in
     `features/firegrid/firegrid-event-streams.feature.yaml` under
     `MATERIALIZATION_REUSE`.

4. Lab UX improvements.
   - Use the typed EventStream workbench to validate real runtime flows.
   - Add operation invocation once browser-safe operation client surface is
     fully settled.
   - Keep raw stream diagnostics visually separate from typed controls.

5. Package migration.
   - Rename remaining packages to `@firegrid/*` only under the migration spec.
   - Specs: `features/firegrid/firegrid-package-migration.feature.yaml`.

## Design Gotchas

- Do not let runtime import client. This was the original layering defect.
- Do not use `withHost`; it was intentionally removed.
- Do not hand-roll Durable Streams State rows if schema-generated helpers can
  produce them.
- Do not append raw Firegrid envelopes to a state stream.
- Do not treat `@durable-streams/state` as a generic JSON stream reader.
- Do not let browser lab import substrate root.
- Do not reintroduce fixed polling loops or module-local durable-state caches.
  The lint rules are repo-specific guardrails for this.
- Do not assume `firegrid` is globally installed in local repo workflows. Use
  `pnpm --filter @firegrid/runtime run firegrid ...` or `pnpm dev:lab`.
- Do not ask agents to implement already-landed surfaces without checking code.

## Useful Search Anchors

Find ACID refs:

```sh
rg -n 'firegrid-|runtime-lab-inspector|durable-records-and-projections|launchable-substrate-host' packages docs features
```

Find EventStream protocol code:

```sh
rg -n 'firegrid.event|EVENT_STREAM_ENVELOPE_TAG|makeEventStreamStateRow|isEventStreamStateRow|eventStreamEnvelopeFromStateRow' packages
```

Find browser-safety boundaries:

```sh
rg -n 'client/firegrid|substrate/descriptors|SubstrateClientLive|@firegrid/runtime|@durable-agent-substrate/substrate' packages/client apps/lab eslint.config.js
```

Find runtime process code:

```sh
rg -n 'firegrid dev|DURABLE_STREAMS_URL|VITE_DURABLE_STREAMS_URL|Command\\.make|NodeRuntime' packages/runtime apps/lab README.md
```

## Current Repo Hygiene

Primary checkout should stay:

```sh
git switch main
git status --short --branch
```

Expected at handoff:

```sh
## main...origin/main
?? docs/REVIEW_FEATURE_ORGANIZATION_FIREGRID.md
```

If a future session needs to recover WIP from the current session, inspect stashes
with:

```sh
git stash list --date=local
git stash show --stat stash@{0}
git stash show -p stash@{0}
```

Do not apply stashes directly into `main` unless the user explicitly asks for
that work to be revived.

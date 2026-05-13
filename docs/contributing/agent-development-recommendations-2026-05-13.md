# Agent Development Recommendations

Date: 2026-05-13

Status: Recommendations from recent Firegrid implementation work.

Scope: Practical repository improvements that would make future agent sessions
more predictable. These are recommendations only; each implementation should
still follow the normal spec/docs review cadence when it changes behavior.

## Context

Recent runtime, Flamecast, DurableTable React, and lint-cleanup work exposed a
few recurring sources of friction for implementation agents:

- It is easy to confuse current architecture with historical SDDs and handoffs.
- Tooling can accidentally scan local agent worktrees and report stale failures.
- Product app source, package source, scripts, tests, and infrastructure
  boundaries are not consistently documented close to the code they affect.
- CI job names do not always map one-to-one to root scripts, so a local pass can
  still miss a CI sub-gate.
- Flamecast currently has temporary app-local dev/runtime scaffolding that looks
  more reusable than it should.
- Several active proposals are intentionally blocked on other proposals, but
  that relationship is not always obvious from the filename or document header.

This document lists recommended improvements, ordered by expected leverage.

## Recommended Improvements

### 1. Exclude local agent worktrees from repo tooling

Add `.claude/**` and similar local-worktree directories to ESLint, jscpd, knip,
dependency-cruiser, and docs checks where appropriate.

Why: stale local worktrees can make root validation fail on code that is not
part of the checked-out branch. This is especially confusing when CI reports
paths such as `.claude/worktrees/<name>/...` alongside real source paths.

### 2. Add package and app `AGENTS.md` files

Add local instructions near the code with the package-specific boundaries:

- `packages/client/AGENTS.md`: browser-safe package; no runtime imports; no
  direct implementation imports from `effect-durable-operators`.
- `packages/runtime/AGENTS.md`: platform-neutral runtime library; expose
  Effects and Layers; do not put `NodeRuntime.runMain` inside reusable package
  exports.
- `packages/protocol/AGENTS.md`: schema and DurableTable declaration ownership;
  allowed re-export surface for shared durable table types.
- `apps/flamecast/AGENTS.md`: app-level intent/UI only; no custom Firegrid
  substrate or control-plane server; temporary dev scaffolding is not the target
  app architecture.

Why: top-level guidance is useful, but implementation mistakes usually happen
at package-boundary edges.

### 3. Add a current-work map

Add `docs/CURRENT.md` or `docs/START_HERE.md` with:

- the current active architecture docs;
- proposals that are blocked on other proposals;
- package boundary summaries;
- current run commands;
- known temporary scaffolding;
- historical docs that should not guide new implementation work.

Why: `docs/README.md` helps, but the repo changes quickly. A current-work map
would help the next agent avoid old substrate/lab-era paths.

### 4. Standardize proposal status headers

Give proposals consistent status metadata:

```txt
Status: Active | Accepted | Superseded | Historical | Blocked
Blocked by: ...
Supersedes: ...
Implementation PRs: ...
```

Why: many proposal files look equally authoritative. The runtime host
dispatcher design, for example, should be visibly blocked on the durable
concurrency primitive proposal until that primitive lands.

### 5. Add explicit "do not implement yet" notes for blocked designs

For blocked architecture docs, add a short section that names the blocker and
the exact implementation shape to avoid.

Example for runtime host dispatcher work:

- do not implement host claims until the durable claim primitive lands;
- do not encode context ownership with product `createdBy` predicates;
- keep Flamecast app-local host code temporary;
- target a reusable `@firegrid/runtime` host launcher that returns an Effect.

Why: agents often arrive with a concrete task and can otherwise start coding a
proposal whose prerequisites are still unsettled.

### 6. Standardize local and Electric app launch ergonomics

Keep one clear runbook for Flamecast and root host execution:

- root `.env.example`;
- required environment variables;
- local Durable Streams path;
- Electric Cloud path;
- which command starts the runtime host;
- which command starts UI only;
- token visibility caveats for browser-based testing.

Why: the Flamecast toy became testable only after adding root-level run commands
and env handling. Those commands should be treated as documented test paths, not
implicit knowledge.

### 7. Prefer reusable dev orchestration over app-local copies

Do not let every app grow a bespoke `src/dev-local.ts`. Move reusable launch
orchestration into a root script, a shared dev utility, or eventually an
`@firegrid/runtime` host launcher.

Why: app-local dev scripts duplicate process orchestration and can violate
source import guardrails. They also obscure the intended product boundary.

### 8. Document runtime host composition patterns

Add a short runtime-host composition guide with examples:

- root `NodeRuntime.runMain` boundary;
- app-defined runtime mount;
- reusable runtime package exports as Effects/Layers;
- `@firegrid/client` for launch/prompt/open intent APIs;
- DurableTable React live query for UI observation;
- runtime dispatcher blocked on durable claim primitive.

Why: this would have prevented confusion over whether Flamecast should export
or run a host plane itself.

### 9. Add CI-parity command aliases

Add commands that match CI job groupings:

```sh
pnpm run ci:lint
pnpm run ci:typecheck
pnpm run ci:tests
pnpm run ci:all
```

`ci:lint` should run every sub-gate included in the CI `Lint` job, including
duplicate-token detection.

Why: `pnpm run lint` can pass locally while the CI `Lint` job still fails on
`lint:dup`.

### 10. Add a lint failure guide

Add `docs/contributing/lint-failures.md` explaining common failures:

- direct `@durable-streams/*` imports in product source;
- direct `effect-durable-operators` implementation imports in client code;
- jscpd duplicate-token threshold;
- Effect-quality metric ratchet;
- Semgrep `process.env` boundary;
- where scripts and tests may import infrastructure packages.

Why: lint messages are precise but not always prescriptive about the intended
architectural fix.

### 11. Remove checked-in platform artifacts

Remove `.DS_Store` files under docs and add an ignore rule if needed.

Why: docs-heavy PRs should not carry platform noise.

### 12. Document shared durable type re-export conventions

When product packages need a shared type from a lower-level durable package,
prefer exporting that type through an allowed boundary package such as
`@firegrid/protocol`.

Why: `DurableTableHeaders` was needed by client configuration, but client
implementation code cannot import `effect-durable-operators` directly.

### 13. Clarify scripts versus product source boundaries

Document that scripts may use infrastructure dependencies that product source
cannot, and keep those scripts outside `apps/*/src` and `packages/*/src`.

Why: moving the local Durable Streams test-server import out of Flamecast source
fixed the architecture lint without removing the local test utility.

### 14. Add a latest-handoff pointer

Add a lightweight `docs/handoffs/LATEST.md` or current-wave note that points to
the most recent relevant handoffs and recently merged work.

Why: several active tasks required rebasing because related APIs had just
landed on `main`. A single pointer would reduce stale branch work.

### 15. Clarify the cleanup-task path in the acai workflow

Add a short note to the acai walkthrough for mechanical cleanup tasks:

- no separate feature spec is required for mechanical lint/doc cleanup;
- still keep changes scoped to the reported guardrail;
- do not bundle behavior changes;
- use the normal PR and coordinator cadence.

Why: the spec-first workflow is correct for behavior changes, but small
mechanical cleanup work benefits from an explicitly documented lighter path.

## Highest-Leverage First Steps

If only three improvements land first, prioritize:

1. Exclude `.claude/**` and local worktrees from repository tooling.
2. Add package/app `AGENTS.md` files for `client`, `runtime`, `protocol`, and
   `flamecast`.
3. Add `docs/CURRENT.md` or `docs/START_HERE.md` with active docs, blocked
   proposals, package boundaries, and run commands.


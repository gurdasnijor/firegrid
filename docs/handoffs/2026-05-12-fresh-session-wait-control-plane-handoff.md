# Firegrid Handoff: Fresh Session For Wait / Control-Plane Ergonomics

Date: 2026-05-12
Repo: `/Users/gnijor/gurdasnijor/firegrid`

This handoff is for a reset coordinator session and reset Coding Agent
sessions. It intentionally preserves the durable-streams baseline and team
operating conventions, but does **not** preserve the full tactical thread
history. The next phase needs a fresh architectural pass over the wait/control
surface, especially because the current tracer-020 proof still feels too
low-level at the scenario call site.

## High-Level Team Context

Firegrid is still greenfield. The project bias is aggressive cleanup and
target-aligned architecture, not compatibility with earlier scaffolding.

Important team preferences:

- Scenarios must exercise production-like package surfaces. Avoid scenario-only
  product harnesses and shadow APIs.
- Delete deprecated code paths rather than preserving adapters for old designs.
- Avoid runtime mini-roots, service planes, and wrapper APIs that hide plain
  Effect code without adding durable semantics.
- Use Effect directly: `Effect`, `Stream`, `Layer`, `Scope`, `Ref`,
  `Schedule`, `Schema`, and typed `Context.Tag` services where they earn their
  keep.
- Use Effect Schema for boundary validation and trusted constructors for
  typed internal construction. Do not use decoders as constructors.
- Specs are authoritative. The repo uses acai ACIDs from
  `features/firegrid/*.feature.yaml`.

## Current Architectural Baseline

The canonical target architecture doc is:

- `docs/architecture/managed-agent-runtime-target-durable-facts.md`

The now-deleted legacy target doc was:

- `docs/architecture/managed-agent-runtime-target.md`

Durable substrate decisions that are now established:

- `effect-durable-streams` is the Effect-native Durable Streams client.
- `effect-durable-operators` is the generic operators package:
  - `ConsumerSource`
  - `DurableConsumer`
  - `DurableTable`
  - `DurableProjection`
  - `ConsumerCheckpointStore`
- Firegrid runtime input delivery now uses `DurableConsumer` and
  `ConsumerCheckpointStoreLive` rather than requested-minus-accepted manual
  folds.
- `packages/runtime/src/stream-native-runtime-loop/**` was deleted.
- `packages/runtime/src/runtime-operators/**` was deleted.
- `packages/runtime/src/required-action/**` was deleted.
- Required-action durable record ownership is schema-only under protocol, not
  a runtime service/workflow/module.

Key merged PRs:

- PR #156: effect-durable-streams DX polish and maintainer reference.
- PR #157: generic `effect-durable-operators` foundation.
- PR #158: tracer 017 completion; runtime input via `DurableConsumer`;
  accepted-row format and stream-native scaffolding deleted.
- PR #159: tracer 018 `ConsumerSource`; adds Durable Streams and optional
  Electric/D2TS source adapters.
- PR #160: legacy drift inventory and canonical target-doc cleanup.
- PR #161: required-action/runtime-operators demolition.

## Active PR Snapshot

Re-verify these before acting; this section is only a point-in-time snapshot.

```bash
gh pr view 162 --json number,title,state,mergeStateStatus,headRefOid,url,isDraft,statusCheckRollup
gh pr view 163 --json number,title,state,mergeStateStatus,headRefOid,url,isDraft,statusCheckRollup
```

As of this handoff:

- PR #162, `Rename runtime ingress facts to session input`, is open, clean, and
  green. It replaces `runtime_ingress` / `runtime-ingress` vocabulary with
  `session-input` / `firegrid.session.input`.
- PR #163, `tracer 020: durable fact wait descriptor via existing operators`,
  is open, clean, and green, but needs a fresh design review. It currently
  proves wait descriptors through existing operators, and includes generic
  helpers such as `DurableConsumer.forEach` and `ConsumerSource.findFirst`.

Do **not** assume #163 is architecturally accepted just because CI is green.
The user explicitly wants a more fundamental ergonomic review.

## Why The Reset Is Needed

The current tracer-020 scenario became more ergonomic than the original raw
composition, but it still may not reveal the right product/control surface.

Rejected or suspect approaches:

- A `DurableWait` public module.
- Names such as `runTerminalEvaluator`, `defineResolver`, `runResolver`,
  `defineRequestHandler`, or `runRequestHandler`.
- A wait-specific operator framework.
- Reintroducing required-action services, workflow launch/poll endpoints, or
  runtime-local mini composition roots.
- Scenario code that teaches users to manually wire:
  - matcher lookup,
  - durable source construction,
  - cursor handling,
  - `Stream.runHead` / `Stream.filterMap`,
  - matched/failed row appends,
  - `DurableConsumer.define` / `run` / policy / checkpoint boilerplate.

The next session should step back and design from desired call sites first.
Do not start by patching the current tracer.

## Core Design Question

What is the smallest ergonomic abstraction that lets higher-level Firegrid
runtime/tool capabilities be expressed as durable fact programs?

The target capabilities include:

```ts
wait_for(trigger, timeout?)
trigger(on, handler)
schedule_me_if(from_now, condition, prompt)
spawn(agent, prompt)
spawn_all(tasks)
```

The likely substrate shape is still:

- input requests are durable facts,
- matching/projecting is over durable fact streams or durable tables,
- progress is via `ConsumerCheckpointStore`,
- workflow suspension, durable clocks, and user-visible tools live above
  `effect-durable-operators`.

But the ergonomic call site is unsettled. Explore it fresh.

## Key References To Read First

Read these before touching code:

- `docs/architecture/managed-agent-runtime-target-durable-facts.md`
- `docs/architecture/legacy-drift-inventory-2026-05-12.md`
- `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md`
- `docs/proposals/SDD_EFFECT_DURABLE_CONSUMER_SOURCES.md`
- `docs/effect-durable-streams/MAINTAINERS.md`
- `packages/effect-durable-operators/README.md`
- `packages/effect-durable-operators/src/ConsumerSource.ts`
- `packages/effect-durable-operators/src/DurableConsumer.ts`
- `packages/effect-durable-operators/src/DurableTable.ts`
- `packages/effect-durable-operators/src/DurableProjection.ts`
- `features/firegrid/effect-durable-operators.feature.yaml`
- `features/firegrid/firegrid-durable-fact-wait-descriptor.feature.yaml`
- `features/firegrid/firegrid-platform-invariants.feature.yaml`

If PR #162 is not merged, also review:

- `docs/tracers/019-session-input-fact-rename.md` if present on the branch.
- `packages/protocol/src/session-input/**` on PR #162.
- `packages/runtime/src/session-input/**` on PR #162.

If PR #163 is not closed/reworked, review:

- `docs/tracers/020-durable-fact-wait-descriptor.md`
- `scenarios/firegrid/src/tracer-020.test.ts`
- `packages/protocol/src/wait/**`
- `packages/effect-durable-operators/test/for-each-find-first.test.ts`

## Specs / Acai Operating Rules

Load the acai skill or read:

- `.agents/skills/acai/SKILL.md`

Rules to preserve:

- Specs live in `features/firegrid/*.feature.yaml`.
- ACIDs are stable IDs and should be referenced in tests/comments.
- Do not renumber requirements; deprecate instead when needed.
- Specs first, code second.
- After spec/code changes, run:

```bash
pnpm run check:specs
pnpm exec acai push --all --product firegrid
```

## Suggested Fresh-Session Plan

1. Pull current main and inspect active PRs:

   ```bash
   git fetch origin
   git status --short --branch
   gh pr view 162 --json number,title,state,mergeStateStatus,headRefOid,url,isDraft,statusCheckRollup
   gh pr view 163 --json number,title,state,mergeStateStatus,headRefOid,url,isDraft,statusCheckRollup
   ```

2. Decide whether #162 should merge before any wait/control work. It likely
   should, because `session-input` naming removes old ingress vocabulary.

3. Treat #163 as a design artifact, not an accepted target. Read it to
   understand the latest substrate proof, then write 2-3 target call-site
   sketches before patching anything.

4. Ask what API would make the tracer scenario understandable in one glance:

   ```ts
   const waitProgram = ...
   yield* waitProgram.run(...)
   ```

   or:

   ```ts
   yield* Trigger.on(...).handle(...)
   ```

   or:

   ```ts
   yield* RuntimeWaits.evaluateSnapshot(...)
   ```

   The exact names are open. The important constraint is that the call site
   should not expose low-level DurableConsumer and source plumbing unless the
   user is explicitly writing substrate-level code.

5. Decide package ownership:

   - Generic source/consumer helpers belong in `effect-durable-operators`.
   - Firegrid row schemas and pure constructors belong in `@firegrid/protocol`.
   - Runtime host wiring belongs in `@firegrid/runtime`.
   - Workflow suspension belongs to `@effect/workflow` or a higher-level
     Firegrid runtime/tool layer, not `effect-durable-operators`.

6. Only after the desired call site is chosen, update the spec and implement.

## Pre-Reset Cleanup Findings

A quick pass before this handoff found one likely deletion and one boundary
clarification.

### Remove `packages/effect-durable-streams-state`

`packages/effect-durable-streams-state` appears to be dead current-surface
code. No production package imports it. `pnpm why effect-durable-streams-state
--recursive` reports no dependents, and repo imports are limited to the package
itself plus docs/spec references.

The current durable table path is:

- `packages/effect-durable-operators/src/DurableTable.ts`
- direct `@durable-streams/state` import
- `createStreamDB(...)`
- TanStack DB collections

That means the local `effect-durable-streams-state` package is historical
validation code from before the upstream `@durable-streams/state` decision
settled. Keeping it will confuse the next design pass because it presents a
second state/materialization abstraction.

Recommended cleanup PR:

- Delete `packages/effect-durable-streams-state/**`.
- Run `pnpm install` to remove its workspace lockfile entry.
- Remove `effect-durable-streams-state` from
  `features/firegrid/effect-durable-operators.feature.yaml`
  `BOUNDARIES.1`.
- Update `packages/effect-durable-operators/src/index.ts` package comment to
  remove the stale dependency mention.
- Update `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md` so dependencies are
  `effect-durable-streams`, `@durable-streams/state`, `@tanstack/db`, and
  Effect packages.
- Update `docs/effect-durable-streams/MAINTAINERS.md` and
  `docs/effect-durable-streams/BACKLOG.md` to mark the local state package as
  deleted/superseded by upstream `@durable-streams/state`.
- Remove validation commands that still mention
  `pnpm --filter effect-durable-streams-state ...`.

### Keep `effect-durable-streams` as a visible internal substrate for now

`packages/effect-durable-streams` already exports only a root surface:

- `package.json` has only `"."` in `exports`.
- `src/index.ts` exports the `DurableStream` namespace plus top-level
  types/errors.

Do **not** hide it behind `effect-durable-operators` yet. The raw durable
stream package is still used by first-party protocol/client/runtime paths for
append/read mechanics, test-server setup, projections, and checkpoint storage.
Making `effect-durable-operators` the only public way to reach the raw stream
would blur the layer boundary: operators should consume the durable stream
substrate; they should not become the substrate package.

Better follow-up:

- Treat `effect-durable-streams` as an internal substrate package, not an
  end-user Firegrid API.
- Keep the root-only export.
- Add or tighten dependency-cruiser rules so direct imports are allowed only
  from explicit substrate-owning packages (`effect-durable-operators`,
  `@firegrid/runtime` infrastructure, `@firegrid/client` append/read surfaces,
  `@firegrid/durable-streams` test/workflow utilities, and scenarios/tests).
- Long term, push product code toward runtime/client/control APIs and keep raw
  `DurableStream` usage at package boundaries.

### Collapse the overloaded `@firegrid/durable-streams` package

`packages/durable-streams` is confusingly positioned. It is named like the
raw durable stream substrate, but the repo now has `effect-durable-streams`
for that. The package currently mixes at least three responsibilities:

- `@firegrid/durable-streams/state`: Firegrid state-schema helpers over
  upstream `@durable-streams/state`.
- `@firegrid/durable-streams/workflow-engine`: a Durable Streams-backed
  `@effect/workflow` engine adapter.
- `@firegrid/durable-streams/test-utils`: Durable Streams test-server setup.

This package should probably be collapsed or split after the immediate reset.
It is a source of architectural ambiguity because it looks like the substrate
owner while also exporting Firegrid-specific state descriptors and a workflow
engine.

Recommended direction:

- Move Firegrid state schema ownership out of `@firegrid/durable-streams/state`.
  Protocol packages should own schema/descriptor shapes; runtime/materialization
  code should choose how to materialize them through `DurableTable` or
  upstream `@durable-streams/state`.
- Rebuild `packages/durable-streams/src/internal/workflow/state.ts` on the
  newer primitives:
  - define workflow collections with `DurableTable.collection(s)`;
  - materialize them with `DurableTable.materialize`;
  - write State Protocol change events via collection `upsert` helpers and a
    durable stream append/producer;
  - use `table.awaitTxId(...)` for read-after-write.
- After that, the workflow adapter should move to a clearly named package or
  module:
  - if generic/reusable: `effect-workflow-durable-streams` or similar;
  - if Firegrid-only: `packages/runtime/src/workflow-engine/**`.
- Move `test-utils` either to `effect-durable-streams/test-utils` or a small
  test-only package. Avoid keeping a broad `@firegrid/durable-streams` root
  solely to host test helpers.

Likely end state:

```text
packages/
  effect-durable-streams/        # raw DS client substrate, root-only API
  effect-durable-operators/      # ConsumerSource, DurableConsumer, DurableTable, DurableProjection
  effect-workflow-durable-streams/  # optional, only if the @effect/workflow adapter is reusable
  protocol/                      # Firegrid row schemas/descriptors
  runtime/                       # Firegrid host/runtime composition
```

Do not do this as an opportunistic drive-by inside a wait-control tracer. It is
load-bearing enough to deserve a small cleanup/tracer PR with package import
inventory and dependency-cruiser updates.

## Coding Agent Bootstrap

Use cmux for Coding Agent sessions. Start by discovering the current workspace
and surfaces:

```bash
cmux --help
cmux list-workspaces
cmux tree --all
cmux current-workspace
```

If the coordinator already has a Firegrid workspace, create agent surfaces in
that workspace rather than creating unrelated workspaces. Example:

```bash
cmux new-surface --workspace <workspace-id> --type terminal
cmux rename-tab --workspace <workspace-id> --surface <new-surface-id> "Coding Agent - wait API design"
cmux send --workspace <workspace-id> --surface <new-surface-id> 'cd /Users/gnijor/gurdasnijor/firegrid && codex --dangerously-bypass-approvals-and-sandbox /Users/gnijor/gurdasnijor/firegrid'
cmux send-key --workspace <workspace-id> --surface <new-surface-id> Enter
```

If using a separate workspace is intentional:

```bash
cmux new-workspace \
  --name "Coding Agent - wait API design" \
  --cwd /Users/gnijor/gurdasnijor/firegrid \
  --command 'codex --dangerously-bypass-approvals-and-sandbox /Users/gnijor/gurdasnijor/firegrid'
```

For an Opus/Claude-style Coding Agent, verify the local command first:

```bash
which claude || true
claude --help | sed -n '1,120p'
```

Then launch with the local team’s normal Claude Code command. Do not guess
model flags if the local CLI does not advertise them.

Useful cmux communication commands:

```bash
cmux read-screen --workspace <workspace-id> --surface <surface-id> --scrollback --lines 120
cmux send --workspace <workspace-id> --surface <surface-id> "$(cat /tmp/message.txt)"
cmux send-key --workspace <workspace-id> --surface <surface-id> Enter
cmux notify --workspace <workspace-id> --surface <surface-id> --title "Review needed" --body "Please pause for coordinator review."
```

When agents report back, preserve:

- PR URL and head SHA.
- Exact files changed.
- Exact validations run.
- Any ACIDs intentionally left unsatisfied.
- Any behavior explicitly deferred.

## Suggested Agent Assignments After Reset

Do not start with implementation. Start with design/read-only passes.

### Coding Agent 1: Wait / Trigger API Call-Site Design

Prompt:

```text
Read the canonical architecture doc, effect-durable-operators README/source,
and tracer-020 PR if present. Do not edit files yet.

Produce 3 concrete call-site sketches for event waits and time waits:
1. substrate-level API,
2. Firegrid runtime-level API,
3. workflow/tool-facing API.

For each sketch, explain package ownership, what durable facts are written,
where progress/checkpoints live, and how scenarios would assert behavior
through production surfaces. Avoid DurableWait, runEvaluator, terminal
evaluator, required-action services, and runtime mini-roots.
```

### Opus Coding Agent: Repo Alignment / Risk Review

Prompt:

```text
Read the canonical architecture doc and active PRs #162/#163. Do not edit
files yet.

Review whether the current tracer-020 approach is aligned with the durable
facts target architecture. Focus on ergonomics, package boundaries, scenario
fidelity, and hidden historical baggage. Return findings ordered by severity
with file/line references and a recommendation: merge, split, redesign, or
close.
```

Only dispatch implementation after both reports converge on a target call
site.

## Review Checklist For PR #163 Or Its Replacement

Before merging any wait/control PR, verify:

- The scenario is understandable without reading `DurableConsumer` internals.
- No `DurableWait` module or evaluator/resolver lifecycle API exists.
- No `packages/runtime/src/runtime-operators/**` or `runtime-waits/**` appears.
- No required-action service/workflow/root is reintroduced.
- Generic package code does not import Firegrid packages.
- Protocol package does not import operators, durable streams, or platform
  clients.
- Scenario writes/reads protocol rows through protocol schemas, not
  `Schema.Any` / `Schema.Unknown`, unless the test is explicitly asserting
  malformed data handling.
- Specs do not overclaim capabilities not proven by code.
- Timeouts/live-follow semantics are either implemented with tests or clearly
  deferred.

## Validation Commands

Typical full validation set:

```bash
pnpm -r typecheck
pnpm -r test
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
git diff --check
pnpm exec acai push --all --product firegrid
```

Focused wait/control validation:

```bash
pnpm --filter effect-durable-operators run typecheck
pnpm --filter effect-durable-operators run test
pnpm --filter @firegrid/protocol run typecheck
pnpm --filter @firegrid/protocol run test
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-020
```

## Open Questions To Re-Open Fresh

- Is `DurableConsumer.forEach` enough, or does the higher-level runtime need a
  clearer trigger/wait program abstraction?
- Should wait evaluation be a Firegrid runtime API rather than a scenario-level
  composition?
- What is the clean call site for live snapshot-then-follow waits?
- Should time waits lower to the same event-wait abstraction via durable
  `timer.fired` / `schedule.due` facts?
- Where should source row references/offsets be captured, if matched outcomes
  need them?
- Should the wait descriptor row belong in general protocol now, or wait until
  the API shape is settled?

## Bias For The Next Phase

The goal is not to make the current tracer pass. The goal is to discover a
small, idiomatic, durable control surface that makes future tracers easier:

- required-action approval,
- scheduled self-prompt,
- child spawn completion,
- tool execution predicates,
- session/event triggers.

If the current tracer-020 branch does not illuminate that surface, split out
the useful generic helpers and redesign the wait proof.

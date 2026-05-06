# OCA Review Handoff — 2026-05-06 Next Wave

Date: 2026-05-06
Owner: OCA review-reserve (read-only / guardrail review)
Scope: Cross-repo review posture for Firegrid + Firepixel + Fireline package-consumption and bridge-proof work, plus next-wave focus on public-surface hardening and external runtime integrations.

## Posture

OCA is **read-only review-reserve**. The role does **not** implement, merge, or push. It does:

- fetch PRs via `gh pr view` / `gh pr diff` (cross-repo); add a worktree only when local verification (typecheck/test/lint/smoke) is needed for Firegrid-side review.
- evaluate against the brief's bars and standing guardrails.
- route a verdict (APPROVED / CHANGES REQUESTED / STOP-AS-BLOCKER-REPORT) to **surface:33** via `cmux send` followed by `cmux send-key --surface surface:33 Enter`. The Enter step is mandatory — a queued cmux message that is not submitted breaks the coordination loop.
- clean up the worktree after each Firegrid-side review.

OCA can serve as **primary** for one lane and **backup** for others; the brief makes that explicit on each handoff. When primary, route promptly. When backup, route only if the brief signals a tie-break or escalation is needed.

## Cross-Repo Review Checklist

Apply in order. Each section is a hard bar unless flagged as soft.

### 1. Diff scope

- [ ] PR is in the expected repo (`gurdasnijor/firegrid`, `gurdasnijor/firepixel`, or `smithery-ai/fireline`).
- [ ] No edits in the **other** two repos (cross-repo edits are out-of-scope by definition).
- [ ] No edits in production code outside the briefed scope (e.g., a smoke-only PR must not touch `packages/`).
- [ ] No `.tgz`, `.zip`, or other tarball/archive blobs committed.
- [ ] No `dist/` artifacts committed.
- [ ] No baseline edits (`scripts/data/effect-quality-metrics-baseline.json`, `scripts/data/effect-artifact-rules-baseline.json` on Firegrid; equivalent on the other repos if they exist).

### 2. Pinned-SHA discipline (Firegrid-bridge smokes)

For Firepixel and Fireline smokes that pack Firegrid artifacts:

- [ ] `FIREGRID_REF` is a 40-char SHA constant, hardcoded.
- [ ] Post-checkout assertion: `git rev-parse HEAD === FIREGRID_REF` (FLX2A pattern). Throws on mismatch before any install/build.
- [ ] If the SHA bumps in the PR, the new SHA must be **reachable from `gurdasnijor/firegrid` `origin/main`**. Verify via `git log <new-sha> -1` and `git rev-list --count <old-sha>..<new-sha>`. Bumps that target a SHA *not yet on main* will fail the smoke and indicate either out-of-order coordination or a typo.

### 3. Pack-and-consume invariants

- [ ] Build + pack flow: `pnpm install --frozen-lockfile` against Firegrid's lockfile, then `pnpm --filter @firegrid/<package> run build`, then `pnpm pack --pack-destination`.
- [ ] `assertNoWorkspaceDependencies` walks all four manifest dep sections (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`) and throws on any `workspace:*` survivor.
- [ ] Bin assertion (runtime smoke only): `runtimeManifest.bin?.firegrid === "./dist/bin/firegrid.js"` defensive check.
- [ ] Consumer manifest uses `file:<absolute-tmp-path>` for tarball deps. **No** `link:`, `../firegrid/...`, or sibling-path resolutions.
- [ ] `pnpm.overrides` for `@firegrid/substrate` (transitive pinning when client or runtime consume substrate).
- [ ] No registry-version specifiers for `@firegrid/*` or `@<integrator>/*` packages — those are not yet published.
- [ ] Final post-typecheck guard (or pre-write guard, depending on script style) re-reads consumer `package.json` and rejects `../firegrid` / `workspace:` substrings.

### 4. Consumer source forbidden-token guard

The canonical 17-token list (see `taxonomy` section below) is enforced at one of three positions:

- **Firegrid (in-memory string, pre-write)**: `pack-runtime-consumption-smoke.mjs`'s `assertExternalConsumerSource(consumerSource)` fires before `writeFileSync`.
- **Firepixel (in-memory string, post-typecheck)**: each `firegrid-*-smoke.mjs` runs the source grep loop after `pnpm run typecheck`.
- **Fireline (filesystem-read, pre-everything)**: `examples/firegrid-bridge-smoke/scripts/run-smoke.mjs`'s `assertNoForbiddenSourceTokens()` fires before `rmSync(workRoot, ...)` and any other side effect.

Different positions reflect each script's source-management style. All three should use the **same 17-token list**.

- [ ] All 17 tokens present (or one of the documented descriptive categories — see taxonomy).
- [ ] If the PR expands the list, the new tokens are kernel/internal/launcher surfaces that have a corresponding public alternative.
- [ ] Brief confirms zero hits against the existing consumer source(s) (CI green).

### 5. Public-surface discipline

- [ ] **No `@firegrid/substrate/kernel`** imports in app/smoke code (only public root + `./descriptors`/`./event-plane`/`./id-gen` subpaths allowed).
- [ ] **No `Choreography`, `DurableWaitsLive`, `WorkProducer`, `SubstrateProducer`** — substrate-internal authorities.
- [ ] **No `processReadyWorkItem`, `attemptClaim`, `completeRun`, `failRun`, `blockRun`, `resolveCompletion`, `createPendingCompletion`, `startRun`** — kernel-internal terminal/state-transition authors.
- [ ] **No `client.work.declare`** — hypothetical work-pipeline-bypass API; pre-emptive ban.
- [ ] **No `FIREGRID_RUNTIME_MODULE` or `firegrid dev`** — banned dynamic-loader / dev-launcher resurrection.
- [ ] **No `durable.run` envelope shape** anywhere except in legitimate substrate-side code; smokes must NOT directly append `durable.run` rows to fake terminalization.

### 6. Runtime composition discipline

- [ ] `Firegrid.composeRuntime({ subscribers, handlers, provide })` with **explicit** arrays. No implicit `subscribers: [timer, scheduledWork, projectionMatch]` defaults.
- [ ] Each Layer in `provide` is justified by its use in handlers/subscribers (no orphan Layers).
- [ ] `RUNTIME_COMPOSITION.5` adapter Scope: `Layer.scoped` adapter resources finalize on `Fiber.interrupt` of the surrounding `run(...)`.
- [ ] App-owned descriptors (`Operation.define`, `EventStream.define`, `EventPlane.define`) live in **integrator-side** code, never pushed back into Firegrid as substrate-native row families.

### 7. EventPlane / RunWait / projection-match recipe

For permission-wait or tool-result smokes:

- [ ] `EventPlane.define({ name, state })` with caller-owned row families and primary keys.
- [ ] Handler emits via `PlaneProducer.emit(...)` (FP3 recipe), not raw `DurableStream.append`.
- [ ] Handler suspends via `RunWait.for(trigger, { resultSchema })` for typed decoded matchedValue.
- [ ] `Firegrid.subscribers.projectionMatch({ evaluate })` with evaluator reading caller-owned `PlaneProjection` state by primary key (FP3 recipe). NOT raw stream scan.
- [ ] Handler typed-failure path uses `Effect.fail({ ... })` matching the operation's `error` schema (FW3 recipe).

### 8. Honest pending-without-decision behavior

For permission-wait smokes specifically:

- [ ] Smoke observes the handler reached the request-emit step before writing the decision row. Two acceptable styles:
  - **`projection.until(requestById, isPresent, {timeout})`** (Fireline FLX4 / dataflow gate) — gates on app-owned EventPlane row visibility.
  - **`pollPermissionRows` polling pattern** with `Effect.filterOrFail + Effect.retry` (Firepixel FPX5) — equivalent shape.
- [ ] **Tighter Pending gate via `client.observe(handle).pipe(Stream.filter(_tag === "Pending"), Stream.take(1), Stream.runDrain/runCollect)`** — FPX5A + FLX7B pattern. Captures the public-state-tag observation that the operation entered Pending.
- [ ] **No `Effect.sleep` between handler emit and `wait.for`** — the FP2-era anti-pattern I caught at PR #76. Always reject this.

### 9. Stop-and-report criteria

The brief sometimes explicitly accepts a **STOP-AS-BLOCKER-REPORT** verdict instead of APPROVE/CHANGES REQUESTED. Triggers:

- **Firegrid edits required** in a Firepixel/Fireline integration PR (would be cross-repo scope leak).
- **Reusable adapter package** (e.g., `packages/firegrid-adapter/`) when the brief says "example-only".
- **Generic abstractions** (e.g., `Permission`/`Authorization`/`Tool`/`Provider` types beyond the single product flow).
- **Multiple deferred lanes added in one PR** (e.g., permission denial + tools + provider lifecycle).
- **Dev-launcher resurrection** (`FIREGRID_RUNTIME_MODULE`, `firegrid dev`) anywhere.
- **Production code outside the briefed scope** (e.g., smoke-only PR touching `packages/`).
- **Generic prompt/streaming/message abstraction** (LLM-protocol shapes) when the brief says single-chunk or single-tool.

When triggered, the verdict identifies the precise gap and recommends a scope-down or split.

## Recent Soft Observations

These are not blockers but coordinator-flagged items worth tracking forward. They came out of the PKG2A → PKG2B → PKG2C arc and the FLX/FPX equivalents.

### 1. Free-form `code: Schema.String` vs `_tag`-discriminated tagged union

Fireline's `BridgeSessionError = {code: Schema.String, message: Schema.String}` (free-form) carries multiple failure sources via `code` discriminator (`"permission_denied"`, `"tool_failed"`). Firegrid's FW3 reference recipe uses `_tag: Schema.Literal("FirelineRequestRejected")` (tagged union). Functionally equivalent for smokes; tagged union gives stronger type narrowing for callers.

Future product-grade integrations may want to migrate to `_tag`-discriminated tagged-union error types. Not a Firegrid concern; flagged for downstream integrators.

### 2. `Schema.optional(output)` vs `Schema.Union(Succeeded, Failed)`

Firepixel FPX7's `ToolResult` schema uses `Schema.optional(output)` + `Schema.optional(errorMessage)` with `status: Schema.Literal("completed", "failed")` discriminator. The shape technically permits malformed cases (e.g., `status: "completed"` with `output: undefined`); the handler defensively treats this as a failure. A tighter shape would use `Schema.Union(Succeeded, Failed)` like Fireline FLX7A. Not blocking; flagged for future tightening.

### 3. Tool result observation: `RunWait.for` vs `projection.until`

Fireline FLX7 uses `projection.until(toolResultById, isPresent, {timeout})` for in-fiber EventPlane observation. Firegrid-side FP4 also uses `projection.until` (matching FLX7's choice). Firepixel FPX7 uses `RunWait.for(toolTrigger, { resultSchema })` with a projection-match subscriber. Both are valid:

- `projection.until` = in-fiber, single-process observation. Lighter weight; appropriate when result is co-located.
- `RunWait.for` = substrate-authoritative durable suspension. Multi-process-safe; appropriate when result may arrive from another process.

Document this distinction when reviewing — neither is wrong; they reflect different threat models.

### 4. Single-pin vs per-smoke-pin in SDD

Firepixel's SDD currently tracks **two separate pins** (client smoke at PKG1 `c54ac406...`, runtime smokes at PKG2 `4aa0fb2a...`). Each smoke pins to the minimum SHA it needs. Alternative: bump both to the same SHA per Firegrid baseline change for simpler maintenance. Coordinator's call; not blocking.

### 5. Shared token-list utility opportunity

PKG2A/PKG2B + FLX7C/FLX7D + FPX7A all use the same 17-token list, duplicated across 7 scripts (1 Firegrid + 1 Fireline + 5 Firepixel). A shared `forbidden-tokens.json` checked into each repo (or an npm package) could centralize. Not blocking; per-script duplication is acceptable for the small token count.

### 6. `Stream.take(N)` truncation risk

FLX6's `Stream.take(2)` and FLX6A/FLX7A's `Stream.take(4)` are bounded counts. If a future regression emits more chunks than expected, `take(N)` would silently truncate and assertions on the first N chunks would still pass. A defensive alternative would be `Stream.timeout(...)` + assert no further events — but that's timing-sensitive in CI. The brief explicitly defers this.

### 7. Free-form vs literal `code` typed-error discrimination

Two stylistic choices observed:
- **Fireline (FLX5/FLX7A)**: `code: Schema.String` free-form. Single error type carries multiple failure sources via `code` value. Easy to extend with new codes.
- **Firepixel (FPX6/FPX7)**: `code: Schema.Literal(...)` per operation. Stronger typing per operation; new failure sources require widening the literal or splitting into multiple operations.

Both valid; reflects different product preferences.

### 8. Two-operation vs one-operation session handling

- **Fireline**: ONE operation (`fireline.session.bridge.start`) handles permission + chunks + tool concerns sequentially in one handler.
- **Firepixel**: separate operations per concern (`firepixel.launch.permission-wait`, `firepixel.launch.tool-result`).

Both valid stylistic choices reflecting different product preferences.

## Guardrail Taxonomy

These are the named guardrails OCA enforces, organized by category. Each maps to one or more concrete tokens, helpers, or assertions.

### A. Forbidden tokens (the 17-token list)

Used by `assertExternalConsumerSource` (Firegrid PKG2B) / `assertNoForbiddenSourceTokens` (Fireline FLX7D) / inline grep loops (Firepixel FPX7A). Same list across all three.

**Substrate kernel + control-plane authorities**:
1. `@firegrid/substrate/kernel`
2. `Choreography`
3. `DurableWaitsLive`
4. `durable.run` (envelope-shape direct authoring)

**Substrate work-pipeline internals**:
5. `WorkProducer`
6. `SubstrateProducer`
7. `processReadyWorkItem`
8. `attemptClaim`
9. `client.work.declare`

**Terminal-event / state-transition authors**:
10. `completeRun`
11. `failRun`
12. `blockRun`
13. `resolveCompletion`
14. `createPendingCompletion`
15. `startRun`

**Dev-launcher resurrection**:
16. `FIREGRID_RUNTIME_MODULE`
17. `firegrid dev`

### B. Manifest-level guards

- `../firegrid` substring ban (no sibling-path deps).
- `workspace:` substring ban (no `workspace:*` specifiers in the consumer's `package.json`).
- `assertNoWorkspaceDependencies` walking all four dep sections in packed manifests.
- `bin?.firegrid === "./dist/bin/firegrid.js"` for the runtime package (PKG2 contract).

### C. Pinned-ref guards

- 40-char SHA constant.
- Post-checkout `git rev-parse HEAD === FIREGRID_REF` defensive assertion (FLX2A pattern).
- Reachability check: bumped SHA must be on `gurdasnijor/firegrid` `origin/main`.

### D. Public-surface gates

- `client.observe(handle).pipe(Stream.filter(_tag === "Pending"), Stream.take(1), Stream.runDrain)` — public Pending gate (FPX5A / FLX7B).
- `projection.until(rowById, isPresent, {timeout})` — EventPlane row-visibility dataflow gate (FLX4 style).
- `pollPermissionRows`/`pollToolRows` polling — equivalent to `projection.until` with explicit retry shape (FPX5/FPX7 style).
- `Effect.either(client.result(...))` — typed Right/Left discrimination on operation result.

### E. Scope-creep blockers

Trigger STOP-AS-BLOCKER-REPORT, not CHANGES REQUESTED:

- Firegrid edits in a Firepixel/Fireline PR.
- `packages/firegrid-adapter/` or any reusable adapter package commitment when the brief says example-only.
- Generic abstractions (Permission/Tool/Provider types beyond single flow).
- Multiple deferred lanes in one PR.
- Dev-launcher resurrection.
- Production code touched in a smoke-only or docs-only PR.
- LLM-protocol-shaped abstractions (Message/PromptPart/StreamingChunk/ToolCallChunk/Delta).

## Approval / Changes-Requested Etiquette

### Verdict format

Each verdict written to `/tmp/pr<N>-verdict.txt` and routed via cmux. Standard structure:

```
REVIEW VERDICT — <Repo> PR #<N> <LANE> <SHORT TITLE>

Status: APPROVED / CHANGES REQUESTED / STOP AS BLOCKER REPORT
Repo: <repo>
Head: <40-char SHA>
Reviewer posture: OCA review-reserve (read-only). Coordinator owns merge.

## Diff scope (...)
[Files changed; out-of-scope confirmation; behavioral change vs additive-only]

## Bars satisfied
[Section per bar from the checklist; map to specific code locations or test invariants]

## Soft observations for coordinator
[Forward-looking notes; not blockers; track for future PRs]

## Notes for coordinator
[One commit count; merge-state status; pin SHA; cross-product implications; stylistic divergences]

Verdict: APPROVED / CHANGES REQUESTED / STOP. <One-line summary>.
```

### Cmux routing

```bash
cmux send --surface surface:33 "$(cat /tmp/pr<N>-verdict.txt)"
cmux send-key --surface surface:33 Enter
```

The Enter step is mandatory. A queued message that is not submitted breaks the coordination loop.

For verdicts that include backticks or shell metacharacters, write to `/tmp/pr<N>-verdict.txt` first via the Write tool, then `cat` into `cmux send` with double-quote interpolation. Avoid heredocs because backticks inside heredoc-quoted body still get evaluated by the shell.

### Etiquette

- **APPROVED with soft observations**: routine outcome. Coordinator owns whether to act on the soft observation now or defer.
- **APPROVED with note "post-merge confirmation"**: when a PR was already merged before review completed (sometimes happens during fast-merge cycles). Treat as sanity sign-off; if any bar were red, the verdict would have been escalation/revert.
- **CHANGES REQUESTED**: spell out the precise fix. Always include:
  - which bar failed
  - which file/line embodies the failure
  - a concrete fix shape (e.g., "extend the resultSchema to include a `_tag` discriminator and update the handler to branch on it")
  - whether the fix is well-scoped to the PR or requires a separate slice
- **STOP-AS-BLOCKER-REPORT**: identify the precise gap and recommend either (a) a Firegrid-side ACID/helper addition, or (b) a scope-down of the integrator PR. Coordinator decides.

### Backup vs primary distinction

- **Primary**: route the verdict promptly; coordinator may merge based on it.
- **Backup**: route only if the brief signals a tie-break or escalation is needed. If primary already routed an APPROVE and OCA agrees, no backup verdict needed unless coordinator pings.

### Pre-merge vs post-merge handling

If a PR merges while OCA is reviewing:
- Continue the review and route the verdict anyway — flagged as "post-merge confirmation".
- If any bar were red, route the verdict as a revert recommendation and escalate to coordinator immediately. Do not silently absorb.

## Next-Wave Review Focus

The PKG / FLX / FPX wave closed with:

| Repo | Lane range | Final merge |
|------|-----------|-------------|
| Firegrid | PKG1-PKG2C | `b46e9e2` |
| Firepixel | FPX2-FPX8 | `4ba3977` |
| Fireline | FLX1-FLX9 | `c56de5a` |

The next wave focuses on **public-surface hardening** and **external runtime integrations** (e.g., `smithery-ai/flamecast-agents`). OCA review focus shifts accordingly:

### Public-surface hardening (Firegrid-side)

Likely lanes: PKG3 (npm publication readiness?), C6+ (client surface tightening?), FP8+ (additional EventPlane/RunWait coverage?), R# (runtime ergonomic helpers beyond `composeRuntime`?).

Review focus:

- [ ] Any new public surface (export, type, helper) must have a corresponding ACID and a public-surface test asserting its shape.
- [ ] No surface widening that re-exposes kernel internals (e.g., a "convenience helper" that re-exports `processReadyWorkItem` would be a regression).
- [ ] Adapter Scope contract (`RUNTIME_COMPOSITION.5`) is still the foundation review's #2 top-blocker — any new `Layer.scoped` adapter pattern must fire finalizers on `Fiber.interrupt`.
- [ ] `Operation.define` / `EventStream.define` / `EventPlane.define` shapes should remain stable. Any breaking change requires a major version bump and migration recipe.
- [ ] Browser-safe surface tests preserved or tightened (per C4's existing `firegrid-browser-surface.test.ts` shape).

### External runtime integrations (third-party)

Treat external runtime integration as a **package-consumption problem first** (per the coordinator handoff guidance). For each integrator:

1. **Inspect the integrator's public seams before coding**. What does their existing API look like? What are their EventStream/EventPlane equivalents? Where do they author terminal state today?

2. **Apply the bridge-smoke recipe**:
   - Pinned Firegrid SHA + post-checkout assertion.
   - Pack-and-consume from public Firegrid packages.
   - Real `Firegrid.composeRuntime + run({connection, runtime})`.
   - Honest pending-without-decision (request-row visibility + public Pending gate).
   - Typed terminalization via `Effect.either(client.result(...))`.
   - 17-token forbidden source guard.

3. **Stop-and-report if the integrator requires**:
   - Provider lifecycle hooks (`Layer.scoped` for ACP/MCP/Claude/Codex transports).
   - Browser UI / DOM imports.
   - Reusable adapter package.
   - Generic Permission/Tool/Provider abstractions.
   - LLM-protocol-shaped streaming (Delta/PromptPart/Message types).
   - Credential/registry/transport models.

   Each of these triggers blocker-report. Coordinator decides whether to add a public Firegrid surface (additive ACID) or scope down the integrator PR.

4. **Cross-product parity expectations**: if a new pattern is established for one integrator (e.g., FLX-like denial path with `_tag` tagged-union error), consider whether it should backport to existing integrators (Fireline, Firepixel) for consistency. Flag as soft observation, not blocker.

### Specific watch-outs for next wave

- **`flamecast-agents` integration**: the integrator name suggests agent-runtime concerns. Watch for provider lifecycle pressure (agents typically need transport adapters). Apply the standard stop-and-report criteria.
- **`PKG3` if it appears**: npm publication is the deferred lane in PKG2C's closing paragraph. If PKG3 enables publication, watch for: registry config, version-tag policy, release-channel decisions, postinstall scripts. Each should be additive-only and not erode the existing dist-only-exports / file-deps-in-smokes contract.
- **Token-list expansion**: if a new internal Firegrid surface needs banning, the canonical 17-token list grows in lockstep across all 7 smoke scripts. PR size: 7 small parallel commits or one consolidated sweep PR.
- **`@firegrid/runtime` bin behavior changes**: `dist/bin/firegrid.js` is written by `scripts/build-runtime-bin.mjs` and is a curated subset of `bin/firegrid.ts` (source). Future bin-behavior changes must update BOTH the source (workspace dev) AND the build script (shipped artifact). The architectural-constraint test (`runtime-foundations.test.ts`) checks the source bin; coordinator may want a parallel test for the shipped bin.

## Cross-Repo Stylistic Divergences (Reference)

Document these when reviewing — they're not bugs, just conventions:

| Property | Fireline | Firepixel | Firegrid |
|----------|----------|-----------|----------|
| Smoke organization | One bridge smoke, multi-concern | Five smokes, narrow concerns each | One pack smoke per package family |
| Coverage rollup doc | `examples/firegrid-bridge-smoke/README.md` (8 bullets, per-concern) | `docs/sdds/firegrid-package-consumption.md` (6 bullets, per-smoke) | `docs/SDD_FIREGRID_CLIENT_API.md` (7 bullets, per-property) |
| Typed error contract | Free-form `code: Schema.String` | Literal `code: Schema.Literal("...")` per op | N/A (Firegrid is producer) |
| Tool result schema | `Schema.Union(Succeeded, Failed)` | `Schema.optional(output) + Schema.optional(error)` discriminated by `status` | N/A |
| Tool wait shape | `projection.until` (FP4 recipe) | `RunWait.for + projectionMatch subscriber` (FP3 recipe) | Both demonstrated in scenarios |
| Pending gate | `Deferred`-shared-across-responders (FLX7B) | Inlined sequential gate (FPX5A) | Source guards only (no end-to-end) |
| Source-guard position | Pre-everything filesystem read (FLX7C) | Post-typecheck in-memory string grep (FPX-side) | Pre-write in-memory string grep (PKG2A) |
| Operation count | One op, multi-concern handler | Multiple ops, each narrow | N/A |

## Useful Commands Reference

For Firegrid-side reviews (local worktree):

```bash
W=/Users/gnijor/gurdasnijor/firegrid/.worktrees/pr<N>-review
git -C /Users/gnijor/gurdasnijor/firegrid worktree add $W <head-sha>
cd $W && pnpm install
pnpm run test:pack:client     # PKG1 client pack smoke
pnpm run test:pack:runtime    # PKG2 runtime pack smoke
pnpm --filter @firegrid/scenarios test
pnpm run lint:effect-quality
pnpm run lint:effect-rules
pnpm run lint
git -C /Users/gnijor/gurdasnijor/firegrid worktree remove --force $W
```

For cross-repo reviews (Firepixel / Fireline):

```bash
gh pr view <N> --repo <repo> --json headRefOid,mergeStateStatus,state
gh pr diff <N> --repo <repo> --name-only
gh pr diff <N> --repo <repo> > /tmp/pr<N>.diff
wc -l /tmp/pr<N>.diff
```

For SHA reachability (Firegrid pin verification):

```bash
git -C /Users/gnijor/gurdasnijor/firegrid fetch origin main
git -C /Users/gnijor/gurdasnijor/firegrid log <new-sha> -1 --format="%H %P %s"
git -C /Users/gnijor/gurdasnijor/firegrid rev-list --count <old-sha>..<new-sha>
```

## Standing-Down Notes

- All recent verdicts (PKG2A/B/C, FLX7C/D, FLX9, FPX5A, FPX6, FPX7, FPX7A, FPX8) routed and acknowledged.
- No open Firegrid PRs at handoff time.
- Local Firegrid checkout has divergent `main` (`ahead 270, behind 7` after fetch). Do not force-reset; coordinator handoff documents this constraint.
- Verdict files in `/tmp/pr*-verdict.txt` may persist — they're informational artifacts.
- The `.worktrees/` directory under the repo root is gitignored; existing worktrees can be removed safely if the working tree was clean at removal time.

Next OCA picks up here. Read the coordinator handoff for cross-repo context, then this doc for review-specific protocol.

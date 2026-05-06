# OLA/Lead Review Handoff

Date: 2026-05-06
Owner: OLA/Lead (`surface:66`)
Scope: Firegrid review primacy + Firepixel review primacy + cross-repo escalation gate. Hand-off written at the end of the PKG/FPX/FLX closeout wave.

## Role Summary

OLA is the **review gate**, not an implementer. The role exists to:

1. Hold each PR to the saved bars before it enters merge.
2. Encode bars as durable memory + spec ACIDs so they survive role rotation.
3. Refuse to merge from the agent side. Coordinator owns merge.
4. Escalate scope creep, fake-terminal patterns, and boundary leaks back to coordinator rather than rewriting the PR.

OLA does **not**:

- Author PRs (CA1/CA2/CA3 do).
- Run `/ultrareview` (user-triggered only).
- Merge or push to `main` from the agent side.
- Take any action on FLX-lane PRs without explicit coordinator reroute (OCA-primary).

## Standing Bars

These bars hold across every Firegrid/Firepixel review. Each is enforced via grep, structural test, or spec ACID. Refuse to APPROVE if any is violated.

### Boundary bars

- **No `@firegrid/client → @firegrid/runtime` edge.** Enforced by `packages/client/src/__tests__/client-foundations.test.ts:235` (`combined.not.toContain("@firegrid/runtime")`). Verify untouched on every PR that edits client or runtime.
- **No `@firegrid/runtime → @firegrid/client` edge** (PKG2 closure). Verify zero `from "@firegrid/client"` in `packages/runtime/src` and no `@firegrid/client` entry in `packages/runtime/package.json` deps.
- **No `@firegrid/substrate/kernel` re-export at any package public root.** Kernel stays a substrate-internal subpath used by runtime internals only.
- **No `Choreography`, `ChoreographyLive`, `DurableWaitsLive`** anywhere outside their internal homes. Retired by FW1 in favor of `RunWait`.
- **No claim/terminal authority builders at any public root**: `WorkProducer`, `SubstrateProducer`, `processReadyWorkItem`, `attemptClaim`, `completeRun`, `failRun`, `blockRun`, `resolveCompletion`, `createPendingCompletion`, `startRun`.
- **No control-plane symbols leaking into apps**: `client.work.declare`, `FIREGRID_RUNTIME_MODULE`, `firegrid dev`, dynamic module-loading flags. Apps own their typed `run({connection, runtime})` entrypoint.

### Authoring bars

- **NO FAKE TERMINAL STATE.** Handler-return `Effect.succeed(...)` / `Effect.fail(...)` is the *only* legitimate path for completing a run. Forbidden patterns: synthetic `_tag: "Completed"` / `_tag: "Failed"` outside handler return; `setTimeout`-synthesized completion; mock client.result; direct `durable.run` append; raw `@durable-streams/state` writer authoring terminal/decision rows. Saved in `feedback_dont_approve_layout_only_cleanup.md` (LAB4 origin) and `feedback_emit_then_wait_review.md` (FP2 origin).
- **Apps compose runtime via `Firegrid.composeRuntime({handlers, subscribers, provide})` only.** Forbid hand-rolled Layer composition that bypasses the typed contract.
- **Apps own their `run({connection, runtime})` entrypoint.** No `serve(...)` API, no dynamic-module-loading binary flags. Saved in `feedback_runtime_run_api.md`.

### Emit-then-wait bar

For any review involving `RunWait.for(...)` blocked on caller-owned EventPlane rows (F2/FP2/FPX5+ pattern):

- The test/smoke MUST deterministically observe blocked-pending state BEFORE emitting the external row that should wake the handler.
- Without this point the test races handler `RunWait.for` setup. The FP2 PR #76 review missed this and got caught by the user — saved in `feedback_emit_then_wait_review.md`.
- Acceptable observation channels:
  - `client.observe(Op, handle)` filtered to `Pending` then `Stream.take(1).runCollect` (FPX5A pattern; uses only public PKG1 surface; the public `Pending` tag intentionally collapses started-and-blocked at the C1 boundary)
  - Runs-table polling for blocked state
  - EventPlane projection visibility on the handler-emitted request row (FPX5 weak form; combined with no-Effect.sleep-in-handler and projectionMatch evaluate-on-registration semantics, this is sound)
- Red flags: `Effect.sleep("X seconds")` in the handler before the wait — hides whether `projectionMatch` actually fired vs raced the sleep timeout.
- Verify the subscriber wakes on **caller-owned EventPlane collection events**, not on handler sleeps.

### Distribution / packaging bars (PKG-wave)

- Public `package.json` ships dist-only `exports`/`main`/`types`/`files` with `{types, default}` conditional shape. No `./src/` paths in published exports.
- `tsconfig.build.json` builds into `dist/`; `files` declares `["dist"]` (or `["dist", "README.md"]`).
- Workspace ergonomics preserved: tsconfig path aliases + vitest source aliases + lab/scenarios shims keep `pnpm install` / `pnpm test` / `pnpm typecheck` working without a build step.
- Pack smokes: clone pinned ref, verify `actualRef === FIREGRID_REF`, build in dependency order, `assertNoWorkspaceDependencies` covers all four dep sections (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`), validate packed `bin` shape if applicable.
- Consumer tsconfig uses `module=NodeNext, moduleResolution=NodeNext` to exercise the published `exports` map externally — `Bundler` resolution can mask exports-map bugs.
- In-source forbidden-string scan **before** writeFileSync (PKG2A/B form is cleaner than the FPX-side post-write read-and-scan; consider backporting if FPX-wave smokes get touched).
- No committed `dist/`, no actual `npm publish`, no vendored tarballs, no dev-launcher resurrection, no baseline edits without justification.

### Don't approve layout-only PRs

PR #68 (FW0) was originally approved as a "mechanical src/ move." The user rejected: cleanup PRs need actual runner architecture (registry, shared CLI, declarative defs), not file shuffling. Saved in `feedback_dont_approve_layout_only_cleanup.md`. If a "cleanup" PR has no architectural payload, push back.

## Review Workflow

1. **Read the PR description.** Cross-check ACID claims against the actual diff.
2. **Pull the PR via `gh pr view <n> --json headRefOid,mergeStateStatus,statusCheckRollup,files`.**
3. **For Firegrid-internal PRs**: `git fetch origin pull/<n>/head:<branch>-review --force && git worktree add .worktrees/<branch>-review <branch>-review`. For cross-repo (Firepixel/Fireline): `gh pr diff <n> --repo <owner>/<repo> > /tmp/<lane>.diff` and Read.
4. **Run forbidden-symbol grep** on the diff or worktree:
   ```bash
   rg -n "@firegrid/runtime|@firegrid/substrate/kernel|RunWait|Choreography|DurableWaitsLive|processReadyWorkItem|attemptClaim|WorkProducer|SubstrateProducer|completeRun|failRun|blockRun|resolveCompletion|createPendingCompletion|startRun|client.work.declare|FIREGRID_RUNTIME_MODULE|firegrid dev" <relevant src> 2>/dev/null || echo "CLEAN"
   ```
5. **Verify baselines untouched**: `git diff --name-only origin/main...HEAD | grep baseline\.json`. Any baseline bump needs to match the actual additions; no smuggled artifacts.
6. **Verify dist not committed**: `git ls-files | grep packages/.*/dist/`.
7. **Verify pin SHAs in cross-repo smokes** point at the actual closure-merge commit on Firegrid main: `git fetch origin <sha> --depth=1 && git log --oneline <sha> -1`.
8. **Compose verdict** (template below) and send via cmux.
9. **Cleanup**: `git worktree remove .worktrees/<branch>-review --force; git branch -D <branch>-review`.

## cmux Etiquette

OLA's surface is `surface:66`. Coordinator's surface is `surface:33`.

**Always send to coordinator and press Enter:**
```sh
cmux send --surface surface:33 "<verdict body>"
cmux send-key --surface surface:33 Enter
```

Long verdicts can timeout. If `cmux send` times out (saw it once on FPX5A), retry with a condensed verdict — the long body is for OLA's own thoroughness; coordinator only needs the verdict + key findings + non-blocking observations.

### Verdict template

```
OLA REVIEW — <LANE-NAME> PR #<n> (<repo if cross>, head <short-sha>)

VERDICT: APPROVED | CHANGES REQUESTED | BLOCKED

Scope: <files changed, scope-clean assertion>
Pin (if cross-repo smoke): <sha verified yes/no, points at which Firegrid closure>

<Section per major bar — boundary, authoring, emit-then-wait, packaging>

CI: <green/red>. Merge state: <CLEAN/UNSTABLE>. Per protocol, OLA does not merge — handing back to coordinator.

<Optional non-blocking observations for future hardening>
```

## Merge-Reserve Expectations

- **OLA never merges.** Even on APPROVED PRs. Coordinator dispatches merge.
- After approval, OLA stands by for the next reservation. Don't push speculative work.
- If coordinator reserves a lane that hasn't opened a PR yet, save a memory file with the bar (`project_<lane>_review_focus.md`) and update `MEMORY.md`. This survives session compaction.
- If a PR is dispatched that's CI-red or mergeState UNSTABLE, **do not review yet**. Acknowledge "queued, no review action until green/CLEAN" and stand by.
- If a lane is OCA-primary or otherwise out of scope, decline review and reroute to coordinator. Don't review unless explicitly redirected.

## Surface-Hardening Focus

The closeout wave landed several hardenings. The next wave should keep these in mind:

- **PKG2A/B in-source pre-write guard** is now in `scripts/pack-runtime-consumption-smoke.mjs`. The FPX-wave smokes still use post-write read-and-scan. Backporting the pre-write form to FPX scripts is a reasonable future hardening (in Firepixel repo, coordinator's call).
- **FPX5A public Pending observation** uses only public client.observe; the public `Pending` tag intentionally collapses started-and-blocked at the C1 boundary. Don't approve any "stronger" observation that reaches past the public surface for a stricter signal — that violates C1's information hiding contract.
- **FPX6 dual-decision mutual-exclusivity** is the correct shape for proving wait genuinely returns durable content (vs coincidentally matching). Apply this template to any new wait/wake smoke — single-path proofs are weaker.
- **Forbidden-token guards** in pack smokes should be the full saved list (PKG2B closed this for runtime; client/substrate smokes may still have shorter lists worth expanding).

## Escalation Guidance

### Out-of-scope deferrals (per coordinator handoff)

Do **not** approve any PR that silently introduces:

- npm publication / release channel validation
- Reusable adapter packages
- Provider lifecycle management
- Browser UI (production; lab is allowed via the LAB seam)
- Broad registries / tool discovery
- Retry, cancellation, credential, transport policy
- Product-specific permission/tool semantics beyond smoke-local fixtures

If a PR needs one of these, send `CHANGES REQUESTED` and require a blocker report or spec proposal first.

### flamecast-agents and other external runtime integrations

Coordinator's next-wave focus mentions `https://github.com/smithery-ai/flamecast-agents`. Treat external runtime integration **as a package-consumption problem first**, NOT a runtime extension problem.

When a flamecast-agents (or similar external runtime) integration PR opens:

1. **Inspect public seams before coding.** Refuse a PR that reaches past `@firegrid/client` / `@firegrid/runtime` / `@firegrid/substrate` public roots into kernel / control-plane / authority builders.
2. **Apply the FPX-wave bar.** External runtimes consuming Firegrid look like Firepixel: pinned ref pack smoke, NodeNext consumer, real `DurableStreamTestServer`, real `Firegrid.composeRuntime + run`, app-owned EventPlane/EventStream descriptors in the consumer fixture, public `client.send/result/observe`, dual success/failure typed-channel proof.
3. **Refuse provider-lifecycle creep.** If flamecast-agents requires startup/shutdown lifecycle hooks, transport credentials, registry discovery, browser UI, or reusable adapter semantics, that's a missing public contract — block and escalate to coordinator with a blocker report rather than inventing the contract via product-specific code.
4. **Refuse Firegrid-side product semantics.** Flamecast/Smithery concepts (agents, agent registries, tool calls, transports) stay in the integrating package. Do NOT approve any PR that adds those names to `packages/client/`, `packages/runtime/`, `packages/substrate/`, or `features/firegrid/`.
5. **Watch for fake terminal in adapter glue.** External-runtime adapters are tempting places to synthesize completion/failure from the adapter's own state. Apply the LAB4/FPX4-FPX7 no-fake-terminal bar: every terminal must come from a handler return through Firegrid's authority path.
6. **Cross-repo PRs need pin verification.** If the integration PR's smoke pins a Firegrid SHA, verify it via `git fetch origin <sha> --depth=1 && git log --oneline <sha> -1` and confirm it's a legitimate closure-merge commit, not an arbitrary feature branch.

### When to refuse a review and escalate

- PR is CI-red or mergeState UNSTABLE — acknowledge queued, don't review.
- PR is in an OCA-primary lane (FLX-wave, anything coordinator dispatched to OCA) — reroute.
- PR touches a Firegrid public surface (client/runtime/substrate roots) and OLA cannot determine if it's intentional widening — escalate to coordinator with the specific symbols and ask for a charter clarification.
- PR violates a saved bar but the user has explicitly overridden it for this PR — confirm the override is in writing in the PR description or coordinator dispatch; otherwise refuse.
- PR claims tests pass but the test added is structurally weak (e.g., assertion only on values that match the input) — request a stronger structural test (mutual-exclusivity, dual-channel, blocked-pending observation).

## Memory Hygiene

OLA owns these memory files (under `~/.claude/projects/-Users-gnijor-gurdasnijor-firegrid/memory/`):

- `feedback_runtime_run_api.md`
- `feedback_dont_approve_layout_only_cleanup.md`
- `feedback_emit_then_wait_review.md`
- `project_c1_client_api_sdd_focus.md`
- `project_pkg2_review_focus.md`
- `project_fpx5_review_focus.md` (latest active)
- (Older `_focus.md` files are superseded but retained for context)
- `MEMORY.md` index — keep entries under ~150 chars and current

When a lane closes, **archive the focus memory** by replacing the active entry with the next lane's reservation. Don't leave stale "reserved for X" entries pointing to closed lanes. The session compaction process relies on the index being tight.

## Known Soft Observations Carried Forward

These were flagged in OLA verdicts but not blocked. Worth knowing for the next wave:

- **FPX5 observation #2** (closed by FPX6): single-decision-path tests don't prove wait returns durable content. FPX6 closed this with dual approved/rejected. Apply the dual-channel template to all new wait/wake smokes.
- **FPX-wave forbidden-token guards** are post-write read-and-scan; PKG2A/B's pre-write form is cleaner. A coordinated FPX hardening pass could backport.
- **Lab seam** is a privileged consumer of production client APIs (LAB0-LAB4 closure). Future lab work should not synthesize fake terminal state — durable observation only (LAB4 bar).
- **C2 client allowlist** is 13 symbols. Any PR widening this needs explicit charter; reject widening that's just convenience.
- **FiregridClientConfig.clientId** is optional — caught late in LAB2 review. When reviewing apps that construct FiregridClient, verify clientId is provided where downstream code may rely on it.

## At-Closeout State

OLA reservation board at the moment of this handoff:

- **No active OLA review reservations.** PKG2C and FPX8 closed the wave.
- **Standing reserves**: future PKG / FPX / Firegrid-internal lanes default to OLA-primary unless coordinator explicitly routes elsewhere.
- **Out of scope unless rerouted**: all FLX-wave (Fireline) PRs — OCA-primary.

## Next Wave Posture

The next session picking up OLA should:

1. Read this handoff first, then `coordinator-handoff.md`, then the two role-specific handoffs in this directory.
2. Read `MEMORY.md` and any active `project_*_review_focus.md` files.
3. Stand by on `surface:66`. Do not push speculative work.
4. When coordinator dispatches a lane, save a focus memory before the PR opens; review when CI green/CLEAN; deliver verdict with `cmux send + Enter`.
5. Escalate boundary leaks, fake-terminal patterns, scope creep, and external-runtime adapter surface widening to coordinator. Do not accommodate them by widening Firegrid.

The wave's accumulated structural bars (forbidden-symbol guards, in-source pre-write scans, dual-channel mutual-exclusivity proofs, public-Pending observation gates, no-fake-terminal everywhere) make new lanes faster to review — most violations show up in grep or in the smoke's own assertion shape. Trust the structural tests; verify the spec ACIDs encode the bar; refuse anything that needs an exemption without an explicit charter.

# Handoff — Stabilize the unified kernel (backlog reset)

- **Date:** 2026-06-01
- **Trunk verified at:** `sim/unified-kernel-validation` HEAD `f74f0750b` (= PR #765 integration branch → `main`)
- **For:** the next agent driving the unified kernel to a green, merged, production-cutover-ready state
- **Epic (single source of truth):** **`tf-ll90`** (label `stabilize-unified`). The old `tf-r06u` epic is **superseded** — do not drive work from it.
- **Fire-ready lane briefs:** **`docs/handoffs/2026-06-01-stabilize-lane-briefs.md`** — four session-start dispatch bodies (Lane 1 trunk-green · Lane 2 kernel-lifecycle sims-first · Lane 3 harness/sim-enforcement+real-agent+proofs · Lane 4 enforcement-surface audit), ready for `scripts/cmux-dispatch.sh`. **HARD GATE:** `tf-ll90.1` (CI-green) is blocked-by `tf-ll90.15` (sim-enforcement) — false-green over a forgeable sim harness is not allowed.
- **Why this reset exists:** the prior coordination drove off a polluted bead backlog + a half-tracked SDD corpus, and asserted several constraints that turned out fabricated (see §8). This handoff is re-grounded in **verified git/code/CI/doc state** (three independent read passes), not bead assumptions.

---

## 0. ★ THE META-PROCESS RULE (governs everything — the cause of every failure in the prior session)
**Do not make assumptions in the absence of data.** When you don't know: (1) locate exactly where the data gap is, (2) instrument/trace that boundary, (3) **run a simulation to GATHER the data**, (4) only then conclude — *from the data*. Inference is a hypothesis to be instrumented, never a conclusion to act on. **A confident conclusion with no captured evidence is the bug, not the finding.**

Every failure in the prior session was the *same* violation — a data gap filled with an assumption instead of a trace: the invented merge-gate, the non-existent `failureMode`/classification mechanisms, the non-airgapped spikes that "proved" nothing, "no lost proofs," the over-built bridges. When you catch yourself or a lane writing *"this is because…"*, *"X can't…"*, *"it's terminal/an ACP limitation"*, or a comment asserting third-party behavior — **STOP. Name the data gap. Instrument it. Run the sim. Then write the conclusion with the artifact that proves it.** This is the entire reason tiny-firegrid exists: generate trace data to drive an experiment. (Source: `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md`.)

**Operationalized by** `docs/runbooks/firegrid-effect-tracing.md`: tiny-firegrid is a **simulation harness, not a test harness** — a sim is a registry entry (`makeHost`/`driver`-requiring-only-`Firegrid`/`summarize`), **run** by `simulate:run`, producing an OTLP/DuckDB trace bundle; evidence is *querying that trace*, not `vitest expect()`. `vitest` and the `test/` `probe.test.ts` tree are an anti-pattern being removed (`tf-ll90.15`). All sim rebuilds (`tf-ll90.11`/`.14`) take this form.

## 1. Read first (in order)
1. This doc.
2. `docs/analysis/2026-06-01-765-deletion-audit.md` — the gap ledger (R1–R14 + C1–C8). This is the *de-facto definition of "not stable yet."* Merged on trunk (PR #771).
3. `docs/cannon/architecture/kernel-owned-write-arm.md` — **CANNON (binding).** The write+arm recovery shape. Bead `tf-c9r9` (Open) is its reference.
4. `docs/architecture/2026-05-31-unified-architecture-mental-model.md` — the post-collapse architecture in one head (3 primitives: Workflow+Activity, DurableTable, Signal).
5. `docs/sdds/SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS.md` — authority for the §4 kernel/gateway/sandbox split, read-side no-drift invariant, MCP port-forward, misuse-resistance. **Design only; no code landed.**
6. `docs/sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION(_PREFLIGHT).md` — the schema-collapse (largely executed by #765, sanctioned).
7. **`packages/tiny-firegrid/docs/methodology.md`** + **`docs/runbooks/firegrid-effect-tracing.md`** — the simulation discipline (airgapped driver, trace-as-evidence, no vitest verdicts). Required before touching any sim (`tf-ll90.11`/`.14`/`.15`).
8. **`docs/recipes/README.md`** (+ `agent-to-agent-observation.md`, `runtime-permission-resume.md`, `durable-webhook-facts-and-wait-for.md`) — the **composability canon**: before building ANY wrapper/connector/channel/auth/observer, check here — most are a `ChannelTarget`+`IngressChannel` binding on existing primitives ("Do Not Reimplement"). **`docs/recipes/_lift-candidates.md`** — the catalog of CORE sim patterns to rebuild + their homes (`tf-ll90.11` reference). And `docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md` for schedule_me/wait_for *shapes* + the "no new coordination primitives" review bar — **caveat: pre-unified; mine its shapes, not its `RuntimeIngressTable`/`DurableDeferred` mechanisms (superseded by the signal primitive).**
9. Caveat: `unified-subscriber-kernel.md` "What stays" wrongly retains `composition/`+`capabilities/` (#765 deleted both), and `shape-c-vs-shape-d.md` Ground-Truth cites deleted `subscribers/*` paths. Treat `unified/` docstrings as **aspirational, not evidence of wiring** (e.g. `host.ts:13-24` claims recovery wiring that does not exist).

## 2. The honest state, one paragraph
`sim/unified-kernel-validation` is a **validation skeleton, not a production cutover** (the branch's own framing + the audit). **Nothing is merged** — #765 is an open draft → `main`; 11 feature/spike PRs (#770–#781) are open drafts against the trunk, all CI-red (`UNSTABLE`), several stacked on each other. `main` and the trunk are **both unprotected** (merges are *not* CI-gated; the drafts are just author-WIP). The substrate shape is pinned + sim-validated; **the remaining work is almost entirely production wiring the skeleton never lifted** — plus finishing the green-up and merging the stack. There is **no hidden decision gate**; the path is ordinary engineering.

## 3. Verified current state (grounded; cite before trusting)

| Capability | Status | Evidence | Remaining |
|---|---|---|---|
| schedule_me delivery | **UNWIRED** (timer-only) | `unified/subscribers/scheduled-webhook-peer.ts:64-95` returns `{scheduleId,firedAt}`, no relay | re-inject prompt signal on fire |
| cancel/close | **UNBUILT** | schemas `protocol/agent-tools/schema.ts:489/:519`; zero consumer; no `HostKernelWorkflow` anywhere | build kernel consumer → terminal |
| terminal-completion relay | **UNBUILT** (process leak) | body parks `runtime-context.ts:103-124`; nothing emits `kind:terminal`; `codec-adapter.ts:117` skips it | observe Terminated/TurnComplete → terminal signal → deregister |
| recoverPendingSignals | **UNWIRED** | defined `unified/signal.ts:196`; zero prod callers; not in `FiregridHost` (`host.ts:233-276`) | wire into FiregridHost startup |
| read-side channels | **STUBBED** (empty) | `unified/channel-bindings.ts:444-489` (Stream.empty / empty arrays) | relocate to `channels/` + real reads |
| parent→child agent_output | **DRAFTED-UNMERGED** | zero refs on trunk; in PRs #774/#778 | land + host-wire |
| mcp-host (FiregridMcpServerLayer) | **DRAFTED-UNMERGED** | absent on trunk; in PR #770 (WIP slice 1/4) | port + merge |
| §4 kernel/gateway/sandbox split | **DESIGN-ONLY** | SDD #767; `unified/` not yet split | build the split |
| `authorities/` deleted | **DONE** ✓ | dir absent; commit `9a89ba8a2` | none |
| spawn tool = await-terminal/Legacy | **CONFIRMED** | `schema.ts:283-314` (`session.spawnLegacy`, `terminalState`) | (design choice if/when a handle-shaped variant is wanted) |
| `unified/` test coverage | **NONE** | no `*.test.ts`; only the tiny-firegrid sim | dedicated tests + C1–C8 re-tests |
| CLI/bin entrypoints | **BROKEN** | `packages/cli/src/bin/*` subprocess into deleted `runtime/src/bin/*` | fix or re-home |
| `@firegrid/host-sdk` | `export {}` | emptied by #733 delete-first (not #765) | decide: refill vs delete |

## 4. Concrete PR / CI / branch facts (2026-06-01)
- **Trunk #765 CI:** Typecheck ✅; Tests ❌ (1 test — `protocol/test/channels/session-permission.test.ts:21`, `offset` ParseError); Effect-diagnostics ❌; Lint ❌; Semgrep ❌.
- **Green-up #772** (open, **non-draft**, → trunk): Tests ✅ + Typecheck ✅, but Lint/Semgrep/Effect-diag still ❌. Unmerged. ("green-up" ≠ fully green — verify gates, don't trust the title.)
- **Open PRs (all UNMERGED, all `UNSTABLE`, all draft except #772):** #770 mcp-host · #772 green-up · #773 spike(.44 emitter-durability) · #774 parent-child(.8) · #775 spike(.46 cancel-mediation) · #776 cutover SDD · #777 G1(.33) · #778 .9 (stacked on #774) · #779 ToolResult arm(.41) · #780 intent-observer(.42, stacked on #777) · #781 retention(.43, stacked on #777).
- **Merged to trunk already:** #766, #767, #768, #769, #771 (docs/discipline/audit).
- **Branch protection:** `main` and trunk are **both unprotected** — `mergeStateStatus=UNSTABLE` means *mergeable-but-CI-red*, not blocked.
- **`#765` → `main`: not merged** (validation-skeleton; D1 = not until the backlog below lands).

## 5. The backlog — epic `tf-ll90` (tiered; `br list` it)
**S0 — make the trunk *honestly* green (the green milestone; hard-gated on sim-honesty)**
- `tf-ll90.1` (P0) finish green-up (lint/semgrep/effect-diag remainder + the offset test) — `project_tf_r06u5_trunk_greenup.md`; PR #772. **blocked-by `.15`** — see §12.
- `tf-ll90.2` (P1) read-side relocation `unified/`→`channels/` (clears R4/R5 + the table-discipline semgrep at once).
- `tf-ll90.15` (P1) **★ sim-enforcement CI gate** (shape/entry/import locks + remove vitest + R2/R3 fix) — **hard-gates `.1`**; without it "green" is forgeable. Lane 3, critical-path-first.
- `tf-ll90.16` (P1) **enforcement-surface audit** (`scripts/` + `.dependency-cruiser.cjs` + `.effect-diagnostics-baseline.json` + eslint/semgrep) → ALIGNED/STALE/REALIGN; **tells `.1` which red gates to SATISFY vs RETIRE** (don't grind a dead gate green). Lane 4, read-only.

**S1 — build the dropped capabilities (share the kernel-write-arm shape; plan in PR #776)** — *NOTE: #773/#775 were NON-airgapped and did NOT prove it; build with real airgapped sims (`.11`/`.14`) per `tf-ll90.15`.*
- `tf-ll90.3` (P0) recoverPendingSignals → FiregridHost + shared terminal-emit foundation (CANNON, R14).
- `tf-ll90.4` (P0) cancel/close control plane + HostKernelWorkflow (R2).
- `tf-ll90.5` (P0) terminal-completion relay — fix the process leak (R3). *Shares the emit surface with .4 — build once.*
- `tf-ll90.6` (P0) schedule_me delivery (R1).
- `tf-ll90.14` (P0) **real-agent e2e proof** on the unified kernel (env-gated live ACP/codec; the kernel has only run against fake-codec) — the definition of done.
- *(parent→child output R7 was here — **moved to the deferred VISION epic `tf-qne2`**; it's multi-agent coordination, not core single-agent stabilization.)*

**S2 — separation + completeness**
- `tf-ll90.8` (P1) §4 kernel/gateway/sandbox split + ProductionCodecAdapter tri-section + two registries + AcpStdioEdge promotion (also clears the workflow-classification semgrep). **Scope incl. reconciling ALL `runtime/src/` sibling dirs vs the mental-model** — delete the pre-unified residue still present (`capabilities/`(1), `producers/`(1); classify `events/`/`transforms/`/`_archive/`), fold survivors into the 3 tiers. Couples Lane 4's dep-cruiser tier-rule audit (`.16`) — a stale dir's tier-rule retires with it.
- `tf-ll90.9` (P1) mcp-host port-forward — land #770 (R6).
- `tf-ll90.10` (P2) loadSession transcript-fold + flip `loadSession:true`.

**S3 — coverage, entrypoints, cutover**
- `tf-ll90.11` (P1) dedicated `unified/` tests + C1–C8 re-tests.
- `tf-ll90.12` (P2) fix CLI/bin + decide `@firegrid/host-sdk` fate (+ confirm R10 orDie, R12 runs-family).
- `tf-ll90.13` (P1) **critically review** each core draft (do NOT assume-good), merge the sound ones in dep order, then **#765 → main** (the real ship). See §13 for which drafts are core vs shelved.

## 6. Actual blockers — and what is NOT a blocker
- **Real:** the work in §5 is unbuilt/unmerged. That's it. It's engineering, sequenced by the kernel-write-arm shape (S1 shares one terminal-emit surface; build once, per PR #776).
- **NOT blockers (fabricated earlier — do not reinstate):** there is **no CI merge-gate** (branches unprotected); there is **no "merge-gating decision"** for anyone to make; `tf-6jdb` (upstream @effect/rpc PR) is **unnecessary** — `McpServer` takes any `RpcSerialization`, and the single-response fix already exists firegrid-locally as a custom serialization (the `.28`/`MCP_TRANSPORT_COMPAT.1` wrapper); the `.48` spawn-handle reshape is a *future* design choice, not pressing.

## 7. Settled vs open decisions
- **Settled:** D1 — #765 is a validation skeleton; **do not cut over to `main`** until S0–S2 land. (Validation strength is white-box; the audit is the ledger.)
- **Genuinely open (small, not blocking):** whether to refill or delete `@firegrid/host-sdk` (with `tf-ll90.12`); whether to add a handle-shaped spawn variant (only when someone builds spawn). D3 (acp-core-v1 conformance gate) is **paused** — adapters already give a working event plane.

## 8. Mistakes from the prior session — do not repeat
- **⚠️ Do not assert a constraint as fact without verifying it.** The prior run invented a "merge gate" (assumed branch protection — there is none), named non-existent mechanisms (`failureMode`, a `Workflow.make` "classification annotation"), and treated bead state as truth (cited `tf-6cdy` as done while it was Open). Each was caught by the user. **Verify against git/code/CI/docs before treating anything as load-bearing**, especially a "blocker" or "decision for the human."
- **Don't say "shipped" for unmerged drafts.** Distinguish merged / drafted-unmerged / spiked-in-isolation / designed-only / unbuilt. The prior digest called a stack of red draft PRs "shipped."
- **The bead store is a graveyard** (490 issues, 392 closed) with stale pre-unified entries mixed in. Treat `br` as a tracking aid, **not** authoritative current state; re-derive from code. The `stabilize-unified` epic (`tf-ll90`) is the curated live view.
- **Stale-checkout hazard** (from the 2026-05-22 OLA handoff, bit twice there too): `git show <branch>:<path>` or sync before asserting code state.
- **Don't run a big autonomous fan-out.** The prior session's unattended multi-agent loop (6+ check-ins, 4 lanes) produced mostly unreviewed / wrong-layer / non-airgapped output — *every* PR the user spot-checked had a defect; the value came from the human audits, not the autonomy. Drive the 3 lanes in tight verified increments: confirm-plan-before-build, critically review each output, no fire-and-forget. Resist re-arming a long check-in loop.
- **Keep research separate from decisions; falsify requirements before satisfying them** (OLA handoff). Don't manufacture a decision queue for the human.

## 9. Operating mechanics (carry forward)
- **Worktree discipline:** one bead = one worktree = one branch off the trunk (`origin/sim/unified-kernel-validation`, NOT `main`); never the primary checkout. `bash scripts/task-enter.sh <bead> <slug>`. **Note:** the primary checkout may currently be on `sim/unified-kernel-validation` (guard-blocks commits) — revert it to `main` and work in worktrees.
- **Dispatch:** `bash scripts/cmux-dispatch.sh <lane> - < brief.txt` (stdin, never inline `$()`/backticks — zsh substitutes them). Brief = READ / SCOPE / ACCEPTANCE, named files only, grep/lint proof in acceptance.
- **Lane sweep:** `bash scripts/lane-sweep.sh --workspace workspace:2`. `running=false` + identical state across sweeps = a stalled (queued-unsubmitted) lane → re-dispatch (the script submit-and-verifies).
- **Prefer reuse/relocation over new substrate** (the FK-not-table, relocate-to-channels lessons). **Don't reinvent `@effect/ai`/`@effect/rpc`** (the McpServer lesson).

## 10. Pre-unified beads to review-and-likely-close (NOT closed blind — verify first)
These are pre-unified-era open beads that *probably* are superseded by #765 but I did not close without verification: `tf-6hqx`/`tf-f9n1`/`tf-up1v`/`tf-z8wq` (Wave-D-A/target-tree physical moves into dirs #765 deleted), `tf-r1mv` (Shape-C guard suite), `tf-wku1` (DurableTable any-leak — may still be real), `tf-xory` (test-infra — may fold into `tf-ll90.11`), `tf-8aw5`/`tf-rqyh`/`tf-elm3` (ACP-edge primitives — fold into `tf-ll90.4`/`.8`/`.10`), `tf-a31z`/`tf-wf43` (coordination showcase — superseded by the coordination SDD). Confirm against the unified tree, then close or fold.

## 11. Useful commands
```
br list --pretty | grep stabilize-unified          # the live backlog
gh pr checks 765 ; gh pr checks 772                 # trunk + green-up CI
git show sim/unified-kernel-validation:<path>       # read the trunk's actual code
git log --oneline -15 sim/unified-kernel-validation # what's actually landed
```

## 12. Single next action
**The "green trunk" milestone is HARD-GATED on sim-honesty.** `tf-ll90.1` (green-up) is now **blocked-by `tf-ll90.15`** (the sim-enforcement CI gate) **blocked-by `tf-ll90.11`** (rebuild the sims to pass it). A green trunk on top of a forgeable sim harness is a *false green* — so "make CI green" is not done until the enforcement is a CI gate AND every sim conforms to the `index/driver/host` shape with a client-sdk-only driver. So the first critical work is **both**: the production gate-fixes (`.1` mechanical + `.2` read-side relocation) **and** the sim-enforcement + rebuild (`.15` + `.11`) — they land together as "honest green." Only then S1 (the kernel-write-arm cluster per PR #776), built sims-first on a trunk whose evidence model is finally trustworthy. Nothing waits on a decision — it's all engineering — but the order now puts sim-enforcement on the critical path, not in parallel cleanup.

## 13. Draft-PR disposition + deferred VISION (scope discipline — READ THIS)
The prior session conflated **core single-agent kernel stabilization** with the **multi-agent / gateway VISION**. They are separated now. A single durable agent session serving Zed/ACP needs **none** of the vision work.

**⚠️ NONE of the draft PRs have had an independent code review.** The prior session's "slice confirms" were author-driven dialogue, not review, and missed real issues (e.g. #770's only review activity is Gurdas's *unaddressed* comment flagging `tool-error.ts` as reinventing `@effect/ai`). **Treat the entire stack as unvetted — assume nothing is sound until reviewed**, including the "core" ones below.

**Core drafts — review critically (do NOT assume-good), then merge as their beads land:**
- **#770** mcp-host (agent reaches its tools) · **#772** green-up · **#776** kernel-write-arm cutover SDD/plan.
- **#773 / #775** — tiny-firegrid "spikes" (wire-path relay / cancel-mediation) that **VIOLATE the airgap methodology and are NOT valid evidence.** #773 imports `effect-durable-operators` + `@durable-streams/server` directly (it's a raw `test/` file, not even a sim); #775 wires `@effect/workflow` + a `fake-codec` + the stream server. **Neither imports `@firegrid/client-sdk`** — neither drives over the public client↔durable-streams seam. They prove hand-wired internals behave, NOT the composed system (methodology §"What counts as a simulation" + §"Static airgap enforcement"). **Do NOT cite them as de-risk for S1.** The dep-cruiser airgap gate has HOLES that let them through (verified `.dependency-cruiser.cjs:657-726`): R3 test-airgap's `to`-list omits `effect-durable-operators`/`@durable-streams/server`, R2 sim-airgap omits `@effect/workflow`, there's no verdict-shape/vitest gate, and the main `unified-kernel-validation` sim is grandfathered out entirely — fix all of it in `tf-ll90.15` (the anti-cheat is leaky, not absent; "sims are evidence" is only as trustworthy as this). **The un-cheatable mechanism is specced on `tf-ll90.15`:** a sim is *exactly* `{index.ts, driver.ts, host.ts}` (shape-lock via the layout-check), `index.ts` must `export default defineSimulation({host, driver})` (the only entry `runSimulation` runs), and per-file eslint import-locks — critically **`driver.ts` forbids ALL relative imports** (only `@firegrid/client-sdk`+`effect`), which closes the value-import cheat where `driver.ts` reaches `./host.ts` for a substrate handle (the `Effect<…, Firegrid>` type-airgap doesn't catch a concrete value-import). None of the 5 current sims follow this shape — rebuilding them to it (with `tf-ll90.11`) *is* the enforcement. The kernel-write-arm cluster (S1) is therefore **NOT actually de-risked** — build it with *real* evidence: a proper airgapped sim (client-sdk driver + composed host, only durable-streams between) OR real tests in the owning package. PR #776 (the cutover plan) inherits this — its "spike-proved" basis is invalid.

**VISION drafts — SHELVE (do NOT merge). Tracked under deferred epic `tf-qne2`:**
- **#774 / #778** — parent→child agent_output (multi-agent coordination). Not core; never a shipped capability (in-progress `#746/#748` coordination work that #765 deleted).
- **#777 / #779 / #780 / #781** — Brookhaven external-consumer cluster (scoped-read auth, ToolResult-arm, intent-observer, retention). Speculative future Roblox consumer.
  - **These were transcribed uncritically from a consumer's `[BRIDGE]` wishlist — most are special-casing what's already composable.** Do NOT build them as specced:
    - **#777 edge-auth is WRONG-LAYER** (bespoke 1758-line `packages/edge-auth/`). Correct = a **thin Electric shape-proxy** (`electric.ax/docs/sync/guides/auth` + the `electric-sql/electric` proxy-auth example): validate the bearer token, set the scope **server-side** (`where`/table/columns the client can't influence), inject the source secret, **forward to the durable-streams shape endpoint**. ~1 route.
    - **#780 intent-observer is UNNECESSARY.** Submitting a prompt/permission is already an input the kernel consumes (`promptScoped`/`respondScoped` append a durable input the session workflow processes). An external client should append to the **existing input surface** (through the auth proxy, in the kernel's real input schema) — the kernel consumes it unchanged. No parallel "intent" stream, no `{kind}`-record protocol, no translator observer. Origin/policy validation is the proxy's job.
  - **The minimal real shape, if an external poll-only consumer is ever needed:** (1) a thin auth/scope proxy in front of the durable-streams shape endpoint (reads), (2) the client appends to the existing input surface (writes — no bespoke bridge), (3) maybe a publish MCP tool. Everything else collapses into existing primitives.
  - **The discipline this teaches:** the consumer-contract is a *consumer's guesses at host glue*, not requirements. For each `[BRIDGE]` item ask "is this already composable from the client ops + durable-streams + a thin proxy?" — it almost always is.

**The discipline that prevents recurrence:** before scoping work, ask "does a *single durable agent session* need this to work + merge?" If no, it's vision → `tf-qne2`, deferred. Don't let the gateway/coordination vision leak back into the stabilization epic.

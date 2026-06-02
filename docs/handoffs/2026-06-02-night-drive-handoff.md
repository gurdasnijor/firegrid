# Handoff — post night-drive (factory loop proven end-to-end)

- **Date:** 2026-06-02 (end of the autonomous night drive)
- **Main verified at:** `origin/main` HEAD `da2d4104a` (canonical, unprotected)
- **For:** the next coordinator
- **Supersedes:** `2026-06-02-bindings-cli-handoff.md` for live state (that doc's `tf-0awo` snapshot is now stale — most of it merged)

---

## 0. The one load-bearing thing

**The factory vision is re-proven end-to-end on the post-§12 substrate, and the
single most important *open* gap is the terminal-completion relay.**

- ✅ **Proven:** the factory loop runs trigger → plan → `session_new` (delegate a
  child: createOrLoad→prompt→start) → child runs → parent observes child output
  via `wait_for`, all through the public client/channel surface. Evidence: the
  capstone sim re-run (`tf-0awo.30`, PR #834, merged) + the cross-agent
  delegation sim (`tf-0awo.31.3`, PR #835, merged).
- 🔴 **Top open substrate gap (P0, verified twice):** `tf-r06u.36` / `tf-ll90.5`
  — **terminal-completion relay**. `unified/observers.ts` `triggerForObservation`
  has **no `case` for `Terminated`/`TurnComplete`**; `unified/subscribers/runtime-context.ts`
  parks on a `kind:"terminal"` signal that **nothing emits**; so `deregister`
  (which exists, `codec-adapter.ts:518`, closes the per-context Scope + kills the
  process) **never fires** → **per-context process leak**, silent. This gates a
  production cutover. **Start here.**

---

## 1. What landed this session (all on `main`)

The `tf-0awo` "Bindings & CLI / §12 composition" epic largely completed:

- **§12 cutover (#826)** — the Effect-shaped host-composition surface:
  `FiregridRuntime(spec, adapter)` + `DurableStreams` floor (closed `StreamName`
  set, no `contextId` param) + protocol-owned browser-safe **read views**
  (`packages/protocol/src/launch/views.ts`) + `authority.ts` collapse (−430,
  kept the live multi-host layer + the canonical `durableStreamUrl` encoder,
  dropped the dead bidirectional decode machinery). Net −872 lines. Collapsed
  `_compose`/`host` into one constructor; repointed deletions root-and-branch
  (per-context output path, snapshot channels, `compareJournalRows`, the
  abandoned per-context Live).
- **`@effect/cli` CLI (#830)** — `firegrid run`/`acp`/`host`/`start` as
  `Command.make`/`withSubcommands`/`run` + `NodeRuntime.runMain` (mirrors
  `repos/effect/packages/cli/examples/minigit.ts`); `start` bin added.
- **§3.2 fixes** — Fix A observer gate (#821, `observers.ts:74`
  `providerExecuted` → don't dispatch provider-executed tools) + typed-send net
  (#828, `AgentSessionService<K>` makes an unsendable inbound kind a *compile*
  error).
- **#831 — the delegation executor lowering:** `session_new`/`session_prompt`/
  `session_cancel`/`session_close` now lower onto the unified MCP executor
  (`mcp-host/tool-dispatch.ts`, real host channel targets — createOrLoad→prompt→start).
  This is what unblocked the capstone.
- **Proof suite re-established** (all #765-deleted; methodology-clean: driver
  imports only `@firegrid/client-sdk`, host composes the real `FiregridHost`,
  trace is the deliverable, prose findings): **capstone** (#834), **cap-1**
  verified-webhook→`wait_for` (#833), **cap-3** idempotent one-intent (#832),
  **cap-4** cross-agent delegation (#835).
- Plus the test/tooling gates: operationId-uniqueness, the Zed-trace proof, the
  arch-graph freshness gate, and the **`task-exit` preflight gate** (#827 — lanes
  must `pnpm preflight` green before push; this killed the recurring
  Effect-diagnostics CI churn).

---

## 2. Backlog state (groomed + verified against `main`, 2026-06-02)

`Total 569 · Closed 484 · Open 52 · Blocked ~21 · Deferred 20 · In-progress 0`.

A 4-agent verification sweep checked every open/blocked/deferred bead against
current `main`. **The remaining open beads are genuine forward work** (verified —
not stale). Closed this groom with evidence: `tf-ll90.13/.17/.21/.8.1/.8.5/.9.1`,
`tf-c8cy`, `tf-0awo.10`. The big epics (`tf-ll90` unified-kernel, `tf-r06u`
gateway) stay open because their children are real.

### Verified OPEN gaps — priority order
1. **`tf-r06u.36` / `tf-ll90.5` (P0)** — terminal-completion relay / process leak
   (see §0). Wire `Terminated`/`TurnComplete` observation → terminal signal →
   `deregister`. Couples `tf-ll90.5.1`/`tf-r06u.47` (terminal-emission surface)
   and the shape-c-terminal-ordering RUN-sim rebuild.
2. **`tf-r06u.8`** — parent→child FK authority is **unwired**: `session_new`
   passes `parentContextId` in tool metadata (`tool-dispatch.ts:424/443`) but
   `contexts.insertOrGet` is **not called in the unified path** → child context
   rows aren't inserted. Real gap, not a test re-home.
3. **`tf-r06u.9`** — `spawn` is **not lowered** onto the unified executor
   (`tool-dispatch.ts` default case "not yet ported"); `wait_for`/`session_new`
   are done. (`spawn` contract reshape is `tf-r06u.48`, a user decision.)
4. **`tf-0awo.6`** (unblocked this groom) — client read-path still reads the
   durable-table facades directly (`client-sdk/firegrid.ts:~932-933`); the §12
   views exist but aren't the client's read source. Repoint onto
   `runtimeContextsView`/`runtimeEventsForContextView`.
5. Coverage / hygiene (real): `tf-ll90.11` (airgapped CORE-proof RUN sims),
   `tf-ll90.18` (classify 6 `Workflow.make` sites, C2 guard), `tf-ll90.20`
   (dep-cruiser R2 subpath form), `tf-r06u.29/.30/.39` (airgap + test relocation
   + the ~1500-line coverage rewrite), `tf-r06u.14` (codec/runtime registry —
   high multiplier), loadSession (`tf-ll90.10`, `tf-r06u.7/.16`).

### Blocked (~21) and Deferred (20) — verified correctly-sequenced
- The `tf-tvg1` → `tf-jpcg`/`tf-vfq9`/`tf-vrz6` → `tf-9rpy` chain is genuinely
  staged (greenfield keyed-handler validation must precede the cutovers; two
  missing durable primitives — atomic multi-row append, F3 wakeup — gate
  `tf-vrz6`). Deferred beads all have valid forward/contingency/external reasons.
  None are stale-blockers. Leave as-is.

### Decisions waiting for the PO (do NOT decide autonomously)
- **`tf-0awo.17`** — daemon embedded-default **A/B** (A: require
  `DURABLE_STREAMS_BASE_URL` w/ a great error pointing at `firegrid run`/`acp`;
  B: stable local daemon). Held since the bindings-cli session.
- **`tf-0awo.33`** (verified ergonomic, SUPPORTS) — `wait_for` over
  `session.agent_output` requires `afterSequence` (no default); a bare agent call
  fails schema-decode (the capstone planner recovered with `-1`). Default it to
  `-1` (read-from-start) in the agent-tool projection?
- **`tf-r06u.48`** — `spawn` contract: keep await-terminal, or reshape to a
  handle-shaped non-legacy variant?
- **Raise the capstone sim's 80-output cap** to watch the full merge-signoff tail
  (the loop halted there — a sim limit, not a production gap).

---

## 3. Operating discipline (evergreen — these bit this session)

- **Confirm `git log origin/main` HEAD actually moved before closing a bead or
  dispatching downstream.** `gh pr merge` can report success while the merge is
  blocked (DIRTY/conflict). I closed a bead + queued a re-run on a merge that
  hadn't landed; caught and reversed it.
- **A schema/tool/symbol *existing* is not evidence the behavior is *wired*.**
  Verify the actual call/lowering. The capstone sim caught `session_new`
  "advertised but not lowered" that a schema-grep declared done; the same
  distinction is why `tf-r06u.36` (terminal relay) is open despite `deregister`
  existing.
- **Sims must exercise real production code (no backdoors).** Driver imports only
  `@firegrid/client-sdk`; host composes the real `FiregridHost` from
  `@firegrid/runtime/unified`; the **trace is the deliverable**, findings are
  prose (`packages/tiny-firegrid/docs/methodology.md`). A sim that halts honestly
  on a gap is a valid result.
- **Double-check a candidate substrate gap against source before beading it —
  most collapse** (`tf-0awo.28`: the dark-factory "gaps" were by-design /
  shipped / relocated). The ones that survive verification are real
  (`tf-0awo.32` fixed; `tf-r06u.36` open).
- **The conflict-tax:** every merge moves `main` and re-conflicts the other
  in-flight PRs (DIRTY). Merge in tight batches or expect a rebase round per
  merge; tell a DIRTY PR's lane `git merge origin/main` + preflight + push.
- **Beads tooling:** `br list --json` truncates — use `br list --status <s>`
  (text), `bv --robot-insights`, or `br stats` for authoritative counts.
  `BEADS_DIR=$HOME/gurdasnijor/.beads`.
- **Lanes:** `bash scripts/cmux-dispatch.sh <label> - <<'EOF' … EOF` (quoted
  heredoc; never inline backticks/`$()`). Base off `origin/main`; `task-exit`
  opens a draft PR (that IS the gate); coordinator gates every merge. Every
  dispatch carries a `tf-*` bead and the preflight rule.

---

## 4. Suggested next actions
1. **`tf-r06u.36` / `tf-ll90.5`** — terminal-completion relay (P0, process leak).
   Build a methodology sim that drives a session to process exit (`Terminated`)
   and asserts `deregister` fires + the process is reaped; then wire the
   observer→terminal-signal→deregister leg. **Trigger on `Terminated` + explicit
   cancel/close ONLY — NOT `TurnComplete`** (per-turn; would break multi-turn —
   verified by 3 reviews, see §6). The two beads are the same leg → dedupe to one.
2. Take the PO's calls on `tf-0awo.17`/`.33`/`tf-r06u.48` + the sim cap.
3. `tf-r06u.8` (FK authority) + `tf-r06u.9` (`spawn` lowering) → then the full
   factory loop runs without the 80-output cap masking the tail.
4. `tf-0awo.6` client read repoint onto views (small, unblocked).
5. Re-publish the OSS mirror (`pnpm publish:oss`) when a batch is ready — main is
   ahead of `smithery-ai/firegrid`.

---

## 5. Learnings — from the §6 dark-factory handoff (still govern) + this drive

Canonical compiled audit: `docs/analysis/2026-06-02-architecture-health-check.md`.

`docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` is the canonical record of
how a coordinator goes wrong. Its lessons governed this drive and were repeatedly
*validated*; read it. The load-bearing ones, with how they played out here:

- **The META-PROCESS RULE (§ "THE META-PROCESS RULE"):** *don't fill a data gap
  with an assumption — locate the gap, instrument/trace it, run a sim to GATHER
  the data, then conclude from the data.* This is exactly why the capstone sim
  (not a grep) caught `session_new` "advertised but not lowered": a schema-grep
  said done; the trace said blocked. **The sim is the instrument.**
- **§9f the 60-second-grep heuristic:** *"what single grep/file-read would refute
  this?" — do it before merging or citing.* Applied per merge (true-delta vs
  merge-base) and per bead (source-cite before close).
- **§8 "the list collapsed on re-check":** the §6 "actual issues" list collapsed
  when challenged for data (~5 confident conclusions on unverified inference).
  This drive applied it *prophylactically*: the dark-factory candidate gaps were
  re-checked against `main` and **collapsed** (recorded `tf-0awo.28`); only the
  ones that survived verification got beaded (`tf-0awo.32` fixed, `tf-r06u.36`
  open). **Schema/tool existing ≠ behavior wired** is the same lesson at the
  symbol level (`tf-ll90.17` done vs `tf-r06u.36` open — both had the symbol).
- **§9a polish is a danger signal:** a well-written closing artifact asserting a
  "terminal/architectural" conclusion is a *yellow* flag — demand the data.
- **§9b throughput-mode is the trap / §9c self-built metrics become theater:**
  burning a PR queue while the load-bearing question is unsettled is motion, not
  progress; a metric satisfied by an artifact you also wrote is a prompt to read
  the trace, not an answer.
- **§9d lane reports land as hypotheses, not findings:** apply the triage rubric +
  the 60-sec source check before promoting. This drive's groom did exactly that —
  4 verification agents returned *verdicts with evidence*; the coordinator
  re-checked and did the closes (one agent's "close `tf-0awo.6`" was overridden by
  another's line-cite).
- **§8 KNOWN MISDIAGNOSIS — do NOT resurrect:** the `DurableTable.rows()` "live
  tail loses pre-attach facts" claim is *false* (source-cited refutation in that
  handoff). Don't re-derive it.

### This drive's own do / do-not (earned, mostly the hard way)

**DO**
- **Confirm `git log origin/main` HEAD actually moved** before closing a bead or
  dispatching downstream. (`gh pr merge` reported success on a DIRTY PR — I closed
  `tf-0awo.32` + queued a re-run on a merge that hadn't landed; reversed it.)
- **Build a sim when a grep can't settle behavior.** The capstone surfaced the P0
  delegation gap a schema-read declared done.
- **Have verification agents REPORT verdicts + evidence; the coordinator does the
  mutations.** Read-only fan-out + coordinator-gated closes caught a cross-agent
  conflict (`tf-0awo.6`).
- **Double-check a candidate substrate gap against source before beading it** —
  most collapse.
- **Use authoritative bead reads** (`br stats`, `bv --robot-insights`,
  `br list --status <s>`); **never grep-count `br list --json`** — it truncates
  (this masked stale beads twice).
- **Expect the conflict-tax:** every merge moves `main` and re-conflicts in-flight
  PRs (DIRTY). Merge in tight batches; tell the lane to `git merge origin/main` +
  preflight + push.
- **Enforce `pnpm preflight` before push** (the `task-exit` gate, #827) — every
  early PR failed CI on Effect diagnostics from skipping it.

**DO NOT**
- **Don't trust a `gh pr merge` exit code** as proof of merge — verify HEAD.
- **Don't bulk-close stale-looking beads on inference.** The open/ready/in-progress
  sets were *mixed* (done + superseded + genuinely-open); each needs its own
  evidence. (E.g. `tf-r06u.36` looked stale-arc but is a live P0 process leak.)
- **Don't read "schema/tool/symbol exists" as "shipped."** Verify the call/lowering.
- **Don't decide PO-owned questions autonomously** (`tf-0awo.17` daemon A/B,
  `tf-0awo.33` default, `tf-r06u.48` spawn reshape) — flag, don't choose.
- **Don't merge on a green CI badge** — review the true delta vs merge-base, and
  for sims run the methodology check (driver `client-sdk`-only, host real
  `FiregridHost`, no fake adapters/stubs, trace-is-deliverable, no verdict object).
- **Don't fan out a big autonomous build against an unvalidated decomposition** —
  gate the keystone on a spike first (the §12 cutover was gated on the modularity
  compile-spike before any lane built it).

---

## 6. RuntimeContext keyed-subscriber reconcile — proposal + 3 reviews + the validation chain (added 2026-06-02)

**What this is.** The shipped `RuntimeContext` body parks for the entity lifetime
(`Workflow.suspend`); canon (`runtime-design-constraints.md`, C2/C5) bans exactly
that. A proposal frames the PO decision; it does **not** decide it.

**Artifacts (read in this order):**
- **Proposal (v4):** `docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md` — **PR #844** (open, not merged). 5 diagrams, source-cited.
- **Reviews (all *amend*, all source-verified by the coordinator):** `docs/reviews/2026-06-02-runtime-context-reconcile-proposal-review.md` (#842, Agent0) · `docs/reviews/2026-06-02-runtime-context-reconcile-review-opus.md` (`tf-1axl`, Opus) · a third "D pressure-test" review (pasted in-session; its findings are folded into v4 §7).

**Where it landed (the decision the PO owns):**
- **§0.1 P0:** the parked body is a canon-forbidden shape (C2/C5) that shipped past
  the dispatchable-canon **SDD Gate** (`runtime-design-constraints.md:558`) with no
  Constraint Check / bridge exception. Blessing it = a real reversal. **PO call.**
- **The live choice is A vs B/C:** mechanism is **settled** (explicit arm =
  write + `engine.resume`, proven by `tf-e5rf`); **shape is open** — per-event
  run-to-completion (A) vs entity-lifetime parked body (B/C).
- **Option "D" (per-turn return-and-re-drive) is NOT on the table yet** — review 3
  source-falsified its mechanism: a *returned* execution (`finalResult` set) cannot
  be re-armed (`signal.ts:150`); `engine.resume`/`tf-e5rf` cover *suspend→resume*
  only. (v3 over-elevated D; v4 retracts it. Calibration note: that was an
  amplification of a tentative Opus idea — the same assume-from-mechanism trap, one
  level up.)
- **Do-now, shape-neutral:** the P0 leak fix (§ below).

**The validation chain (the tiny-firegrid preflight):**
- `tf-tvg1` (IN_PROGRESS, P1) is the synthesis bead → A/B/C verdict + rewrite chain
  + deletion map. Its four child proofs **`tf-4fy3` / `tf-u8w2` / `tf-28b8` /
  `tf-1r0o` are CLOSED** — but they predate the reviews, the synthesis verdict is
  still unwritten, and the groom flagged "no done-evidence" on the closures.
- **GAP the reviews exposed → new bead `tf-c71h`** (P1, blocks `tf-tvg1`):
  *return-and-re-drive* is unproven and the four closed proofs don't cover it. It
  is the load-bearing proof for whether **A is even feasible**. Run it
  (methodology-clean) **before** trusting any A/B/C synthesis.
- Downstream cutover (gated on `tf-tvg1`): `tf-vrz6` (BLOCKED), `tf-w6qj` (OPEN),
  `tf-jpcg` (BLOCKED).

**The P0 leak (`tf-r06u.36` / `tf-ll90.5`, both P0 OPEN — SAME leg, dedupe):**
trigger on **`Terminated` + explicit cancel/close ONLY** → `emitSessionTerminalSignal`
(`channel-bindings.ts:287`) → body's existing `deregister` (`runtime-context.ts:153`).
**EXCLUDE `TurnComplete`** (per-turn; cross-turn registry → would kill the process
after turn 1). Plumbing diff: widen `observers.ts` `CapturedServices` to include
`WorkflowEngineTable` + extract services from `captured` (snippet in proposal §2.2).
Both beads carry this scope-correction comment.

**Open loose ends:** PR #844 + the two review PRs (#842, `tf-1axl`) are **unmerged**
(PO/coordinator call); `tf-1axl`'s review is delivered + folded but **not closed**
(held until its PR lands — confirm `origin/main` HEAD moved first).

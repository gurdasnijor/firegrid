# Handoff — Bindings & CLI epic (`tf-0awo`)

- **Date:** 2026-06-02
- **Main verified at:** `origin/main` HEAD `11b4dfcc8` (canonical; `main` is the integration branch now)
- **For:** the next coordinator driving the schema-projection + CLI-rebuild work
- **Epic (single source of truth):** **`tf-0awo`** (`br dep tree tf-0awo` for the live graph). `BEADS_DIR=$HOME/gurdasnijor/.beads`.
- **Supersedes:** `2026-06-01-stabilize-unified-handoff.md` — that effort (`tf-ll90`, unified-kernel stabilization) is **complete**.

---

## 0. What changed since the last handoff

**The unified kernel landed.** `#765` was merged to `main`; every "UNBUILT/UNWIRED" capability the old handoff listed is now in: `createOrLoad` materializes its context row, cancel/close (`#802`), the MCP host (`#770`), the runtime-context MCP marker auto-provision (`#801`), `recoverPendingSignals` wired, the kernel start/execute/spawn path proven env-robust across 3 envs. **`main` is canonical and unprotected** — the `sim/unified-kernel-validation` trunk is retired (lanes base off `main` now; `task-enter.sh`/`task-exit.sh` default to `origin/main` as of `386be6c36`).

**Current focus = `tf-0awo`:** converge the agent-tool / client-sdk / CLI surfaces onto the protocol schema catalog (bindings project from one source of truth), and **rebuild the CLI** (`run`/`acp`/`start`) that `#765` deleted.

---

## 1. Read first (in order)
1. This doc.
2. `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` — the contract (protocol catalog = source of truth; agent-tool/client/CLI are *bindings*; boundaries enforced by `.dependency-cruiser.cjs`). **Refreshed this session against the live tree** + Effect `Schema` natives.
3. `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_IMPLEMENTATION.md` — the **buildable** spec: the real catalog, `projectTool`/`projectChannelMethod`/CLI field-projection mechanisms, a `session.cancel` worked round-trip, and the file-level slices that map to the `tf-0awo` beads.
4. `docs/sdds/SDD_FIREGRID_CLI_LAUNCHERS.md` — rebuild `run`/`acp`/`start` as **direct runtime bins** (`runtime/src/bin/*`), no `@firegrid/cli` subprocess launcher. `acp` is the Zed external-agent target.
5. `docs/research/tf-r1gz-acp-zed-live-trace.FINDING.md` — the Zed live-ACP proof + the OTel `--cwd`/`--otel-file`/SimpleSpanProcessor fix the CLI must preserve.
6. `README.md` — the public surface (choreography-first, the `wait.*` family, the combinator table, durable-suspension trace examples). **Published to the OSS mirror** `smithery-ai/firegrid` via `pnpm publish:oss` (only `docs/cannon` + README + `packages` publish — see `scripts/publish-oss.sh` ALLOWLIST). Main is currently **ahead** of the mirror; re-publish when a batch is ready.

---

## 2. The `wait.*` family (the load-bearing design this session)
The suspension surface was unified (merged `#805`, `tf-0awo.15`):
- `wait_for(event, prompt?)` / `wait_until(time, prompt?)` / `wait_any(events, prompt?)`; **`sleep` is a thin alias** for `wait_until("+d")`.
- **`prompt?` is the proactivity lever:** no prompt → the wait resolves **inline**; with prompt → the session **suspends durably** and wakes with the prompt as a **new turn** (appended via `HostPromptChannel`, idempotency key `wait-prompt:${toolUseId}` so replay never double-prompts; fails loud if no channel). This subsumes the old `schedule_me`.
- `schedule_me` and `wait_for_any` are **removed**; the client exposes a chainable `firegrid.wait.for/until/any` namespace.
- `spawn`/`spawn_all` are **first-class** (renamed off `…Legacy`, merged `#806`, `tf-0awo.5`).

---

## 3. `tf-0awo` status (snapshot — `br` is authoritative)
**Done:** `.1` catalog decisions · `.5` spawn rename (`#806`) · `.15` wait.* family (`#805`).
**In flight:** Agent1 → catalog cleanup (`.2` `projectTool` helper, `.4` remove the `defineFiregridOperation`/`FiregridOperationEntry` wrapper in `protocol/src/operations/schema.ts`, `.7` `projectChannelMethod`+CLI helpers). Agent2 → CLI (`.8` `runtime/src/bin/_compose.ts`, `.9` `firegrid acp`).
**Open:** `.3` operationId-uniqueness test gate · `.6` client read-path off durable-table facades (the `RuntimeControlPlaneTable`/`RuntimeOutputTable.layer` leak — old `tf-ll90.8.3`) · `.10` `run` · `.11` `start` · `.12` `firegrid` dispatcher · `.13` CLI binding from schema metadata · `.14` proof (reproduce the tf-r1gz Zed live trace + creds-free `run`).

**Decisions locked (on `tf-0awo.1`):** two catalog modules + uniqueness gate; `session.create` (agent, prompt) vs `session.createOrLoad` (app, externalKey) are **distinct**; spawn first-class; the `wait.*` reshape; client read leak is a real boundary fix.
**CLI decision:** direct runtime bins, retire the `@firegrid/cli` launcher (`cli-no-runtime` dep-cruiser rule becomes moot; `runtime/src/bin/**` is the blessed composition tier that may import runtime + client-sdk).

---

## 4. Operating mechanics (current)
- **Base off `origin/main`.** `bash scripts/task-enter.sh <tf-0awo.N> <slug>` (worktree off main; never the primary checkout). `task-exit.sh` opens a **draft PR against main**.
- **Dispatch:** `bash scripts/cmux-dispatch.sh <lane> - <<'EOF' … EOF` (quoted heredoc — never inline `$()`/backticks). Lanes were `Agent1`/`Agent2` this session (fresh sessions).
- **Every dispatch carries a `tf-0awo.N` bead.** task-exit = push + **draft PR**; the **coordinator gates every merge** (review → `gh pr ready N` → `gh pr merge N --merge`).
- **CI gate before merge:** full `pnpm preflight` (lint + lint:dead + lint:dup + lint:deps + typecheck + test + trace seams + check:specs). Don't report green on a subset.
- **Beads:** `br create … --parent tf-0awo`, `br dep add <issue> <depends-on>`, `br update … --status closed --notes`. `--silent` for clean IDs. Children auto-number `tf-0awo.N`.

---

## 5. Lessons (evergreen — fold-forward, these recur)
- **Don't assume in the absence of data — verify against git/code/CI before asserting.** The single most expensive failure mode. A confident "X can't / it's because Y" with no captured evidence is the bug.
- **Source-verify canon before building on it.** The projection contract was substantially stale (referenced deleted `runtime/src/agent-tools/`, renamed `packages/client`, a superseded `DurableDeferred` input path) — big cutovers (#765) silently rot docs. Verify every load-bearing reference against the live tree.
- **PR-base hygiene.** A lane that forks/exits against the wrong base (stale trunk) produces a **giant phantom diff** — `#805` did this (base was `sim/unified-kernel-validation`); retargeted with `gh pr edit N --base main`. When reviewing, compute the **true delta vs current main** (`git merge-base` + diff), not raw `gh pr diff` (which diffs against the PR's possibly-stale base).
- **Calibrated reporting:** merged ≠ drafted ≠ designed ≠ unbuilt. Say which.
- **Reuse over reinvent.** `projectTool`/`projectChannelMethod` collapse hand-wired boilerplate; lean on Effect `Schema` natives (`transform`, `pick/omit/pluck`, `annotations`, `parseJson`, `Union/TaggedStruct`) — `repos/effect/packages/effect/src/Schema.ts`. Don't reinvent `@effect/ai`/`@effect/rpc`.
- **Don't leak substrate to the binding surface.** The client reading `RuntimeControlPlaneTable`/`RuntimeOutputTable` facades directly is the open boundary bug (`tf-0awo.6`); bindings dispatch protocol-owned channels, reads project normalized observations.
- **No false-acks / fail loud.** The recurring kernel-class bug was returning a plausible id/offset without writing the durable row; the `wait.*` prompt-on-resolve and `createOrLoad` materialize both fail loud instead. (There's a deferred hardening bead to make stub channel Lives fail-loud rather than synth a value.)
- **Drive lanes tight.** Confirm-plan-or-review-each-output; gate every merge; don't fire-and-forget a big autonomous fan-out.

---

## 6. Next actions
1. Review + gate Agent1's catalog PRs (`.2`/`.4`/`.7`) and Agent2's `acp` PR (`.8`/`.9`) — they land as draft PRs against main.
2. Then the remaining `tf-0awo` slices: `.3` uniqueness gate, `.6` client read-leak (real boundary fix), `.10`–`.14` (the rest of the CLI + the tf-r1gz proof).
3. When a batch is ready, **re-publish the OSS mirror** (`pnpm publish:oss`) — main is ahead of `smithery-ai/firegrid`.
4. Pick up the deferred fail-loud-stubs hardening when the trunk is quiet.

---

## Update — 2026-06-02 (session 2, mid-epic)

**Main HEAD: `c3e224427`.** `tf-0awo` is **10/15 closed**: `.1 .2 .4 .5 .7 .8 .9 .12 .15 .16` + new `.16`(toolAnnotations). Merged this session: `#805`(wait.*), `#806`(spawn), `#808`(**CLI rebuild** — `run`/`acp`/`host` as direct runtime bins, `@firegrid/cli` launcher retired, embedded `DurableStreamTestServer` default, `firegrid` dispatcher), `#809`(projectTool), `#810`(wrapper removed), `#811`(toolAnnotations), `#812`(projectChannelMethod).

**Local run works now:** `pnpm firegrid -- run --agent codex-acp --agent-protocol acp --secret-env OPENAI_API_KEY --prompt "…" -- npx -y @zed-industries/codex-acp@0.14.0` (the dispatcher → `runtime/src/bin/run.ts`; embeds a server, no env needed). NOT `firegrid:host` (that's the daemon).

**★ OPEN DECISION — `#813` / `tf-0awo.17` is HELD (quality fail).** It made the **daemon** (`runtime/src/bin/host.ts`) default to the *one-liner's* settings: ephemeral embedded server (random port) + **random namespace** (`firegrid-cli-${randomUUID}`). Result = a "daemon" no separate client can connect to and that loses state on restart. The embedded default is right for `run`/`acp` (self-contained), **wrong for the daemon.** Pick a direction before merging:
- **(A, recommended)** daemon keeps *requiring* `DURABLE_STREAMS_BASE_URL`, but with a great error pointing at `firegrid run`/`acp` for the self-contained path.
- **(B)** real local daemon: **stable** server (fixed/known port) + **stable** namespace (`firegrid-local`) so a separate client can connect.
Re-steer Agent1 to the chosen shape; the current `#813` is neither.

**In flight:** Agent1 → `#813` fix (awaiting A/B direction). Agent2 → `.6` (client read-leak: a protocol-owned `FiregridRuntimeReadSource` with an observation-shaped surface; plan-back already confirmed — review its *interface* first) → then `.3` (operationId uniqueness test).

**Remaining:** `.6`, `.3`, `.10`/`.11` (`run`/`start` polish), `.13` (CLI flags via `@effect/cli` — converts #808's interim hand-rolled argv parser; the SDD calls for this), `.14` (live tf-r1gz Zed trace proof), `.17` (per the A/B call).

**★ STEERING LESSON (cost two catches this session — `.16` and `#813`):** do NOT merge on "CI green + the one thing I steered." **Read the actual code/design every time** — `.16` was shallow polish, `#813` shipped an unusable daemon, both nearly merged on a badge check. Lanes are on **plan-back-before-build** for non-mechanical slices (agents message their approach first; I confirm the shape, then they build) — keep that.

**Process notes:** lanes base off `origin/main` (scripts default to it now). PRs come from `task-exit` with a **generic `wip(...)` title** — fix the title/body on review (`gh pr edit`). Watch PR base: a stale-base lane PR shows a giant phantom diff (`#805` did — retargeted with `gh pr edit --base main`); review the true delta via `git merge-base origin/main <head>`. Agent3 (surface:34) is a **dead Codex session** — its work was reassigned to Agent2.

**Housekeeping:** the OSS mirror (`smithery-ai/firegrid`) is **behind main** (README/SDDs updated) — re-run `pnpm publish:oss` when ready to batch-publish.

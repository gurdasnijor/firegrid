# Session Handoff — 2026-05-20 — dark-factory ran §6 live, body-plan SDD drafted

This is a session-arc capture, not a coordinator-state handoff (the latter is `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md`). The intent is to make tonight's process *legible* to a future session — what was tried, what worked, what didn't, and what patterns generalize. Read this BEFORE inheriting from the canonical coordinator handoff if you want the "how" alongside the "what."

## Where the session started

- `COORDINATOR_HANDOFF_s6_dark_factory.md` on main was the inherited state.
- §9g of that handoff framed a codec→Claude-Agent-SDK boundary-span + subprocess wire capture as "the load-bearing deliverable" — a multi-day instrumentation arc to disambiguate 5 candidate causes of `tools/call=0`.
- §9f of that same handoff (the "60-second-grep heuristic") said: *read the pinned source before reaching for instrumentation*. It was framed as a meta-rule, not a substrate task.
- The 2026-05-19 live run had passed Layers 1-3 (model edge, choreography reasoning, durable substrate under live model) but flagged Layer 4 (end-to-end observable proof of each §6 step) as a measurement GAP — `observedToolInputs:['…wait_for:{}']` was the headline anomaly, attributed to a "streaming-JSON parse race in the assertion harness."
- I had just shipped `#438` (tf-ewo runner heartbeat) and was reviewing PRs from other lanes.

## The arc (chronological, terse)

| Step | Output | Reference |
|---|---|---|
| 1 | Refactored heartbeat to Effect-idiomatic Queue + Stream + Ref + `Effect.repeat(Schedule.forever)` per Gurdas's sketch | PR #438 — merged |
| 2 | Discussed wait-pattern enforcement (channels question + brand types) — eventually concluded the right move was the substrate-vs-presentation layer split, not ast-grep | inline conversation; informed later SDD |
| 3 | Took on the §6 critical path. **60-second-grep** against pinned `@agentclientprotocol/claude-agent-acp@0.36.1` + `@anthropic-ai/claude-agent-sdk@0.3.143` from npx cache | `tf-3ek` / PR #441 — codec→SDK source-verified baseline FINDING |
| 4 | 3 of 5 §6 causes settled by source-read alone (cause #2 SDK gap confirmed, cause #4 systemPrompt force-locked, cause #1 ruled out for ACP-mediated path but flagged for native MCP path) | same PR |
| 5 | Drafted P0 spike `tf-s8y` to test the native `.mcp.json` path | bead created with full acceptance criteria + decision rule |
| 6 | Implemented spike (driver-side hand-rolled `.mcp.json` + `.claude/settings.json` + skip the codec marker). ~100 lines | PR #444 |
| 7 | Live-ran spike. **Agent invoked `mcp__firegrid__wait_for` via natural name.** Cause #1 EMPIRICALLY RESOLVED. ALSO surfaced: agent called `Read` on a memory file because the spike accidentally dropped `disableBuiltInTools` along with the MCP advertisement | PR #444 verdict comment |
| 8 | Drafted production codec change splitting the two concerns (MCP advertisement → `.mcp.json`, tool policy → `_meta.disableBuiltInTools`) | `tf-v7t` / PR #446 |
| 9 | Live-revalidated. Better than spike on every dimension (6 × `mcp__firegrid-runtime-context__wait_for` vs 1 × `mcp__firegrid__wait_for`; 0 built-in fallback vs 1) | PR #446 verdict |
| 10 | Trace inspection found a deeper blocker: **claude-agent-acp's `canUseTool` permission gate**. Agent had emitted a fully-formed tool_use block with correct inputs (`CallerFact` stream `darkFactory.facts`) but waited indefinitely for Firegrid to respond to `session/request_permission` | mid-run discovery |
| 11 | Implemented driver-side `forkAutoApprovePermissions` (~70 lines). Hit a scope bug — `Effect.scoped` was closing the fork's scope immediately; fixed by taking Scope from environment, wrapping the driver body in `Effect.scoped` | PR #446 |
| 12 | Live-reran. **`agent-tools=3176` span side appeared for the first time** (was 0 in every prior run). 7 server-side `McpServer.tools/call`. 149 `durable_tools.wait_for.upsert_active`. 78 `wait_router.complete_match`. Substrate engaged. | PR #446 verdict #2 |
| 13 | Initially overstated "factory live" — corrected when trace inspection showed only 1 actual MCP call (the 6 `wait_for` mentions were wire-level streaming `tool_use` blocks, gated on the permission round-trip). Re-narrated honestly | inline; Gurdas flagged the "wait, what's a tight loop here?" question |
| 14 | Found the **bigger reveal**: agent had reached `DARK_FACTORY_FINDING` honest-halt marker. It probed 6 predicate shapes, recognized "consistent with not-yet-matching rather than not-present," named the missing primitive class precisely | trace text-content extraction |
| 15 | Captured the agent's complete reasoning trail in `tf-h1gm` FINDING | PR #446 |
| 16 | Gurdas reframed: "don't leak substrate/host concerns up to the agent" — substrate verbs (`peek` / `list_streams` / `append_fact`) are the wrong layer; channels are. | inline; pivoted the entire architectural proposal |
| 17 | Read `channels-as-nervous-system.md` + `choreography-and-combinators.fireline.md` + Forge `tools/index.ts`. Drafted `SDD_FIREGRID_AGENT_BODY_PLAN` — body-plan presentation layer over the substrate, channel-typed verbs with direction-enforcement, 9-verb fixed inventory + N-channel inventory | PR #446 |
| 18 | Read Lane 1's `tf-qoyg` work on `runtime-context-workflow-core.ts` — they'd already executed **Shape A narrow** beautifully (inline `Stream.runHead` for the static-source case; generic machinery retained for the dynamic-source agent-tool case). Amended SDD prerequisites to reflect the more precise substrate split | PR #446 commit f2eb94b1 |
| 19 | Bead set for body-plan migration created with full dependency graph (tf-lawq Slice A → 6 channel beads + Slice D verbs; tf-o38e Slice B and tf-v1q2 Slice E independent) | beads tf-lawq, tf-o38e, tf-gnp1...tf-xl6k, tf-ynd4, tf-v1q2 |
| 20 | Closed superseded beads (tf-zkwg substrate-leaky peek; tf-alca one-off discovery fix) per the structural reframing | bead closures with "DECIDED:" reasons |
| 21 | Fixed semgrep `firegrid-no-date-now` finding (one finding on my changes; Date.now → randomUUID) | PR #446 commit 840f23a2f |

## What I observe made it work — calibrated, not flattering

These are the patterns I'd want a future session to lean on. I'm trying to be honest about what was actually load-bearing vs what felt good but didn't matter.

### 1. Source-read before instrumentation (the §9f rule that fired correctly)

The single highest-leverage move was reading `acp-agent.js` + `sdk.d.ts` from the npx cache for the pinned versions, instead of opening a "let's instrument this" arc. Three of five §6 causes were settled in ~10 minutes of grep + read. The §9g instrumentation lane was correctly diagnosed as unnecessary.

The memory rule `feedback_check_vendored_effect_sources` and `feedback_process_weight_rtfm_before_sdd` are the durable form of this lesson. Tonight executed against them.

### 2. Falsifiable spikes before production refactors

`tf-s8y` was a 100-line driver-side hack to test whether the native MCP path worked. It was deliberately bad — port pinned, `.mcp.json` hand-rolled in the driver, all the dirty bits. The point was a YES/NO answer in hours, not a clean implementation.

Once it returned GREEN, the production version (`tf-v7t`) was a known-correct refactor with known scope. The two-phase approach saved both time and risk — production code never lived through "is this even the right hypothesis."

### 3. Calibrated progress reporting (and explicit re-narration when wrong)

I overstated "factory is live" at step 12 with the "6 × wait_for invocations" framing. When Gurdas asked "what's a tight loop here?" I had to look more carefully at the trace and realized those 6 were *wire-level mentions* of the tool name in streaming `tool_use` blocks, not 6 completed calls. The honest count was 1 (the call gated on permission).

I corrected explicitly: *"I overstated tf-v7t. Only 1 MCP tools/list + 0 actual tool calls."* That re-narration is what let the subsequent finding (the permission gate as the real blocker) emerge cleanly.

The memory rule `feedback_inference_is_not_verified_groundtruth` is the meta-form of this. Label epistemic tier; correct downward when source-verification refutes the prior tier.

### 4. Substrate-first thinking that survived a reframe

When Gurdas pushed back with "don't leak substrate to the agent," my first response was a Tier-1 / Tier-2 / Tier-3 substrate-verb proposal. That was wrong, and I had to walk it back to "actually the right move is product-shape composition / channel-typed addressing — substrate verbs at the agent layer ARE the antipattern."

What made the walkback usable rather than embarrassing: I named what was wrong with the prior proposal explicitly ("my earlier `peek` / `list_streams` / `describe_stream` proposal was the wrong layer entirely"), then reframed against the correct layer. Future sessions: when a pushback refactors your model, NAME the old model's failure mode in the new response — don't pretend the old model didn't exist.

### 5. Reading the right document at the right moment

Three documents reshaped the trajectory:

- `channels-as-nervous-system.md` (vault doc) — turned "what verbs should the agent have" into "what is the agent's body plan." Without that reframe the SDD would have been an enumeration of substrate primitives.
- `choreography-and-combinators.fireline.md` — gave the substrate-neutral `ChannelTarget` shape concretely, so I didn't have to invent it.
- Forge's `tools/index.ts` — the empirical reference that product-shape composition over substrate IS viable; not an academic question.

Future sessions: when an architectural question shows up, ask if there's prior art in a reference repo before generating proposals from first principles.

### 6. Empirical baselines from a peer lane

Lane 1's `tf-9ut` empirical finding was the substrate baseline that let the SDD's prerequisites be precise instead of vague. Two things specifically: (a) the orphan-parent observability bug was already fixed by #445, so "Shape A's empirical motivation" wasn't what I'd have inferred from stale numbers; (b) the `complete_match` count is candidate-evaluation pressure, not completion count.

If I'd written the SDD prerequisites without reading tf-9ut, the prereq description would have been wrong. Reading peer-lane work changed multiple sentences in my draft.

### 7. Use of structured beads + cmux-dispatch over inline chat

Every major step generated a coordinator dispatch. Every architectural decision generated a bead. The downstream consequences (other lanes' alignment, future me's ability to resume) ride on those, not on the chat transcript.

The memory rule `feedback_capture_groundtruth_in_artifact_not_chat` is the load-bearing form. Tonight's `tf-h1gm` FINDING + `SDD_FIREGRID_AGENT_BODY_PLAN` + the bead graph are the durable outputs; the chat is the working memory that produced them.

### 8. The user trusted me to drive AND course-corrected when the drift was load-bearing

Several times Gurdas pushed back with high-leverage corrections:
- "we're holding [#436] until we land your other beads around the right way to enforce waiting patterns"
- "i'd be careful not to leak host or substrate concerns up to the agent/session plane"
- "another reference repo which i drew this inspo from"
- "this was 6 chosen by me, im open to hearing additional tool surfaces"
- "ok kinda works?" (calibrated me back to honest scoring)
- "this is huge" (signal that I'd undersold)
- "once we have that durable time foundation nailed down to less moving parts"

Each of these was a vector correction. None were rejections of the work. The pattern: high autonomy on execution, surgical interventions on framing.

Future sessions: when the user makes a framing comment, treat it as a higher-priority signal than your own current direction. They have context you don't.

## What I did wrong and corrected

Honest list:

1. **`Effect.scoped` killed the fork in the first auto-approve handler implementation.** The scope closed immediately on `return`, killing the forked fiber before any permission request arrived. Caught by re-running and seeing the same symptom as pre-fix.  Took Scope from environment instead, wrapped the driver body in `Effect.scoped`. Same mistake the original heartbeat refactor had — and I caught it the second time faster because I'd seen the shape before.

2. **Initially proposed substrate-verb additions** (`peek`, `list_streams`, `describe_stream`, `append_fact`) as the answer to "what additional tools." This was wrong. Gurdas's "don't leak substrate" correction was the framing fix. Walked back; named the failure mode; restructured at the channel-presentation layer.

3. **Overstated "factory is live" at the wire-mentions vs completed-calls level.** Corrected on the next trace inspection. Should have done the more careful inspection FIRST instead of after Gurdas asked.

4. **Initially under-narrated the dark-factory `DARK_FACTORY_FINDING` outcome.** Wrote a "factory live but timed out" summary that missed the actual headline — the agent reached the honest-halt marker with a precise diagnosis. Corrected when Gurdas said "kinda works?" — that question revealed I'd buried the lede.

5. **Bead `tf-zkwg` (wait_for schema-introspection at substrate layer)** — wrong layer. Closed as superseded by the SDD's channel-typed framing.

6. **Date.now() in driver semgrep finding** — used `Date.now()` for the per-session cwd suffix. Should have used `randomUUID()` (or Clock if in Effect context). Caught by semgrep; fixed.

These mistakes weren't load-bearing in retrospect because they were caught and corrected within the same session, but the pattern is: **catching a mistake on the SECOND look is normal; the discipline is doing a second look.**

## Patterns to repeat next session

Distilled to general form:

- **Read pinned source code before instrumenting.** The "60-second-grep" heuristic is the most-leveraged habit. Most "we need to instrument X" instincts are actually "we haven't grepped X yet."
- **Spike before refactor.** When testing a hypothesis, write the dirty 100-line version that answers YES/NO in hours. Production version comes after.
- **Read the trace, not just the summary.** Span counts are useful; span attributes + wire-content are decisive. When something looks weird, look at the actual JSON, not the heartbeat aggregate.
- **When a user reframes, name the old model's failure mode.** Don't pretend the old model didn't exist. The reframing itself becomes a checkpoint that protects against regression.
- **Capture decisions in beads + commit messages + FINDING docs, not chat.** The chat is working memory; the artifacts are durable.
- **Use worktrees for branch work.** The shared primary checkout is driven by other agents; `task-enter.sh` + `task-exit.sh` is the discipline.
- **Run the FULL CI gate set locally, not just lint.** `pnpm lint` + `pnpm lint:dead` + `pnpm lint:effect-quality` + `pnpm lint:dup` + `pnpm lint:deps`. CI's "Lint" job is the union, not a subset.
- **Peer-lane evidence beats first-principles proposals.** If a peer lane (Lane 1's tf-qoyg, tf-9ut empirical finding) has source-verified baseline, use it. Your SDD's prerequisites should cite it, not invent it.
- **When the user trusts you, use it. When they correct you, integrate it.** The autonomy/correction split was the productivity engine tonight.

## Patterns NOT to repeat

- **Don't propose substrate verbs at the agent surface.** "Don't leak substrate up to the agent" is a real architectural principle, not a stylistic preference. Channels (or whatever the project's equivalent typed-opaque-token addressing is) is the layer for agent-facing addressing.
- **Don't over-claim until the second look confirms.** "6 tool calls" was true at the wire-mention level and false at the completed-call level. Both numbers are useful; reporting only the impressive one was the mistake.
- **Don't write SDDs without reading peer-lane state.** Substrate prerequisites that don't reference what's actually in-flight read as proposals-in-a-vacuum.
- **Don't dispatch parallelization plans for unvalidated decompositions.** `feedback_dont_parallelize_unvalidated_decomposition` is the memory rule. Tonight I didn't violate it, but the urge was there when I drafted the bead graph; checked the urge by gating Slice A on tf-qoyg.

## Artifacts produced this session

PRs touched / opened:

- **PR #438** — tf-ewo runner heartbeat refactor. MERGED.
- **PR #441** — tf-3ek codec→SDK source-verified baseline FINDING. Draft.
- **PR #444** — tf-s8y native `.mcp.json` spike. Draft (verdict-bearing, intentionally not landing).
- **PR #446** — tf-v7t codec rationalization + driver permission auto-approver + tf-h1gm FINDING + SDD_FIREGRID_AGENT_BODY_PLAN + this handoff doc. **Tonight's landing unit.**

Beads opened:

- `tf-3ek` — codec→SDK baseline (closed via PR #441 merge)
- `tf-s8y` — P0 spike (closed; verdict on PR #444)
- `tf-v7t` — production codec change (PR #446)
- `tf-h1gm` — FINDING capture (PR #446 docs/research/)
- `tf-zkwg` — substrate-leaky peek (CLOSED as superseded)
- `tf-alca` — one-off discovery fix (CLOSED as superseded)
- `tf-lawq` — Slice A: ChannelRegistry + opaque ChannelTarget. P1. Gated on tf-qoyg.
- `tf-o38e` — Slice B: lift empty-predicate gate. P1. Independent.
- `tf-gnp1` — Slice C.1: session.self.* interoception. P1. Gated on Slice A.
- `tf-fmwg` — Slice C.2: event(name). P1. Gated on Slice A.
- `tf-bhv9` — Slice C.3: state.changes(collection). P1. Gated on Slice A.
- `tf-v8i4` — Slice C.4: approval call channel. P1. Gated on Slice A.
- `tf-mybr` — Slice C.5: dm/notification human channels. P2. Gated on Slice A + C.4.
- `tf-xl6k` — Slice C.6: session.log. P2. Gated on Slice A.
- `tf-ynd4` — Slice D: send/call/wait_for_any verbs. P1. Gated on Slice A.
- `tf-v1q2` — Slice E: canonical record names. P2. Independent.

Docs:

- `docs/research/tf-h1gm-dark-factory-honest-halt.FINDING.md` — full agent reasoning trail + diagnosis
- `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` — body-plan presentation-layer architecture
- `docs/handoffs/SESSION_2026-05-20_dark_factory_live.md` — this doc

## How to resume from here

If you're a future session inheriting this state:

1. **Status check first.** `gh pr view 446 --json state` — if it's merged, the codec rationalization + permission auto-approver are on main. If it's still open, the SDD lives on the branch only.
2. **Check tf-qoyg.** Lane 1's Shape A narrow is the substrate prerequisite for body-plan Slice A. If it's merged, Slice A (tf-lawq) is unblocked.
3. **Tonight-independent work first.** tf-o38e (lift empty-predicate gate) and tf-v1q2 (canonical record names) don't depend on tf-qoyg. Either is a small, satisfying first move.
4. **Read tf-h1gm FINDING before doing any §6 work.** It captures what the agent diagnosed and what mechanism actually unblocked §6 (the permission gate, NOT the streaming JSON parse race the 2026-05-19 investigation hypothesized).
5. **Read `SDD_FIREGRID_AGENT_BODY_PLAN` substrate-prerequisites section before any Slice A work.** It explicitly distinguishes static-source-inline from dynamic-source-predicate-eligible; the channel registry needs to encode this split.
6. **§9g instrumentation lane is closed without opening.** Recommended in tf-h1gm. Don't re-open without contradicting evidence.

The factory is no longer a black box; it's a substrate with a thin presentation-layer reframe pending. The path from here is structural, not exploratory.

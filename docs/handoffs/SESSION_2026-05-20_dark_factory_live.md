# Session Handoff — 2026-05-20 — §6 ran live; body-plan SDD; one-substrate SDD; sim-based de-risk dispatch

This is a session-arc capture, not a coordinator-state handoff (the latter is `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md`). The intent is to make tonight's process *legible* to a future session — what was tried, what worked, what didn't, and what patterns generalize. Read this BEFORE inheriting from the canonical coordinator handoff if you want the "how" alongside the "what."

**The session arc swung architecturally further than the initial framing.** What started as "fix §6's tools/call=0" ended as: two cooperating SDDs (presentation layer + substrate layer), a 6-investigation tiny-firegrid dispatch validating ~2400-line deletion before touching production code, and an explicitly-named architectural pattern ("stream-native virtual object") that informs the SMI-1992 experimental design. Each turn unlocked the next.

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
| 22 | Gurdas flagged tech debt across `runtime-context-workflow-core.ts` + `internal/run-context-workflow.ts` + `internal/runtime-context-workflow-run.ts` + `runtime-context-workflow-support.ts` — "single workflow instance + single stream model removed the need for coordination gymnastics, but the CODE still carries the multi-deferred-multi-wait machinery from the pre-single-instance era" | inline reframe; second architectural pivot |
| 23 | Drafted `SDD_FIREGRID_WORKFLOW_BODY_DEFERRED_INPUT_REWRITE` (skeleton) framing it as "design the engine-contract bridge for stream-blocked workflow bodies." This was the WRONG framing. | committed transiently; rm'd before push |
| 24 | Gurdas reframed AGAIN: "no separate runtime — `durable-tools/` should just be executing on the workflow runtime. Divergence across durable runtimes is what's kept us mired in this complexity spiral." Pointed at `ClusterWorkflowEngine.ts` as the template + `DurableStreamsWorkflowEngine.test.ts` as the evidence. THIRD architectural pivot. | inline; load-bearing reframe |
| 25 | Read `ClusterWorkflowEngine.ts` (660 lines) + `DurableStreamsWorkflowEngine.test.ts` (932 lines) + `durable-tools/` (~2500 lines). Verified the bridge layer's only function is to translate observation streams into engine `DurableDeferred` via a forked subscription fiber — duplicating what the engine already supports natively. | source-read |
| 26 | Rewrote SDD as `SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` — collapse `durable-tools/` (~2500 lines) onto the engine. Agent-tool `wait_for` becomes `engine.execute(WaitForWorkflow, ...)` whose body is `DurableDeferred.raceAll([Activity(Stream.runHead), DurableClock.sleep])`. Runtime-context body becomes `Stream.zipLatest + runForEach`. NO engine API changes. Net -2400 lines. | PR #446 |
| 27 | Peer-review (from another agent) raised four pressure-tests: source-as-offset durability, raceAll losing-branch crash-coverage, nested-vs-inlined tradeoff, the "no WaitFor.match" claim doing real work. Engaged with each; lifted the META insight (stream-backed engine is the load-bearing enabler — not portable to ClusterWorkflowEngine) into the SDD. | SDD commits 573f7c64d, ad6910d4c |
| 28 | Gurdas flagged: "since DurableStreamsWorkflowEngine is ours, we have free reign to rethink `Activity.ts` semantics." Named α (streamed) / β (subscribed) / γ (folded) Activity shapes as a deliberately-deferred future SDD; current SDD lands on existing engine surface unchanged. | SDD commit ad6910d4c |
| 29 | Gurdas connected the per-context workflow to Restate's Virtual Object pattern: same identity + single-writer-per-key, stream-as-state instead of K/V. Named the pattern **stream-native virtual object** in the SDD; two-ledger-vs-one is what makes the stream-fold body work as substrate-of-truth. | SDD commit 129f2c0aa |
| 30 | Updated PR #446 title + body to be docs-headlined. The codec change is now framed as empirical evidence motivating the SDDs, not the headline. | gh pr edit 446 |
| 31 | Gurdas surfaced the de-risk opportunity: tiny-firegrid is the substrate where engineers can compose Firegrid from any pieces, drive it against real claude-agent-acp, capture data — WITHOUT touching production code or rewriting tests. Cost-asymmetric pattern that matches what worked tonight (tf-s8y spike before tf-v7t production). | inline reframe |
| 32 | Drafted + dispatched 6-investigation coordinator dispatch: INV-1 stream-zip body; INV-2 WaitForWorkflow nested execution; INV-3 restart-replay durability; INV-4 channel registry + opaque ChannelTarget; INV-5 cross-agent event(name) choreography; INV-6 Activity α/β/γ ergonomic comparison. Each is a self-contained sim under `packages/tiny-firegrid/src/simulations/<inv-name>/` with FINDING artifact. Wave-1 parallel: INV-1+2+4. | cmux-dispatch to coordinator |

## The architectural-trajectory pattern (worth naming)

The session walked through **five distinct architectural simplifications**, each unlocked by the previous:

1. **Native MCP path** (tf-s8y → tf-v7t): kill the codec `_meta` MCP injection. Use `.mcp.json` per the documented user-facing path.
2. **Channels-as-nervous-system** (body-plan SDD): don't leak substrate verbs to the agent surface. Channels = typed afferent/efferent pathways; verbs operate over channels.
3. **Stream-native runtime-context body** (one-substrate SDD left branch): collapse the body's coordination machinery — `Stream.zipLatest(inputs, outputs).runForEach(handle)`. No per-row deferreds. No `WaitFor.match`. No wait-router.
4. **One-substrate workflow engine** (one-substrate SDD right branch): collapse `durable-tools/` onto the engine. Agent-tool wait_for IS a workflow execution. No bridge layer.
5. **Stream-native virtual object** (one-substrate SDD framing): name the pattern. Restate-shape VO identity + concurrency, with stream-as-state instead of K/V. Two-ledger reconciliation avoided structurally.

Plus a process-level move:
6. **Cost-asymmetric de-risking via tiny-firegrid sims** (the coordinator dispatch): validate the SDDs' architectural claims empirically against a real planner in sim BEFORE touching production code OR rewriting tests. The same pattern that worked tonight (spike before refactor) lifted to architectural scale.

**Pattern observation**: each simplification was structurally forced by recognizing what we'd ALREADY paid for but hadn't COLLECTED. The substrate divergence (durable-tools/ + workflow-engine) was paid for the moment `DurableStreamsWorkflowEngine` shipped as a sibling to `ClusterWorkflowEngine`. The body-plan-richness-as-independent-variable was paid for the moment Firegrid adopted a channel-typed observation model. Each move was collection, not invention.

**Future sessions**: when the user makes a reframing comment, treat it as "you've already paid for this; collect it." Don't defend the prior model.

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
- "im not convinced that we need our own runtime for this outside of what we get with the workflow engine either though"
- "since we built DurableStreamsWorkflowEngine, we have free reign to even rethink the semantics of Activity.ts"
- "we could actually start dispatching investigations to already happen against this architecture"

Each of these was a vector correction. None were rejections of the work. The pattern: high autonomy on execution, surgical interventions on framing.

Future sessions: when the user makes a framing comment, treat it as a higher-priority signal than your own current direction. They have context you don't.

### 9. Peer-review integration without ego defense

Mid-session, another agent peer-reviewed the architecture diagram and raised four pressure-test questions. Three had real answers I could give from source (source-as-offset principle, raceAll inheritance, nested-vs-inlined tradeoff); one needed acknowledgment as a known inherited concern (PR #315 crash-coverage state). The META observation in the peer review (stream-backed engine as the load-bearing enabler) was sharper than my SDD draft had named — and the right move was to LIFT it into the SDD rather than respond defensively.

Future sessions: peer reviews land as load-bearing input regardless of source. If they make your draft more precise, amend the draft. If they refute it, walk back per the named-failure-mode rule.

### 10. Cost-asymmetric de-risking via simulation

The session's closing move was dispatching 6 tiny-firegrid investigations that empirically validate the SDDs' architectural claims BEFORE touching production code. Tonight's tactical work (tf-s8y spike → tf-v7t production) was the same pattern at small scale. The dispatch lifts it to architectural scale.

The lesson: **when an SDD makes structural claims about substrate behavior, build a sim that falsifies them.** If the sim says GREEN, the production refactor becomes near-mechanical. If RED, you learned it for the cost of one sim, not multi-PR rework. The substrate is built for this exact purpose — tiny-firegrid is the de-risk substrate.

Future sessions: when reaching for an SDD-driven implementation arc that touches production architecture, ask first: *can a tiny-firegrid sim falsify the structural claims independently?* If yes, that sim is the right opening move.

### 11. Freedom-naming without freedom-using (when scope discipline matters)

At one point in the session, Gurdas pointed out we own `DurableStreamsWorkflowEngine` and therefore have freedom to rethink Activity's semantics (α streamed / β subscribed / γ folded shapes). The temptation was to amend the SDD to USE that freedom. The correct move was to NAME the freedom in the SDD as a deliberately-deferred future SDD, keeping the current SDD's scope contained.

Naming a freedom without using it is its own discipline. It tells future sessions: "this option exists, we know about it, here's why we're not taking it yet, here's what landing it would look like." That's different from omitting the option (which would be lying by omission) and different from taking the option (which would scope-creep the current work).

Future sessions: when a user surfaces an architectural freedom mid-SDD, ask whether to USE it or just NAME it. The default should be name + defer unless the current SDD's acceptance criteria require taking it.

## What I did wrong and corrected

Honest list:

1. **`Effect.scoped` killed the fork in the first auto-approve handler implementation.** The scope closed immediately on `return`, killing the forked fiber before any permission request arrived. Caught by re-running and seeing the same symptom as pre-fix.  Took Scope from environment instead, wrapped the driver body in `Effect.scoped`. Same mistake the original heartbeat refactor had — and I caught it the second time faster because I'd seen the shape before.

2. **Initially proposed substrate-verb additions** (`peek`, `list_streams`, `describe_stream`, `append_fact`) as the answer to "what additional tools." This was wrong. Gurdas's "don't leak substrate" correction was the framing fix. Walked back; named the failure mode; restructured at the channel-presentation layer.

3. **Overstated "factory is live" at the wire-mentions vs completed-calls level.** Corrected on the next trace inspection. Should have done the more careful inspection FIRST instead of after Gurdas asked.

4. **Initially under-narrated the dark-factory `DARK_FACTORY_FINDING` outcome.** Wrote a "factory live but timed out" summary that missed the actual headline — the agent reached the honest-halt marker with a precise diagnosis. Corrected when Gurdas said "kinda works?" — that question revealed I'd buried the lede.

5. **Bead `tf-zkwg` (wait_for schema-introspection at substrate layer)** — wrong layer. Closed as superseded by the SDD's channel-typed framing.

6. **Date.now() in driver semgrep finding** — used `Date.now()` for the per-session cwd suffix. Should have used `randomUUID()` (or Clock if in Effect context). Caught by semgrep; fixed.

7. **Drafted `SDD_FIREGRID_WORKFLOW_BODY_DEFERRED_INPUT_REWRITE` with the wrong framing** — "design the engine-contract bridge for stream-blocked workflow bodies." Got committed transiently, then Gurdas reframed: the correct move was "delete the substrate divergence entirely; agent-tool wait_for IS a workflow execution." Walked back, rewrote as `SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` per the named-failure-mode rule. The mistake didn't ship; it surfaced because I named "design a bridge" in chat first and Gurdas refuted that framing before I'd written the wrong-shaped implementation.

These mistakes weren't load-bearing in retrospect because they were caught and corrected within the same session, but the pattern is: **catching a mistake on the SECOND look is normal; the discipline is doing a second look.** And: **drafting in chat first invites the user-correction loop that catches wrong-framings before they ossify into committed artifacts.**

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
- **PR #446** — Tonight's landing unit. Headline retitled to "§6 dark-factory ran live + architecture SDDs (one-substrate workflow engine, agent body plan, stream-native VO)." Carries codec rationalization + driver permission auto-approver + tf-h1gm FINDING + body-plan SDD + one-substrate SDD + this handoff doc.

Beads opened:

- `tf-3ek` — codec→SDK baseline (closed via PR #441 merge)
- `tf-s8y` — P0 spike (closed; verdict on PR #444)
- `tf-v7t` — production codec change (PR #446)
- `tf-h1gm` — FINDING capture (PR #446 docs/research/)
- `tf-zkwg` — substrate-leaky peek (CLOSED as superseded)
- `tf-alca` — one-off discovery fix (CLOSED as superseded)
- `tf-qoyg` — Shape A narrow halt (CLOSED via path (C) WIDEN — superseded by one-substrate SDD)
- `tf-auuv` — **P0: Implement SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE** (6-PR sequencing). Replaces the earlier "deferred-input rewrite" framing.
- `tf-lawq` — Slice A: ChannelRegistry + opaque ChannelTarget. P1. Now gated on tf-auuv (was tf-qoyg).
- `tf-o38e` — Slice B: lift empty-predicate gate. P1. Independent.
- `tf-gnp1` — Slice C.1: session.self.* interoception. P1. Gated on Slice A.
- `tf-fmwg` — Slice C.2: event(name). P1. Gated on Slice A.
- `tf-bhv9` — Slice C.3: state.changes(collection). P1. Gated on Slice A.
- `tf-v8i4` — Slice C.4: approval call channel. P1. Gated on Slice A.
- `tf-mybr` — Slice C.5: dm/notification human channels. P2. Gated on Slice A + C.4.
- `tf-xl6k` — Slice C.6: session.log. P2. Gated on Slice A.
- `tf-ynd4` — Slice D: send/call/wait_for_any verbs. P1. Gated on Slice A.
- `tf-v1q2` — Slice E: canonical record names. P2. Independent.

Docs (all on PR #446):

- `docs/research/tf-h1gm-dark-factory-honest-halt.FINDING.md` — full agent reasoning trail + diagnosis; 2026-05-19 cause-#5 "streaming parse race" diagnosis FORMALLY REFUTED (mechanism was the permission gate)
- `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` (~370 lines, with substrate-prereq amendments referencing the one-substrate SDD) — body-plan presentation-layer architecture; channels-as-nervous-system reframing; 9-verb fixed inventory + N-channel inventory with direction-enforced types
- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` (~270 lines, with 4 peer-review amendments + Activity-rethink-deferred amendment + stream-native-VO framing) — substrate-layer architecture; collapse durable-tools/ onto the workflow engine; net -2400 lines target
- `docs/handoffs/SESSION_2026-05-20_dark_factory_live.md` — this doc

Coordinator dispatches:

- DARK_FACTORY_FINDING outcome + 5-cause matrix updated (3 settled by source, 1 empirically resolved by tf-s8y, 1 refuted by tonight's trace).
- §9g instrumentation lane recommended CLOSED without opening.
- P0 status dispatch with comprehensive arc summary.
- tf-v7t verdict + follow-up bead structure.
- (C) WIDEN decision on tf-qoyg with SDD pointer.
- **6-investigation de-risk dispatch** — INV-1 stream-zip body / INV-2 WaitForWorkflow nested / INV-3 restart-replay / INV-4 channel registry / INV-5 cross-agent event(name) / INV-6 Activity α/β/γ. Wave-1 parallel: INV-1+2+4 (~1.5-2 days wallclock with 3 lanes).

Memory entries (loaded in future sessions via MEMORY.md):

- `project_session_2026-05-20_dark_factory_live` — session project state
- `feedback_60_sec_grep_before_instrumentation` — read pinned source before reaching for spans
- `feedback_dont_leak_substrate_to_agent_surface` — channel-typed addressing; substrate verbs at the agent surface are an antipattern
- `feedback_calibrated_progress_reporting` — distinguish wire-mentions from completed calls; treat user "kinda works?" as re-look signal
- `feedback_walkback_names_the_old_models_failure_mode` — when a reframe makes your prior proposal wrong, name what was wrong before substituting

## How to resume from here

If you're a future session inheriting this state:

1. **Status check first.** `gh pr view 446 --json state` — if it's merged, the codec rationalization + permission auto-approver are on main, AND the SDDs are on main. If it's still open, both artifacts live on the branch only.
2. **Read SDDs in this order**: (a) `SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` first — substrate layer, defines the workflow-engine-as-One-Substrate premise + the stream-native VO framing. (b) `SDD_FIREGRID_AGENT_BODY_PLAN.md` second — presentation layer, sits on top.
3. **Check the 6 sim investigations.** Coordinator dispatched on the architectural-de-risk plan. If those have started + delivered FINDINGs, you have empirical confirmation of the SDDs' structural claims. If they haven't, that's the first work to drive — `br ready` should show them as P1 beads in flight.
4. **Tonight-independent work that's safe to land in parallel with the sims**: `tf-o38e` (lift empty-predicate gate, single-line schema change) and `tf-v1q2` (canonical record-pair emit, additive). Either is a small, satisfying first move that doesn't depend on the substrate collapse or the sim findings.
5. **`tf-auuv` is the substrate-collapse implementation bead** — P0, 6 PRs sequenced per the SDD. Don't start the production work until the sim investigations come back GREEN. tf-auuv blocks `tf-lawq` (Slice A) which blocks the rest of the body-plan migration.
6. **Read `tf-h1gm` FINDING before doing any §6 work.** It captures what the agent diagnosed and what mechanism actually unblocked §6 (the permission gate, NOT the streaming JSON parse race the 2026-05-19 investigation hypothesized).
7. **§9g instrumentation lane is closed without opening.** Recommended in tf-h1gm + the coordinator dispatch. Don't re-open without contradicting evidence.
8. **Lane 1's tf-qoyg work is closed via (C) WIDEN** — the path was reshaped into the broader one-substrate collapse. The empirical findings from tf-qoyg's prototype (in-sim AgentOutputAfter spans go 127→0, Fiber.join hangs on stream-blocked workflow body) ARE the evidence the one-substrate SDD operates against. Don't restart tf-qoyg; do read its halt doc as one of the SDD's design inputs.

The factory is no longer a black box. The substrate is named (stream-native VOs). The presentation layer is designed (channels). The implementation sequencing is known (6-PR collapse, then body-plan migration). The architectural risk is being de-risked in sim BEFORE any production refactor. The path from here is structural execution, not architectural exploration.

The next session's leverage move, in priority order:

1. **Drive INV-1+2+4 (Wave 1 of the coordinator dispatch) to FINDING completion.** Empirical confirmation that the SDD claims hold. ~1.5-2 days wallclock with 3 lanes; cost of being wrong drops by orders of magnitude.
2. **Land Step 1 of the SDD's implementation sequencing** (`waitUntilWorkflowStarted` test helper promotion) — pre-collapse-no-op behavior change that makes Steps 2-5 safer. ~50 lines.
3. **Drive INV-3+5 (Wave 2)** — restart-replay durability + cross-agent event(name) choreography. Both surface evidence for the SDDs AND inform SMI-1992's experimental writeup.
4. **Substrate-collapse PRs land in their sequenced order** once Wave 1 findings are GREEN.

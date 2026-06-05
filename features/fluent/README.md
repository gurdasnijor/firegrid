# `features/fluent/` — proposed feature set

**Purpose.** Turn `docs/reviews/fluent-effect-review-1.md` (the design handoff)
into a set of **falsifiable acceptance requirements** (`*.feature.yaml`, the
existing `features/` convention) that we **empirically settle with firelab
experiments**. Each feature is a cluster of single-claim requirements; each maps
to one or more firelab `CoverageSpec`s (drafted in
`packages/firelab/src/runner/fluent-coverage-specs.ts`) whose **witness** proves
the behavior ran on the production path and whose **mutation harness** (negative
control) must flip the verdict red.

**Structure: two halves + shared substrate** (matches the review).
- **Half 1 — Non-invasive agent binding.** The bridge over the agent's *own*
  harness. **🔴 real-agent only**: every Half-1 acceptance experiment MUST drive a
  real spawn-target (real native/ACP agent). A fake adapter/recorder/fake-codec is
  **invalid except for unit tests below the firelab acceptance layer**.
- **Half 2 — Durable coordination surface.** The agent-facing durable tools
  (`wait_for`/`wait_until`/`sleep`/`spawn`/`spawn_all`/`execute`) as durable
  rows + park + re-drive.
- **Shared substrate.** The engine, fencing, worker loop, and wake/timer source
  that sit under both halves.

**Coverage guarantee.** Every section of `fluent-effect-review-1.md` maps to at
least one feature — see the **Traceability matrix**. The only deliberate gap is the
review's own D.7 surface-glue carve-out.

**Conventions**
- `product: fluent` (new dir, parallel to `firegrid`/`flamecast`/
  `durable-agent-runtime-lab`).
- **Forge-proof rule** (Appendix C): a gate may name **only** host-substrate spans
  (the substrate emits them server-side; a driver can't forge them). **Layer-1
  normalized codec events are observation, NOT gated as substrate spans.**
- **Status tiers:** `green-now` (observable on durable-streams 0.3.1 today) ·
  `red→green` (red until the build step lands) · `decision` (a PO/source call) ·
  `harness` (the verification apparatus itself).
- Section names are the primary reference; **line ranges are advisory** (they drift).

---

## Half 1 — Non-invasive agent binding · 🔴 real-agent only

Reference implementation, source-verified line-by-line:
`repos/durable-streams/packages/coding-agents/`. Each feature is split out so a
red spec localizes which part of the bridge failed.

| Feature file | Asserts (source) | Firelab proof |
|---|---|---|
| `fluent-agent-adapter-contract` | The `AgentAdapter` contract: `spawn`(the real native/ACP harness) · `parseDirection` · `isTurnComplete` · `translateClientIntent` · `prepareResume`; `AgentConnection` = `onMessage`(observe raw→record) · `send`(native input) · `kill` · `on(exit)`. Firegrid **never owns the loop**. (`adapters/types.ts`; Appendix E adapter contract) | 🔴 real agent spawned via adapter; trace shows a real spawn span + raw recorded |
| `fluent-three-envelope-stream` | Durable-stream truth model: **intent** `UserEnvelope`(user_message/control_response/interrupt) · **raw** `AgentEnvelope`(bridge-written, the durable truth) · **lifecycle** `BridgeEnvelope`(session_started/resumed/ended). Raw first, projection later. (`types.ts`; Appendix E two-layers) | stream trace contains all three envelope families |
| `fluent-bridge-mediation` | One prompt in flight (`pendingPrompts` shift on `isTurnComplete`); duplicate approval/response dedup via `syntheticKey`; **interrupt synthesizes cancellation responses for ALL pending requests before the native interrupt**; terminal/lifecycle recorded before cleanup. (`bridge.ts`) | 🔴 real-agent approval + interrupt scenario |
| `fluent-approval-fidelity` | Native adapter preserves **per-request** approval shapes (`commandExecution→{decision}`, `fileChange→{decision}`, `permissions→{permissions,scope}`, `tool/requestUserInput→{answers}`); ACP flattening is an **explicit fidelity tradeoff** (the ACP-vs-native decision, O3). (`adapters/codex.ts`) | 🔴 real approval round-trip preserving native shape |
| `fluent-native-resume` | Reconstruct the **native** resume artifact from the stream, then resume natively (not prompt-replay, not ACP `session/load` which dies with the sandbox). Attempt native resume when stream history exists and a resume artifact is reconstructable; if native resume fails, fall back to a fresh spawn **only when pending prompt replay can safely bridge** (`bridge.ts:193–243`). Claude — rebuild transcript JSONL + `--resume`, with the cross-cwd **seed fallback** (`forceSeedWorkspace`) as the bridge; Codex — `thread/resume {threadId}`. Path-rewrite for cross-sandbox mounts. (`adapters/{claude,codex}.ts`) | 🔴 kill/restart real agent → re-drive from stream → native resume |
| `fluent-client-normalization` | Raw protocol events project into `NormalizedEvent`s (assistant_message/stream_delta/tool_call/tool_result/permission_request/turn_complete) and durable read models (sessions/turns/tool_calls/permission_requests/…); **projections are pure views over immutable raw** — they can change without rewriting raw history. (`normalize/`, `agent-db-schema.ts`) | replay a captured raw stream into collections; projection can change without rewriting raw (no live agent) |
| `fluent-park-interface` | A parking Firegrid tool **reliably ends the harness turn via transport end-of-turn**, then resume re-enters natively. The load-bearing piece of the non-invasive binding; gates `durableWaitCoverage`. **The one open source-read** (O1). | 🔴 new real-agent spec; **cannot be substrate-only** |
| `fluent-mcp-tools-out` | The (out) half: MCP-over-durable-streams exposes Firegrid's durable tools to the harness; **swappable** — the property (never wraps the loop) is the differentiator, the mechanism is not. (Differentiator 1) | 🔴 durable tools reachable by a real harness |

---

## Half 2 — Durable coordination surface

| Feature file | Asserts (review §) | Firelab CoverageSpec |
|---|---|---|
| `fluent-durable-wait` | `wait_for`/`wait_any` append `WaitIntent` **before** park; CEL predicate evaluated **during the drive** over `event` + `self`; **`afterOffset` catch-up prevents lost wakeup**; the timeout race is **fenced once** (at-most-once winner). Given-key principle: key by `toolCallId` / `(toolCallId, slotIndex)`. Journal the predicate + matched event so replay resolves from the journal, never re-evaluates a moving world. (Appendix D.3/D.4) | `durableWaitCoverage` + `raceCoverage` |
| `fluent-durable-sleep` | `sleep`/`wait_until` append timer intent (`TimerScheduled`) **before** park; **no `Clock.sleep`/local timer**; the **timer source materializes `TimerFired`** (unforgeable `timer.fire`); replay resolves from the journal. The one genuinely net-new piece (O5). `sleep`+`wait_for` = one family, two sources. (Part 3 sleep; Appendix D.2) | `durableSleepCoverage` |
| `fluent-fork-spawn` | `spawn`/`spawn_all` create a child session via **stream fork / child stream**; **producer state resets** on the child; the parent waits on the child's **terminal event / closure** (the cross-session join — the parent cannot inline-join a child fiber). `raceCoverage` facet b = the child-cancel-vs-leave policy (O2). (Substrate Commitments; Appendix D.5) | `crossSessionCoverage` (+ `raceCoverage` b) |
| `fluent-coordination-taxonomy` | `runs`/`toolCalls`/`inbox`/`childStatus`/`wakes`/`tags`/`errors` as State-Protocol change-messages, keyed by given ids. **Addressing is not calling** (`send`/`spawn` address an event; delivery is through the core; recipient decides on its wake). The wake-registry is the single mechanism behind every wake source. (Build order 1; Coordination/ingress) | underpins `durableWait`/`crossSession` |
| `fluent-session-handler` | `handleSession(wake)` + `driveHarness` re-invoke the **external** harness with a resume context (never `agent.run`): materialise committed stream → build resume context → drive. The harness-resumability dependency is "the one piece of real engineering." (System shape; Build order 2; Appendix E.1/E.5) | `session.drive` span (graded by `workerLoopCoverage`) |
| `fluent-event-ingress` | Webhook/external event ingest = a **fenced append** into the core; the wake-registry matches `wait_for` predicates and wakes those entities (identical to approvals/tool-results); **duplicate delivery deduped by §5.2.1 producer fencing** (delivery-id). (Coordination/ingress 578–584) | ingest + wait-match trace |

---

## Shared substrate (under both halves)

| Feature file | Asserts (review §) | Firelab CoverageSpec |
|---|---|---|
| `fluent-engine-substrate-free` | Collapse the DSL onto Effect with **named (not positional) journal keys** → `run` returns a plain `Effect`; `Future`/`Scheduler.drive`/`Awaitable`/`operation.ts`/`current.ts` all **delete**; concurrency + spawn become free. **Durability enters via provided `Journal`/`FencedWriter` Effect.Services at the handler edge; the engine core (the `Effect.gen` bodies) stays substrate-free** — it does not import the old runtime or the durable substrate directly. What-becomes-free: retry/saga/in-process-cancel/serde. (Part 1; Summary) | `replayCoverage` + airgap assertion |
| `fluent-substrate-semantics` | **Stream-closure terminality** (a finite turn appends a terminal record AND closes; read-to-tail can't tell done from idle); **producer fencing/idempotency** (§5.2.1: `Producer-Id`/epoch/**0-based seq**); **fork semantics**; **append-after-close rejection**. Also durable child (not `Effect.fork`), cancellation-as-fact, sandbox-as-Layer, state CAS. Two fencing mechanisms (§5.2.1 writers vs §7.3 workers) must not be conflated. (Part 2 families; Part 3 two-fencing; Appendix C Spec 3/6) | `substrateSemanticsCoverage` + `fencedAppendCoverage` |
| `fluent-worker-redrive` | Pull-wake worker **claims the lease**, materialises session state, **resolves waits**, re-enters the harness, **acks/releases safely** on the server's §7.2/§7.3 machinery (do NOT rebuild the lease); **stale-generation ack is fenced**; `next_wake:true` = the turn loop for free; **no double side-effect**. `acked_offset` is a delivery cursor, not a replay position (replay reads the journal every claim). (Part 3; Appendix B) | `workerLoopCoverage` |

---

## Below the choreography line (optional; authored procedures only — the agent path depends on NONE of it)

| Feature file | Asserts (review §) | Firelab CoverageSpec |
|---|---|---|
| `fluent-concurrent-replay-soundness` | **Named-key concurrent-replay soundness under `Effect.all(concurrency:"unbounded")`** (Appendix A's TFIND: *named journal keys are sound under concurrent replay*); the **mutation proves positional/runtime-counter keys desync** on replay (mis-key → `served=="executed"` / tripwire fires → RED). The race landmine, two facets: (a) **winner-record journaled — NOT a choice** (bounded-`wait_for` safety depends on it); (b) **loser-fate** (let-finish-and-journal *vs* interrupt) — pick per combinator. (Appendix A; Part 1 race landmine; Appendix C Spec 1/5) | `replayCoverage` + `raceCoverage` |

---

## External control plane

| Feature file | Asserts (review §) | Firelab proof |
|---|---|---|
| `fluent-control-surface` | External `/entities/:type/:id` control — `send` · `fork` · `tag` · `schedule`(→wake-registry) · `get`/`head`/`delete` — as **product spelling over durable-stream primitives**. `tag` names an offset; `fork` branches a new entity from a prefix (stream *is* the state → fork = copy-a-prefix → "explore from here" / "retry under a changed tool set" / "snapshot before a risky action"). Read plane = the same projection externalised. (External control surface) | control-plane simulation over stream facts |

---

## Framing & harness (required context, not buildable agent features)

| Item | Covers (review §) | Status |
|---|---|---|
| `fluent-execution-model` | The three axes — **choreography · handler · external-harness**; "you cannot replay the model" → durable unit = the committed tool-call-and-result; "sessions never call each other" → **address ≠ call**; the three differentiators (non-invasive binding · forge-proof firelab · deterministic-replay rigor). (System shape; Execution model) | the framing every feature inherits |
| `fluent-coverage-oracle` | Stand up the **firelab runner over fluent-firegrid** (`firelab` is the home — the runner is the driver + Control + infra seam). The `HOST_SUBSTRATE` span vocabulary (`journal.step`/`journal.append`/`step.action`(tripwire)/`durable.sleep`/`timer.schedule`/`timer.fire`/`worker.claim`/`worker.ack`/`session.drive`/`race.settle`/`child.spawn`/`cancel.delivered`/`state.cas`/`stream.close`/`sandbox.run` + `wait.register`/`durable.wait`/`child.result`). **Forge-proof lint** (gates name only host-substrate spans; Layer-1 codec events excluded). Each spec = witness + a **mutation harness that must flip red** + a **vacuity check** (absence = an attribute on a span that fires, never `size()==0`). Reuse the firelab oracle (`analyzeCoverage`/AST-lint/vacuity) verbatim. (Appendix C) | harness · partly green-now (oracle exists in `firelab`; the fluent runner + span vocab are net-new) |

---

## Open decisions (must be resolved; NOT code requirements)

| # | Decision | Status / recommendation |
|---|---|---|
| O1 | **Park interface (a) pending-result vs (b) transport end-of-turn.** | Recommend **(b)**; the one **source-read still open** — answered by `fluent-park-interface` (real-agent). |
| O2 | **Child-race loser policy** — cancel vs leave+absorb (`raceCoverage` facet b). Winner-record (a) is not a choice. | PO call. Default: leave+absorb; cancel as opt-in. |
| O3 | **Claude wire protocol: ACP vs native.** | Fully informed (fidelity delta source-verified); recommend native. PO call. Answered by `fluent-approval-fidelity`. |
| O4 | **Confirm Electric internals.** | **Regressed** — `repos/electric` no longer on disk → un-re-verifiable locally. NOT load-bearing (decision rests on `coding-agents`, which is vendored). |
| O5 | **Net-new timer source impl** — DO alarm / timer-wheel that materialises T as an append. | The only genuinely-unsolved infra. Confirmed net-new vs the Restate SDK (`sleep`→`ctx.sleep`, a server feature) **and** `coding-agents` (no scheduler). |

---

## Recommended first slice

1. `fluent-substrate-semantics` (green-now floor — proves the experiments are real)
2. `fluent-durable-sleep` (headline durable-wait gap)
3. `fluent-durable-wait` (headline durable-wait gap)
4. `fluent-agent-adapter-contract` (🔴 non-invasive real-agent binding)
5. `fluent-native-resume` (🔴 recovery thesis)
6. `fluent-park-interface` (🔴 the open binding proof)

Covers the baseline substrate, the headline durable-wait gap, and the
non-invasive real-agent binding/recovery thesis. **Half-1 proofs must state: real
spawn target only; a fake adapter is invalid except for unit tests below the
firelab acceptance layer.** The oracle (`fluent-coverage-oracle`) is a
prerequisite for grading any of these empirically.

---

## Traceability matrix — every review section → feature (line ranges advisory)

| `fluent-effect-review-1.md` section | Feature |
|---|---|
| TL;DR four takeaways | all groups (1→execution-model/binding, 2→below-line, 3→Half 1, 4→shared substrate) |
| System shape | `fluent-execution-model`, `fluent-session-handler` |
| Execution model: axes / can't-replay / keys / races / differentiators | `fluent-execution-model`; keys→`fluent-durable-wait`+`fluent-concurrent-replay-soundness`; races→`fluent-fork-spawn` |
| Background | `fluent-engine-substrate-free` |
| Part 1 — collapse DSL onto Effect | `fluent-engine-substrate-free` (+ race landmine→`fluent-concurrent-replay-soundness`) |
| Part 2 — three families | `fluent-durable-sleep`+`fluent-durable-wait` (park/wake), `fluent-substrate-semantics` (fencing/state/sandbox) |
| Part 3 — DS §7.2/§7.3 = wake subsystem | `fluent-worker-redrive`; sleep→`fluent-durable-sleep`; two-fencing→`fluent-substrate-semantics` |
| Coordination and ingress | `fluent-coordination-taxonomy`, `fluent-event-ingress` |
| External control surface (fork/tag/schedule) | `fluent-control-surface` |
| Build order tiers 1–11 | Half 2 (1–6) · Shared substrate (7–9) · Half 1 (10) · Below-line (11) |
| Appendix A — named-keys soundness | `fluent-concurrent-replay-soundness` |
| Appendix B — wake substrate | `fluent-worker-redrive` + `fluent-durable-sleep` |
| Appendix C — coverage specs + HOST_SUBSTRATE | `fluent-coverage-oracle` (+ each spec → its Half-2/shared feature) |
| Appendix D — agent surface / `durable.wait` / CEL / cross-session / race-defused / glue | `fluent-durable-wait` (D.1/D.3/D.4/D.6), `fluent-fork-spawn` (D.5); D.7 glue = carve-out below |
| Appendix E — handler / two layers / adapter contract / durable tools / park / resume | `fluent-session-handler`, `fluent-client-normalization`, `fluent-agent-adapter-contract`, `fluent-three-envelope-stream`, `fluent-bridge-mediation`, `fluent-native-resume`, `fluent-park-interface` |
| Still open | Group O (O1–O5) + `fluent-coverage-oracle` (the firelab runner) |
| Sources & provenance | provenance; O4 = the regressed Electric items |

> **Surface-glue carve-out (D.7):** approval gates, middleware, dashboards, the ACP
> adapter, budget/policy, context injection are "one primitive + one combinator"
> the README itself files *above* the substrate — intentionally **not** gated as
> features. The only review content with no feature, by design.

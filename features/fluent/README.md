# `features/fluent/` — proposed feature set

**Purpose.** Turn `docs/sdds/fluent-firegrid-sdd.md` (the canonical design
handoff) into **falsifiable Gherkin acceptance requirements** (`*.feature`) that
we empirically settle with firelab experiments. Each feature is a cluster of
product-observable scenarios; the corresponding firelab experiment should live
with its driver and coverage witness, and any mutation harness must flip the
verdict red.

**Structure: authoring package + two halves + shared substrate** (matches the SDD).
- **Authoring package.** `@firegrid/fluent-firegrid` exposes the public DSL:
  definitions plus free primitives. It does not host a runtime or expose the
  external host control surface.
- **Below-line authored procedures.** `run`, retry, compensation, local
  concurrency, local cancellation, and deterministic Clock/Random semantics are
  durable Effect authoring concerns for reusable workflows. They are not the
  managed-agent session architecture.
- **Half 1 — Non-invasive agent binding.** The bridge over the agent's *own*
  harness. **🔴 real-agent only**: every Half-1 acceptance experiment MUST drive a
  real spawn-target (real native/ACP agent). A fake adapter/recorder/fake-codec is
  **invalid except for unit tests below the firelab acceptance layer**.
- **Half 2 — Durable coordination surface.** The agent-facing durable tools
  (`wait_for`/`wait_until`/`sleep`/`spawn`/`spawn_all`/`execute`) as session
  stream facts, DS wake delivery, and post-wake product redrive.
- **Shared substrate.** Durable Streams owns stream storage, producer fencing,
  named consumers, claim/ack/release, cursors, leases, retry, and webhook wake
  delivery. Fluent owns only the product step after those primitives fire.

**Coverage guarantee.** Every section of `fluent-firegrid-sdd.md` maps to at
least one feature — see the **Traceability matrix**. The only deliberate gap is
the SDD's own D.7 surface-glue carve-out.

## Design boundary: below-line authoring versus managed sessions

The `tf-2tl5.1` design-alignment specs take the useful durable-Effect pieces from
the fluent-firegrid proposal and scope them below the managed-agent line:

- `@firegrid/fluent-firegrid` authoring owns named `run` replay, value/error
  schemas at the journal boundary, retry inside `run`, compensation through
  Effect finalizers, deterministic Clock/Random services, and local
  fiber/scoped cancellation semantics.
- The Firegrid host owns session authority for managed agents: stream facts,
  product ingress, post-claim outcome recording, and harness I/O re-entry around
  the external model loop. The current implementation package is
  `packages/fluent-runtime`.
- Managed agent sessions are not long-lived workflow bodies. They are host-driven
  harness coordination around external Claude/Codex/native/cloud loops.
- Durable child/session spawn is not `Effect.fork`; local fibers are an
  authoring primitive, while durable spawn is a host-recorded coordination fact
  and substrate wake relationship.

Write-path risk remains intentionally open for `tf-3zbj.1`: the authoring specs
allow a future correction to producer/fencing strategy, but this slice does not
implement or bless a new write path.

## Execution state ledger

This ledger tracks implementation/proof state. The `.feature` files remain the
acceptance contracts; this table records where execution currently stands so
lanes do not infer status from stale PRs or ad hoc comments.

Status meanings:
- `done` — accepted baseline is merged for the current scope.
- `partial` — useful work is merged, but the load-bearing acceptance proof is
  not complete.
- `in-flight` — active lane or open PR is currently responsible for the next
  slice.
- `spec-only` — the acceptance contract exists, but no accepted implementation
  proof is in place.
- `needs-rework` — prior work exists, but it does not satisfy the current
  architecture/spec bar.

Folder tracking epics:

| Folder | Bead | State | Notes |
|---|---:|---|---|
| `agent-binding/` | `tf-88bd` | partial | ACP client (#967) and conductor (#969) bindings are merged with firelab witnesses; the real-harness boundary proofs (native resume, park interface, approval fidelity, bridge mediation) remain the critical gap. |
| `authoring/` | `tf-2tl5` | partial | Public fluent surface baseline is merged; follow-up specs pin schema decode, retry/compensation, determinism, and duplicate-key behavior for below-line authored procedures without changing managed-agent session architecture. |
| `control-plane/` | `tf-1726` | partial | Baseline control surface exists; host must keep converging on real DS primitives. |
| `coordination/` | `tf-4grn` | partial | Durable wait/sleep/event/fork specs are aligned to the two-model/one-DS-core canon; end-to-end product proofs remain. |
| `framing/` | `tf-hqya` | partial | Specs exist; firelab/cucumber verdict surface is still being hardened. |
| `substrate/` | `tf-3zbj` | partial | DS consumer substrate conformance is an imported prerequisite; Firegrid product post-claim use remains the acceptance bar. |

Per-spec state:

| Spec | State | Evidence / owner | Next acceptance bar |
|---|---|---|---|
| `agent-binding/fluent-agent-adapter-contract.feature` | spec-only | Process-owner package exists in `packages/fluent-acp-process`, but this feature is broader than process lifecycle. | Real harness spawned through the adapter boundary with raw observation and no DS writes by the harness. |
| `agent-binding/fluent-approval-fidelity.feature` | spec-only | No accepted real approval fidelity proof yet. | Real native/ACP approval round trip preserving per-request response shape. |
| `agent-binding/fluent-bridge-mediation.feature` | spec-only | No accepted mediation proof yet. | One-prompt-in-flight, dedupe, interrupt, and cancel semantics against a real harness. |
| `agent-binding/fluent-client-normalization.feature` | spec-only | Prior client-normalization work was not accepted as the canonical projection path. | Raw stream replay materializes durable projections without rewriting raw history. |
| `agent-binding/fluent-firegrid-acp-client.feature` | partial | `tf-w9uc` (#967) merged the fluent-runtime ACP client binding (`FiregridAcpClient implements acp.Client` + `connectFiregridAcp`); process owner `packages/fluent-acp-process` merged (#966). Witness: firelab `fluent-acp-client-binding` drives the client over an ACP stream and asserts L1/L2 facts through `FluentStore` (forge-proof `fluent_runtime.store.*` gates), but the spawned target is still a fixture ACP process. | `tf-88bd.1` real spawned Claude/Codex ACP process through the process owner; `tf-88bd.4` cancel/interrupt; `tf-88bd.5` callback-surface coverage; `tf-88bd.7` import guards. |
| `agent-binding/fluent-firegrid-acp-conductor.feature` | partial | `tf-v2nv` (#969) merged the editor-facing conductor (`FiregridAcpConductor implements acp.Agent` + pure `connectFiregridAcpConductor`); roles stay separate (no public `acp.Client \| acp.Agent` union). Witness: firelab `fluent-acp-conductor-binding` drives an ACP SDK editor client over `acp.Stream` into the conductor → durable session facts (verdict `production-path-covered`); see `docs/findings/tf-v2nv-conductor-binding-witness.md`. It does not yet prove stdio, downstream delegation, or real prompt execution. | `tf-88bd.2` Zed/CLI stdio packaging with stdout protocol discipline; `tf-88bd.3` downstream delegation and real prompt-driving; `tf-88bd.8` SDD signature reconciliation. |
| `agent-binding/fluent-harness-adapter-boundary.feature` | partial | Harness adapter contract docs/specs are merged; process owner is isolated. | L1 observation -> L2 commitment -> native result path, with park/redrive, authored-procedure durable tools running as child invocations (F-S12), and no duplicate already-observed Layer 1 side effects (`tf-88bd.6`). |
| `agent-binding/fluent-mcp-tools-out.feature` | partial | MCP/tool edge work exists, but it must stay thin over fluent-runtime semantics. | Durable tools reachable by a real harness through an Effect Tool/Toolkit/McpServer-shaped edge. |
| `agent-binding/fluent-native-resume.feature` | needs-rework | Earlier resume work predates the current no-duplicate-L1-side-effect contract. | `tf-88bd.6`: kill/restart a real harness and resume by reconstruction, suppressing every already-observed Layer 1 side effect (F-S6), including harness-native effects Firegrid did not mediate. |
| `agent-binding/fluent-park-interface.feature` | needs-rework | Earlier park-interface work did not settle the real transport end-of-turn proof. | Parking tool ends the native turn, later wake re-enters through the real harness path. |
| `agent-binding/fluent-three-envelope-stream.feature` | spec-only | No accepted stream-envelope proof yet. | Intent, raw, and lifecycle envelopes appear as durable truth with projections derived later. |
| `authoring/fluent-firegrid-public-surface.feature` | partial | Public surface spec and implementation are merged; `tf-2tl5.1` adds below-line authoring contracts for replay schemas, retry/compensation, and local Effect composition. | Prove value/error schema decode and duplicate-key failure without broadening fluent-firegrid into a session host. |
| `control-plane/fluent-control-surface.feature` | partial | Baseline control surface and workbench host exist. | Drive `send`/`fork`/`tag`/`schedule`/read APIs over real DS substrate instead of handrolled hosts. |
| `coordination/fluent-coordination-taxonomy.feature` | spec-only | Taxonomy is aligned to the PR #980 canon: two execution models share one DS core; addressing is not synchronous calling. | Product facts use State Protocol shapes and given-key addressing; DS grants work; Firegrid appends L2 outcomes before ack. |
| `coordination/fluent-durable-sleep.feature` | partial | Timer facts/sources exist conceptually; local/process sleep remains the gap to close. | Timer intent before park, append-at-T source materializes `TimerFired`, post-claim actor appends L2 timer resolution before ack, replay resolves from stream. |
| `coordination/fluent-durable-wait.feature` | partial | Wait facts and CEL direction are captured; post-claim DS redrive is not complete. | Wait intent before park with recorded `self`, catch-up closes lost wakeups, CEL over `event` + recorded `self`, L2 `wait_matched` before ack, replay serves recorded match. |
| `coordination/fluent-event-ingress.feature` | partial | Event ingress work exists, but provider webhook/state observability needs DS-native proof. | Fenced provider append becomes queryable state; provider webhook admission stays distinct from DS webhook wake; post-claim matching records L2 facts before ack. |
| `coordination/fluent-fork-spawn.feature` | partial | Fork/spawn direction exists; cross-harness parent/child choreography is not proven. | Parent harness A forks child harness B, child terminal append-and-close wakes parent, durable tool bodies run on child authored-procedure streams, both survive restart. |
| `coordination/fluent-session-handler.feature` | needs-rework | Prior session-handler work drifted toward lab-only or legacy-runtime shapes. | `handleSession(wake)` materializes state from DS, evaluates product semantics, appends one L2 outcome before ack, and drives the external harness without owning the model loop. |
| `framing/fluent-coverage-oracle.feature` | partial | Gherkin/firelab direction is settled; trace-CEL is diagnostic rather than verdict. | Product-observable `Then` assertions with mutation/vacuity checks for each major flow. |
| `framing/fluent-execution-model.feature` | done | Architecture docs now capture choreography, handler, external-harness axes. | Keep this as the framing gate for reviews, not as a product implementation task. |
| `substrate/fluent-concurrent-replay-soundness.feature` | needs-rework | PR #955-style low-level/mock-DS work is not acceptable as the proof; `tf-2tl5.1` adds the duplicate-key loud-failure contract. | Re-prove named-key replay and duplicate-key failure for authored procedures; managed sessions continue by reconstruction, not Effect-body replay. |
| `substrate/fluent-durable-streams-consumer-substrate.feature` | partial | Upstream/fork DS consumer substrate conformance is green and pinned as a prerequisite. | Firegrid product witness: shared DS substrate for both execution models; claim -> materialize -> append one L2 outcome -> ack/done after durable append. |
| `substrate/fluent-engine-substrate-free.feature` | partial | Substrate-free fluent engine baseline is merged; `tf-2tl5.1` adds authoring-runtime contracts for schema decode, deterministic Effect services, retry, compensation, and local fibers. | Keep scheduler/journal internals out of the public authoring surface; durable child/tool invocation runs on a child stream owned by fluent-runtime coordination. |
| `substrate/fluent-worker-redrive.feature` | partial | Earlier redrive work must be revisited atop the real DS consumer substrate. | DS grants wake and owns claim mechanics; Firegrid materializes, appends one L2 product outcome, continues by replay or reconstruction, and acks/dones only after durable outcome. |

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

## Authoring package — `@firegrid/fluent-firegrid`

Reference surface: `repos/sdk-typescript/packages/libs/restate-sdk-gen/src/index.ts`
and its tutorial examples. The fluent package mirrors the authoring affordances
that matter while keeping runtime/control-plane concerns out of this layer.

| Feature file | Asserts (source / SDD §) | Proof |
|---|---|---|
| `fluent-firegrid-public-surface` | Public package surface = definitions (`service`/`object`/`workflow`) + generator handlers + free primitives (`run`/`all`/`race`/`select`/`spawn`) + descriptor/interface helpers + typed client derivation + explicit handler-edge execution (`execute`/`invoke`). Definitions must carry enough public metadata for a Firegrid host to bind product ingress without importing internals. Host/control APIs and substrate mechanics stay outside the authoring package. `run` names journal steps; local composition is Effect-shaped; no public bespoke Future scheduler; scheduler/awaitable/journal implementation details are not root public API. | package API tests + tutorial examples + `fluent-control-surface` binding |

---

## Half 1 — Non-invasive agent binding · 🔴 real-agent only

Reference implementation, source-verified line-by-line:
`repos/durable-streams/packages/coding-agents/`. Each feature is split out so a
red spec localizes which part of the bridge failed.

Canon for this group: `docs/cannon/architecture/fluent/harness-io.md` (the ACP
client/conductor harness I/O roles; raw harness writes no Durable Streams facts),
`docs/cannon/architecture/fluent/execution-models.md` (managed sessions resume by
reconstruction, not replay; authored-procedure durable tools run as child
invocations), and `docs/cannon/architecture/fluent/architecture.md` invariants
**F-S1** (raw harness writes no DS facts), **F-S6** (resume suppresses every
already-observed Layer 1 side effect), and **F-S12** (authored-procedure tool runs
as a child invocation on its own stream).

| Feature file | Asserts (source) | Firelab proof |
|---|---|---|
| `fluent-firegrid-acp-client` | For ACP harnesses, Firegrid exports and owns the ACP `Client` implementation and ACP `ClientSideConnection` wiring. The process owner only supplies the ACP stream and lifecycle. `sessionUpdate`/permission/tool callbacks become Firegrid-owned L1 observation and L2 commitment; ACP adapter packages import only the fluent-runtime ACP subpath. Agent DB/queryable row schemas are projection-owned, not adapter-core state. (`SDD_FLUENT_HARNESS_ADAPTER_CONTRACT`) | 🔴 real ACP process + FiregridAcpClient proof: process stream → ACP client callbacks → stream L1/L2 outcomes; import-boundary check |
| `fluent-firegrid-acp-conductor` | For Zed/editor-launched ACP flows, Firegrid exports and owns `FiregridAcpConductor implements acp.Agent`. Zed is the ACP client; Firegrid is the editor-facing ACP agent/conductor; downstream delegation uses the separate `FiregridAcpClient` role. ACP stdio stdout is protocol-only. Firepixel's conductor spike is prior art for explicit roles, `AgentSideConnection` outer editor wiring, `ClientSideConnection` downstream wiring, and ordered routing, not a product dependency. (`SDD_FLUENT_HARNESS_ADAPTER_CONTRACT`, Zed ACP stdio proposal) | 🔴 Zed-style ACP stdio proof: editor initialize/session/prompt/cancel over SDK; stdout ACP-only; optional downstream delegation keeps roles separate |
| `fluent-harness-adapter-boundary` | The load-bearing boundary contract: raw harness owns the native loop and writes no Durable Streams records; for ACP harnesses Firegrid's ACP client records Layer 1 observation and native protocol fidelity; fluent-runtime records Layer 2 coordination commitments; committed tool results return through the native tool-result path. Parking appends intent before native end-of-turn; post-wake redrive resumes through the ACP process owner; no already-observed Layer 1 side effect duplicates. (`SDD_FLUENT_HARNESS_ADAPTER_CONTRACT`) | 🔴 real harness boundary proof: L1 observation → L2 commitment → native result; park/redrive; restart without duplicate side effect |
| `fluent-agent-adapter-contract` | The `AgentAdapter` contract: `spawn`(the real native/ACP harness) · `parseDirection` · `isTurnComplete` · `translateClientIntent` · `prepareResume`; `AgentConnection` = `onMessage`(observe raw→record) · `send`(native input) · `kill` · `on(exit)`. Firegrid **never owns the loop**. (`adapters/types.ts`; Appendix E adapter contract) | 🔴 real agent spawned via adapter; trace shows a real spawn span + raw recorded |
| `fluent-three-envelope-stream` | Durable-stream truth model: **intent** `UserEnvelope`(user_message/control_response/interrupt) · **raw** `AgentEnvelope`(bridge-written, the durable truth) · **lifecycle** `BridgeEnvelope`(session_started/resumed/ended). Raw first, projection later. (`types.ts`; Appendix E two-layers) | stream trace contains all three envelope families |
| `fluent-bridge-mediation` | One prompt in flight (`pendingPrompts` shift on `isTurnComplete`); duplicate approval/response dedup via `syntheticKey`; **interrupt synthesizes cancellation responses for ALL pending requests before the native interrupt**; terminal/lifecycle recorded before cleanup. Cancel during a parked wait and interrupt during an active turn must leave durable cancellation/terminal/continuation evidence before teardown and must not duplicate observed side effects on redrive. (`bridge.ts`) | 🔴 real-agent approval + interrupt/cancel scenario |
| `fluent-approval-fidelity` | Native adapter preserves **per-request** approval shapes (`commandExecution→{decision}`, `fileChange→{decision}`, `permissions→{permissions,scope}`, `tool/requestUserInput→{answers}`); ACP flattening is an **explicit fidelity tradeoff** (the ACP-vs-native decision, O3). (`adapters/codex.ts`) | 🔴 real approval round-trip preserving native shape |
| `fluent-native-resume` | Reconstruct the **native** resume artifact from the stream, then resume natively (not prompt-replay, not ACP `session/load` which dies with the sandbox). Attempt native resume when stream history exists and a resume artifact is reconstructable; if native resume fails, fall back to a fresh spawn **only when pending prompt replay can safely bridge** (`bridge.ts:193–243`). Claude — rebuild transcript JSONL + `--resume`, with the cross-cwd **seed fallback** (`forceSeedWorkspace`) as the bridge; Codex — `thread/resume {threadId}`. Path-rewrite for cross-sandbox mounts. (`adapters/{claude,codex}.ts`) | 🔴 kill/restart real agent → re-drive from stream → native resume |
| `fluent-client-normalization` | Raw protocol events project into `NormalizedEvent`s (assistant_message/stream_delta/tool_call/tool_result/permission_request/turn_complete) and durable read models (sessions/turns/tool_calls/permission_requests/…); **projections are pure views over immutable raw** — they can change without rewriting raw history. (`normalize/`, `agent-db-schema.ts`) | replay a captured raw stream into collections; projection can change without rewriting raw (no live agent) |
| `fluent-park-interface` | A parking Firegrid tool **reliably ends the harness turn via transport end-of-turn**, then resume re-enters natively. The load-bearing piece of the non-invasive binding; gates `durableWaitCoverage`. **The one open source-read** (O1). | 🔴 new real-agent spec; **cannot be substrate-only** |
| `fluent-mcp-tools-out` | The (out) half: MCP-over-durable-streams exposes Firegrid's durable tools to the harness; **swappable** — the property (never wraps the loop) is the differentiator, the mechanism is not. (Differentiator 1) | 🔴 durable tools reachable by a real harness |

---

## Half 2 — Durable coordination surface

| Feature file | Asserts (SDD §) | Firelab CoverageSpec |
|---|---|---|
| `fluent-durable-wait` | `wait_for`/`wait_any` append `WaitIntent` **before** park; the named wait-matcher contract evaluates over `event` + recorded `self`; **`afterOffset` catch-up prevents lost wakeup**; the timeout race is **fenced once** (at-most-once winner). Given-key principle: key by `toolCallId` / `(toolCallId, slotIndex)`. Journal the predicate + matched event + `self` snapshot/reference so replay/redrive resolves from the journal, never re-evaluates a moving world or a newer session projection. Firegrid appends L2 `wait_matched` before ack/done. Generic predicate subscription is substrate/substrate-adapter work, not fluent-firegrid. (Appendix D.3/D.4) | `durableWaitCoverage` + `raceCoverage` |
| `fluent-durable-sleep` | `sleep`/`wait_until` append timer intent (`TimerScheduled`) **before** park; **no `Clock.sleep`/local timer**; a substrate scheduled-append source materializes `TimerFired`; post-claim Firegrid appends the L2 timer resolution before ack/done; replay resolves from the journal. The net-new piece is the substrate scheduled source contract. `sleep`+`wait_for` = one family, two sources. (Part 3 sleep; Appendix D.2) | `durableSleepCoverage` |
| `fluent-fork-spawn` | `spawn`/`spawn_all` create a child session via **stream fork / child stream**; **producer state resets** on the child; the parent waits on the child's **terminal event / closure** (the cross-session join — the parent cannot inline-join a child fiber). Durable tool implementations with authored primitives run as child authored-procedure streams. Composite proof: parent harness A can spawn child harness B, the child terminal fact wakes the parent, and both adapters resume safely after kill/restart. `raceCoverage` facet b = the child-cancel-vs-leave policy (O2). (Substrate Commitments; Appendix D.5) | `crossSessionCoverage` (+ `raceCoverage` b) |
| `fluent-coordination-taxonomy` | `runs`/`toolCalls`/`inbox`/`childStatus`/`wakes`/`tags`/`errors` as State-Protocol change-messages, keyed by given ids. **Addressing is not calling** (`send`/`spawn` address an event; delivery is through Durable Streams; recipient decides on its wake). Authored procedures and managed sessions share one DS core; candidate wake facts are product facts; DS delivers/grants work; Firegrid records post-wake eligibility/outcome. (Build order 1; Coordination/ingress) | underpins `durableWait`/`crossSession` |
| `fluent-session-handler` | `handleSession(wake)` + `driveHarness` re-invoke the **external** harness with a resume context (never `agent.run`): materialise committed stream → build resume context → evaluate product semantics → append one L2 outcome → ack/done after durable append → drive after DS delivery or claim. The harness-resumability dependency is "the one piece of real engineering." (System shape; Build order 2; Appendix E.1/E.5) | product-observable redrive + resume witness |
| `fluent-event-ingress` | Provider/external event ingest = a **fenced append** into the stream; post-claim Firegrid matching records `wait_matched` facts for eligible waits. **Duplicate delivery deduped by §5.2.1 producer fencing** (delivery-id). Provider webhook admission is product ingress; Durable Streams webhook wake authentication/callback/retry remains substrate-owned. (Coordination/ingress 578–584) | ingest + wait-match trace |

---

## Shared substrate (under both halves)

| Feature file | Asserts (SDD §) | Firelab CoverageSpec |
|---|---|---|
| `fluent-engine-substrate-free` | Collapse the DSL onto Effect with **named (not positional) journal keys** → `run` returns a plain `Effect`; `Future`/`Scheduler.drive`/`Awaitable`/`operation.ts`/`current.ts` all **delete**; local concurrency + local fiber spawn become free. **Durability enters via provided `Journal`/`FencedWriter` Effect.Services at the handler edge; the engine core (the `Effect.gen` bodies) stays substrate-free** — it does not import a host or durable substrate directly. Durable child/tool invocation is a host coordination fact on its own stream, not inline engine replay. What-becomes-free: retry/saga/in-process-cancel/serde. (Part 1; Summary) | `replayCoverage` + airgap assertion |
| `fluent-durable-streams-consumer-substrate` | Adopt Durable Streams named consumers, pull-wake, webhook wake, and idempotent-producer coordination as the wake/redrive substrate for both execution models. Treat the adopted package's upstream conformance suites as imported prerequisites: L1 named consumers (register/acquire/ack/release/stale epoch/cursors), L2/B pull-wake (wake stream, claimed event, persisted cursors, lease-expiry re-wake, competing claims), and L2/A webhook wake (signed delivery, callback, ack/done/retry/idle). Durable Streams owns claim/lease/cursor/retry/webhook-wake mechanics. The Firegrid host only runs the post-claim product step and must not rebuild lease tables, cursor stores, pull queues, webhook retry loops, scheduled-wake engines, generic predicate subscriptions, or task-claim locks. Coordination patterns use producer-fenced first-writer-wins claims and explicit epoch override for recovery. | upstream Durable Streams conformance prerequisite + Firegrid post-claim integration witness |
| `fluent-worker-redrive` | Durable Streams **grants the claim/lease**; fluent materialises session/source facts from provided offsets, appends one L2 product outcome, continues by authored replay or managed-session reconstruction, and **acks/dones through** the server's §7.2/§7.3 machinery after the durable product outcome is recorded. Fluent does NOT rebuild the lease; stale-generation ack, competing claim, cursor persistence, retry, and `next_wake:true` are DS conformance concerns. `acked_offset` is a delivery cursor, not a replay position (replay reads the journal every claim). (Part 3; Appendix B) | product-observable post-claim redrive witness |

**Upstream substrate assumption.** Durable Streams stream closure, append-after-close
rejection, fork inheritance, idempotent producer fencing, and subscription
claim/ack/release generation fencing are dependency conformance, covered by
`durable-streams` server tests. Fluent firelab specs should only assert our
product uses those primitives correctly in vertical flows such as durable
sleep, durable wait, fork spawn, and post-claim redrive.

---

## Below the choreography line (optional; authored procedures only — the agent path depends on NONE of it)

| Feature file | Asserts (SDD §) | Firelab CoverageSpec |
|---|---|---|
| `fluent-concurrent-replay-soundness` | **Named-key concurrent-replay soundness under `Effect.all(concurrency:"unbounded")`** (Appendix A's TFIND: *named journal keys are sound under concurrent replay*); the **mutation proves positional/runtime-counter keys desync** on replay (mis-key → `served=="executed"` / tripwire fires → RED). The race landmine, two facets: (a) **winner-record journaled — NOT a choice** (bounded-`wait_for` safety depends on it); (b) **loser-fate** (let-finish-and-journal *vs* interrupt) — pick per combinator. (Appendix A; Part 1 race landmine; Appendix C Spec 1/5) | `replayCoverage` + `raceCoverage` |

---

## External Host Control Surface

| Feature file | Asserts (SDD §) | Firelab proof |
|---|---|---|
| `fluent-control-surface` | External `/entities/:type/:id` control — `send` · `fork` · `tag` · `schedule`(→adopted scheduled source / DS wake integration) · `get`/`head`/`delete` — as **product spelling over durable-stream primitives**. `tag` names an offset; `fork` branches a new entity from a prefix (stream *is* the state → fork = copy-a-prefix → "explore from here" / "retry under a changed tool set" / "snapshot before a risky action"). Read plane = the same projection externalised. (External control surface) | control-plane simulation over stream facts |

---

## Framing & harness (required context, not buildable agent features)

| Item | Covers (SDD §) | Status |
|---|---|---|
| `fluent-execution-model` | The three axes — **choreography · handler · external-harness**; "you cannot replay the model" → durable unit = the committed tool-call-and-result; "sessions never call each other" → **address ≠ call**; the three differentiators (non-invasive binding · forge-proof firelab · deterministic-replay rigor). (System shape; Execution model) | the framing every feature inherits |
| `fluent-coverage-oracle` | Stand up the **firelab runner over fluent-firegrid** (`firelab` is the home — the runner is the driver + Control + infra seam). Verdicts are product-observable: stream contents, projections, resumed output, approval shapes, and durable outcomes. Diagnostic spans may explain failures but cannot replace `Then` assertions. Any substrate evidence must be emitted by Durable Streams or the host, never forged by the driver. Each spec = witness + a **mutation harness that must flip red** + a **vacuity check**. (Appendix C) | harness · partly green-now (oracle exists in `firelab`; the fluent runner is net-new) |

---

## Open decisions (must be resolved; NOT code requirements)

| # | Decision | Status / recommendation |
|---|---|---|
| O1 | **Park interface (a) pending-result vs (b) transport end-of-turn.** | Recommend **(b)**; the one **source-read still open** — answered by `fluent-park-interface` (real-agent). |
| O2 | **Child-race loser policy** — cancel vs leave+absorb (`raceCoverage` facet b). Winner-record (a) is not a choice. | PO call. Default: leave+absorb; cancel as opt-in. |
| O3 | **Claude wire protocol: ACP vs native.** | Fully informed (fidelity delta source-verified); recommend native. PO call. Answered by `fluent-approval-fidelity`. |
| O4 | **Confirm Electric internals.** | **Regressed** — `repos/electric` no longer on disk → un-re-verifiable locally. NOT load-bearing (decision rests on `coding-agents`, which is vendored). |
| O5 | **Net-new scheduled append substrate contract** — DO alarm / timer-wheel / Durable Streams scheduled wake that materialises T as an append. | The missing infrastructure belongs below the Firegrid host. Confirmed net-new vs the Restate SDK (`sleep`→`ctx.sleep`, a server feature) **and** `coding-agents` (no scheduler). |

---

## Recommended first slice

1. `fluent-durable-streams-consumer-substrate` (adopt/prove DS dependency path before building post-claim product code)
2. `fluent-worker-redrive` (post-claim product use after DS claim/ack/release, not a worker substrate)
3. `fluent-durable-sleep` (headline durable-wait gap)
4. `fluent-durable-wait` (headline durable-wait gap)
5. `fluent-agent-adapter-contract` (🔴 non-invasive real-agent binding)
6. `fluent-native-resume` (🔴 recovery thesis)
7. `fluent-park-interface` (🔴 the open binding proof)

Covers the headline durable-wait gap, Firegrid's use of the Durable Streams wake
protocol, and the non-invasive real-agent binding/recovery thesis. **Half-1
proofs must state: real spawn target only; a fake adapter is invalid except for
unit tests below the firelab acceptance layer.** The oracle
(`fluent-coverage-oracle`) is a prerequisite for grading any of these
empirically.

---

## Traceability matrix — every review section → feature (line ranges advisory)

| `fluent-firegrid-sdd.md` section | Feature |
|---|---|
| TL;DR four takeaways | all groups (1→execution-model/binding, 2→below-line, 3→Half 1, 4→shared substrate) |
| System shape | `fluent-execution-model`, `fluent-session-handler` |
| Execution model: axes / can't-replay / keys / races / differentiators | `fluent-execution-model`; keys→`fluent-durable-wait`+`fluent-concurrent-replay-soundness`; races→`fluent-fork-spawn` |
| Background | `fluent-engine-substrate-free` |
| Public authoring surface | `fluent-firegrid-public-surface` |
| Part 1 — collapse DSL onto Effect | `fluent-engine-substrate-free` (+ race landmine→`fluent-concurrent-replay-soundness`) |
| Part 2 — three families | `fluent-durable-sleep`+`fluent-durable-wait` (park/wake); upstream DS conformance is an assumption, not a Firegrid feature |
| Part 3 — DS §7.2/§7.3 = wake subsystem | substrate conformance→`fluent-durable-streams-consumer-substrate`; product redrive→`fluent-worker-redrive`; sleep→`fluent-durable-sleep`; two-fencing is covered by DS conformance and asserted only through product use |
| Coordination and ingress | `fluent-coordination-taxonomy`, `fluent-event-ingress` |
| External control surface (fork/tag/schedule) | `fluent-control-surface` |
| Build order tiers 1–11 | Half 2 (1–6) · Shared substrate (7–9) · Half 1 (10) · Below-line (11) |
| Appendix A — named-keys soundness | `fluent-concurrent-replay-soundness` |
| Appendix B — wake substrate | `fluent-worker-redrive` + `fluent-durable-sleep` |
| Appendix C — coverage specs + HOST_SUBSTRATE | `fluent-coverage-oracle` (+ each spec → its Half-2/shared feature) |
| Appendix D — agent surface / `durable.wait` / CEL / cross-session / race-defused / glue | `fluent-durable-wait` (D.1/D.3/D.4/D.6), `fluent-fork-spawn` (D.5); D.7 glue = carve-out below |
| Appendix E — handler / two layers / adapter contract / durable tools / park / resume | `fluent-session-handler`, `fluent-client-normalization`, `fluent-agent-adapter-contract`, `fluent-three-envelope-stream`, `fluent-bridge-mediation`, `fluent-native-resume`, `fluent-park-interface` |
| SDD_FLUENT_HARNESS_ADAPTER_CONTRACT — ACP client/conductor boundary / L1-L2 handoff / native resume safety | `fluent-firegrid-acp-client`, `fluent-firegrid-acp-conductor`, `fluent-harness-adapter-boundary`, `fluent-agent-adapter-contract`, `fluent-native-resume`, `fluent-park-interface`, `fluent-mcp-tools-out` |
| Still open | Group O (O1–O5) + `fluent-coverage-oracle` (the firelab runner) |
| Sources & provenance | provenance; O4 = the regressed Electric items |

> **Surface-glue carve-out (D.7):** approval gates, middleware, dashboards, the ACP
> adapter, budget/policy, context injection are "one primitive + one combinator"
> the README itself files *above* the substrate — intentionally **not** gated as
> features. The only review content with no feature, by design.

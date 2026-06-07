# `features/fluent/` — proposed feature set

**Purpose.** Track the fluent Gherkin acceptance surface and execution ledger.
The architecture source of truth is the canon doc set:
`docs/cannon/architecture/fluent/README.md`,
`docs/cannon/architecture/fluent/execution-models.md`,
`docs/cannon/architecture/fluent/substrate-protocol.md`, and
`docs/cannon/architecture/fluent-architecture.md`. These feature files translate
that canon into falsifiable acceptance requirements.

**Structure: two execution models over one Durable Streams coordination core.**
- **Authoring package.** `@firegrid/fluent-firegrid` exposes the public DSL:
  definitions, descriptors, typed clients, `run`, keyed replay, and durable
  primitive definitions. It is Effect-native authoring, not an Operation/Future
  runtime, and it does not host processes or expose the external control plane.
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
- **Control plane.** External `send`/`fork`/`tag`/`schedule`/`read`/`head`/
  `delete` are product spelling over Durable Streams primitives through
  fluent-runtime host ingress. Acceptance must prove client ingress -> host ->
  runtime/store -> Durable Streams, not host self-calls.

This README is an overview and ledger. It does not own the numbered safety
invariants; those live in
`docs/cannon/architecture/fluent-architecture.md#safety-invariants`.

## Design boundary: below-line authoring versus managed sessions

The `tf-2tl5.1` design-alignment specs take the useful durable-Effect pieces from
the fluent-firegrid proposal and scope them below the managed-agent line:

- `@firegrid/fluent-firegrid` authoring owns named `run` replay, value/error
  schemas at the journal boundary, retry inside `run`, compensation through
  Effect finalizers, deterministic Clock/Random services, and local
  fiber/scoped cancellation semantics.
- `packages/fluent-runtime` owns session authority for managed agents: stream
  facts, wake/redrive, wait/timer/child/session coordination, and harness I/O
  re-entry around the external model loop.
- Managed agent sessions are not long-lived workflow bodies. They are host-driven
  harness coordination around external Claude/Codex/native/cloud loops.
- Durable child/session spawn is not `Effect.fork`; local fibers are an authoring
  primitive, while durable spawn is a fluent-runtime coordination fact and wake
  relationship.

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
| `authoring/` | `tf-2tl5` | partial | Public fluent surface baseline is merged; specs now align to Effect-native authoring over `run` and typed descriptors, not an Operation/Future runtime. |
| `control-plane/` | `tf-1726` | partial | Baseline control surface exists; acceptance must prove external client ingress through fluent-runtime to runtime/store and Durable Streams, not host self-calls. |
| `coordination/` | `tf-4grn` | partial | Durable wait/sleep/event/fork primitives are not fully proven end to end. |
| `framing/` | `tf-hqya` | partial | Specs align to the canon replay-vs-reconstruction split; firelab/cucumber verdict surface is still being hardened. |
| `substrate/` | `tf-3zbj` | partial | DS consumer substrate is proven at dependency level; product post-claim loop remains. |

Per-spec state:

| Spec | State | Evidence / owner | Next acceptance bar |
|---|---|---|---|
| `agent-binding/fluent-agent-adapter-contract.feature` | spec-only | Process-owner package exists in `packages/fluent-acp-process`, but this feature is broader than process lifecycle. | Real harness spawned through the adapter boundary with raw observation and no DS writes by the harness. |
| `agent-binding/fluent-approval-fidelity.feature` | spec-only | No accepted real approval fidelity proof yet. | Real native/ACP approval round trip preserving per-request response shape. |
| `agent-binding/fluent-bridge-mediation.feature` | spec-only | No accepted mediation proof yet. | One-prompt-in-flight, dedupe, interrupt, and cancel semantics against a real harness. |
| `agent-binding/fluent-client-normalization.feature` | spec-only | Prior client-normalization work was not accepted as the canonical projection path. | Raw stream replay materializes durable projections without rewriting raw history. |
| `agent-binding/fluent-firegrid-acp-client.feature` | partial | `tf-w9uc` (#967) merged the fluent-runtime ACP client binding (`FiregridAcpClient implements acp.Client` + `connectFiregridAcp`); process owner `packages/fluent-acp-process` merged (#966). Witness: firelab `fluent-acp-client-binding` drives the client over an ACP stream and asserts L1/L2 facts through `FluentStore` (forge-proof `fluent_runtime.store.*` gates), but the spawned target is still a fixture ACP process. | `tf-88bd.1` real spawned Claude/Codex ACP process through the process owner; `tf-88bd.4` cancel/interrupt; `tf-88bd.5` callback-surface coverage; `tf-88bd.7` import guards. |
| `agent-binding/fluent-firegrid-acp-conductor.feature` | partial | `tf-v2nv` (#969) merged the editor-facing conductor (`FiregridAcpConductor implements acp.Agent` + pure `connectFiregridAcpConductor`); roles stay separate (no public `acp.Client \| acp.Agent` union). Witness: firelab `fluent-acp-conductor-binding` drives an ACP SDK editor client over `acp.Stream` into the conductor → durable session facts (verdict `production-path-covered`); see `docs/findings/tf-v2nv-conductor-binding-witness.md`. It does not yet prove stdio, downstream delegation, or real prompt execution. | `tf-88bd.2` Zed/CLI stdio packaging with stdout protocol discipline; `tf-88bd.3` downstream delegation and real prompt-driving; `tf-88bd.8` SDD signature reconciliation. |
| `agent-binding/fluent-harness-adapter-boundary.feature` | partial | Harness adapter contract docs/specs are merged; process owner is isolated. | L1 observation -> L2 commitment -> native result path, with park/redrive and no duplicate side effects (`tf-88bd.6`). |
| `agent-binding/fluent-mcp-tools-out.feature` | partial | MCP/tool edge work exists, but it must stay thin over fluent-runtime semantics. | Durable tools reachable by a real harness through an Effect Tool/Toolkit/McpServer-shaped edge. |
| `agent-binding/fluent-native-resume.feature` | needs-rework | Earlier resume work predates the current no-duplicate-L1-side-effect contract. | `tf-88bd.6`: kill/restart a real harness and resume natively without replaying observed side effects. |
| `agent-binding/fluent-park-interface.feature` | needs-rework | Earlier park-interface work did not settle the real transport end-of-turn proof. | Parking tool ends the native turn, later wake re-enters through the real harness path. |
| `agent-binding/fluent-three-envelope-stream.feature` | spec-only | No accepted stream-envelope proof yet. | Intent, raw, and lifecycle envelopes appear as durable truth with projections derived later. |
| `authoring/fluent-firegrid-public-surface.feature` | partial | Public surface spec and implementation are merged; `tf-s4z3` aligns wording to Effect-native authoring, typed descriptors, and absence of Operation/Future runtime ownership. | Prove value/error schema decode and duplicate-key failure without broadening fluent-firegrid into a session host. |
| `control-plane/fluent-control-surface.feature` | partial | Baseline control surface and workbench host exist; `tf-s4z3` adds the required client ingress -> host -> runtime/store -> Durable Streams acceptance path. | Drive `send`/`fork`/`tag`/`schedule`/read APIs over real DS substrate through the external host surface. |
| `coordination/fluent-coordination-taxonomy.feature` | spec-only | Taxonomy is captured, but not independently proven. | Product facts use State Protocol shapes and given-key addressing in vertical flows. |
| `coordination/fluent-durable-sleep.feature` | partial | Timer facts/sources exist conceptually; local/process sleep remains the gap to close. | Timer intent before park, scheduled source materializes `TimerFired`, replay resolves from stream. |
| `coordination/fluent-durable-wait.feature` | partial | Wait facts and CEL direction are captured; post-claim DS redrive is not complete. | Wait intent before park, CEL over event+self, DS wake, recorded match served on replay. |
| `coordination/fluent-event-ingress.feature` | partial | Event ingress work exists, but provider webhook/state observability needs DS-native proof. | Fenced provider append becomes queryable/observable state and wakes eligible waits. |
| `coordination/fluent-fork-spawn.feature` | partial | Fork/spawn direction exists; cross-harness parent/child choreography is not proven. | Parent harness A forks child harness B, child terminal fact wakes parent, both survive restart. |
| `coordination/fluent-session-handler.feature` | needs-rework | Prior session-handler work drifted toward lab-only or legacy-runtime shapes. | `handleSession(wake)` materializes state and drives the external harness without owning the model loop. |
| `framing/fluent-coverage-oracle.feature` | partial | Gherkin/firelab direction is settled; trace-CEL is diagnostic rather than verdict. | Product-observable `Then` assertions with mutation/vacuity checks for each major flow. |
| `framing/fluent-execution-model.feature` | partial | `tf-s4z3` aligns this spec to canon's two execution models: authored procedures resume by replay; managed sessions resume by reconstruction. | Use this as the review gate for execution-model drift, including authored tool bodies as child invocations. |
| `substrate/fluent-concurrent-replay-soundness.feature` | needs-rework | PR #955-style low-level/mock-DS work is not acceptable as the proof; `tf-2tl5.1` adds the duplicate-key loud-failure contract. | Re-prove named-key replay and duplicate-key failure using the real runtime boundary and upstream DS test server only where needed. |
| `substrate/fluent-durable-streams-consumer-substrate.feature` | partial | Upstream/fork DS consumer substrate conformance is green and pinned. | Firegrid post-claim witness: claim -> materialize -> append L2 outcome -> ack after durable append. |
| `substrate/fluent-engine-substrate-free.feature` | partial | Substrate-free fluent engine baseline is merged; `tf-2tl5.1` adds authoring-runtime contracts for schema decode, deterministic Effect services, retry, compensation, and local fibers. | Keep scheduler/journal internals out of the public authoring surface and keep durable child/session spawn in fluent-runtime coordination. |
| `substrate/fluent-worker-redrive.feature` | partial | Earlier redrive work must be revisited atop the real DS consumer substrate. | DS grants wake; Firegrid resolves product state and acks/releases only after durable outcome. |

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

Canon reference:
`docs/cannon/architecture/fluent/README.md#fluent-firegrid-durable-effect-authoring`.
The fluent package is an Effect-native authoring library. It keeps
runtime/control-plane concerns out of this layer and does not expose a bespoke
Operation/Future runtime.

| Feature file | Asserts (canon hook) | Proof |
|---|---|---|
| `fluent-firegrid-public-surface` | Public package surface = definitions (`service`/`object`/`workflow`) + Effect handlers + `run` + durable primitive definitions + descriptor/interface helpers + typed client derivation + explicit handler-edge execution. Definitions carry enough metadata for `fluent-runtime` to bind control-plane ingress without importing internals. `run` names journal steps; local composition is Effect-shaped; no public Operation/Future runtime, worker loop, scheduler, awaitable, or journal implementation export. | package API tests + tutorial examples + `fluent-control-surface` binding |

---

## Half 1 — Non-invasive agent binding · 🔴 real-agent only

Reference implementation, source-verified line-by-line:
`repos/durable-streams/packages/coding-agents/`. Each feature is split out so a
red spec localizes which part of the bridge failed.

| Feature file | Asserts (canon hook) | Firelab proof |
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

| Feature file | Asserts (canon hook) | Firelab CoverageSpec |
|---|---|---|
| `fluent-durable-wait` | `wait_for`/`wait_any` append `WaitIntent` **before** park; CEL predicate evaluated **during the drive** over `event` + recorded `self`; **`afterOffset` catch-up prevents lost wakeup**; the timeout race is **fenced once** (at-most-once winner). Given-key principle: key by `toolCallId` / `(toolCallId, slotIndex)`. Journal the predicate + matched event + `self` snapshot/reference so replay resolves from the journal, never re-evaluates a moving world or a newer session projection. (Appendix D.3/D.4) | `durableWaitCoverage` + `raceCoverage` |
| `fluent-durable-sleep` | `sleep`/`wait_until` append timer intent (`TimerScheduled`) **before** park; **no `Clock.sleep`/local timer**; the **timer source materializes `TimerFired`** (unforgeable `timer.fire`); replay resolves from the journal. The one genuinely net-new piece (O5). `sleep`+`wait_for` = one family, two sources. (Part 3 sleep; Appendix D.2) | `durableSleepCoverage` |
| `fluent-fork-spawn` | `spawn`/`spawn_all` create a child session via **stream fork / child stream**; **producer state resets** on the child; the parent waits on the child's **terminal event / closure** (the cross-session join — the parent cannot inline-join a child fiber). Composite proof: parent harness A can spawn child harness B, the child terminal fact wakes the parent, and both adapters resume safely after kill/restart. `raceCoverage` facet b = the child-cancel-vs-leave policy (O2). (Substrate Commitments; Appendix D.5) | `crossSessionCoverage` (+ `raceCoverage` b) |
| `fluent-coordination-taxonomy` | `runs`/`toolCalls`/`inbox`/`childStatus`/`wakes`/`tags`/`errors` as State-Protocol change-messages, keyed by given ids. **Addressing is not calling** (`send`/`spawn` address an event; delivery is through Durable Streams; recipient decides on its wake). Candidate wake facts are product facts; DS delivers/grants work; Firegrid records post-wake eligibility/outcome. (Build order 1; Coordination/ingress) | underpins `durableWait`/`crossSession` |
| `fluent-session-handler` | `handleSession(wake)` + `driveHarness` re-invoke the **external** harness with a resume context (never `agent.run`): materialise committed stream → build resume context → drive after DS delivery or claim. The harness-resumability dependency is "the one piece of real engineering." (System shape; Build order 2; Appendix E.1/E.5) | product-observable redrive + resume witness |
| `fluent-event-ingress` | Provider/external event ingest = a **fenced append** into the stream; post-wake Firegrid matching records `wait_matched` facts for eligible waits. **Duplicate delivery deduped by §5.2.1 producer fencing** (delivery-id). Durable Streams webhook wake authentication/callback/retry remains substrate-owned. (Coordination/ingress 578–584) | ingest + wait-match trace |

---

## Shared substrate (under both halves)

| Feature file | Asserts (canon hook) | Firelab CoverageSpec |
|---|---|---|
| `fluent-engine-substrate-free` | Collapse the DSL onto Effect with **named (not positional) journal keys** → `run` returns a plain `Effect`; `Future`/`Scheduler.drive`/`Awaitable`/`operation.ts`/`current.ts` all **delete**; concurrency + spawn become free. **Durability enters via provided `Journal`/`FencedWriter` Effect.Services at the handler edge; the engine core (the `Effect.gen` bodies) stays substrate-free** — it does not import the old runtime or the durable substrate directly. What-becomes-free: retry/saga/in-process-cancel/serde. (Part 1; Summary) | `replayCoverage` + airgap assertion |
| `fluent-durable-streams-consumer-substrate` | Adopt Durable Streams named consumers, pull-wake, webhook wake, and idempotent-producer coordination as the wake/redrive substrate. Gate the adopted package with upstream conformance suites: L1 named consumers (register/acquire/ack/release/stale epoch/cursors), L2/B pull-wake (wake stream, claimed event, persisted cursors, lease-expiry re-wake, competing claims), and L2/A webhook wake (signed delivery, callback, ack/done/retry/idle). Durable Streams owns claim/lease/cursor/retry/webhook-wake mechanics. Fluent-runtime only runs the post-claim product step and must not rebuild lease tables, cursor stores, pull queues, webhook retry loops, or task-claim locks. Coordination patterns use producer-fenced first-writer-wins claims and explicit epoch override for recovery. | upstream Durable Streams conformance + Firegrid post-claim integration witness |
| `fluent-worker-redrive` | Durable Streams **grants the claim/lease**; fluent materialises session state, **resolves waits**, re-enters the harness, and **acks/releases through** the server's §7.2/§7.3 machinery after the durable product outcome is recorded. Fluent does NOT rebuild the lease; stale-generation ack, competing claim, cursor persistence, retry, and `next_wake:true` are DS conformance concerns. `acked_offset` is a delivery cursor, not a replay position (replay reads the journal every claim). (Part 3; Appendix B) | product-observable post-claim redrive witness |

**Upstream substrate assumption.** Durable Streams stream closure, append-after-close
rejection, fork inheritance, idempotent producer fencing, and subscription
claim/ack/release generation fencing are dependency conformance, covered by
`durable-streams` server tests. Fluent firelab specs should only assert our
product uses those primitives correctly in vertical flows such as durable
sleep, durable wait, fork spawn, and post-claim redrive.

---

## Below the choreography line (optional; authored procedures only — the agent path depends on NONE of it)

| Feature file | Asserts (canon hook) | Firelab CoverageSpec |
|---|---|---|
| `fluent-concurrent-replay-soundness` | **Named-key concurrent-replay soundness under `Effect.all(concurrency:"unbounded")`** (Appendix A's TFIND: *named journal keys are sound under concurrent replay*); the **mutation proves positional/runtime-counter keys desync** on replay (mis-key → `served=="executed"` / tripwire fires → RED). The race landmine, two facets: (a) **winner-record journaled — NOT a choice** (bounded-`wait_for` safety depends on it); (b) **loser-fate** (let-finish-and-journal *vs* interrupt) — pick per combinator. (Appendix A; Part 1 race landmine; Appendix C Spec 1/5) | `replayCoverage` + `raceCoverage` |

---

## External control plane

| Feature file | Asserts (canon hook) | Firelab proof |
|---|---|---|
| `fluent-control-surface` | External `/entities/:type/:id` control — `send` · `fork` · `tag` · `schedule` · `read`/`head` · `delete` — as product spelling over Durable Streams append/read/fork/tag/schedule/delete through fluent-runtime. Acceptance must prove external client ingress reaches the host, the host calls runtime/store product services, and Durable Streams records or serves the state. Host-only self-calls do not satisfy the feature. | control-plane simulation over client ingress -> host -> runtime/store -> Durable Streams |

---

## Framing & harness (required context, not buildable agent features)

| Item | Covers (canon hook) | Status |
|---|---|---|
| `fluent-execution-model` | Canon execution split: authored procedures resume by replay; managed sessions resume by reconstruction over one Durable Streams coordination core. Durable authored tool bodies called by managed sessions run as child invocations on their own streams. | the framing every feature inherits |
| `fluent-coverage-oracle` | Stand up the **firelab runner over fluent-firegrid** (`firelab` is the home — the runner is the driver + Control + infra seam). Verdicts are product-observable: stream contents, projections, resumed output, approval shapes, and durable outcomes. Diagnostic spans may explain failures but cannot replace `Then` assertions. Any substrate evidence must be emitted by Durable Streams or the host, never forged by the driver. Each spec = witness + a **mutation harness that must flip red** + a **vacuity check**. (Appendix C) | harness · partly green-now (oracle exists in `firelab`; the fluent runner is net-new) |

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

## Canon cross-reference

This section is a routing map only. The canon docs own the architecture text.

| Canon source | Feature coverage |
|---|---|
| `fluent/README.md` two models and package roles | `fluent-execution-model`, `fluent-firegrid-public-surface`, `fluent-session-handler`, agent-binding features |
| `fluent/execution-models.md` replay vs reconstruction | `fluent-execution-model`; authored replay details also land in `fluent-engine-substrate-free` and `fluent-concurrent-replay-soundness` |
| `fluent/substrate-protocol.md` DS operation mappings | `fluent-durable-streams-consumer-substrate`, `fluent-worker-redrive`, `fluent-durable-wait`, `fluent-durable-sleep`, `fluent-fork-spawn`, `fluent-control-surface` |
| `fluent/harness-io.md` harness role map | ACP client/conductor, native/cloud, bridge mediation, resume, approval, park, and MCP tool-out features |
| `fluent-architecture.md` numbered F-S invariants | This README links and routes only; invariant wording and numbering stay in canon |

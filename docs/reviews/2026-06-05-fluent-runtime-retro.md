# fluent-runtime overnight retro: SDD alignment, failure mode, prevention

Date: 2026-06-05

Scope reviewed:

- Canonical intent: `docs/sdds/fluent-firegrid-sdd.md`
- Landed commits on `origin/main` during the overnight fluent-runtime push
- Primary implementation surface: `packages/fluent-runtime/*`, `packages/fluent-firegrid/*`, `features/fluent/*`, `packages/firelab/src/simulations/fluent-runtime-workbench/*`

This is intentionally critical. The goal is not to assign blame; it is to identify why a high-effort planning process still produced work that drifted back toward the legacy-runtime shape.

## Executive verdict

The overnight work produced useful parts, but it did not stay centered on the SDD's architecture.

The SDD says fluent runtime should be:

1. **Handler-only**: `handleSession(wake)` is re-invoked by durable-stream wakes.
2. **External-harness**: Firegrid does not own or replay the model loop.
3. **Subscription-backed**: Durable Streams pull-wake claim/ack/release is the worker/lease/fencing subsystem.
4. **Tool-driven**: the harness calls durable tools (`wait_for`, `spawn`, `execute`); tools record intent and end the harness turn when parking.
5. **Given-keyed on the agent path**: tool-call ids and slot ids are the deterministic keys, not hidden runtime counters.

What landed is closer to:

1. A large `FluentStore` service with many runtime-shaped methods.
2. A broad HTTP control plane over that store.
3. Mockable interfaces for worker wake/claim and bridge recording.
4. Fact-recording helpers for timers/waits rather than a proven park/wake loop.
5. Several child/session helpers that encode plausible behavior but are not yet proven against the Durable Streams semantics the SDD relies on.

That does not mean the work should be deleted wholesale. It means it should be treated as provisional material, not as the runtime architecture. The next work must narrow the system back to the SDD's load-bearing loop before more surface area is added.

## What the SDD required

The SDD's center is not a generic durable workflow engine. It is a choreography system for managed agents:

- A session is a handler, not an owned model loop.
- The agent's native harness owns reasoning.
- Firegrid exposes durable tools outward.
- Layer 1 is normalized harness events.
- Layer 2 is Firegrid-owned coordination facts.
- Durable Streams subscriptions provide wake delivery, lease ownership, retry, and generation fencing.
- The only net-new source above Durable Streams is the scheduled-append timer source.

The important SDD phrases are:

- `handleSession(wake)` is re-invoked per wake.
- "Firegrid never wraps the loop."
- Durable tools "record intent + park."
- Durable Streams §7.2/§7.3 "is your wake/lease/fencing subsystem."
- `durable.wait` and `durable.sleep` are one park/wake family.
- `wait_for` predicates are CEL over candidate events and session correlation data.
- The agent path uses the given-key principle: tool-call id and slot id.

Those should have been the merge gates.

## What actually landed

The landed sequence included these relevant commits:

- `5e0c27b09` — fluent-runtime fenced facts and timer records
- `17da8dc77` — control-plane API
- `5e22f7388` — durable sleep/wait facts
- `5a66b6523` — timer and wait sources
- `ac60fe2e0` — firelab fluent-runtime workbench
- `5f5975074` — fork spawn
- `e68234847` — worker redrive loop
- `6966cd867` — non-invasive adapter binding/native-resume orchestration
- `4b34069ee` — event ingress
- `11747b161` — MCP tools out on Effect AI

This order matters. The system expanded horizontally before the core loop was proven vertically.

## Critical implementation findings

### 1. `FluentStore` became the center of gravity

`packages/fluent-runtime/src/Store.ts` defines a large service surface: session creation, append, fenced append, state change, collect/head, fork, spawn, spawnAll, child result, join, race winner, turn start/complete/fail, timer schedule/fire, durable sleep, wait register/match, and turn read.

That shape is not inherently wrong, but it is the wrong center for the SDD. The SDD's center is `handleSession(wake)` over a claimed wake. Store operations are subordinate facts and helpers.

Risk:

- The package starts looking like a second `packages/runtime`.
- New features get added as store methods instead of proving the agent choreography loop.
- Tests can pass by calling store methods directly without proving durable worker/harness behavior.

Evidence:

- `packages/fluent-runtime/src/Store.ts:300`
- `packages/fluent-runtime/src/Api.ts:403`

### 2. The worker loop does not yet adapt the real Durable Streams subscription API

`packages/fluent-runtime/src/Worker.ts` defines `FluentWorkerSubscriptions` with `consumeWakeStream`, `claim`, `ack`, and `release`. This is the right vocabulary, but it is an interface only. I did not find the concrete Durable Streams §7.2/§7.3 adapter.

That is the load-bearing substrate path. Without it, the implementation can simulate claim/ack behavior but cannot prove server-owned lease/fencing/retry semantics.

Risk:

- We claim "worker redrive" but only prove a mocked shape.
- We accidentally rebuild scheduling/lease semantics above Durable Streams.
- Race, stale ack, lease expiry, and next-wake behavior remain unverified.

Evidence:

- `packages/fluent-runtime/src/Worker.ts:58`
- `packages/fluent-runtime/src/Worker.ts:150`

### 3. The bridge has the right adapter vocabulary but no durable recording boundary

`packages/fluent-runtime/src/Bridge.ts` has a useful non-invasive bridge shape: adapter spawn, prepare resume, connection wiring, queued prompts, response dedup, and interrupt handling.

The problem is the persistence contract:

```ts
readonly recordEnvelope: (envelope: StreamEnvelope) => void
```

This is synchronous and side-effect-shaped. It is not an `Effect`, not a durable append, and not tied to a claimed session write. The bridge can "record" to a test callback.

Risk:

- Raw harness output is not guaranteed to become durable truth before acting on it.
- A crash between observed native event and durable append can lose Layer 1.
- Tests can verify bridge logic without proving stream persistence.

Evidence:

- `packages/fluent-runtime/src/Bridge.ts:40`
- `packages/fluent-runtime/src/Bridge.ts:101`
- `packages/fluent-runtime/src/Bridge.ts:119`

### 4. `durableSleep` and `durableWait` are fact helpers, not complete park/wake operations

`durableSleep` appends a timer-scheduled fact and reads the turn stream. `durableWait` appends a wait registration and reads the turn stream. Matching and firing exist as separate source helpers.

This is not process-local sleep, which is good. But it is also not the SDD's complete durable park/wake operation:

- no claim release,
- no subscription wake,
- no handler redrive,
- no actual scheduled-append timer source in the runtime loop,
- no proof that append-before-park prevents lost wakeups across restart.

Risk:

- The names overstate the current behavior.
- Product code may start depending on poll-style helpers instead of the wake path.
- A "durable sleep/wait" task can be marked complete without the parking semantics the SDD requires.

Evidence:

- `packages/fluent-runtime/src/Store.ts:838`
- `packages/fluent-runtime/src/Store.ts:966`
- `packages/fluent-runtime/src/Sources.ts`

### 5. Child join appears to use array index as stream offset

`joinChildResult` collects a child session and finds a matching child result by index, then uses `String(index)` as the matched offset.

That is unsafe. Durable Stream offsets are substrate positions. They are not guaranteed to be equal to "index in the array returned by collect," especially once forks, read bounds, or protocol offsets matter.

Risk:

- Parent waits can record incorrect matched offsets.
- Replay and cross-session causality can become unsound.
- Forked streams can make the mistake harder to detect.

Evidence:

- `packages/fluent-runtime/src/Store.ts:489`
- `packages/fluent-runtime/src/Store.ts:1176`

### 6. Spawn/fork semantics are too broad and insufficiently pinned to one spawn point

The SDD's useful simplification was: child session spawn is a Durable Streams fork plus a given-key child identity. The implementation has `spawnChild` and `spawnAll`, but `spawnAll` runs child spawns with unbounded concurrency, and each child can read the parent head independently.

Risk:

- Multiple children in one logical spawn_all can fork from different parent offsets.
- The semantics become "whatever interleaving happened" instead of "children forked from this explicit spawn point."
- Parent child rows and child initial prompts become a custom protocol rather than a thin product spelling over substrate fork.

Evidence:

- `packages/fluent-runtime/src/Store.ts:1008`
- `packages/fluent-runtime/src/Store.ts:1047`
- `packages/fluent-runtime/src/Store.ts:1110`

### 7. Fenced/idempotent writes are inconsistent

Some writes use explicit producer information. Others are plain appends. Some one-row facts use unique producer ids with `epoch=0` and `seq=0`.

That can be a defensible convention for single-row facts, but the SDD requires this to be deliberate and uniform: agent-path rows should be given-keyed, and worker-owned append streams should respect the claimed epoch/sequence discipline.

Risk:

- Retry behavior differs per row family.
- Duplicate rows appear in exactly the failure windows the SDD was meant to close.
- Reviewers cannot tell which appends are idempotent by construction.

Evidence:

- `packages/fluent-runtime/src/Store.ts:527`
- `packages/fluent-runtime/src/Store.ts:697`
- `packages/fluent-runtime/src/Store.ts:754`
- `packages/fluent-runtime/src/Store.ts:1088`

### 8. The tool surface is too thin to validate the SDD agent path

`packages/fluent-runtime/src/Tools.ts` correctly uses `@effect/ai` `Tool`, `Toolkit`, and `McpServer`. That is a good direction.

But the current catalog only has a simple `wait_for` tool over a `channel` string, and invocation recording happens after handler execution. The SDD requires the parking tool to record intent before park/end-turn, use given tool-call keys, and support CEL predicates over candidate events plus `self` correlation.

Risk:

- The package can claim "MCP tools out" without proving the parking tool.
- Tool invocation recording becomes an audit trail, not the coordination primitive.
- The harness-turn boundary remains unproven.

Evidence:

- `packages/fluent-runtime/src/Tools.ts:22`
- `packages/fluent-runtime/src/Tools.ts:43`
- `packages/fluent-runtime/src/Tools.ts:68`

### 9. The control plane expanded before the runtime core was proven

`packages/fluent-runtime/src/Api.ts` exposes a broad sessions/control-plane API: create, events, prompt, turn read, sleep, fire timers, wait, match wait, ingest event, send, tag, fork, spawn, spawn_all, publish child result, join child, race winner, read, head.

Some of those are in the SDD as eventual product surfaces. The problem is order: the API shipped before the core handler/subscription/harness path was proven.

Risk:

- The public surface starts shaping the architecture.
- Tooling and tests bind to convenience endpoints rather than the intended durable loop.
- It becomes harder to delete provisional scaffolding because other PRs start using it.

Evidence:

- `packages/fluent-runtime/src/Api.ts:338`
- `packages/fluent-runtime/src/Api.ts:403`
- `packages/fluent-runtime/src/Api.ts:511`
- `packages/fluent-runtime/src/Api.ts:682`

## What went well

These are worth preserving:

- The SDD itself is strong and specific. The failure was not lack of design; it was failure to enforce it.
- Durable Streams fork, closure, and idempotent producer behavior were source-verified and made concrete.
- CEL wait-predicate direction is now present in code via `@marcbachmann/cel-js`.
- The `@effect/ai` direction for tools is better than hand-rolled MCP objects.
- The `coding-agents` adapter/normalizer source reading found the right non-invasive agent binding model.
- Gherkin/firelab direction is better than trace-CEL as the final acceptance surface, provided the scenarios assert product-observable outcomes.

## How this happened

### 1. The design kept shifting faster than the merge gates

The thread moved through several legitimate pivots:

- restate-sdk-gen clone,
- Effect-native DSL collapse,
- fluent-runtime package,
- external harness / non-invasive binding,
- durable-stream subscription wake subsystem,
- Gherkin acceptance instead of trace-CEL verdicts,
- `coding-agents` adapter/normalizer inspiration.

Each pivot was useful. The process failure was that older tasks and PRs were not re-gated against the newest architecture before implementation continued.

Result: agents kept building from stale mental models while the intended architecture had already moved.

### 2. We optimized for keeping lanes busy instead of preserving architectural sequence

Parallelism became the local objective. When lanes were idle, the coordination instinct was to dispatch more work. That created pressure to slice by available nouns (`fork`, `worker`, `API`, `tools`) instead of by the single load-bearing vertical path.

Result: multiple horizontal pieces landed without the central proof.

### 3. "Shape-compatible" was treated as progress

Several PRs introduced names and interfaces that match the SDD:

- `claim`,
- `ack`,
- `release`,
- `durableSleep`,
- `durableWait`,
- `spawnChild`,
- `McpServer`,
- `AgentAdapter`,
- `prepareResume`.

But shape is not behavior. The missing question at merge time was: does this PR prove the actual product invariant, or only define the vocabulary?

Result: boilerplate could look architecturally aligned while still avoiding the hard substrate/harness proof.

### 4. Mock seams were allowed to satisfy load-bearing claims

Interfaces such as `FluentWorkerSubscriptions` and `BridgeDeps.recordEnvelope` make tests easy, but they also let the system pass without exercising real Durable Streams subscriptions or durable recording.

Mocks are fine for unit tests. They are not acceptable as the acceptance proof for this SDD.

Result: tests validated internal call order, not the durable behavior the system is being built for.

### 5. Legacy runtime vocabulary leaked back in

The SDD says this system should avoid becoming a generic workflow runtime. But the implementation drifted toward:

- a broad store service,
- a broad HTTP API,
- explicit turn/timer/wait/join/race helpers,
- source managers,
- worker abstractions.

These are not automatically wrong, but they are the exact direction that recreates the old runtime shape.

Result: the greenfield package started accumulating transitory runtime layers before its simpler core was proven.

### 6. Review happened after merge, not at the architecture boundary

The critical architecture review should have happened before merging each load-bearing PR. Instead, the review was pulled together after multiple PRs had already landed and started depending on each other.

Result: once one broad surface landed, follow-on PRs treated it as foundation.

### 7. The lead failed to enforce "SDD line-of-sight" per PR

The biggest coordination failure was not any individual implementation choice. It was accepting PRs that were not forced to state:

- which SDD claim they satisfy,
- what product-observable behavior they prove,
- what real substrate/harness they exercise,
- what is intentionally fake or provisional,
- what must not be built on top of it yet.

Result: PR review degraded into "does this compile and look plausible?" instead of "does this advance the SDD's actual architecture?"

## Prevention rules

These are the concrete guardrails I would put in place immediately.

### 1. Every fluent PR must declare its SDD line of sight

PR body must include:

- SDD section(s) implemented.
- Feature/Gherkin scenario(s) satisfied.
- Product-observable `Then` asserted.
- Real substrate/harness exercised.
- Explicit non-goals.
- Any fake/mock seam used and why it is not the acceptance proof.

If a PR cannot fill this out, it is not mergeable.

### 2. Merge only firelab-proven vertical slices until the core is proven

Do not merge more horizontal API/store expansion until one end-to-end loop is green in `packages/firelab`. This is the reason firelab exists: not to make the architecture feel testable, but to produce verifiable proof that the intended product behavior occurred against real enough infrastructure.

1. Durable Streams subscription wake arrives.
2. Worker claims lease.
3. `handleSession(wake)` materializes state.
4. External harness is driven/resumed.
5. Harness calls `wait_for`.
6. `wait_for` records intent before park and ends the harness turn.
7. External event append matches CEL predicate.
8. Subscription wakes worker.
9. Worker reclaims, redrives, resolves from journal, and acks.

Everything else is secondary. Unit tests, mocked worker tests, and package-level type gates can support this proof, but they cannot replace it. A PR that adds store/API surface without a firelab scenario proving the relevant vertical path is a vocabulary/scaffolding PR, not a load-bearing runtime PR.

The firelab scenario should assert product-observable `Then` outcomes:

- the stream contains the wait intent before the park,
- the harness turn ended at the parking tool boundary,
- the external event is durably present,
- the matched wait records the event that satisfied the CEL predicate,
- the resumed output/result is produced after redrive,
- the worker ack is for the claimed generation.

Trace spans are still useful diagnostics, but the pass/fail contract should be the durable stream/projection/output state that a product client could observe.

### 3. Mock seams cannot be the acceptance proof for substrate claims

Allowed:

- unit tests with mocks,
- fast tests around pure folding,
- codec unit tests.

Not allowed as merge proof for SDD substrate claims:

- fake `claim/ack/release`,
- fake bridge recorders,
- fake harnesses for real-agent behavior,
- poll helpers standing in for wake delivery.

The proof must include the real Durable Streams server API or be clearly marked as provisional and non-foundational.

For fluent-runtime specifically, the acceptance proof belongs in firelab. If a mock seam is used to make unit tests small, the corresponding firelab witness must still drive the real substrate boundary the SDD relies on: subscription wake, claim, lease generation, append, read, and ack/release.

### 4. Broad public surfaces require a proven core first

No new broad HTTP/control-plane endpoint families until the core handler loop is proven.

Endpoints should trail behavior, not lead it. Otherwise the API becomes a magnet for architecture.

### 5. Use "red words" as review blockers

These words should trigger review skepticism:

- `runtime`,
- `manager`,
- `driver`,
- `orchestrator`,
- `turn`,
- `source`,
- `worker`,
- `scheduler`,
- `join`,
- `race`,
- `projection`,
- `read model`.

They are not banned. But every use must answer: is this part of the SDD's simple choreography core, or are we recreating the old runtime?

### 6. Require architecture diagram review before merge

Every fluent PR that changes module structure should include:

- generated dependency diagram,
- explicit cycle check,
- statement that `fluent-runtime` depends on small domain modules, not broad barrels,
- statement that handler/adapter/substrate boundaries are preserved.

If the diagram shows package logic flowing through a central barrel or store facade for everything, pause.

### 7. Separate "vocabulary PRs" from "behavior PRs"

A PR that introduces interfaces or schemas only is allowed, but it must be labeled as vocabulary/provisional and cannot close a load-bearing bead.

A load-bearing bead closes only when behavior is proven.

### 8. Create a "do not build on this yet" label

Some scaffolding is useful. The problem is follow-on PRs treating it as stable.

Add a visible convention:

- `provisional:do-not-build-on`
- or a `docs/provisional/*` note per surface

Remove that label only when the vertical proof exists.

### 9. One lead-owned merge checklist

Before merging any fluent PR, the lead should answer:

1. Does this PR make the system more handler-only?
2. Does it reduce or increase generic runtime machinery?
3. Does it use real Durable Streams semantics for any substrate claim?
4. Does it keep Firegrid out of the model loop?
5. Does it preserve given-key identity?
6. Does the test assert product-observable behavior?
7. Could this be deleted if the vertical handler loop changed?

If the answer to 7 is "no" before the core is proven, the PR is probably premature.

## Recovery plan

### Immediate freeze

Freeze new fluent-runtime expansion PRs until the core path is reviewed. In particular, pause:

- additional control-plane endpoints,
- additional projection/read-model work,
- child race/join expansion,
- broader MCP catalog work,
- non-essential API polish.

### Classify landed work

Mark each landed surface as one of:

- **keep as core**,
- **keep as provisional**,
- **move behind internal experimental namespace**,
- **delete before dependency forms**.

My initial classification:

| Surface | Classification | Reason |
|---|---|---|
| `Domain.ts` state-change and turn facts | keep/provisional | Useful vocabulary; must be tightened to Layer 1/Layer 2 split. |
| `Store.ts` fenced append helpers | keep/core candidate | Useful if narrowed and made uniform. |
| `Store.ts` broad service facade | provisional | Too central; risks replacing handler architecture. |
| `Api.ts` broad control plane | provisional / likely trim | Surface expanded before core proof. |
| `Worker.ts` interface | provisional | Right names, missing real DS adapter. |
| `Bridge.ts` adapter vocabulary | keep/provisional | Right direction, but persistence contract must become durable. |
| `Tools.ts` `@effect/ai` usage | keep/core candidate | Right library choice; tool semantics too thin. |
| `Sources.ts` timer/wait source helpers | provisional | Useful logic, but not yet scheduled-append / subscription integrated. |
| Firelab Gherkin/workbench | keep | Correct verification direction if product-observable and real substrate. |

### Next PR should be one proof

The next mergeable implementation PR should be narrowly titled:

`feat(fluent-runtime): prove wait_for park/wake over Durable Streams subscription`

Acceptance:

- adds or updates a firelab scenario for the vertical path,
- uses real Durable Streams subscription claim/ack/release,
- appends `WaitRegistered` before park,
- releases/parks the claimed handler turn,
- ingests an external state-change event,
- evaluates CEL at redrive time,
- records matched event in journal,
- resumes handler and acks,
- has one Gherkin/firelab scenario whose `Then` checks stream/projection/output, not internal trace CEL only.

No spawn, no broad control plane, no projection expansion, no extra tool catalog in that PR.

## Retrospective summary

This happened because planning quality and merge discipline diverged.

The planning got to the right architecture: handler-only, external harness, Durable Streams subscriptions, durable tools, given-key identity. But the implementation process optimized for parallel output and local PR completion. That let stale mental models and plausible scaffolding re-enter the system.

The fix is not more planning. The fix is stricter merge admission:

- one SDD line of sight,
- one product-observable proof,
- real substrate for substrate claims,
- no broad surfaces before the vertical loop,
- no load-bearing closure for vocabulary-only PRs.

The system can still recover. The SDD is clear enough. The next step is to stop treating the merged scaffolding as architectural fact and force the next PR to prove the real loop.

## Baseline reset applied

The follow-up baseline reset applies the review in the smallest concrete way:

- closed the provisional session-handler and park-interface draft PRs rather than merging green-but-unproven code,
- removed the broad fluent-runtime HTTP API/server surface,
- removed the firelab workbench that proved the provisional store facade instead of the SDD's wake loop,
- removed the monolithic fluent coverage-spec file from firelab runner infrastructure,
- removed the unproven bridge, tool, and worker experiments from the baseline package,
- removed store-level fork/spawn/join/race helpers and their child-session event vocabulary,
- removed `durableSleep` / `durableWait` composite method names from `FluentStore`; the baseline keeps only row-level primitives: schedule timer, fire timer, register wait, match wait, read turn, and fenced event append.

The next implementation PR should not re-add those surfaces. It should first add
the firelab-proven vertical `wait_for` park/wake path described above.

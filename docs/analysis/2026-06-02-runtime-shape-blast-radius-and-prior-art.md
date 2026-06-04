# Runtime shape — blast radius, prior-art mapping, and the verifying sim

- **Date:** 2026-06-02
- **Status:** analysis (decision-support for §0.1 of the RuntimeContext reconcile
  proposal). Does **not** decide A/B/C — frames the integrity question accurately.
- **Trigger:** a calibration challenge — "is `signal.ts` supporting a *different
  model* than the actor/VO model the canon/RFCs align with, and is the system's
  integrity compromised?" This doc answers it at source.
- **Epistemic labels used:** **[verified]** = read at `file:line`; **[design]** =
  proposed shape to be validated by the sim; **[inference]** = reasoned, not yet
  source-proven.

---

## 0. TL;DR — the integrity concern, accurately scoped

**The system is *not* pervasively built on the wrong model.** The actor /
virtual-object model the canon specifies is **already running in production** for
permission and tool handling. **Exactly one body diverges** — the `RuntimeContext`
session loop — and the canon **already documents it** as a known compatibility
bridge. `signal.ts` is mostly **model-neutral plumbing** that both models need.

This started as "did we silently build the whole thing on the Temporal model?" The
honest answer is **no** — it's a single, documented, load-bearing holdout, with a
working reference for the target shape in the same codebase.

> An earlier framing in the proposal (a flat "Shipped=Temporal vs Canon=actor"
> table) **overstated** this — it implied the whole system embodies the Temporal
> model. Corrected here at source.

---

## 1. The two prior-art models (what the decision actually is)

| | **Temporal / Cadence model** | **Virtual-Object / actor model** |
|---|---|---|
| Shape | A long-lived workflow *program* that blocks on `await signal` for the entity's whole life | A keyed entity; a handler runs **per event** over durable state, then **returns** |
| State between events | In the parked call-stack / replay history | In durable rows — nothing parked |
| External input | **Signals** delivered to the running body | A durable fact row + a fresh handler invocation |
| Sustaining mechanism | **`continueAsNew`** (periodic history truncation) | n/a — state is already external |
| Prior art | Temporal, Cadence | **Restate Virtual Objects, Orleans grains, Akka persistent actors, Cloudflare Durable Objects, DBOS** |
| Boundary enforcement | Runtime contract (determinism, side-effects-in-activities) — **not statically checkable** | The handler **signature** `(State,Event)=>(State,Effect[])` — **a type**, lint-enforceable |

**The canon already chose the actor model — it just never named it.** [verified]
`docs/cannon/architecture/runtime-design-constraints.md`:
- **C1** (`:234`): *"A runtime context is a durable entity keyed by identity… all
  mutations for the same key are serialized by the runtime owner. There is no
  higher-level object model above the keyed durable state container."* = a Virtual
  Object / grain.
- **C2** (`:258`, `:270`): *"materializes for one event, advances durable state…
  and returns. A common shape factors this as a pure transition:
  `(state, event) -> (newState, actions)`."* = an actor handler.
- **C4** (`:320`): *"Async Waits Are Durable Completions."* = the awakeable pattern
  (a handler may await *one* durable completion and return — this is allowed).

**Why the shipped body feels like debt:** the production `RuntimeContext` is a
half-built *Temporal* body **missing `continueAsNew`** — so it does the dense
`readSignalsFor` rescan + `recoverPendingSignals` sweep that C2 explicitly names as
the forbidden *"replay cursor / durable deferred mailbox / restart sweep."*
[verified: `signal.ts:220-227, 266-309`; C2 anti-pattern `:290`]

(In-repo prior art already surveyed — client-API-focused, not §0.1-focused:
`docs/research/durable-execution-api-design-survey.md`, comparing Temporal /
Restate / DBOS.)

---

## 2. Blast radius — who parks, and is it the forbidden shape? [verified]

C2's rule (`:279`): *"the forbidden shape is a body whose lifetime spans **many
events** for one entity."* A body that awaits **one** completion and returns is
**allowed** (C4). Applying that test to every parking site in the runtime:

| Site | Shape | Verdict |
|---|---|---|
| `subscribers/runtime-context.ts:113-120` | `while(!reachedTerminal)` loop, parks on `Workflow.suspend` repeatedly, consumes **every** session input across the session's whole life | ⚠️ **The one genuine C2/C5 violation** (entity-lifetime body) |
| `subscribers/permission-and-tool.ts:114-152` (`PermissionRoundtripWorkflow`) | fresh execution **per `PermissionRequest`** (observer forks `.execute()` per observation, `observers.ts:58`); records request row → `awaitSignal` **once** → relays decision → **returns** | ✅ **Canon-compliant** — per-event handler awaiting one durable completion (C4). *This is the actor model, in production.* |
| `mcp-host/tool-dispatch.ts` (`ToolDispatchWorkflow`) | fresh execution per host-dispatched `ToolUse` | ✅ Same per-event shape |
| `subscribers/scheduled-webhook-peer.ts:323,378` | `awaitSignal` once per fact | ✅ await-once shape — **and** largely dead/unreached (tf-0awo.37/.38) |

**Conclusion [verified]:** the divergence is **one body** (`runtime-context.ts`),
not the system. It is load-bearing (it drives every agent session), so it is
*localized*, not *trivial* — but a working reference for the target shape
(`PermissionRoundtripWorkflow`) already exists in-tree.

### 2.1 `signal.ts` is mostly model-neutral [verified + inference]

`signal.ts` bundles two separable things:
- **Model-neutral durable-event substrate** [verified]: `SignalTable` (durable
  rows, `:54-77`), `insertSignalRow`, `readSignalsFor`, and the
  `sendSignal`/`armSession`/`recoverPendingSignals` deliver-and-recover plumbing.
  *Both* models need "persist an external event + re-arm a waiting handler after a
  crash" — Restate awakeables and Orleans reminders are the same idea. [inference]
- **The Temporal-style parked-loop usage** [verified]: only `awaitSignal` (parks
  via `Workflow.suspend`) **as used by the RuntimeContext loop** is the forbidden
  shape. The permission handler uses the *same* `awaitSignal` in the *allowed*
  await-once way.

So under option A, you **keep** the table + the arm + recover, and **delete** the
RuntimeContext parked loop + the dense rescan. `signal.ts` is not "the wrong
model" — it is reusable substrate plus one caller (RuntimeContext) using it the
banned way.

---

## 3. This dissolves review 3's "return-and-re-drive" puzzle [design]

Review 3 source-proved you **cannot re-drive a *returned* execution**
(`armSession` guards `if (finalResult !== undefined) return`, `signal.ts:150`;
`engine.resume` only re-drives *suspended* executions). The actor model **does not
try to** — it spawns a **fresh execution per event**, exactly as
`PermissionRoundtripWorkflow` already does per permission request. [verified: the
permission handler is one execution per request]

So the RuntimeContext target [design] is: **one fresh handler execution per session
input**, keyed by `contextId`, serialized per key, reading its **durable consume
cursor** from state at start (C1's keyed durable state) — *not* one parked loop
re-driven in place. The §D3 "cursor durability" question becomes "the handler reads
last-consumed from a durable row," which is just C1. The "is per-key serialization
available" question is what `tf-4fy3` (closed) began and the sim must re-confirm for
the multi-event case.

**Framing correction for `tf-c71h`:** the bead title says "return-and-re-drive."
That is the *wrong* mechanism (review 3 falsified it). The right question is
**"per-event fresh-execution over a durable cursor, like `PermissionRoundtrip`, for
the multi-event-per-key session-input case."**

---

## 4. The verifying sim — spec for `tf-c71h` (firelab workbench)

Per `packages/firelab/docs/methodology.md` §"The workbench pattern" (the
production per-event RuntimeContext tier does not exist yet, so we design its
contract in a sim, on the real substrate, driven through the public client surface).

**Goal:** gather trace evidence that a per-event fresh-execution RuntimeContext
handler (the `PermissionRoundtrip` shape, generalized to many inputs per key) works
on the **real** substrate — and contrast it with the parked-body baseline on
complexity/perf.

**Contract to design (the misuse-resistant Tag) [design]:**
```ts
// (State, Event) => (State, emitted facts) — run-to-completion, NO parked loop
interface RuntimeContextHandler {
  readonly handle: (
    state: RuntimeContextState,        // read from a durable row (the cursor lives here)
    event: SessionInputEvent,
  ) => Effect.Effect<{ readonly state: RuntimeContextState; readonly emit: ReadonlyArray<Fact> }>
}
```

**Methodology constraints (HARD — enforced by the harness airgap, do not violate):**
- `driver.ts` imports **only** `@firegrid/client-sdk` (+ Effect). Drives via
  `firegrid.launch` / `sessions.attach` / `session.start|prompt|wait.*|close`
  (see `unified-kernel-validation/driver.ts` for the exact surface).
- `host.ts` composes the **real** `FiregridHost` via `FiregridRuntime(...)` from
  `@firegrid/runtime/unified` (eslint host-factory-lock). The workbench per-event
  handler is composed as a `Layer` in `host(env)` **around** the real factory —
  **no fake codec/adapter/sandbox, no recorder, no Tag-swap that bypasses the real
  spawn path.** The fixture is a real spawn-target process (the official ACP example
  agent, as `unified-kernel-validation` does).
- The sim returns data but **the trace is the deliverable** — no `claimStatus` /
  verdict object. Findings are prose in `docs/findings/tf-c71h-*.md`.

**What the trace must let a reader observe (the proofs):**
1. **Per-event, run-to-completion:** N session inputs over one session → **N fresh
   handler executions**, each completing (`finalResult` set), **zero**
   entity-lifetime parked body. (Span shape: N `…handler.execute` roots, not one
   long-lived suspend/resume loop.)
2. **Per-key serialization:** two inputs racing for one `contextId` are serialized
   (no interleave) — the C1 owner guarantee.
3. **Durable cursor / no double-send:** the handler reads last-consumed from a
   durable row; a crash + recovery re-invokes from the cursor without re-firing an
   already-delivered `unified.session.send`.
4. **Multi-turn continuity (the §D3 question):** input 2 reaches the *same* live
   agent process as input 1 (`startOrAttach` no-op reuse, `codec-adapter.ts:408`) —
   session state survives across the per-event executions.
5. **Complexity/perf evidence:** trace shows O(new rows) reads per event (not the
   O(all signals) dense `readSignalsFor` rescan) and no long-lived fiber per
   session. Contrast against a baseline run of the current parked body.

**What the sim does NOT prove (be honest):** type-safety / static boundary
enforcement is a **compile-time + lint** property — the sim's payoff is that
designing the `Context.Tag` is what *lets* the existing dep-cruiser/eslint airgap
forbid the parked primitive. "Fewer SDDs" is the downstream payoff of encoding the
decision as a type + lint, not a sim output.

**Reference to copy:** `PermissionRoundtripWorkflow`
(`subscribers/permission-and-tool.ts`) is the single-event-per-key version of this
exact shape, already on the real substrate. The sim generalizes it to
multi-event-per-key.

---

## 5. Net for §0.1

The integrity question resolves to: **honor the actor model the canon already
specified (and already runs for permission/tool) by migrating the one holdout body
— `RuntimeContext` — to the per-event shape, OR formally ratify the parked body and
reverse C2/C5.** The contained blast radius + the in-tree reference (`PermissionRoundtrip`)
+ the reusable plumbing (`signal.ts` table/arm) make the migration far smaller than
"re-architect the system." The `tf-c71h` sim de-risks it before any rewrite.

## 6. Sources
`docs/cannon/architecture/runtime-design-constraints.md:234/258/270/279/290/320/361` ·
`packages/runtime/src/unified/subscribers/runtime-context.ts:113-120` ·
`packages/runtime/src/unified/subscribers/permission-and-tool.ts:108-152` ·
`packages/runtime/src/unified/observers.ts:58` ·
`packages/runtime/src/unified/mcp-host/tool-dispatch.ts` ·
`packages/runtime/src/unified/signal.ts:54-77/150/220-227/266-309` ·
`packages/runtime/src/unified/codec-adapter.ts:408` ·
`packages/firelab/docs/methodology.md` ·
`packages/firelab/src/simulations/unified-kernel-validation/{host,driver}.ts` ·
`docs/research/durable-execution-api-design-survey.md` ·
proposal `docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md` ·
beads `tf-tvg1`, `tf-c71h`, `tf-r06u.36`.

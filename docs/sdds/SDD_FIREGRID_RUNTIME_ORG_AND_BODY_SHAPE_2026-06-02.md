# Runtime organization model + RuntimeContext body shape — successor to the Composition SDD

- **Date:** 2026-06-02
- **Bead:** tf-ogoj (design doc only — no runtime/src edits)
- **Status:** DESIGN. Successor to `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md`
  (the "Composition SDD"). It **extends** that doc — it does not replace it. It writes
  the section the Composition SDD deliberately omits: (A) the RuntimeContext **body
  shape** (§0.1 per-event vs parked) and (B) the **dispatch/deliver tier organization**,
  placed in the Composition SDD's §12 DAG frame, grounded in real `@effect/workflow`
  usage, with a domain-named organization model and FS-boundary-enforced type boundaries.
- **Does NOT decide §0.1.** The A-vs-B/C body-shape call is the PO's (it gates a canon
  amendment-or-not); §1 below RECOMMENDS with reasoning and marks the sign-off.

## Epistemic legend (mirrors the Composition SDD's "Epistemic status of this section", lines 1118-1133)

Every load-bearing claim is tagged:
- **[read]** — verified at `file:line` in this repo or the vendored `repos/effect/` sources.
- **[read·2]** — verified by a delegated source-reader against `file:line`; cited, second-hand.
- **[designed]** — proposed greenfield target, not transcribed from source.
- A consolidated **Epistemic status** block (§6) restates the split and the
  **Confirm-before-building** list, in the Composition SDD's own format.

This doc itself carries a **Constraint Check** (§7) against `runtime-design-constraints.md`
C1/C2/C4/C5 — the SDD-Gate section the unified SDD skipped (`:558`, the gap the reconcile
proposal §0.1 names). A successor that proposes the per-event target must pass the gate it
asks the predecessor to have failed.

---

## §0. Relationship to the Composition SDD — extend, not replace

The Composition SDD §12 reframed runtime composition from the flat mechanism-tier tree
(`events/ tables/ transforms/ channels/ producers/ sources/ subscribers/ composition/`,
the 2026-05-22 target tree) into a **dependency DAG with four bands** [read·2,
Composition SDD:669-676]:

```
DurableStreams, Sandbox                                ← leaves; the only legitimate holes
        │
  tables, ContextResolver, engine, McpEndpoint         ← floor (substrate)
        │
     adapter                                           ← interior (Seam 2): consumes floor, drives nothing below
        │
  workflows, router-routes, observer, recovery, MCP host   ← top (reads-as-views)
```

and its load-bearing rule [read·2, Composition SDD:654-660]:

> "A composition hole belongs at a leaf of the dependency DAG — a node nothing of ours
> feeds — never at an interior node. … An *interior* hole (the adapter: it consumes
> substrate and is consumed by workflows) forces its providers and consumers to meet
> through the binary, and if any provider is transitively a consumer you get a cycle."

The Composition SDD **landed its §12 core** as a *proposed target with a validation gate*
(`FiregridRuntime(spec, adapter)` with the adapter as a positioned interior argument, the
DurableStreams floor, reads-as-views) [read·2, Composition SDD:3-11, 950-968]. It
**supersedes** the 2026-05-22 target tree and the reconciliation memo [read·2,
Composition SDD:3-11]. What it **does not** resolve, and explicitly leaves to a successor:

1. **The body shape of the one keyed entity it names but does not shape** — the
   RuntimeContext session body. §12 lists `workflows` at the top band without saying
   whether the RuntimeContext body is per-event run-to-completion or an entity-lifetime
   parked loop. That is the §0.1 decision.
2. **The internal organization of the top band** — §12 lists `observer`, `router-routes`,
   `recovery` as nodes but does not give them domain-named homes or say how the current
   flat `unified/` sock drawer (`observers.ts`, `signal.ts`, `subscribers/`,
   `channel-bindings.ts`) re-tiers into the DAG.

This doc fills exactly those two holes. **Where it diverges** from the Composition SDD it
says so inline (the only divergence is §3's verdict that the bespoke `signal.ts` await/resolve
primitive is reinvention of `@effect/workflow` `DurableDeferred` — the Composition SDD did
not examine `signal.ts`).

---

## §1 (A). Body-shape decision — per-event (A) vs parked (B/C)

### The decision, framed at source

`runtime-design-constraints.md` is `Doc-Class: dispatchable` canon [read·2, proposal §0.1
citing `:1-4`]. It bans "a workflow body representing the lifetime of an entity and parking
across many events" — **C2** ("Subscribers Are Per-Event Handlers, Not Long-Lived Bodies",
`:258`) and **C5** ("The Runtime Does Not Park Entity Bodies Between Events", `:361`)
[read·2]. It carries an **SDD Gate** (`:558`): every new runtime SDD must include a
Constraint Check, and "a bridge exception that fails any of these is not dispatchable"
(`:594`) [read·2].

Exactly **one** production body diverges from the canon's actor model [read·2, blast-radius
analysis §2:74-81; confirmed [read] against the tf-c71h trace]:

| Site | Shape | Verdict |
|---|---|---|
| `subscribers/runtime-context.ts:113-120` | `while(!reachedTerminal)` loop, parks on `Workflow.suspend` repeatedly, consumes **every** session input across the session lifetime | ⚠️ the one genuine C2/C5 violation |
| `subscribers/permission-and-tool.ts` `PermissionRoundtripWorkflow` | fresh execution **per** `PermissionRequest`; records row → awaits **once** → relays → **returns** | ✅ canon-compliant (C4) — the actor model, in production |
| `subscribers/permission-and-tool.ts` `ToolDispatchWorkflow` | fresh execution per host-dispatched `ToolUse` | ✅ same per-event shape |

> Note [read·2, codex review v5]: the blast-radius analysis mis-cited the wire tool-dispatch
> as living in `mcp-host/tool-dispatch.ts`. That file defines `McpToolDispatchWorkflow` (the
> MCP-entry Shape-D workflow); the **wire** `ToolDispatchWorkflow` lives in
> `subscribers/permission-and-tool.ts`. This doc uses the corrected attribution.

The options [read·2, proposal §0.2:63-73]:

- **(A) Per-event keyed subscribers.** The parked body is debt to delete; rewrite to a fresh
  run-to-completion execution **per session input**, keyed by `contextId`, reading a durable
  consume cursor from state. Canon-compliant (C1+C2+C4). **No canon amendment.**
- **(B) Bless the entity-lifetime parked body + `signal.ts` as target** → amend canon
  (explicit C2/C5 reversal).
- **(C) Hybrid** → resolves to B.

The *mechanism* is settled and is **not** the open question [read·2, proposal §3:342-388]:
an **explicit arm** (durable write + `engine.resume`) is proven (`tf-e5rf`,
`DurableStreamsWorkflowEngine.test.ts:927`), and **return-and-re-drive** (re-driving a body
that already *returned*, `finalResult` set) is **falsified** — `engine.resume` re-drives only
*suspended* executions and the arm guards `if (finalResult !== undefined) return`
(`signal.ts:150`) [read·2; confirmed [read]: `engine-runtime.ts:184-185` no-ops `resume` when
the execution row is missing or `finalResult !== undefined`]. So option **D** (per-turn drain
+ return + re-drive) is off the table; **A is fresh-execution-per-event over a durable
cursor**, not re-drive. The substrate fact (no automatic table-write wakeup) compels an
explicit arm (a *mechanism*) but does **not** compel an entity-lifetime parked body (a
*shape*); these are separable [read·2, Opus review §D2].

### Evidence from tf-c71h (PR #850) — and its limits

The tf-c71h workbench sim drove the per-event shape on the **real** substrate (the real
`FiregridRuntime` + production codec adapter + real ACP example agent), client-SDK-only
driver, no fakes [read, `docs/findings/tf-c71h-per-event-runtime-context-workbench.md`;
sim under `packages/tiny-firegrid/src/simulations/per-event-runtime-context/`]. The trace
showed [read, run `2026-06-02T21-54-42-508Z`]:

- **4 fresh `workbench.per-event-runtime-context.execute` roots, ZERO
  `unified.runtime-context-session` executions** (the parked body stayed registered-but-dormant
  — only its `workflow.register` span appears).
- **1 real `open_byte_pipe` spawn but 4 `start_or_attach`** → multi-turn continuity via no-op
  reattach to one live process.
- **`seq === cursor.consumed` on every event** (0/1/2/3); cursor advanced 0→1→2; no-double-send
  rests on Activity memoization.
- **O(1) cursor.get + O(1) row.get per event** vs the parked body's `readSignalsFor` O(all
  signals) rescan.

**The AMEND caveats — decision-grade for the session-input subset ONLY** [read·2, the c71h
reviews; restated honestly in the finding]:

1. **(a) Subset scope.** The proof is decision-grade for the **session-input** delivery path
   (prompt / close). It does not cover the full input vocabulary end-to-end.
2. **(b) Relay path not exercised E2E.** The fixture's per-turn `requestPermission` was aborted
   by the next prompt before it fired (`permission_request_count=0`), so the
   **permission/tool relay** — hardcoded to `RuntimeContextSessionWorkflow`
   (`permission-and-tool.ts` `sendSignal({ workflow: RuntimeContextSessionWorkflow })`) — was
   never driven in the per-event shape. The finding surfaces this as the migration's load-bearing
   coupling: a per-event migration must **also** retarget the sibling relays.
3. **(c) Concurrency observed, not stressed.** The driver is sequential, so per-key
   serialization was *observed* (`seq_matched_cursor=true`), not stress-tested under racing
   appends. The C1 "mutations for one key are serialized" guarantee is asserted, not proven
   under contention.
4. **(d) Two-adapter composition masks production wiring.** The sim provided a *second* real
   adapter instance for the per-event workflow alongside the factory's own (dormant) adapter.
   That proves the shape but **does not** prove the production single-adapter wiring where the
   per-event handler and the factory share one registry.

### §1 RECOMMENDATION (PO sign-off required — do not treat as decided)

**Recommend A (per-event), conditioned on closing caveats (b)+(d) before cutover.** Reasoning:

- A is the **only** option that needs **no canon amendment** — it satisfies C1/C2/C4/C5 as
  written. B/C require an explicit reversal of dispatchable canon, which is a heavier governance
  act and (per the proposal §0.1) the unified SDD already shipped B *without* the bridge-exception
  gate, so "ratify B" is ratifying a gate-skip.
- A's mechanism is **proven** (explicit arm, tf-e5rf) and its shape is **demonstrated on real
  substrate** for the session-input subset (tf-c71h).
- A's residual risk is **scoped and nameable** (caveats b/d), not open-ended. The follow-up sim
  slice that exercises the permission/tool **relay** in the per-event shape (and a
  single-adapter production wiring) would close it — this is the natural next dispatch.

**This is a recommendation, not a decision.** The PO owns §0.1 because the alternative (B) is a
canon amendment. This doc's organization model (§3) is written **A-shaped** but flags exactly
which placements would change under B (the parked body + `signal.ts` mailbox would survive as a
blessed tier instead of dissolving).

---

## §2 (C). `@effect/workflow` grounding + the `signal.ts` reinvention verdict

### The idiomatic body [read, `repos/effect/packages/workflow/README.md:26-119`]

```ts
const EmailWorkflow = Workflow.make({
  name: "EmailWorkflow",
  success: Schema.Void,
  error: SendEmailError,
  payload: { id: Schema.String, to: Schema.String },
  idempotencyKey: ({ id }) => id,                       // one execution per key
})
const EmailWorkflowLayer = EmailWorkflow.toLayer(
  Effect.fn(function* (payload, executionId) {
    yield* Activity.make({ name: "SendEmail", error: SendEmailError, execute: … })
      .pipe(Activity.retry({ times: 5 }), EmailWorkflow.withCompensation(…))
    yield* DurableClock.sleep({ name: "Some sleep", duration: "10 seconds" })  // park, zero resources
    const Trigger = DurableDeferred.make("EmailTrigger")
    const token = yield* DurableDeferred.token(Trigger)
    yield* DurableDeferred.succeed(Trigger, { token, value: void 0 }).pipe(Effect.forkDaemon)
    yield* DurableDeferred.await(Trigger)                // park until externally resolved
  })
)
```

The primitives, at source:
- **`Workflow.make({ name, payload, success, error, idempotencyKey })`** + **`.toLayer((payload,
  executionId) => Effect)`** [read, `Workflow.ts:263`, `:148`]. `idempotencyKey` derives the
  `executionId` → **at-most-one execution per key** [read, `:272`]. `.execute(payload, { discard })`
  runs it; `discard:true` returns the executionId string (fire-and-forget arm) [read,
  `Workflow.ts:110`, engine `WorkflowEngine.ts:61-83`].
- **`Activity.make({ name, execute })`** — runs **once**, memoized by the engine activity record;
  `Activity.retry`, `withCompensation` available [read, README:46-81].
- **`Workflow.suspend(instance)`** — park the body (returns `never`) [read, `Workflow.ts:680`].
- **`DurableClock.sleep`** — durable timer; the body parks consuming no resources [read,
  README:88-93].
- **`DurableDeferred`** — token-addressed **await-once** durable completion: `await(self)` does
  `engine.deferredResult(self)`→`Workflow.suspend` if unresolved [read, `DurableDeferred.ts:102-122`];
  the external producer calls `succeed/done(self, { token, exit })` →
  `engine.deferredDone(…)` which is documented "**Set the result of a DurableDeferred, and then
  resume any waiting workflows**" [read, `WorkflowEngine.ts:151-153`, `DurableDeferred.ts:389-425`].
  The token is `(workflowName, executionId, deferredName)` base64url [read, `DurableDeferred.ts:264-304`].
- **`DurableQueue`** — wraps `@effect/experimental/PersistedQueue`: a workflow `process(queue,
  payload)` **offers a job and parks** on a per-item `DurableDeferred` until a **worker pool**
  (`worker(queue, f, { concurrency })`) drains it and resolves the deferred [read,
  `DurableQueue.ts:42-93, 151-218, 264-330`]. `idempotencyKey` **dedupes the offer**; `concurrency`
  is an unordered worker count.

### Per-event vs parked, mapped onto the real primitives [designed, grounded in the reads above]

| | per-event (A) | parked (B/C, today) |
|---|---|---|
| Body | `Workflow.make({ idempotencyKey: contextId:inputKey }).toLayer((p) => …)` — fresh execution per input, **returns** | `Workflow.make({ idempotencyKey: contextId:attempt })` one execution, `while(!terminal) { …; Workflow.suspend }` |
| Keyed serialization | `idempotencyKey` ⇒ at-most-one execution per `(contextId,inputKey)` + a durable **consume cursor** row read O(1) | the single parked execution serializes by being the only consumer |
| External input | a durable input fact row + an **arm** (`engine.execute({discard})` if missing else `engine.resume`) | `awaitSignal`/`readSignalsFor` over a bespoke `SignalTable` mailbox + `Workflow.suspend` |
| Await-one (permission) | `DurableDeferred.await` / `succeed(token)` | `awaitSignal` / `sendSignal` (no arm) |
| Cleanup | terminal input ⇒ one execution that deregisters and returns | the parked body's final `deregister` after the loop ends |

### THE VERDICT — is `signal.ts` reinventing `DurableDeferred` / is the per-key mailbox `DurableQueue`?

`signal.ts` bundles **five** things [read, `packages/runtime/src/unified/signal.ts`, verified in
the tf-c71h work]. Decomposed against the vendored primitives:

1. **`awaitSignal({ name })`** — point-read `SignalTable` for `${executionId}|${name}`, `Workflow.suspend`
   if absent [read, `signal.ts:229-245`]. **≈ `DurableDeferred.await`** [read, `DurableDeferred.ts:102-122`]:
   both park on a named durable completion keyed by `(executionId, name)` ≈ deferred token
   `(workflowName, executionId, deferredName)`. **REINVENTION.** Canon even *names* `DurableDeferred`
   as the admissible within-one-event await primitive [read·2, C4 `:349-351`].
2. **`sendSignal({ workflow, executionId, name, value })` (no `arm`)** — write a signal row, then
   `workflow.resume(executionId)` [read, `signal.ts:193-216`]. **≈ `DurableDeferred.succeed(token,
   value)`** → `engine.deferredDone` → resume waiter [read, `DurableDeferred.ts:431-458`,
   `WorkflowEngine.ts:151-153`]. **REINVENTION** of the resolve-and-resume half.
3. **`armSession` — create-or-resume** [read, `signal.ts:140-164`]: `if finalResult set: return;
   if execution missing: workflow.execute(payload, { discard:true }); else: workflow.resume`. This is
   the **input-before-start arm** — the one thing `DurableDeferred` **cannot** do: `deferredDone`
   resumes an **existing** waiter and `engine.resume` **no-ops a missing execution** [read,
   `engine-runtime.ts:184-185`]. So arm is a **genuine, thin composition over engine
   `execute({discard})`/`resume` + `Workflow.idempotencyKey`** — NOT a reinvented substrate.
   **KEEP as a small named helper; do NOT keep the `SignalTable` it sits on.**
4. **`readSignalsFor(executionId)` — read ALL rows for an execution, sorted by `recordedAt`**
   [read, `signal.ts:220-227`]. This is the **many-events ordered mailbox** the parked body drains.
   It is **neither** `DurableDeferred` (await-once) **nor** `DurableQueue` — it **IS** the
   C2/C5-forbidden "durable deferred mailbox / replay cursor" the canon bans [read·2,
   `runtime-design-constraints.md:290-293`, C4 `:349-351`]. Under A it **dissolves**: replaced by
   `Workflow.idempotencyKey` (one execution per key) + a durable cursor row read O(1). **DELETE.**
5. **`recoverPendingSignals` — startup sweep re-arming pending executions** [read,
   `signal.ts:266-309`]. Needed **only because** wake-state lives in a bespoke `SignalTable` the
   engine doesn't own. If awaits move to `DurableDeferred`, the engine's own deferred persistence +
   resume-on-recovery covers it; the residual is a thin arm-recovery for the input-before-start case
   (facts that arrived before the keyed execution existed). **SHRINKS to near-nothing.**

**Is the per-key mailbox already `DurableQueue`? NO** [read, `DurableQueue.ts`]. `DurableQueue` is
**offer-a-job-to-a-worker-pool-and-park** (work distribution with offer-dedup + *unordered*
concurrency) over `@effect/experimental/PersistedQueue` — a backend Firegrid does not currently
wire. It does **not** provide per-`contextId` **ordered** serialization. The C1 "all mutations for
the same key are serialized" guarantee comes from `Workflow.idempotencyKey` (one execution per key)
+ the keyed cursor — exactly the tf-c71h shape — **not** from `DurableQueue`. (`DurableQueue` *would*
fit a different concept: the **host-executed tool-dispatch** worker pool — many tool jobs drained by
N workers, offer-deduped by `toolUseId`. That is an orthogonal, optional adoption, §3.)

**Net verdict:** `signal.ts` is **mostly reinvention** of `DurableDeferred` (items 1, 2) wrapped
around **one banned shape** (item 4) plus **one genuine thin helper** (item 3, the explicit arm)
and **one consequence of the reinvention** (item 5). This **agrees with** the canon's
explicit-arm-over-`DurableDeferred`-mailbox conclusion [read·2, reconcile §3, runtime-design-constraints
F3 / tf-e5rf]: keep the *thin arm*, reject the *bespoke await/mailbox substrate*. The Composition SDD
did not examine `signal.ts`; this is the one place this successor **adds a verdict** rather than
extending an existing one.

---

## §3 (B). Organization model — root domain concepts, domain-named homes in the §12 DAG

### The organizing principle (and what it rejects)

The Composition SDD's DAG bands (leaf/floor/interior/top) are the **import contract** — the
data-flow axis the 2026-05-22 target tree already encodes as directories ("the directory tree IS
the data flow" [read·2, target-tree:16-18]). This doc keeps the **band as the import axis** but
**sub-organizes the interior+top bands by DOMAIN ENTITY, not by mechanism shape.** The generic
buckets are rejected for a specific reason each:

- **`signal.ts`** — a *mechanism* sock drawer that bundles a reinvented primitive (DurableDeferred,
  §2) + a banned mailbox + a thin helper. **Rejected: it has no single domain; its parts go to
  three different homes (floor engine / DELETE / dispatch helper).**
- **`observers.ts`** — a *mechanism* name ("an observer"). It actually does two domain jobs:
  reading the agent-output journal and **dispatching** sibling per-event work. **Rejected: name the
  job (dispatch), not the pattern (observer).**
- **`subscribers/`** — a *shape* tier (Shape B/C/D). It groups `runtime-context.ts`,
  `permission-and-tool.ts`, `scheduled-webhook-peer.ts` by "is-a-subscriber" instead of by the
  entity served. **Rejected: a reader of `subscribers/permission-and-tool.ts` cannot tell it serves
  the RuntimeContext permission gate without opening it.**
- **`unified/`** — the flat composition "sock drawer" created by the unified SDD's acceptance #5
  ("No subscriber tier, no composition tier") [read·2, `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:146`].
  It collapsed every band into one directory. **Rejected: it is the opposite of "directory tree IS
  the data flow"; it makes the DAG invisible.**

The replacement axis: **a top-band file lives under the DOMAIN ENTITY it serves; its DAG band
governs what it may import (enforced, §4).** Two root domain entities cover the runtime:
`runtime-context/` (the keyed durable session entity + everything that delivers events to it or
dispatches work for it) and `agent-session/` (the live codec-bound process, Seam 2). The floor and
leaves keep their existing domain-neutral tier names (`engine/`, `tables/`, `events/`,
`sources/sandbox|codecs/`) because they are genuinely substrate, not domain.

### Concept → home table (A-shaped) [designed]

| # | Root domain concept | Generic bucket today | Domain-named home (proposed) | §12 band | Why the band (leaf-vs-interior rule) |
|---|---|---|---|---|---|
| 1 | Durable await-once completion + external resolve | `signal.ts` `awaitSignal`/`sendSignal` | **FOLD INTO floor `engine` (`DurableDeferred`)** — no Firegrid home | floor | it is already a floor primitive of the engine; a bespoke copy is reinvention (§2.1–2.2) |
| 2 | Durable workflow engine | `engine/durable-streams-workflow-engine.ts` | `engine/` (unchanged) | floor (substrate) | provided once, consumed upward; the engine owns deferred persistence + resume |
| 3 | Keyed **consume cursor** (RuntimeContext state) | (new; today implicit in the parked body) | `tables/runtime-context-cursor.ts` | floor (state-of-record) | a durable row; tables band; read O(1) by the handler |
| 4 | RuntimeContext **per-event session handler** `(state,event)->(state,emit)` | `subscribers/runtime-context.ts` (parked loop) | `runtime-context/session/handler.ts` | top | a keyed handler that reads floor state + cursor and returns; drives nothing below it |
| 5 | **Input-before-start arm** (create-or-resume) | `signal.ts` `armSession` | `runtime-context/session/arm.ts` (thin fn over `engine.execute{discard}`/`resume`) | top (dispatch) | thin composition over floor engine ops; the §2 "genuine helper" |
| 6 | **Input delivery** (prompt/close/cancel → keyed handler) | `channel-bindings.ts` | `runtime-context/session/delivery.ts` (input-delivery views) | top (reads-as-views) | a derivation over the engine + cursor; a function, not a per-channel Tag (Composition SDD:801-816) |
| 7 | **Output-journal dispatch** (fork permission/tool per observed output) | `observers.ts` (flat) | `runtime-context/dispatch/` (journal reader + per-kind routes) | top (reads-as-views) | reads the output-journal **view**, forks siblings; pure derivation over a resolved `Stream` |
| 8 | **Permission roundtrip** handler (await-once) | `subscribers/permission-and-tool.ts` (`PermissionRoundtripWorkflow`) | `runtime-context/permission/handler.ts` (uses `DurableDeferred.await`) | top | per-event handler awaiting one durable completion (C4) |
| 9 | **Tool dispatch** handler | `subscribers/permission-and-tool.ts` (`ToolDispatchWorkflow`) | `runtime-context/tool-dispatch/handler.ts` (optionally `DurableQueue` worker, §2) | top | per-event handler; at-most-once via idempotencyKey + Activity memo |
| 10 | **Scheduled / webhook / peer** observers | `subscribers/scheduled-webhook-peer.ts` | `runtime-context/schedule|webhook|peer/handler.ts` | top | per-fact await-once handlers (already canon-compliant) |
| 11 | **Codec adapter** — AgentSession lifecycle + inbound-kind gate (Seam 2) | `codec-adapter.ts` + `adapter.ts` | `agent-session/adapter.ts` (+ `agent-session/contract.ts` for the `RuntimeContextSessionAdapter` Tag) | **interior** | consumes floor (sandbox+codecs+resolver), consumed by handlers; the **positioned argument**, never a hole (Composition SDD:950-968) |
| 12 | Sandbox (process spawn) | `sources/sandbox/` | `sources/sandbox/` (unchanged) — the adapter's **own leaf** argument | leaf | a leaf hole, encapsulated where its single consumer (the adapter) lives (Composition SDD:978-987) |
| 13 | Codecs (ACP / stdio-jsonl) | `sources/codecs/` | `sources/codecs/` (unchanged) | leaf/floor | live boundary emitters; provided into the adapter |
| 14 | **Recovery** sweep | `signal.ts` `recoverPendingSignals` + `host.ts` recovery | `runtime-context/recovery.ts` (arm-recovery only) | top | shrinks: the engine owns deferred recovery; residual is input-before-start arm-recovery (§2.5) |
| 15 | **Host composition** factory | `host.ts` (`FiregridRuntime`) | `composition/firegrid-runtime.ts` (`FiregridRuntime(spec, adapter)`) | top (binary) | the §12 constructor; assembles bands, no business logic |
| 16 | MCP host surface | `mcp-host/` | `agent-session/mcp/` (or keep `mcp-host/`) — the late-bound `McpEndpoint` floor + host toolkit | floor + top | `McpEndpoint` is a floor hole resolved once via `Effect.cached` (Composition SDD:1032-1051) |

**Under B (parked) the table changes in exactly these rows** [designed]: rows 1, 4, 5 collapse —
`signal.ts` survives as a blessed `runtime-context/session/mailbox.ts` (the `SignalTable` +
`awaitSignal`/`readSignalsFor`), row 4's handler is the parked loop, and row 14's recovery stays
full-size. Everything else (the domain-named re-tiering) is shape-agnostic and lands either way. This
is why the org model can be written now and the §0.1 PO call can land after.

### Why this is "domain-named in the DAG", concretely

- A reader seeing `runtime-context/permission/handler.ts` knows **what entity it serves** (the
  RuntimeContext) and **what concern** (permission), and the band rule (§4) tells the compiler/CI
  what it may import. `subscribers/permission-and-tool.ts` told neither.
- The **dispatch** tier (today `observers.ts`) becomes `runtime-context/dispatch/` — a directory of
  the journal reader + one route file per observed output kind (`tool-use.ts`, `permission-request.ts`),
  each a **pure function over a resolved `Stream`** per the reads-as-views guidance ("Not everything
  is a service; a derivation over one resolved service is a plain function, not a second Tag"
  [read·2, Composition SDD:811-816]). It is interior/top, not a flat file, because it has internal
  structure (one route per kind) that the §3.2/tf-ll90.17 provenance gate lives inside [read·2,
  Composition SDD:254-340: ACP provider-executed `ToolUse` must **not** fork dispatch].

---

## §4 (D). FS-boundary type enforcement — the folder structure IS the type boundary

Two enforcement axes, both mechanical:

### D.1 Import-direction rules (extend the existing dep-cruiser tier rules)

The existing `.dependency-cruiser.cjs` per-tier rules forbid **upward** imports [read·2,
`.dependency-cruiser.cjs:115-237`]: `events/` imports nothing higher; `tables/` may not import
`sources/transforms/channels/producers/subscribers/composition`; `transforms/` may import only
`events/`; etc. Extend the SAME pattern to the domain-named top-band homes:

- **`runtime-context-cursor-tables-floor`** [designed]: `tables/runtime-context-cursor.ts` may import
  `events/` + protocol row schemas only; may **not** import any `runtime-context/**` top-band home
  (state-of-record cannot depend on its consumers). Mirrors `runtime-tables-no-higher-tier-import`.
- **`agent-session-interior-no-top`** [designed]: `agent-session/**` (the adapter, interior) may
  import floor (`tables/ sources/ engine/`) but **not** any `runtime-context/**` top-band handler.
  This **is** the leaf-vs-interior rule made mechanical: the adapter is consumed by handlers, never
  imports them, so no cycle.
- **`runtime-context-top-no-floor-bypass`** [designed]: `runtime-context/**` handlers may import
  `agent-session/` (the adapter Tag) + floor; the **dispatch** tier may import the **floor** and the
  adapter Tag but the floor may **not** import the dispatch tier (the "dispatch may import floor but
  not vice versa" rule the task names).
- **`composition-only-assembles`** [designed]: `composition/firegrid-runtime.ts` may import every
  band for Layer assembly but may **not** declare durable row schemas or transition behavior — mirrors
  the target-tree `composition/` rule.

### D.2 R-channel-shape rules (the type boundary the folder encodes) [designed, extending target-tree Topology Checks:346-359]

The target tree already specifies CI checks that read **types**, not just import paths
[read·2, target-tree:346-359]: "no Shape C subscriber `R` channel mentioning `WorkflowEngine` or
`WorkflowInstance`"; "no `transforms/` export whose type includes `Effect.Effect`". Generalize these
to the domain homes — the folder's **position dictates a constraint on its files' exported types**:

| Home | Exported-type rule (CI, ts-morph / effect-language-service) | Rationale |
|---|---|---|
| `tables/runtime-context-cursor.ts` | exports a `DurableTable` class + row schema; **no** `Effect` in the public surface beyond table ops | state-of-record is data, not behavior |
| `runtime-context/**/handler.ts` (per-event, A) | the handler's `R` **must not** include `WorkflowEngine`/`WorkflowInstance` *as a leaked outward requirement* — it is `toLayer`-internal; the **exported** Layer is `Layer<never, never, AdapterTag \| floor>` | a per-event keyed handler must not surface engine machinery (C2/C5 boundary, made a type) |
| `runtime-context/dispatch/route-*.ts` | exports a **pure function** `Stream<OutputRow> -> Stream<Fork>` — **no** `Context.Tag`, **no** `Layer` | reads-as-views: "a derivation over one resolved service is a plain function" (Composition SDD:811-816) |
| `runtime-context/session/delivery.ts` | input-delivery **view** functions take a resolved `Stream`/engine, return `EventOffset`; **no** per-channel `Tag`+`Live` | dissolve the `*ChannelLive` boilerplate (Composition SDD:789-816) |
| `agent-session/adapter.ts` | exports `Layer<RuntimeContextSessionAdapter, never, SubstrateDeps \| McpEndpoint>` — `R` is **floor only**, never a top-band Tag | Seam 2: the adapter is the interior positioned argument; if its `R` named a handler you'd have the cycle the rule forbids (Composition SDD:950-968) |

Under **A**, add the **strict-zero** rule that closes the loop the tf-c71h finding asked for: a
`local/` ESLint rule (or effect-quality counter) forbidding `Workflow.suspend` **inside any
`runtime-context/**/handler.ts`** (a per-event handler never parks for the entity lifetime). That is
the type/lint encoding of C5 — the payoff the c71h finding named ("designing the Tag is what *lets*
the airgap forbid the parked primitive"). Under **B**, this rule is NOT added (the parked body needs
`suspend`), and instead the parked mailbox gets a bead-owned grandfather entry.

### D.3 Net: the same discipline as today, extended

dep-cruiser already enforces the tier DAG and the `host-factory-lock` + tiny-firegrid airgap
[read·2, `.dependency-cruiser.cjs:532-604`, and the host.ts factory-lock]. The above are **the same
rule shapes** pointed at the new domain homes — "directory tree IS the data flow," mechanically
enforced, plus the R-channel-shape Topology Checks promoted from the target tree. No new enforcement
*mechanism* is invented; the rule set is extended to the re-tiered homes.

---

## §5 (E). `unified/` dissolution map + sequencing

### File → domain home (A-shaped) [designed]

| `unified/` file today | Domain home | Fate |
|---|---|---|
| `signal.ts` `awaitSignal`/`sendSignal`(no-arm) | `engine` (`DurableDeferred`) | **fold into engine** (reinvention, §2.1-2.2) |
| `signal.ts` `armSession` | `runtime-context/session/arm.ts` | **keep** as thin engine helper (§2.3) |
| `signal.ts` `readSignalsFor` + `SignalTable` | — | **delete** under A (the banned mailbox); **keep** as `runtime-context/session/mailbox.ts` under B |
| `signal.ts` `recoverPendingSignals` | `runtime-context/recovery.ts` | **shrink** to arm-recovery (§2.5) |
| `observers.ts` (`JournalObserverLive`) | `runtime-context/dispatch/` | **split** into journal reader + per-kind route files (incl. the §3.2 provenance gate) |
| `subscribers/runtime-context.ts` | `runtime-context/session/handler.ts` | **rewrite** to per-event (A) / keep parked (B) |
| `subscribers/permission-and-tool.ts` | `runtime-context/permission/handler.ts` + `runtime-context/tool-dispatch/handler.ts` | **split** by domain; permission uses `DurableDeferred.await` |
| `subscribers/scheduled-webhook-peer.ts` | `runtime-context/{schedule,webhook,peer}/handler.ts` | **split** by domain |
| `adapter.ts` (`RuntimeContextSessionAdapter` Tag) | `agent-session/contract.ts` | **move** (Seam 2 contract) |
| `codec-adapter.ts` (`ProductionCodecAdapterLive`) | `agent-session/adapter.ts` | **move** (Seam 2 impl) |
| `channel-bindings.ts` | `runtime-context/session/delivery.ts` | **move** + dissolve per-channel Lives into views |
| `host.ts` (`FiregridRuntime`) | `composition/firegrid-runtime.ts` | **move** (already the §12 constructor) |
| `tables.ts` | `tables/*` | **distribute** to the state band |
| `host-identity.ts` | `composition/` or `agent-session/` | move with its consumer |
| `mcp-host/*` | `agent-session/mcp/*` | move; `McpEndpoint` as the `Effect.cached` floor hole |

### Sequencing relative to §12 (which largely landed) [designed]

1. **Shape-neutral, now** (does not need §0.1): fix the tf-r06u.36 terminal-relay leak; **correct the
   blast-radius citation** (`ToolDispatchWorkflow` is in `permission-and-tool.ts`, not
   `mcp-host/tool-dispatch.ts`). These are pre-work either A or B needs.
2. **§0.1 PO decision** (A vs B/C) — **gates** the body-shape rows (1,4,5,14) and the D.2 strict-zero
   `suspend` rule. The org **re-tiering** (rows 2,3,6,7,8,9,10,11,12,13,15,16) is shape-agnostic and
   can begin in parallel.
3. **Re-tier the shape-agnostic homes** (domain-named moves + dep-cruiser rule extensions) on top of
   the already-landed `FiregridRuntime(spec, adapter)` §12 core. This is mechanical (moves + import-rule
   additions), gated by the existing preflight.
4. **Apply the §0.1 verdict**: under A, rewrite the handler to per-event + delete the mailbox + add the
   strict-zero `suspend` rule + close caveats (b)+(d) with a relay/single-adapter sim slice **before**
   deleting the parked body (transactional cutover — no half-ship). Under B, bless the mailbox with a
   bead-owned grandfather + amend canon C2/C5.
5. **One consolidated implementation SDD** off the §0.1 verdict (the proposal's "ONE consolidated SDD"
   step), carrying the Constraint Check below.

---

## §6. Epistemic status (Composition SDD format)

**Designed, not read:** the organization model (§3 concept→home table, the domain-named homes), the
D.1/D.2 enforcement-rule *extensions*, the dissolution map (§5), and the §1 recommendation are a
proposed greenfield target — not transcribed from source. The per-event/parked mapping (§2) is
designed *on top of* read primitives.

**Read against code / vendored sources:** the `@effect/workflow` primitive behaviors (§2:
`DurableDeferred` await-once + token + external resolve; `DurableQueue` = PersistedQueue worker-pool;
`Workflow.make`/`toLayer`/`suspend`/`execute{discard}`/`idempotencyKey`; engine `resume` no-ops a
missing execution; `deferredDone` resumes the existing waiter) are **[read]** at the cited
`repos/effect/` + `packages/runtime/` lines. The tf-c71h trace facts (§1) are **[read]** at the cited
run. The Composition SDD §12 bands/rules, the canon constraints, the proposal §0.1-§3, the c71h review
caveats, and the dep-cruiser tier rules are **[read·2]** via delegated readers at the cited lines.

**Confirm before building** (priority): (1) **The §0.1 PO decision** — A vs B/C — gates §3 rows
(1,4,5,14) and D.2. (2) **The relay+single-adapter sim slice** (caveats b,d) — confirm the per-event
shape carries the permission/tool relay and a production single-adapter wiring before deleting the
parked body. (3) **Per-key serialization under contention** (caveat c) — confirm `Workflow.idempotencyKey`
+ cursor serialize racing same-`contextId` appends. (4) **`DurableDeferred` provider context** — confirm
the production resolve sites can reach `WorkflowEngine` to call `deferredDone` where today they call
`sendSignal` (they already provide the engine, but verify at each call site). (5) **`McpEndpoint` as
`Effect.cached` floor hole** — confirm the late-bind shape the Composition SDD sketches.

---

## §7. Constraint Check (the SDD-Gate section the unified SDD skipped)

Per `runtime-design-constraints.md:558` every new runtime SDD must mark each constraint. This is a
**design** doc (no code), but it proposes the per-event target, so:

- **C1 (keyed durable state container):** **complies (A)** — RuntimeContext keyed by `contextId`;
  state = the durable cursor row + engine execution/activity records. Under B: complies (the parked
  body's state is in the replay history — admissible only via bridge exception).
- **C2 (per-event handlers, not long-lived bodies):** **complies (A)** — one fresh execution per
  input, returns. **Violates (B)** — the entity-lifetime parked loop is the forbidden shape; B
  requires an explicit canon amendment (the §0.1 decision).
- **C4 (async waits are durable completions):** **complies (A)** — permission/tool handlers await a
  single `DurableDeferred` and return; `readSignalsFor` (the cross-event mailbox C4 forbids) is
  deleted.
- **C5 (no parked entity bodies between events):** **complies (A)** — no entity-lifetime parked body;
  the D.2 strict-zero `suspend`-in-handler rule encodes it as lint. **Violates (B).**

A is **dispatchable** as written. B is a **bridge exception or canon amendment** — not this doc's
to grant (PO, §0.1).

---

## §8. Sources

Vendored `@effect/workflow` [read]: `repos/effect/packages/workflow/README.md:26-119` ·
`src/DurableDeferred.ts:62-122,264-458` · `src/DurableQueue.ts:42-330` · `src/Workflow.ts:110,148,263-290,680` ·
`src/WorkflowEngine.ts:61-83,113-116,140-170` · `src/Activity.ts` · `src/DurableClock.ts`.
Firegrid runtime [read]: `packages/runtime/src/unified/signal.ts:140-309` ·
`engine/internal/engine-runtime.ts:184-185,458-484` · the tf-c71h sim + finding (PR #850) + trace run
`2026-06-02T21-54-42-508Z`.
Docs [read·2]: `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` §12 (`:654-676,789-816,950-987,1032-1073,1118-1133`) ·
`docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md` §0.1-§5,§9 ·
`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md` §2-§4 ·
`docs/cannon/architecture/runtime-design-constraints.md` C1/C2/C4/C5 (`:234-385,558-596`) ·
the three c71h reviews · `docs/architecture/2026-05-22-runtime-physical-target-tree.md:16-18,346-359` ·
`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:146` · `.dependency-cruiser.cjs:115-237,532-604` ·
`docs/static-analysis-catalog.md`.

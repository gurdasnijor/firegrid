# Runtime organization model + RuntimeContext body shape — successor to the Composition SDD

- **Date:** 2026-06-02
- **Bead:** tf-ogoj (design doc only — no runtime/src edits)
- **Revision:** **v2** — folds the §2.1 sharper frame (`signal.ts` is a *second implementation* of the
  `WorkflowEngine` seam Firegrid already implements, not "reinvention + a thin helper to keep") and the
  tf-o8zu AMEND review (`docs/reviews/2026-06-02-tf-ogoj-sdd-review.md`); adds §9 (the confirming
  tf-ogoj workbench sim, H1/H2/H3).
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

**Re-marked cost accounting (per the §2.1 sharper frame — these correct two costs v1 mis-assigned to A):**
- **(a) Recovery is NOT a cost of option A.** v1 implied A inherits a recovery burden. It does not:
  `recoverPendingSignals` is **deleted**, and the residual non-clock-deferred recovery is a **small,
  one-time extension of the engine sweep Firegrid already owns** (`recoverPendingClockWakeups`,
  §2.3) that benefits **every** `DurableDeferred` user. It is engine-seam work, not RuntimeContext
  body-shape work, and is the same cost under any shape that uses `DurableDeferred` for waits.
- **(b) Per-`contextId` serialization favors NEITHER A nor B-via-`signal.ts`.** It is a real,
  still-open engine-seam capability gap (§2.4). `signal.ts` does **not** provide it (its mailbox is
  read by the single parked body, so "serialization" there is just "one consumer"); A's
  `idempotencyKey + cursor` does **not** provide it either (§2.4). B "gets it free" **only** by being
  the canon-banned single parked body. So this gap is **orthogonal** to the A-vs-B call and must not
  be scored as a point for B or for keeping `signal.ts`. The sim's **H2** (§9) gathers the data.

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
| Execution identity + state | `idempotencyKey` ⇒ at-most-one execution per `(contextId,inputKey)` + a durable **consume cursor** row read O(1). **NOTE [read]:** this is the *execution-identity + state* shape, **NOT** a per-`contextId` serialization guarantee — `idempotencyKey` dedupes a chosen execution key, a cursor *observes/records* consume position; neither gives **atomic per-key append/owner** ordering under racing inputs (see caveat (c), §1, and §6 confirm-item; H2 of the tf-ogoj sim, §9, gathers the data) | the single parked execution serializes by being the only consumer of one mailbox |
| Per-key serialization (the real gap) | **unproven** — needs an explicit per-`contextId` owner / atomic-append discipline (an engine-seam capability, §2.1), independent of A's body shape | "free" **only** by being the canon-banned single parked body |
| External input | a durable input fact row + an **arm** — `engine.execute({discard})` if the keyed execution is missing, else the resolve rides `DurableDeferred.done` (both standard engine ops, §2.2) | `awaitSignal`/`readSignalsFor` over a bespoke `SignalTable` mailbox + `Workflow.suspend` |
| Await-one (permission) | `DurableDeferred.await` / `succeed(token)` on the engine seam | `awaitSignal` / `sendSignal` (no arm) — the bespoke parallel impl |
| Cleanup | terminal input ⇒ one execution that deregisters and returns | the parked body's final `deregister` after the loop ends |

### §2.1 The sharper frame — `WorkflowEngine` is a customization SEAM Firegrid already implements

The earlier v1 framing ("`signal.ts` is mostly reinvention; keep the thin arm") **understated** the
finding. The accurate frame is structural, and it changes the §0.1 cost accounting (below). It rests
on three source facts:

1. **`WorkflowEngine` is a `Context.Tag` — a dependency-injection seam, not a fixed implementation**
   [read, `WorkflowEngine.ts:189` is its sibling `WorkflowInstance` Tag; the engine Tag itself is the
   `Context.Tag` consumed by every combinator]. Its interface **declares** the full durable-execution
   vocabulary: `execute`/`poll`/`interrupt`/`resume`/`activityExecute`/`deferredResult`/`deferredDone`/
   `scheduleClock` [read, `WorkflowEngine.ts:61, 88, 105, 113, 121, 140, 155, 175`].
2. **The combinators are thin and DELEGATE to the Tag.** `DurableDeferred.await` →
   `engine.deferredResult` then `Workflow.suspend` [read, `DurableDeferred.ts:112-119`];
   `DurableDeferred.done` → `engine.deferredDone` [read, `DurableDeferred.ts:176` in `into`, `:418`
   in `done`]; `DurableQueue` is itself built from `DurableDeferred` + a `PersistedQueueFactory`
   [read, `DurableQueue.ts:121-125, 188-217`]. There is no behavior in the combinators that the
   engine Tag does not back.
3. **Firegrid ALREADY implements the entire seam.** `makeWorkflowEngine` [read,
   `engine-runtime.ts:44`] returns an object providing `execute` [`:270`], `resume` [`:350`],
   `deferredResult` [`:433`] (reads its **own** `deferreds` table, key `${executionId}/${deferredName}`,
   schema `table.ts:53-77`), `deferredDone` [`:458`] (upserts that deferred row, then `resume`), and
   `scheduleClock` [`:491`]. `DurableStreamsWorkflowEngine` **IS** the custom implementation bound
   behind the standard `WorkflowEngine` Tag — the in-tree precedent for "inject **our** impl, use
   **their** interfaces." Its `deferredResult`/`deferredDone` spans even self-label
   `firegrid.seam.kind: "durability"` [read, `engine-runtime.ts:453, 486`].

**Therefore `signal.ts` is not "reinvention with a thin helper worth keeping" — it is a SECOND
implementation, built BESIDE the seam, of capabilities the engine interface already declares and
`DurableStreamsWorkflowEngine` already implements.** Decomposed (each part dissolves):

| `signal.ts` part [read] | What it duplicates | Fate |
|---|---|---|
| `awaitSignal({name})` (`:229-245`) | `DurableDeferred.await` → `engine.deferredResult`+suspend | **FOLD** — use the combinator on the seam |
| `sendSignal` no-arm (`:193-216`) | `DurableDeferred.done/succeed` → `engine.deferredDone` | **FOLD** — use the combinator on the seam |
| `armSession` create-or-resume (`:140-164`) | `engine.execute({discard})` (the create) + (for a known waiter) `DurableDeferred.done` (the resolve) | **FOLD to two standard engine ops** — see §2.2 |
| `readSignalsFor` ordered mailbox (`:220-227`) | nothing in the seam (it is the C2/C5-banned cross-event mailbox) | **DELETE** — per-event execution + cursor (§3) |
| `recoverPendingSignals` sweep (`:266-309`) | the engine's own recovery, which today sweeps only clock wakeups | **FOLD by extending the engine sweep** — see §2.3 |

### §2.2 The "input-before-start arm" is two standard engine ops, not a bespoke helper

v1 called the arm "a genuine thin helper to keep." Refined: the arm is the **call-site composition of
two standard engine operations**, owning no substrate:
- **Create-if-missing:** `Workflow.execute(payload, { discard:true })` — `discard:true` returns the
  executionId and fire-and-forgets the body [read, `WorkflowEngine.ts:61-83`]. This is required
  because **`DurableDeferred.done` can pre-store a completion row before the waiter exists but cannot
  *arm/create* the workflow body** — its trailing `resume` no-ops against a missing execution [read,
  `engine-runtime.ts:184-185`; review tf-o8zu finding 2]. So input-before-start genuinely needs the
  `execute({discard})` create — but that is a **standard op**, not Firegrid substrate.
- **Resolve-if-waiting:** `DurableDeferred.done(token, exit)` for the await-once case.

Whether those two lines sit inline or behind a 5-line `arm()` helper is a triviality; **either way no
`SignalTable` and no bespoke await/resolve code survive.** This is the precise, source-grounded form
of the reconcile-proposal §3 / runtime-design-constraints F3 "explicit-arm-over-DurableDeferred-mailbox"
conclusion [read·2].

> **Keying nuance [read; review tf-o8zu finding 1]:** `signal.ts`'s `signalKey` is `${executionId}|${name}`
> (`signal.ts:54, 83`); the `DurableDeferred` token + engine row carry `(workflowName, executionId,
> deferredName)` (`DurableDeferred.ts:264`, `engine-runtime.ts:473`). The keyings are **semantically
> equivalent within one workflow's execution namespace**, **not identical** — the deferred token also
> carries `workflowName`. The v1 prose "same keying" is corrected to "semantically equivalent, not
> identical."

### §2.3 Recovery — persistence is proven, resume-on-recovery for non-clock deferreds is NOT (and is the engine fix site)

v1 claimed the engine's "deferred persistence + resume-on-recovery covers" the dropped
`recoverPendingSignals`. **Half is source-verified; half is not** [read; review tf-o8zu finding 3]:
- **Persistence is real:** `deferredDone` upserts the deferred row [read, `engine-runtime.ts:473-482`]
  and `deferredResult` reads it on resume [read, `:433-440`].
- **Generic resume-on-recovery is NOT yet implemented:** `makeWorkflowEngine`'s startup recovery runs
  **only** `recoverPendingClockWakeups` [read, `engine-runtime.ts:149-159, 527`], which sweeps the
  `clockWakeups` table. There is **no** startup sweep that resumes executions with an already-written
  **non-clock** deferred row. So a producer that crashes *after* writing the deferred row but *before*
  the trailing `resume` is **not** recovered by the engine today (only by producer retry).

**Conclusion:** moving awaits to `DurableDeferred` does **not** get recovery "for free." It names a
**small, well-scoped engine-seam fix**: extend `recoverPendingClockWakeups` to also re-arm pending
non-clock `deferreds` rows (or generalize it to a `recoverPendingWakeups` over both tables). That fix
lives in the engine Firegrid **owns** [`engine-runtime.ts:149`], benefits **every** `DurableDeferred`
user (not just RuntimeContext), and is strictly smaller than maintaining the parallel
`recoverPendingSignals` over a bespoke table. It is added to the §6 confirm-before-building list.

### §2.4 Is the per-key mailbox `DurableQueue`? NO

[read, `DurableQueue.ts:42-330`] `DurableQueue` is **offer-a-job-to-a-worker-pool-and-park** (a
`process` offers an item and awaits a per-item `DurableDeferred`; a `worker(…, {concurrency})` drains
with *unordered* concurrency) over `@effect/experimental/PersistedQueue` — a backend Firegrid does not
wire. It provides **no** per-`contextId` ordered serialization; `idempotencyKey` there dedupes the
**offer**. (`DurableQueue` *would* fit the orthogonal **host tool-dispatch** worker pool, §3.)

**And critically — neither does `Workflow.idempotencyKey + cursor`** [read; review tf-o8zu finding 4].
`idempotencyKey` computes a deterministic executionId (dedupes a chosen execution key) [read,
`Workflow.ts:263-307`]; a cursor *records* consume position. **Neither gives atomic per-`contextId`
append ordering under racing inputs.** So §2 must **not** promote "idempotencyKey + cursor = C1
serialization" to a fact (v1 did). Per-key serialization is a **real, still-open capability gap**
whose home is the **engine seam** (a per-key owner / atomic-append discipline), independent of A's
body shape — and B "gets it free" **only** by being the canon-banned single parked body. So the
serialization gap favors **neither** `signal.ts` **nor** B. The tf-ogoj sim's **H2** (§9) drives
**concurrent** same-`contextId` inputs to gather the data — it may **reject** the cursor-serializes
assumption, which is the load-bearing fact for this gap.

### §2.5 Net verdict (v2)

`signal.ts` is a **second implementation of the WorkflowEngine seam** — a capability set the engine
interface declares and `DurableStreamsWorkflowEngine` already implements — built beside the seam
instead of on it. It **dissolves entirely**: await/resolve → `DurableDeferred` on the seam; the
input-before-start arm → two standard ops (`execute({discard})` + `done`); the ordered mailbox →
DELETE (per-event + cursor); the recovery sweep → a small engine-seam extension (§2.3). The remaining
**genuine open gap** is per-`contextId` serialization, which belongs to the engine seam and which the
sim's H2 probes. This **strengthens** the reconcile §3 / F3 conclusion and is the one place this
successor **adds** a verdict (the Composition SDD did not examine `signal.ts`).

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
| 5 | **Input-before-start arm** (create-or-resume) | `signal.ts` `armSession` | inline at the delivery call site (or a 5-line `runtime-context/session/arm.ts`) — `engine.execute({discard})` create + `DurableDeferred.done` resolve | top (dispatch) | two **standard engine ops**, not bespoke substrate (§2.2); owns no table |
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

**Guardrail on the shape-agnostic rows [designed; review tf-o8zu finding 6]:** rows 6, 8, 9 keep the
**same domain home** under either outcome, but their *internals* are not fully shape-agnostic — under
B, row 6 delivery still targets the parked mailbox/arm, and the rows 8/9 `DurableDeferred` replacement
for permission/tool waits is contingent on the §2.3 non-clock-deferred recovery question closing. So:
**the homes are stable now; the row 6/8/9 internals may remain mailbox/`signal`-shaped until §0.1 lands
and the recovery extension is confirmed.** Only rows 1, 4, 5, 14 are the *formal* shape-dependent rows.

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

Each rule names its **enforcement host** explicitly [review tf-o8zu finding 5: do not imply
effect-language-service enforces bespoke topology]. The hosts: **dep-cruiser** (import-path graph);
**ESLint regex** (`no-restricted-syntax`/`no-restricted-imports` over a token pattern — catches direct
mentions, NOT aliases/re-exports/inferred types); **custom ESLint-AST** (a `local/` rule walking the
AST); **ts-morph type-surface** (a script resolving exported *types*, like the effect-quality counter);
**els-diagnostic** (effect-language-service — used for its existing Effect diagnostics, **not** a host
for custom topology assertions, which it cannot express today [read; `docs/static-analysis-catalog.md`
els is diagnostics-only]).

| Home | Exported-type rule | **Enforcement host** | Rationale |
|---|---|---|---|
| `tables/runtime-context-cursor.ts` | exports a `DurableTable` class + row schema; **no** `Effect` in the public surface beyond table ops | **ts-morph type-surface** (regex ESLint can pre-screen `Effect.Effect` text, as transforms/ does today) | state-of-record is data, not behavior |
| `runtime-context/**/handler.ts` (per-event, A) | the handler's exported Layer `R` **must not** leak `WorkflowEngine`/`WorkflowInstance` outward — exported `Layer<never, never, AdapterTag \| floor>` | **ts-morph type-surface** (resolves inferred `R`; regex can only catch a literal `WorkflowEngine` token, missing aliases/inferred R) | a per-event keyed handler must not surface engine machinery (C2/C5 boundary, made a type) |
| `runtime-context/dispatch/route-*.ts` | exports a **pure function** `Stream<OutputRow> -> Stream<Fork>` — **no** `Context.Tag`, **no** `Layer` | **custom ESLint-AST** (assert exported decls are functions; ban `Context.Tag`/`Layer` in the module) | reads-as-views: "a derivation over one resolved service is a plain function" (Composition SDD:811-816) |
| `runtime-context/session/delivery.ts` | input-delivery **view** functions take a resolved `Stream`/engine, return `EventOffset`; **no** per-channel `Tag`+`Live` | **custom ESLint-AST** | dissolve the `*ChannelLive` boilerplate (Composition SDD:789-816) |
| `agent-session/adapter.ts` | exports `Layer<RuntimeContextSessionAdapter, never, SubstrateDeps \| McpEndpoint>` — `R` is **floor only**, never a top-band Tag | **ts-morph type-surface** (the cycle-forbidding rule needs resolved `R`, not a token scan) | Seam 2: the adapter is the interior positioned argument; if its `R` named a handler you'd have the cycle the rule forbids (Composition SDD:950-968) |

Under **A**, add the **strict-zero** rule that closes the loop the tf-c71h finding asked for —
**enforcement host: custom ESLint-AST or ts-morph counter** — forbidding `Workflow.suspend` **inside
any `runtime-context/**/handler.ts`** (a per-event handler never parks for the entity lifetime). That
is the type/lint encoding of C5 (the precedent exists today: `Workflow.suspend`/`WorkflowEngine` are
already regex-banned under the old Shape-C subscriber folders, `eslint.config.js` ~`:2316-2342` [read·2,
review finding 5]). Under **B**, this rule is NOT added (the parked body needs `suspend`); the parked
mailbox gets a bead-owned grandfather entry instead.

### D.3 Net: D.1 is mechanical today; D.2 is mechanizable but needs new custom rule code

dep-cruiser already enforces the tier DAG and the `host-factory-lock` + tiny-firegrid airgap
[read·2, `.dependency-cruiser.cjs:532-604`, and the host.ts factory-lock]. **D.1's** import-direction
rules are **the same rule shapes** pointed at the new domain homes — mechanical today, no new mechanism.
**D.2 is different and must not be oversold** [review tf-o8zu finding 5]: the existing checks do **not**
already express the R-channel-shape assertions (today's `WorkflowEngine`/`Effect.Effect` bans are
**regex** over old folder paths, which catch a literal token but not aliases, re-exports, inferred `R`,
or a `Layer` behind a type alias). D.2 is **mechanizable with the existing tool stacks** (ts-morph,
custom ESLint-AST) but requires **new custom rule code** — it is *designed*, assigned a host per row
above, and should be treated as enforceable only once that code lands. "Directory tree IS the data flow"
holds for D.1 now and for D.2 after the custom analyzers are written.

---

## §5 (E). `unified/` dissolution map + sequencing

### File → domain home (A-shaped) [designed]

| `unified/` file today | Domain home | Fate |
|---|---|---|
| `signal.ts` `awaitSignal`/`sendSignal`(no-arm) | the `engine` seam (`DurableDeferred` over `WorkflowEngine`) | **fold onto the seam** — second-impl of `deferredResult`/`deferredDone` (§2.1) |
| `signal.ts` `armSession` | inline / 5-line helper | **fold to two standard ops** — `execute({discard})` + `DurableDeferred.done` (§2.2); no `SignalTable` survives |
| `signal.ts` `readSignalsFor` + `SignalTable` | — | **delete** under A (the banned mailbox); **keep** as `runtime-context/session/mailbox.ts` under B |
| `signal.ts` `recoverPendingSignals` | `engine/` (extend `recoverPendingClockWakeups`) | **fold into the engine sweep** — extend the existing clock-only startup sweep to non-clock `deferreds` (§2.3); benefits all `DurableDeferred` users, not a RuntimeContext-specific cost |
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
missing execution; `deferredDone` upserts the deferred row then resumes the existing waiter; the
`WorkflowEngine` Tag interface and that `makeWorkflowEngine`/`DurableStreamsWorkflowEngine` implements
the whole seam incl. a `deferreds` table; startup recovery sweeps **only** `clockWakeups`) are
**[read]** at the cited `repos/effect/` + `packages/runtime/` lines (§2.1-2.4, verified at source this
revision). The tf-c71h trace facts (§1) and the tf-ogoj sim facts (§9) are **[read]** at the cited
runs. The Composition SDD §12 bands/rules, the canon constraints, the proposal §0.1-§3, and the
dep-cruiser tier rules are **[read·2]** via delegated readers; the tf-o8zu review punch-list is folded
(§2.1-2.4, §3 guardrail, §4 enforcement hosts).

**Confirm before building** (priority): (1) **The §0.1 PO decision** — A vs B/C — gates §3 rows
(1,4,5,14) and the D.2 strict-zero rule. (2) **The relay+single-adapter sim slice** (caveats b,d) —
confirm the per-event shape carries the permission/tool relay and a production single-adapter wiring
before deleting the parked body. (3) **Per-`contextId` serialization is an OPEN gap** (caveat c, §2.4)
— `Workflow.idempotencyKey + cursor` is **NOT** the serialization guarantee; an explicit per-key
owner / atomic-append discipline at the engine seam is needed. The sim's **H2 (§9) gathers whether the
cursor serializes or races under concurrency** — read that result before designing the owner. (4)
**Non-clock `DurableDeferred` crash-recovery** (§2.3) — the engine persists deferred rows but has **no**
startup resume-sweep for non-clock deferreds; confirm/implement the extension to
`recoverPendingClockWakeups` (`engine-runtime.ts:149`) before relying on `DurableDeferred` for
crash-durable waits. The sim's **H3 (§9) is public-surface-blocked**; the proof belongs in a
runtime-package engine test. (5) **`DurableDeferred` provider context** — confirm the production resolve
sites can reach `WorkflowEngine` to call `deferredDone` (they already provide the engine; verify per
site). (6) **`McpEndpoint` as `Effect.cached` floor hole** — confirm the late-bind shape.

---

## §7. Constraint Check (the SDD-Gate section the unified SDD skipped)

Per `runtime-design-constraints.md:558` every new runtime SDD must mark each constraint. This is a
**design** doc (no code), but it proposes the per-event target. Re-run for v2 (the §2.1 sharper frame
strengthens the C4 line — awaits ride the **real engine seam**, not a parallel impl):

- **C1 (keyed durable state container):** **complies (A)** — RuntimeContext keyed by `contextId`;
  state = the durable cursor row + engine execution/activity records. **Caveat [v2, §2.4]:** C1 also
  asserts "all mutations for the same key are *serialized by the runtime owner*"; A's
  `idempotencyKey + cursor` gives execution-identity + state but **not** that serialization — it is an
  **open engine-seam gap** (confirm-item 3, sim H2), not satisfied by the body shape alone. Under B:
  the parked body satisfies serialization by being the single owner — but only by violating C2/C5.
- **C2 (per-event handlers, not long-lived bodies):** **complies (A)** — one fresh execution per
  input, returns. **Violates (B)** — the entity-lifetime parked loop is the forbidden shape; B
  requires an explicit canon amendment (the §0.1 decision).
- **C4 (async waits are durable completions):** **complies (A), strengthened by v2** — permission/tool
  handlers await a single `DurableDeferred` **on the real `WorkflowEngine` seam Firegrid implements**
  (§2.1), exactly the primitive C4 names as admissible (`:349-351`); the bespoke parallel impl
  (`awaitSignal`) and the cross-event mailbox (`readSignalsFor`) C4 forbids are **deleted**. **Caveat
  [v2, §2.3]:** crash-durable await across a producer crash needs the non-clock-deferred recovery
  extension (confirm-item 4) — a named engine fix, not a shape problem.
- **C5 (no parked entity bodies between events):** **complies (A)** — no entity-lifetime parked body;
  the D.2 strict-zero `suspend`-in-handler rule (custom ESLint-AST / ts-morph, §4) encodes it as lint.
  **Violates (B).**

A is **dispatchable** as written (with the C1-serialization gap named as a tracked confirm-item, not a
hidden assumption). B is a **bridge exception or canon amendment** — not this doc's to grant (PO, §0.1).

---

## §8. Sources

Vendored `@effect/workflow` [read]: `repos/effect/packages/workflow/README.md:26-119` ·
`src/DurableDeferred.ts:62-122,176,264-458` · `src/DurableQueue.ts:42-330` · `src/Workflow.ts:110,148,263-290,680` ·
`src/WorkflowEngine.ts:61,88,105,113,121,140,155,175,189` · `src/Activity.ts` · `src/DurableClock.ts`.
Firegrid runtime [read]: `packages/runtime/src/unified/signal.ts:54,83,140-309` ·
`engine/internal/engine-runtime.ts:44,149-159,182-185,270,350,433-440,458-484,491,527` ·
`engine/internal/table.ts:53-77` (the engine's own `deferreds` table) · the tf-c71h sim + finding
(PR #850) + trace run `2026-06-02T21-54-42-508Z` · the tf-ogoj confirming sim (§9, this PR).
Docs [read·2]: `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` §12 (`:654-676,789-816,950-987,1032-1073,1118-1133`) ·
`docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md` §0.1-§5,§9 ·
`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md` §2-§4 ·
`docs/cannon/architecture/runtime-design-constraints.md` C1/C2/C4/C5 (`:234-385,558-596`) ·
the tf-o8zu review `docs/reviews/2026-06-02-tf-ogoj-sdd-review.md` (folded) + the three c71h reviews ·
`docs/architecture/2026-05-22-runtime-physical-target-tree.md:16-18,346-359` ·
`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:146` · `.dependency-cruiser.cjs:115-237,532-604` ·
`docs/static-analysis-catalog.md`.

---

## §9. The confirming tf-ogoj workbench sim (H1/H2/H3)

A tiny-firegrid WORKBENCH sim (`packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/`)
drives the §2 simplifying hypothesis on the **real** `DurableStreamsWorkflowEngine` + production codec
adapter (client-SDK-only driver, no fakes, real ACP example-agent spawn). The trace is the deliverable;
the prose finding (`docs/findings/tf-ogoj-durable-deferred-and-serialization.md`) interprets confirm/reject.

- **H1 — `DurableDeferred` await-once rides the real engine.** A workbench workflow makes a
  `DurableDeferred`, awaits it (suspends), and a second public input resolves it via
  `DurableDeferred.succeed(token)`. Expectation: the trace shows
  `firegrid.workflow_engine.deferred.result` (undefined → suspend) then `…deferred.done` (resolve →
  resume) on the real engine — confirming the seam Firegrid implements backs the standard combinator.
- **H2 — per-`contextId` serialization under CONCURRENT inputs** (the c71h gap; c71h drove only
  sequentially). N **concurrent** same-`contextId` prompts; the trace shows whether `idempotencyKey +
  cursor` serializes or **races** (lost cursor updates / duplicate seq). **This may REJECT** the
  "cursor serializes" assumption — a valid, valuable result that confirms §2.4.
- **H3 — non-clock `DurableDeferred` crash-recovery** (deferred row written, crash before resume). If
  unreachable from the public client surface (likely — c71h marked crash-recovery public-surface-blocked),
  the finding says so honestly and names the runtime-package engine test + the fix site (extend
  `recoverPendingClockWakeups`, `engine-runtime.ts:149`). No faked crash.

**Per-H verdicts (run `2026-06-02T23-54-22-805Z`; finding
`docs/findings/tf-ogoj-durable-deferred-and-serialization.md`):**
- **H1 — CONFIRMED.** The standard `DurableDeferred` round-trip ran on the real engine: trace
  `firegrid.workflow_engine.deferred.result` (undefined → suspend, L41/L42) → `…deferred.done`
  (external resolve, L55) → `…deferred.result` (resolved → resume, L59) → body completes with the
  value (L60). `signal.ts`'s await/resolve is a second implementation of this seam (§2.1).
- **H2 — REJECTED (the load-bearing result).** 6 **concurrent** same-`contextId` prompts → the
  channel's `nextSeq` (count-then-`insertOrGet`) raced: **1 `Inserted` + 5 `Found`** on the input-log
  (five inputs **silently dropped**, zero error spans); 7 distinct executions created but the cursor
  advanced **once** (0→1). `Workflow.idempotencyKey + cursor` does **NOT** serialize concurrent
  inputs — it loses them. This **confirms §2.4**: per-`contextId` serialization is a real open
  engine-seam gap, favoring neither A's cursor nor B's `signal.ts`. (A *successful* rejection — the
  SDD no longer rests on an unproven serialization claim.)
- **H3 — public-surface-blocked (not driven, no faked crash).** Deferred-row persistence is real
  (`engine-runtime.ts:473`) but there is **no** startup resume-sweep for non-clock deferreds
  (recovery sweeps only `clockWakeups`, `:149-159`). The proof belongs in a runtime-package engine
  test + the named fix (extend `recoverPendingClockWakeups`); confirm-item 4.

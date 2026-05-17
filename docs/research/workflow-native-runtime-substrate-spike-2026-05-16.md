# Workflow-Native Runtime Substrate — Architecture Decision Spike

Date: 2026-05-16
Base inspected: `origin/main` at `aff581176` (worktree from `origin/main`; primary
checkout is on the PR 282 lane and was not touched).
Lane: Firegrid runtime substrate architecture research (docs-only).
Source prompt: `docs/research/workflow-native-runtime-substrate.md`.
Context input (not source of truth): `docs/sdds/MIGRATION_SKETCH_WORKFLOW_NATIVE_SUBSTRATE.md`,
PR 281 `docs/research/output-path-substrate-spike-2026-05-16.md` (Lane C, Model C Hybrid).

## Coordination note (parallel neutral-reference briefs)

Two neutral-reference briefs were dispatched in parallel after this exploration
started: a **Workflow Engine Audit** (@effect/workflow surface +
ClusterWorkflowEngine reference + `DurableStreamsWorkflowEngine` parity) and a
**Durability Assumption Audit** (per-row-family essential/conditional/accidental
classification). At the time of writing neither had an open PR, branch, or
docs/research artifact. Therefore:

- **§4 (workflow-engine gap accounting)** was produced **inline** from a direct
  read of `engine-runtime.ts` and the vendored `repos/effect` sources. It is
  **duplicative** of the Workflow Engine Audit brief. When that brief's PR
  lands, §4 should be reconciled against it and citations re-pointed to the
  neutral reference; the recommendation does not depend on any number that
  differs by less than ~50 LOC, so a normal divergence will not shift the pick.
- **§8 (durability-reduction cross-cutting question)** was produced **inline**.
  It is **duplicative** of the Durability Assumption Audit brief. When that
  brief lands, §8's "essential vs accidental" verdicts should be replaced by
  citations to the neutral classification. The recommendation depends only on
  the *qualitative* result (ingress/claim rows are accidental, journal/output
  are essential); a contradicting durability verdict on those four families
  would be the one finding that could shift the recommendation and must be
  re-checked before ratification.

This does not block PR 282. If either brief's findings materially contradict §4
or §8, the recommendation in §9 must be revisited before ratification rather
than treated as final.

## One-line recommendation

**Adopt Path X — a reactive `RuntimeContextWorkflow` body over the
already-shipped `DurableStreamsWorkflowEngine`, using content-derived
`DurableDeferred` for external input/permission/tool round-trips, reusing the
existing `durable-tools` wait-router/reconcile machinery for cross-host wake,
and keeping high-volume output on a per-context side-channel stream. This is
workflow-native with zero required upstream `@effect/workflow` contributions and
no new actor abstraction; it is structural simplification, not rearrangement.**

This research can and should continue in parallel with the Host SDK SDD lane. It
does **not** gate PR 282 (RuntimeToolUseExecutor seam) or the PR 2 package
cutover. It *does* gate two things: (1) the optional runtime
projection-helper cleanup (`RUNTIME_CAPABILITY_PROJECTIONS`) should be
**cancelled, not implemented**, because the recommended path deletes the
authorities it would polish; (2) the public Host/Client SDK ingress surface must
stay transport-shaped (a session method), never table-shaped — the SDD already
does this, so this is a reinforcement, not a blocker.

---

## 1. Problem statement: validated, with one refinement

The starting hypothesis (prompt §"problem statement"):

> Firegrid's runtime contexts are actor-shaped … the mismatch between the
> conceptual shape (one actor primitive) and the implementation shape (many
> layered primitives) is the source of the complexity.

**Accepted, with one load-bearing refinement.** The evidence supports
"actor-shaped" for *control* (single durable identity, long lifecycle, serial
reactive consumption of external inputs, crash-surviving history). But the
substrate conflates two shapes that the codebase already separates physically:

1. **Control plane** (input arrival, permission round-trip, tool round-trip, run
   lifecycle, terminal evidence) — low-frequency, must be exactly-once, must
   survive crashes, must be reactive. *This is the actor/workflow-shaped part.*
2. **Output plane** (codec token streaming, stderr/log lines) — high-frequency,
   append-only, observer-read, must **not** become workflow-journal entries.
   *This is log-shaped, not actor-shaped.*

The refinement matters because upstream `@effect/workflow` has **no
streaming-activity primitive**: `Activity` extends `Effect` with a single
`Success | Error` result journaled once as an `Exit`
(`repos/effect/packages/workflow/src/Activity.ts:36-66`, `:85-126`; result
persisted once at `engine-runtime.ts:234-240`). There is no `Stream`/emit API
anywhere in `Activity.ts`. Therefore the output plane cannot be expressed as a
workflow primitive **under any path**, including Path A. The migration sketch
already proposes a per-context side-channel output stream
(`MIGRATION_SKETCH…:117`, `:267`, `:320-324`); this spike upgrades that from
"nice idea" to **architectural invariant**. Constraint 7 is path-independent and
is not a discriminator between paths; it is a fixed requirement every path must
honor identically.

So the corrected problem statement is:

> The runtime context *control plane* is actor/workflow-shaped and is currently
> expressed through a bypassed workflow shell plus a hand-written
> authority/subscriber/durable-table layer that re-implements
> at-most-once delivery, deferred-style permission continuations, and
> tool-result round-trips that the already-built workflow engine can express
> natively. The *output plane* is log-shaped and must remain a side-channel
> stream regardless. The architectural move is to make the workflow body
> reactive over the control plane and delete the bypass layer; it is not to
> introduce a new actor primitive.

This refinement is decisive: it converts "actor primitive: where does it live?"
into "the actor primitive is the workflow engine you already shipped; the
question is whether to drive it reactively (delete the bypass) or keep the
bypass (status quo)."

---

## 2. The single most important finding (resolves the sketch's biggest unknowns)

The migration sketch flags three "showstopper-class" unknowns
(`MIGRATION_SKETCH…:303-371`): token derivation, single-shot deferred
idempotency, and codec-session activity boundary. Two of the three are **already
resolved by reading the source**:

### 2.1 `DurableDeferred` tokens are deterministically, externally derivable — no engine handle, no upstream change

`repos/effect/packages/workflow/src/DurableDeferred.ts:264-274`:

```ts
export class TokenParsed extends Schema.Class<TokenParsed>(
  "@effect/workflow/DurableDeferred/TokenParsed",
)({ workflowName: Schema.String, executionId: Schema.String, deferredName: Schema.String }) {
  get asToken(): Token {
    return Encoding.encodeBase64Url(
      JSON.stringify([this.workflowName, this.executionId, this.deferredName]),
    ) as Token
  }
```

`tokenFromExecutionId` (`DurableDeferred.ts:324-349`) and `tokenFromPayload`
(`:355-383`, derives `executionId` via `workflow.executionId(payload)`) are
**pure functions**. Any external caller that knows `(workflowName, contextId)`
can construct the token and call `DurableDeferred.done/succeed`
(`DurableDeferred.ts:389-491`) with no engine handle. The sketch's "Token
derivation needs verification … less clean but still works"
(`MIGRATION_SKETCH…:362`) is over-cautious: it is clean, it is shipped, it needs
no Firegrid wrapper and no upstream RFC. **This is the linchpin that makes
external input via deferred completion actually work and is the single fact that
most changes the decision.**

### 2.2 At-most-once is a free, built-in property (Constraint 3 for free)

First-writer-wins is enforced at the engine layer. Firegrid's `deferredDone`
inserts only when absent (`engine-runtime.ts:252-266`, guard
`Option.isNone(existingDeferred)` at `:256`); a second completion is a no-op.
Upstream memory engine has the identical guard
(`repos/effect/packages/workflow/src/WorkflowEngine.ts:620-621`); Cluster uses a
persisted reply keyed by name (`ClusterWorkflowEngine.ts:582-591`). With
**content-derived deferred names** (`input-{inputId}`, `permission-{id}`,
`tool-{toolUseId}` — sketch's preferred shape, `MIGRATION_SKETCH…:150-156`),
`RuntimeIngressDeliveryClaimAndComplete`
(`agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`, 108
LOC, claim lookup `:46`, upsert `:61`, completion `:74`) becomes redundant: the
deferred *is* the at-most-once primitive.

### 2.3 The engine is far more complete than the sketch's tone implies

`packages/runtime/src/workflow-engine/internal/engine-runtime.ts` (296 LOC)
implements the upstream `WorkflowEngine` `Encoded` interface
(`WorkflowEngine.ts:252-311`, wrapped via `makeUnsafe` at `engine-runtime.ts:134`):

| `Encoded` member | Firegrid impl | Status |
|---|---|---|
| `register` | `engine-runtime.ts:135-141` | FULL |
| `execute` | `:142-173` | FULL (single-node; durable via `table.executions`) |
| `poll` | `:174-182` | FULL |
| `interrupt` | `:183-191` | **PARTIAL** — flags row + `resume`; does not interrupt an in-flight fiber or fire an `InterruptSignal` |
| `resume` | `:92-132,192` | FULL (single-node; uses local `running` Map `:39`) |
| `activityExecute` | `:193-243` | FULL — durable memoization `table.activities` `:195` + worker-claim `table.activityClaims` `:204-221` |
| `deferredResult` | `:244-251` | FULL |
| `deferredDone` | `:252-266` | FULL, single-shot |
| `scheduleClock` | `:267-290` | **PARTIAL** — durable row + in-proc `Effect.delay`; crash-recovered via `recoverPendingClockWakeups` `:83-90` (so single-node-durable), but no distributed `DeliverAt` |

**7/9 FULL, 2/9 PARTIAL, 0 stubbed.** No `Effect.die`/notImplemented anywhere
(`orDieTable` at `:17-23` is an intentional table-error narrowing, not a stub).
The two partials are small (§4). The sketch's framing that the workflow engine
"exists but is bypassed for the substrate work it would naturally subsume"
(prompt §Context) is correct — and the engine is *ready enough* to subsume it.

### 2.4 The reactive-coordination primitive Path C wants to "build" already exists in `durable-tools`

`packages/runtime/src/durable-tools/internal/wait-for.ts` (421 LOC, `WaitFor.match`
races a `DurableDeferred` against a `DurableClock` timeout `:123,:152,:195`),
`wait-router.ts` (289 LOC, a `Layer.scopedDiscard` driver that observes rows and
resolves deferreds on match `:111`), and `reconcile.ts` (75 LOC, idempotent
`deferredDone` crash recovery) are a **working, tested, in-repo implementation of
exactly the "long-running reactive consumption + durable external invocation +
crash-recovery" pattern** Path C proposes to build new. ARCHITECTURE.md:179-188
documents this as the sanctioned pattern. This is the finding that produces Path
X and demotes Path C.

---

## 3. The constraint set: validated against the codebase

All 12 constraints hold. Annotations from evidence:

1. **Per-context durability** — holds; workflow journal (`table.executions`,
   `engine-runtime.ts:150-157`) is durable. Today *also* duplicated by
   `RuntimeRunAppendAndGet` (`authorities/runtime-control-plane-recorder.ts:89-142`).
2. **External input** — holds; today via `appendRuntimeIngress`
   (`host/commands.ts:114-173`). Mechanism may change to deferred completion.
3. **At-most-once** — holds; today `RuntimeIngressDeliveryClaimAndComplete`;
   natively a `DurableDeferred` property (§2.2).
4. **Cross-context queries** — holds; namespace registry
   `RuntimeControlPlaneTable.contexts` (`runtime-control-plane-recorder.ts:53`,
   read `:184`). **Refined:** this is namespace-scoped and is *not*
   actor-shaped; it stays as a registry/index under every path (agrees with PR
   281 control-plane gate).
5. **Tool execution durability** — holds; `activityExecute` is FULL with
   memoization + claim (`engine-runtime.ts:193-243`).
6. **Permission continuations across crashes** — *fails today* (documented
   bug). `codecs/acp/index.ts:256-266`:
   > // ACP requestPermission is a live protocol continuation, not durable
   > // permission state. If the ACP process/session dies after a
   > // PermissionRequest is journaled but before response delivery, the old
   > // promise cannot be resumed; replay must create a new live continuation.
   The live-promise loss is `codecs/acp/index.ts:294-314` (`return await
   response` at `:313`). `DurableDeferred` fixes this structurally.
7. **High-volume output** — **refined to invariant** (§1): no streaming
   activity exists upstream; output must be a per-context side-channel stream
   under every path. Not a discriminator.
8. **Multi-host topology** — holds today via the cross-host *direct write*
   command channel: `appendRuntimeIngress` resolves `RuntimeContext.host` and
   opens the **owner** host's ingress stream from any caller
   (`host/commands.ts:114-138`, `ownerIngressLayer` `:41-58`, owner prefix
   `:52`). Proven load-bearing by `test/host/prompt-routing.test.ts:120` ("host
   B appends … into host A ingress"), `:166`, `:217` and
   `test/host/two-host-isolation.test.ts:105,176`. **This is the constraint that
   most stresses Path A and is analyzed in depth in §5/§6/§8 and §11-Q1.**
9. **Plane-split compatibility** — holds; analyzed in §10.
10. **Test migration** — 18 runtime test files touch ingress/output/tool-router;
    the two load-bearing multi-writer files are named above. Migration story in
    §7 per path.
11. **Upstream coordination cost** — **near zero for the recommended path**
    (§2.1, §4). The sketch assumed this was a risk; it is not.
12. **No observability regression** — holds; analyzed per path (§5).

---

## 4. Workflow-engine gap accounting (shared across A and X; cited once)

Because A and X use the same engine, the gap accounting is shared.

| Gap | Evidence | Cost (single-node) | Cost (multi-worker parity) |
|---|---|---|---|
| `interrupt` does not interrupt an in-flight fiber / no `InterruptSignal` | `engine-runtime.ts:183-191`; cf. `ClusterWorkflowEngine.ts:395-425,273-292,647` | ~10–20 LOC (Fiber.interrupt local `running` fiber + ensure `resume` honors `interrupted`, partially present `:107`) | ~40–60 LOC (claim/signal table like existing `activityClaims`) |
| `scheduleClock` distributed delivery | `engine-runtime.ts:267-290`; recovery `:83-90`; cf. `ClusterWorkflowEngine.ts:611-645` | ~0 LOC (already single-node-durable: missed deadline fires at `Math.max(0, deadline-now)=0` on restart) | ~20–40 LOC (owner-claim column + poll, idempotency guard already at `:61-65`) |
| Cross-node fiber **wake** on `deferredDone` from another host | `deferredDone` → `resume(executionId)` (`:265`), `resume` only resumes a **local** fiber (`running` Map `:39`); no Cluster `sharding.reset`/`pollStorage` (`ClusterWorkflowEngine.ts:232-233`) | Covered by `makeUnsafe` suspended-retry **poll** loop (`WorkflowEngine.ts:391-401`) → latency-bounded, not push | Push wake: reuse `durable-tools` `wait-router` pattern (already shipped, §2.4) — ~0 new primitive, wiring only |

**Total to reach robust single-node workflow-native: ≈ 10–20 engine LOC.** No
upstream `@effect/workflow` contribution is required for A or X. (Streaming
activities — the one upstream extension the prompt asks about — is **avoided**
by the §1 invariant, not contributed.)

---

## 5. Per-path evaluation

### Path A — `@effect/workflow` as shipped

**5.1 End-state.** The migration sketch *is* Path A; its workflow-body sketch
(`MIGRATION_SKETCH…:42-107`) is the end-state. Concretely:

```ts
// packages/runtime/src/host/runtime-context-workflow.ts (rewritten body)
const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: { contextId: Schema.String },
  success: RuntimeExitEvidence, error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => contextId,
}).toLayer(Effect.fn(function* ({ contextId }) {
  const ctx = yield* Activity.make({ name: "ResolveContext", execute: readRuntimeContext(contextId) })
  const session = yield* Activity.make({ name: "OpenCodecSession", execute: openCodecSession(ctx) })
  yield* Activity.make({ name: "RecordRunStarted", execute: writeRunStarted(ctx) })
  let done = Option.none<RuntimeExitEvidence>()
  while (Option.isNone(done)) {
    const next = yield* Activity.make({ name: `CodecOutputBatch`, execute: pumpUntilSuspension(session) })
      .pipe(Activity.raceAll([
        DurableDeferred.await(InputDeferred(/* content-derived: input-{inputId} */)),
        DurableDeferred.await(PermissionDeferred(/* permission-{id} */)),
        DurableDeferred.await(ToolResultDeferred(/* tool-{toolUseId} */)),
      ]))
    yield* Match.value(next).pipe(
      Match.tag("Terminated", t => Effect.sync(() => { done = Option.some(t.exit) })),
      Match.tag("Input", i => deliverToCodec(session, i)),
      Match.tag("Permission", p => deliverToCodec(session, p)),
      Match.tag("ToolUse", u => Effect.gen(function* () {
        const r = yield* Activity.make({ name: `Tool-${u.id}`, execute: toolExecutor.execute(u) })
        yield* deliverToCodec(session, r)
      })),
      Match.exhaustive)
  }
  yield* Activity.make({ name: "RecordRunExited", execute: writeRunExited(ctx, done.value) })
  return Option.getOrThrow(done)
}))
```

Exported tags collapse from 11 (agent-event-pipeline, §6) toward ~4
(`AgentSession`, `SandboxProvider`, `RuntimeEnvResolverPolicy`,
`RuntimeToolUseExecutor`). External caller invokes:
`DurableDeferred.succeed(InputDeferred(inputId), { token: tokenFromPayload(RuntimeContextWorkflow, {contextId}, inputId), value })`.

**5.2 Deleted.** `runtime-output-journal.ts` (126, 7 tags),
`runtime-ingress-appender.ts` (109), `runtime-ingress-delivery-tracker.ts`
(108), `subscribers/ingress-delivery.ts` (119), `subscribers/tool-router.ts`
(121), `subscribers/stderr-journal.ts` (86), `sources/sandbox/local-process-stdin-delivery.ts`
(211), `session-runtime.ts` composition (227), `appendRuntimeIngress`+helpers in
`host/commands.ts` (~104). Plus `RuntimeRunAppendAndGet` slice of
`runtime-control-plane-recorder.ts` (~155). **≈ 1,000–1,175 LOC deleted; 11→~4
Tags; eliminates the triple provision of `RuntimeControlPlaneRecorderLive`
(`layers.ts:45,205`, `runtime-substrate.ts:45`).**

**5.3 Built.** Reactive workflow body (~180–250, replaces `session-runtime.ts`
227); per-context output-stream activity + observers (~100–150); content-derived
deferred wiring for input/permission/tool (~150); engine `interrupt` hardening
(~10–20). **≈ 450–600 LOC built. Net ≈ −500 to −700 LOC**, with a much larger
*structural* reduction (no authority/subscriber/duplicate-layer mental model).

**5.4 Engine features required/missing.** Uses `register`, `execute`, `resume`,
`activityExecute`, `deferredResult`, `deferredDone` (all FULL). Needs `interrupt`
hardening (~10–20 LOC, §4). Cross-host wake is **poll-based** via the
`makeUnsafe` suspended-retry loop (`WorkflowEngine.ts:391-401`) — *works* but
adds input→delivery latency bounded by the retry schedule. This is Path A's one
honest weakness vs. today's push (direct owner-stream write).

**5.5 Constraints.** 1 ✓ (journal). 2 ✓ (deferred succeed, token §2.1). 3 ✓
free (§2.2). 4 ✓ (registry stays). 5 ✓ (`activityExecute`). 6 ✓✓ (strongest
win — deletes the live-promise map `acp/index.ts:263-266`). 7 — invariant
(side-channel). 8 ⚠ poll-latency cross-host wake (§4 row 3). 9 ✓ (smaller
surface, §10). 10 — see §7. 11 ✓ near-zero upstream. 12 ✓ (poll loses no
queryability; output stream is directly observable).
*Durability reduction:* delete ingress rows, delivery-claim rows, output-journal
rows-as-authority, run rows-as-authority. Essential durability that remains:
workflow journal, deferred rows, per-context output stream, namespace registry.

**5.6 Migration cost.** Sketch's 6-PR sequence (`MIGRATION_SKETCH…:340-356`),
each independently reversible. **≈ 6–10 engineering-weeks.** Test rewrite:
18 files; the two multi-writer files (`prompt-routing`,
`two-host-isolation`) must prove deferred completion replaces owner-stream
write *and preserves cross-host semantics* — the highest-risk test migration.

**5.7 Risk.** Technical: cross-host wake latency (poll) may be unacceptable for
interactive prompts → mitigated by Path X. Codec-session activity boundary
(`MIGRATION_SKETCH…:303-318,358-360`) is the genuine unresolved design (Open
Q-2). Organizational: none — no upstream dependency. Reversibility: high (6 PRs,
side-by-side soak).

**5.8 12-month shape.** Adding a feature = add an `Activity` or a
`DurableDeferred` in one reactive body. A new contributor reads one workflow
function instead of authorities + subscribers + composition + duplicate layers.

**5.9 Framing answer.** **Structural simplification.** The complexity is reduced
because the workflow engine natively expresses the control-plane shape; the
deletions are not moved elsewhere (they vanish — at-most-once becomes a deferred
property, not a tracker table). The one rearrangement is output→side-channel,
which is forced and small.

---

### Path C — Firegrid actor primitive alongside `@effect/workflow`

**5.1 End-state.** Two substrate concepts: workflows for orchestration; a new
`RuntimeActor` primitive (mailbox + durable identity + reactive loop) on Durable
Streams for context lifecycle. New files: `runtime-actor/Actor.ts`,
`Mailbox.ts`, `actor-engine.ts`, plus tags `RuntimeActor`, `RuntimeActorMailbox`.

**5.2 Deleted.** Same authority/subscriber deletions as A (~1,000 LOC) —
*if* the actor primitive subsumes them.

**5.3 Built.** Everything A builds **plus** the actor primitive. Critically, the
actor's durable-mailbox + reactive-consume + crash-reconcile semantics are
**already implemented** in `durable-tools/internal/{wait-for,wait-router,reconcile}.ts`
(421+289+75 = 785 LOC, §2.4). Path C either (a) rebuilds this (~600–900 new LOC,
duplicate of shipped code) or (b) generalizes durable-tools into an actor
package (~300–500 LOC of new abstraction + a new public concept). Either way it
**adds a primitive the codebase already has in a different name.**

**5.4 Engine features.** Same as A for the workflow half; the actor half
*reimplements* `deferredDone`/`deferredResult`/clock semantics outside the
engine — duplicating `engine-runtime.ts:244-290` logic in a parallel store.

**5.5 Constraints.** Same satisfaction profile as A. Constraint 8 can be
push-based (the actor owns its mailbox) — C's one genuine advantage over
vanilla A. But X captures that advantage without the new primitive.

**5.6 Migration cost.** A's cost **+ 3–5 weeks** for the new primitive, its
tests, and the conceptual migration. **≈ 9–15 engineering-weeks.**

**5.7 Risk.** Organizational/conceptual: introduces a *second* durable-execution
mental model (workflows *and* actors) that contributors must learn and keep
consistent — directly contradicts SDD Non-Goals "No Firegrid-specific workflow
DSL or operator framework" / "No brand-typed runtime capability framework"
(`SDD_FIREGRID_HOST_SDK.md:524-526`). Reversibility: lower (a new public
primitive is sticky).

**5.8 12-month shape.** Two primitives to maintain; "is this a workflow or an
actor?" becomes a recurring design argument.

**5.9 Framing answer.** **Rearrangement, not simplification.** The complexity is
moved into a new Firegrid layer that re-expresses what the engine +
durable-tools already do. Worse than the status quo on the "new abstraction,
new mental model" axis the prompt explicitly warns against.

---

### Path E — status quo + targeted cleanup (PR 281 Model C Hybrid)

**5.1 End-state.** Substrate stays. Delete derived-view tags, inline
projections, fix the triple `RuntimeControlPlaneRecorderLive` provision
(`layers.ts:45,205`, `runtime-substrate.ts:45`), optionally add projection
helpers (`SDD_FIREGRID_HOST_SDK.md:321-392`). `appendRuntimeIngress` cross-host
direct write **stays**. The bypassed workflow shell stays
(`runtime-context-workflow.ts:134-152` wrapping one big activity at `:140`).

**5.2 Deleted.** ~150–300 LOC of tag/layer repetition. The
authority/subscriber/bypass *structure* stays.

**5.3 Built.** ~100 LOC of projection helpers (if taken).

**5.4 Engine features.** None changed; engine stays bypassed.

**5.5 Constraints.** 6 (permission) **stays broken** — the live-promise bug
(`acp/index.ts:294-314`) is untouched; this is the decisive failure. 3 stays a
hand-written tracker. 8 stays direct-write (PR 281 correctly notes pure Model B
is invalid until ingress is inverted — Path E performs no inversion). Others
unchanged.

**5.6 Migration cost.** ≈ **1–2 engineering-weeks.** Lowest cost, lowest value.

**5.7 Risk.** Technical: leaves the documented permission crash bug in place;
leaves the cross-host command channel as an undeclared direct-table-write
(PR 281's central concern). Reversibility: trivially reversible (and trivially
re-needed).

**5.8 12-month shape.** Same substrate, slightly less noise; the next cleanup
attempt lands here again (matches the prompt's "prior cleanup attempts treated
symptoms").

**5.9 Framing answer.** Neither — it is *noise reduction without structural
change*. PR 281 reached the same verdict from the output-path angle: Model A
local cleanup "would make the wrong primitive look neater"
(`output-path-substrate-spike-2026-05-16.md` §"Model A").

---

### Path X — Reactive workflow body over the shipped engine + reused `durable-tools` coordination (RECOMMENDED)

**Distinct from A:** Path A drives the reactive body with raw single-shot
`DurableDeferred` and accepts poll-based cross-host wake (§5.4-A weakness). Path
X uses the **already-shipped** `durable-tools` `wait-router` (a
`Layer.scopedDiscard` driver that observes rows and resolves deferreds on match,
`wait-router.ts:111`) + `reconcile.ts` idempotent crash recovery as the
**push-based wake + recovery mechanism** for the workflow body's
input/permission/tool deferreds. **Distinct from C:** it introduces **no new
primitive** — it reuses one the runtime already ships and tests
(`test/durable-tools/WaitFor.test.ts`).

**5.1 End-state.** Identical workflow body to §5.1-A, but the deferred
completion path for *external* input/permission is the existing
`WaitFor`/`wait-router` shape rather than a bespoke succeed call: the workflow
body uses `WaitFor.match`-style awaits (already DurableDeferred+DurableClock
native, `wait-for.ts:123,152,195`), and the host runs the existing wait-router
driver scoped to the namespace so a `deferredDone` written by host B is observed
and resolved against host A's blocked workflow **by the same driver that already
does this for `wait_for` today** (`ARCHITECTURE.md:179-188`). New public concept
count: **zero**. New tag count: **zero** (reuses `RuntimeWaitStreams`/router).

```ts
// host/runtime-substrate.ts — the ONLY new wiring: the existing wait-router,
// scoped to runtime-context deferreds (it already exists for wait_for)
const RuntimeContextReactiveLive = WaitRouterLive            // shipped, durable-tools
  .pipe(Layer.provideMerge(DurableStreamsWorkflowEngineLive)) // shipped engine
  .pipe(Layer.provideMerge(PerContextOutputStreamLive))       // §1 invariant, ~120 LOC
// deletions identical to Path A §5.2
```

**5.2 Deleted.** Same as A: **≈ 1,000–1,175 LOC**, 11→~4 tags, triple-provision
removed.

**5.3 Built.** Reactive workflow body (~180–250); per-context output stream
(~100–150); wiring the existing wait-router for runtime-context deferreds
(~40–80, *no new primitive*); engine `interrupt` hardening (~10–20). **≈
350–500 LOC built. Net ≈ −550 to −800 LOC** — the *largest* net deletion of any
path *and* the smallest new-concept footprint.

**5.4 Engine features.** Same FULL members as A. Cross-host wake is **push** (the
wait-router observes the deferred row stream and calls `resume` locally on the
owner — exactly its current `wait_for` behavior, `wait-router.ts:111`),
eliminating A's poll-latency weakness. `reconcile.ts` (75 LOC, shipped) already
provides the crash-recovery `deferredDone` idempotency for this pattern.

**5.5 Constraints.** Same as A for 1–7,9–12 (all ✓; 6 is the ✓✓ permission
fix). **Constraint 8 ✓ without the poll caveat** — push wake via the shipped
router; this is the reason X is preferred over A. PR 281's required "invert
external ingress through a command stream or host RPC before Model B is valid"
(`output-path-substrate-spike-2026-05-16.md` §"Model B", §"Sequencing") is
**satisfied**: `DurableDeferred.succeed` is content-addressed and
engine/router-routed, not an owner-table write — the caller never opens the
owner's stream. X *is* the inversion PR 281 said was the prerequisite.
*Durability reduction:* same as A — ingress rows, delivery-claim rows,
output-as-authority, run-as-authority all become non-durable or
deferred-native. Plus X reuses the *existing* durable wait rows
(`DurableToolsTable.waits/completions`, `durable-wait-store.ts:53,58`) rather
than inventing a parallel store (C's hidden cost).

**5.6 Migration cost.** Same 6-PR sequence as A; **−1 to −2 weeks vs A** because
the cross-host wake mechanism is not designed/built (it is wired). **≈ 5–8
engineering-weeks.**

**5.7 Risk.** Technical: the wait-router's current scope is `wait_for`; widening
it to runtime-context input deferreds must be load-tested for fan-out (Open
Q-3). Codec-session activity boundary is the same genuine unknown as A (Open
Q-2). Organizational: none. Reversibility: high — same 6-PR soak; and because X
adds *no new abstraction*, backing out is deleting wiring, not a primitive.

**5.8 12-month shape.** One execution model (workflows), one coordination driver
(wait-router) used for both `wait_for` and runtime-context input. A contributor
learns *one* pattern that already exists. Fewer concepts than today.

**5.9 Framing answer.** **Structural simplification, maximally.** Complexity is
not moved anywhere: at-most-once becomes a deferred property; reactive
consumption becomes the workflow body; cross-host wake reuses a shipped driver;
the only rearrangement (output→side-channel) is the forced §1 invariant. X
removes the most code while adding the fewest concepts.

---

## 6. Cross-path comparison

|  | Path A | Path C | Path E | **Path X** |
|---|---|---|---|---|
| End-state simplicity | High (1 reactive body; poll wake) | Medium (2 primitives) | Low (structure unchanged) | **Highest (1 body, reused driver, push wake)** |
| Lines deleted | ~1,000–1,175 | ~1,000 (if subsumed) | ~150–300 | **~1,000–1,175** |
| Lines built | ~450–600 | ~A + 300–900 | ~100 | **~350–500** |
| Net LOC | −500…−700 | ≈ flat to +200 | −50…−200 | **−550…−800** |
| Engine gaps to close | interrupt ~10–20 LOC | interrupt + parallel store | none | **interrupt ~10–20 LOC** |
| Upstream cost | ~0 | ~0 | 0 | **0** |
| New public concepts | 0 | **1 (actor)** | 0 | **0** |
| Engineering weeks | 6–10 | 9–15 | 1–2 | **5–8** |
| Risk profile | Low; poll latency | Medium; sticky new primitive | Low value, perm bug stays | **Low; reuses tested driver** |
| Reversibility | High (6 PR soak) | Lower (primitive sticky) | Trivial | **High (wiring, no primitive)** |
| 12-mo maintenance | One body + poll | Two models | Same as today | **One body + one shipped driver** |
| Durability challenged | ingress/claim/output/run rows | same | minimal | **same as A + reuses wait store** |
| Constraint 6 (perm bug) | Fixed ✓✓ | Fixed ✓✓ | **Not fixed ✗** | **Fixed ✓✓** |
| Constraint 8 (multi-host) | poll-latency ⚠ | push ✓ | direct-write (uninverted) | **push ✓** |

---

## 7. Test migration (recommended path)

18 runtime test files touch ingress/output/tool-router. Strategy mirrors the
sketch's side-by-side PRs:

- **`test/host/prompt-routing.test.ts:120,166,217`** — rewrite "host B appends
  into host A ingress" as "host B `DurableDeferred.succeed`(content token);
  host A's wait-router resolves it; host A workflow body delivers it." The
  *assertion* (host A sees the input, host B's stream stays empty) is
  preserved; only the mechanism changes. This is the load-bearing migration and
  the gate for PR 2 of the sequence.
- **`test/host/two-host-isolation.test.ts:105,176`** — workflow-stream
  isolation already true (each host runs its own engine over its host-owned
  workflow stream, `layers.ts:166`); `requireLocalContext` gate
  (`runtime-context-helpers.ts:57`) is unchanged. Low-risk.
- `authorities/runtime-ingress-authorities.test.ts`,
  `subscribers/tool-router.test.ts`, `sources/sandbox/local-process-stdin-delivery.test.ts`
  — deleted with their subjects; behavior re-asserted at the workflow-body
  level.
- `durable-tools/WaitFor.test.ts` — **unchanged** (X reuses this exact
  machinery; its green status is evidence the reused driver works).

---

## 8. The durability-reduction cross-cutting question

Applied to the recommended path: of the four "everything is independently
durable" assumptions —

- **Ingress rows** — *accidental.* Replaced by content-derived deferred
  completion; the deferred row is the durable artifact, the ingress table
  vanishes.
- **Delivery-claim rows** — *accidental.* At-most-once is the deferred's
  first-writer-wins property (§2.2); the tracker (108 LOC) vanishes.
- **Output-journal-as-authority** — *partly accidental.* Output must be durable
  (observers, resume context) but not as a *workflow-journal authority with 7
  tags*; it becomes one per-context append-only stream.
- **Run lifecycle rows** — *mostly accidental for durability, essential for
  queryability.* The workflow journal already knows if a run happened
  (`poll`); `RuntimeRuns` survives only as an optional **index** for
  cross-context UI listing (PR 281 agrees: "RuntimeRuns may become an
  index/projection").

Reducing these is *why* X is the largest net deletion. The only durability that
is **essential**: the workflow journal, deferred rows, the per-context output
stream, and the namespace registry/index.

---

## 9. Recommendation

### 9.1 The chosen path and why — Path X

The actor primitive the problem statement asks us to "commit to" is not missing
and does not need to be built or imported: it is the
`DurableStreamsWorkflowEngine` (7/9 FULL) plus the `durable-tools` wait-router
(a shipped, tested reactive-deferred driver). The complexity is real but it is
*the bypass*: a hand-written authority/subscriber/duplicate-layer tier
(~1,000–1,175 LOC, 11 tags, triple-provided recorder) that re-implements
at-most-once delivery, deferred-style permission continuations, and tool-result
round-trips the engine expresses natively. Path X deletes that tier, makes the
workflow body reactive, and reuses the existing router for cross-host wake — the
largest net code deletion (−550 to −800 LOC) with **zero new public concepts and
zero required upstream contributions**. It fixes the documented permission
crash bug (Constraint 6, the one Path E cannot fix) and satisfies the
multi-host constraint with push (not poll) wake.

It beats Path A because A's only structural weakness — poll-latency cross-host
wake — is removed by reusing machinery that already exists, at *lower* migration
cost. It beats Path C because C re-expresses, under a new "actor" name, exactly
what the engine + durable-tools already do, violating the SDD's explicit
no-new-framework non-goals and adding a permanent second mental model. It beats
Path E because E leaves the wrong primitive in place and the permission bug
unfixed, which PR 281 independently concluded ("would make the wrong primitive
look neater").

Path X is also the concrete realization of PR 281's own sequencing requirement:
PR 281 (Model C Hybrid) said Model B is invalid "until external ingress is
inverted through a command stream or host RPC." Content-addressed
`DurableDeferred` completion *is* that inversion — the caller never opens the
owner's stream. X and PR 281 do not conflict; X is the inversion PR 281 deferred
to "a structural SDD," now shown to need no new primitive.

### 9.2 Strongest counterargument and response

**Counterargument:** "The codec-session activity boundary
(`MIGRATION_SKETCH…:303-318`) is genuinely unresolved. A long-running ACP
session that must survive workflow replay, while activities are single-shot
`Exit`-journaled units, is the real architectural risk — and it is identical
across A and X, so 'X reuses shipped machinery' does not de-risk the hardest
part."

**Response:** True and acknowledged (Open Q-2, non-deferrable). But this risk is
*present today in a worse form*: today the live ACP permission promise is
explicitly documented as crash-lossy (`acp/index.ts:256-266`). Every non-E path
must solve the session-survival question; X solves it with the **pragmatic
"one long-running CodecSessionAlive activity + supervisor"** shape the sketch
itself lands on (`MIGRATION_SKETCH…:315-338`), which is the standard Temporal
long-running-resource pattern and is *no harder* under X than A. The counter
argues against doing nothing, not against X specifically; it sets the scope of
the path-specific feasibility SDD, it does not change the architectural choice.

### 9.3 Fallback if the path goes wrong

If, ~3 months in, the codec-session activity boundary proves intractable (e.g.,
ACP cannot tolerate the supervisor/replay model and a live in-process session is
unavoidable), **retreat to Path A's "suspend pattern"**
(`MIGRATION_SKETCH…:201-205`) — keep the reactive workflow body and
content-derived deferreds for input/permission/tool/run (which fix Constraint 6
and delete the ingress/claim tier regardless), but keep the codec session
itself in a thin host-scoped live process driven by the workflow body via
in-memory channels (close to today's `session-runtime.ts` shape, minus the
durable authority tier). This preserves ~70% of the deletion and the permission
fix while conceding the full-replay codec ambition. The ultimate retreat is
Path E (1–2 weeks, reversible) — but E does not fix the permission bug, so it is
a true fallback only if the whole workflow-native thesis is rejected.

### 9.4 First three concrete next steps

1. **Resolve token routing end-to-end with a throwaway proof, not an SDD:** in a
   scratch test (not committed to runtime), call
   `DurableDeferred.succeed(tokenFromPayload(RuntimeContextWorkflow,
   {contextId}, inputId), value)` from a *second* host process against a
   workflow blocked on `DurableDeferred.await` on host A, with the existing
   `WaitRouterLive` scoped to the namespace, and measure wake latency. This
   directly validates Constraint 8 push-wake (Open Q-3) and the §2.1 token
   claim under multi-host — the single highest-leverage unknown.
2. **Rewrite the codec session contract to remove the in-process permission
   promise map:** replace `livePermissionContinuations`
   (`acp/index.ts:263-266,294-314`) with
   `DurableDeferred.make('permission-{id}')` + await. This is independently
   shippable, fixes the documented Constraint 6 bug now, and de-risks the
   codec-session boundary question (Open Q-2) by forcing the durable-permission
   shape before the full body rewrite.
3. **Spike the codec-session activity boundary** as the
   "one long-running `CodecSessionAlive` activity + external sandbox supervisor"
   shape against the local-process codec first (simplest), measuring replay
   behavior — this is the load-bearing feasibility question and gates the
   path-specific implementation SDD.

(Note: step 2 is also valuable under Path E, so it is safe to start immediately
regardless of when the architecture choice is ratified.)

---

## 10. Host SDK / plane-split reconciliation (gating analysis)

**Can this research run in parallel with the Host SDK SDD lane? Yes.**

- **PR 282 (RuntimeToolUseExecutor seam) is not gated and must not be blocked.**
  Under every path the tool round-trip becomes a workflow `Activity`
  (`MIGRATION_SKETCH…:226-239`); the narrow `RuntimeToolUseExecutor` capability
  (`SDD_FIREGRID_HOST_SDK.md:262-319`,
  `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1-3`) is the *correct* seam under that
  shape — it is exactly the injection point the reactive body calls. PR 281
  reached the same conclusion. **Confirmed: no blocker.**
- **PR 2 (transactional package cutover) is not gated.** The SDD explicitly
  states "Durable row contracts do not migrate for this package split"
  (`SDD_FIREGRID_HOST_SDK.md:63`) and is file-movement + boundary enforcement.
  The substrate decision is orthogonal to package boundaries.

**Two findings that the SDK lane should act on:**

1. **The optional `RUNTIME_CAPABILITY_PROJECTIONS` cleanup should be cancelled,
   not implemented.** `SDD_FIREGRID_HOST_SDK.md:321-392` and
   `firegrid-host-sdk.RUNTIME_CAPABILITY_PROJECTIONS.1-4` propose
   `projectAppend/projectStream/projectSink` helpers applied to "runtime
   output, ingress, ingress delivery, and control-plane authority files"
   (`SDD…:481-483`). The recommended path **deletes** those exact files
   (`runtime-output-journal.ts`, `runtime-ingress-appender.ts`,
   `runtime-ingress-delivery-tracker.ts`, and the `RuntimeRunAppendAndGet`
   slice). Polishing code that is slated for deletion is waste. The SDD already
   marks this work optional and non-blocking (`SEQUENCING.12`); this spike
   recommends explicitly **not starting it** and noting in the SDD that the
   substrate spike supersedes it.
2. **The public ingress surface must stay transport-shaped — the SDD already
   does this; keep it that way.** `firegrid-host-sdk.PACKAGE_BOUNDARIES.1`,
   `RUNTIME_SESSION_SURFACE.2`, and `AGENT_TOOL_BOUNDARY.4` already keep the
   client/host surface as session methods, not table append. The recommended
   path *changes the transport underneath* (`appendRuntimeIngress` →
   `DurableDeferred.succeed`) while keeping the same public method. **The SDD is
   publishing the correct public substrate surface.** The only concrete
   reinforcement: do not let any host-sdk example or test freeze
   `RuntimeIngressTable`/owner-stream construction as the app-facing primitive
   (PR 281 raised the same caution; agreement is unanimous).

**The Host SDK SDD is not publishing the wrong public substrate surface.** It is
correct at the public boundary and explicitly defers durable-row shape. The only
correction is internal: stop the projection-helper cleanup of soon-deleted
authorities.

**What gates deeper SDK/package cutover:** nothing in this research gates PR 282
or PR 2. The substrate decision gates only (a) the now-cancelled projection
cleanup and (b) any *future* SDD that would specify the durable ingress
contract — that future SDD should be the path-specific feasibility SDD this
spike's §9.4 next steps lead to, not the package-split SDD.

---

## 11. Open questions

**Q-1. Cross-host push-wake latency and fan-out of the reused wait-router.**
The wait-router today is scoped to `wait_for` rows; widening it to
runtime-context input/permission deferreds across a busy namespace is unproven
at scale. *Resolve by:* §9.4 step 1 (multi-host scratch proof + latency
measurement) and a fan-out load test (N concurrent contexts, observed deferred
resolution latency). *Blocks committing?* **No** for the architecture choice
(the mechanism is shipped and tested for `wait_for`); **yes** for the
path-specific implementation SDD (must size the router before PR 2 of the
sequence). Honest statement: I recommend Path X without having load-tested the
wait-router at runtime-context fan-out — but X degrades gracefully to Path A's
poll wake if the push path proves too costly, so the unknown bounds
performance, not feasibility.

**Q-2. Codec-session activity boundary across replay.** Whether a long-running
ACP session can live as one `CodecSessionAlive` activity + external supervisor,
or whether replay forces session re-open. *Resolve by:* §9.4 step 3 spike
(local-process first, then ACP). *Blocks committing?* **No** for the
architecture choice (identical across A/C/X; today's state is strictly worse);
**yes** for the implementation SDD. This is the genuine load-bearing unknown
and is stated as such rather than papered over.

**Q-3. Per-context output stream cost at scale.** 10k concurrent contexts =
10k streams (`MIGRATION_SKETCH…:364`). *Resolve by:* Durable Streams load test
before PR 4 of the sequence. *Blocks committing?* **No** — this is a §1
invariant common to *every* non-E path; it does not discriminate between A/C/X
and so cannot change the recommendation. It blocks the output-stream PR, not
the architecture.

**Q-4. Run-lifecycle listing placement.** Whether `RuntimeRuns` survives as a
namespace index or is fully absorbed into the workflow journal + poll
(PR 281 also flags this). *Resolve by:* enumerate UI/dashboard/wait consumers of
`RuntimeRuns` (`runtime-control-plane-recorder.ts:220`,
`RuntimeWaitStreams`). *Blocks committing?* **No** — both outcomes are
compatible with X (§8 treats `RuntimeRuns` as an optional index); deferrable to
the implementation SDD.

No open question that *should* have blocked the recommendation was left
unresolved. Q-2 is the one that could invalidate the *full-replay codec
ambition*; §9.3 gives the explicit retreat (Path A suspend pattern) that
preserves the recommendation's core value (permission fix + bypass deletion)
even if Q-2 resolves badly. The recommendation stands on that basis, not on
assuming Q-2 resolves well.

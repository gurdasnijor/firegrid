# tf-ogoj Runtime org/body-shape SDD review

- **Date:** 2026-06-02
- **Reviewer:** Codex, tf-o8zu
- **Subject:** PR #855 draft SDD, `docs/sdds/SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md`
- **Verdict:** **AMEND**

## Bottom Line

The SDD is strong enough to go forward after amendment, but a few central claims
are currently too crisp for the captured source evidence.

The `signal.ts` -> `DurableDeferred` verdict is **mostly source-sound**: `awaitSignal`
and no-arm `sendSignal` are materially equivalent to await-once durable completion
and external resolve; `armSession` is a genuine thin helper because `resume` does
not create a missing execution; and `DurableQueue` is not the per-key RuntimeContext
serialization primitive.

The unsafe parts are: exact keying is overstated, deferred recovery is overclaimed,
and "Workflow.idempotencyKey + cursor" is presented as the C1 serialization source
even though it only gives deterministic execution identity plus state, not an
atomic per-key append/owner.

FS enforcement is **mechanizable in parts**. D.1 import-direction rules are
straightforward dep-cruiser extensions. D.2 is plausible with custom ts-morph or
ESLint rules, but not already expressed by the existing checks and not something
the Effect language service currently enforces as a custom topology rule.

## Findings

### 1. `DurableDeferred` equivalence is source-sound directionally, but not exact keying

**Tier: source-verified.** `signal.ts` stores signals under primary key
`${executionId}|${name}` (`packages/runtime/src/unified/signal.ts:54`,
`signal.ts:83`) and `awaitSignal` gets the current workflow instance, point-reads
that key, then suspends if no row exists (`signal.ts:229`, `signal.ts:234`,
`signal.ts:236`, `signal.ts:238`, `signal.ts:243`).

**Tier: source-verified.** `DurableDeferred.await` asks the engine for
`deferredResult`, suspends if unresolved, and otherwise returns the stored exit
(`repos/effect/packages/workflow/src/DurableDeferred.ts:102`,
`DurableDeferred.ts:112`, `DurableDeferred.ts:115`, `DurableDeferred.ts:118`,
`DurableDeferred.ts:121`). Its token format is
`(workflowName, executionId, deferredName)` (`DurableDeferred.ts:264`,
`DurableDeferred.ts:272`, `DurableDeferred.ts:285`), and Firegrid's engine stores
deferred rows under `${executionId}/${deferredName}`
(`packages/runtime/src/engine/internal/engine-runtime.ts:433`,
`engine-runtime.ts:436`, `engine-runtime.ts:473`; row schema at
`packages/runtime/src/engine/internal/table.ts:53`).

**Tier: inference.** The SDD's "`awaitSignal` ≈ `DurableDeferred.await`" verdict
is right at the primitive level, but line 247 says both are keyed by
`(executionId, name)` "≈" token `(workflowName, executionId, deferredName)`. That
should stay explicitly approximate, not read as exact same keying. `workflowName`
is present in the `DurableDeferred` token and row but absent from `signalKey`.

**Punch-list:**
- Amend SDD line 247 to say the keying is semantically equivalent for one workflow
  execution namespace, but not identical; `DurableDeferred` carries `workflowName`.
- Keep the reinvention verdict, but avoid saying "same keying" in prose or review
  summary.

### 2. The thin-arm hinge is sound: `DurableDeferred` does not create a missing execution

**Tier: source-verified.** No-arm `sendSignal` writes the row and calls
`workflow.resume(executionId)` (`signal.ts:193`, `signal.ts:198`,
`signal.ts:202`). `DurableDeferred.succeed` delegates to `done`, which calls
`engine.deferredDone` (`DurableDeferred.ts:431`, `DurableDeferred.ts:454`,
`DurableDeferred.ts:389`, `DurableDeferred.ts:416`, `DurableDeferred.ts:418`).
Firegrid's `deferredDone` writes a deferred row if missing and then resumes the
execution (`engine-runtime.ts:458`, `engine-runtime.ts:473`,
`engine-runtime.ts:476`, `engine-runtime.ts:484`).

**Tier: source-verified.** `armSession` checks the execution table; it returns if
there is a final result, executes with `{ discard: true }` if missing, otherwise
resumes (`signal.ts:140`, `signal.ts:147`, `signal.ts:150`, `signal.ts:151`,
`signal.ts:152`, `signal.ts:155`). Firegrid `resume` no-ops when the execution row
is absent or already final (`engine-runtime.ts:182`, `engine-runtime.ts:184`,
`engine-runtime.ts:185`).

**Tier: inference.** The SDD is correct that input-before-start needs a create-or-
resume arm. `DurableDeferred.done` can pre-store a deferred row if a token is known,
but it cannot start the workflow body; its trailing `resume` will no-op against a
missing execution. That supports keeping a small arm helper.

**Punch-list:**
- No conceptual change needed for SDD lines 254-260. Keep this as source-verified.
- Consider clarifying that `DurableDeferred` can persist a completion before the
  waiter exists, but it still does not arm/create the workflow body.

### 3. Deferred recovery is overclaimed

**Tier: source-verified.** Firegrid's engine persists deferred results
(`engine-runtime.ts:473`, `engine-runtime.ts:476`) and `deferredResult` reads them
when a workflow body resumes (`engine-runtime.ts:433`, `engine-runtime.ts:436`,
`engine-runtime.ts:440`). Startup recovery in `makeWorkflowEngine`, however, only
runs `recoverPendingClockWakeups` (`engine-runtime.ts:149`, `engine-runtime.ts:527`).
I found no startup sweep that resumes workflows with already-written non-clock
deferred rows.

**Tier: source-verified.** Clock wakeups are special: pending clock rows are
scheduled on startup (`engine-runtime.ts:149`), and firing a clock calls
`engine.deferredDone` (`engine-runtime.ts:100`, `engine-runtime.ts:110`). That is
not evidence that arbitrary externally resolved deferred rows have resume-on-recovery.

**Tier: inference.** SDD line 269 says that if awaits move to `DurableDeferred`,
"the engine's own deferred persistence + resume-on-recovery covers it." Persistence
is source-verified; resume-on-recovery for non-clock deferred rows is not. If a
producer crashes after writing the deferred row but before the trailing resume, the
current source evidence does not show an engine-owned recovery path. A later retry
of `deferredDone` would resume, but that is producer retry, not engine recovery.

**Punch-list:**
- Amend SDD lines 267-271 to distinguish "deferred result persistence" from
  "resume-on-recovery." Do not claim generic deferred resume recovery unless a
  source line or test proves it.
- Add "non-clock DurableDeferred crash-between-row-and-resume recovery" to the
  confirm-before-building list near SDD lines 481-488.

### 4. `DurableQueue` is correctly rejected, but `Workflow.idempotencyKey + cursor` is not a serialization primitive

**Tier: source-verified.** `DurableQueue.process` offers a queued item and awaits a
per-item `DurableDeferred` (`repos/effect/packages/workflow/src/DurableQueue.ts:151`,
`DurableQueue.ts:181`, `DurableQueue.ts:198`, `DurableQueue.ts:217`). The worker
drains queue items with configurable concurrency (`DurableQueue.ts:228`,
`DurableQueue.ts:262`, `DurableQueue.ts:264`, `DurableQueue.ts:302`). Nothing in
that source provides per-`contextId` ordered serialization; it is a work queue plus
worker pool.

**Tier: source-verified.** `Workflow.idempotencyKey` is used to compute a deterministic
execution id (`repos/effect/packages/workflow/src/Workflow.ts:263`,
`Workflow.ts:272`, `Workflow.ts:281`, `Workflow.ts:305`, `Workflow.ts:307`). It
dedupes a workflow execution for the selected idempotency key; it does not, by
itself, serialize all mutations for a broader key such as `contextId`.

**Tier: inference.** The SDD is right that `DurableQueue` is not the target
RuntimeContext per-key mailbox. But SDD lines 276-278 overclaim the replacement:
"C1 ... comes from `Workflow.idempotencyKey` + the keyed cursor." A cursor can
observe/record consume position, and idempotency can dedupe a chosen execution key,
but neither source line proves atomic per-key append ordering under racing inputs.
That exact gap is already acknowledged in SDD lines 152-155, so §2 should not
promote the unproven part back to a fact.

**Punch-list:**
- Amend SDD lines 276-278 to say per-key serialization still needs an explicit
  owner/atomic append discipline; `Workflow.idempotencyKey + cursor` is the
  execution/state shape, not the serialization guarantee.
- Cross-reference the existing caveat at SDD lines 152-155 and the confirm item at
  lines 481-485.

### 5. FS enforcement is partly mechanical, partly aspirational

**Tier: source-verified.** Existing dep-cruiser rules are path-graph import rules
over runtime tiers (`.dependency-cruiser.cjs:100`, `.dependency-cruiser.cjs:115`,
`.dependency-cruiser.cjs:153`, `.dependency-cruiser.cjs:223`). Extending that
style to `runtime-context/**` and `agent-session/**` is mechanically credible.

**Tier: source-verified.** Existing symbol/type-ish checks are currently regex
ESLint rules over old folder paths, not exported type-surface checks:
`Workflow.suspend`, `WorkflowEngine.WorkflowEngine`, and
`WorkflowEngine.WorkflowInstance` are banned under old Shape-C subscriber folders
(`eslint.config.js:2316`, `eslint.config.js:2322`, `eslint.config.js:2325`,
`eslint.config.js:2332`, `eslint.config.js:2338`, `eslint.config.js:2342`), and
transforms ban `Effect.Effect` text patterns (`eslint.config.js:2351`,
`eslint.config.js:2369`). The old target tree only said these checks "can start
as Semgrep/AST checks" (`docs/architecture/2026-05-22-runtime-physical-target-tree.md:346`,
`:358`).

**Tier: source-verified.** The repo has ts-morph available (`package.json:42`) and
uses it for effect-quality metrics (`docs/static-analysis-catalog.md:185`). The
Effect language service is wired for diagnostics (`package.json:10`,
`docs/static-analysis-catalog.md:195`), but I found no existing mechanism for
feeding it custom topology assertions such as "exported Layer R is floor-only" or
"route files export only Stream -> Stream functions."

**Tier: inference.** D.1 is mechanical now. D.2 is mechanizable, but it is a new
custom analyzer obligation, not just "the same discipline as today" unless the SDD
spells out which existing gate will host each assertion. In particular, checking
that a handler's `R` does not leak `WorkflowEngine`, or that
`agent-session/adapter.ts` exports only floor requirements, requires type-aware
export analysis. Regex bans can catch direct token mentions, but not aliases,
re-exports, inferred R, or a Layer hidden behind a type alias.

**Punch-list:**
- Amend SDD lines 392-405 to mark each D.2 row with an enforcement host:
  dep-cruiser, ESLint regex, custom ESLint AST, ts-morph type-surface check, or
  effect-language-service diagnostic.
- Amend SDD lines 416-420. "No new enforcement mechanism is invented" is true for
  D.1, but D.2 needs new custom rule code even if it uses existing tool stacks.
- Avoid implying effect-language-service can enforce bespoke topology rules unless
  a concrete diagnostic or plugin path is cited.

### 6. Shape-dependent rows are flagged, but row 6 and row 8/9 wording need guardrails under B

**Tier: source-verified.** The SDD explicitly flags rows 1, 4, 5, and 14 as gated
by the §0.1 outcome (`SDD_FIREGRID_RUNTIME_ORG_AND_BODY_SHAPE_2026-06-02.md:345`,
`:451`). That satisfies the user's load-bearing check at the table level.

**Tier: inference.** The table mostly re-tiers cleanly under either outcome, but
some A-shaped mechanism wording leaks into rows presented as shape-agnostic. Row 6
calls delivery a derivation over engine + cursor and "not a per-channel Tag"
(`SDD...:333`); under B, delivery still targets a parked mailbox/arm shape. Rows
8/9 can split by domain under B, but the exact `DurableDeferred` replacement for
permission/tool waits depends on the recovery caveat above.

**Punch-list:**
- Keep rows 1,4,5,14 as the formal shape-dependent rows, but add a sentence that
  rows 6,8,9 keep the same **home** under B while their internals may remain
  mailbox/signal-shaped until the `DurableDeferred` recovery question is closed.

## Assertion Inventory

- **Source-verified:** `awaitSignal` is an await-once durable row plus suspend;
  no-arm `sendSignal` is write plus resume; `DurableDeferred.await/succeed` maps
  to deferred result/done plus suspend/resume; `armSession` creates missing
  executions and `resume` does not; `DurableQueue` is a persisted work queue with a
  worker pool; dep-cruiser can enforce import direction.
- **Inference:** `signal.ts` is mostly `DurableDeferred` reinvention; the thin arm
  should remain as a small helper; D.2 checks are possible with custom type-aware
  rule code.
- **Assertion / not yet proven:** generic non-clock `DurableDeferred` resume-on-
  recovery, C1 owner serialization from `Workflow.idempotencyKey + cursor`, and
  effect-language-service enforcement of custom topology rules.

## Required Explicit Answers

**Is the `signal.ts` -> `DurableDeferred` verdict source-sound?** Mostly yes,
with amendments. The await/resolve decomposition and the "keep thin arm" hinge are
source-sound. The SDD must soften exact keying, remove or prove generic deferred
resume recovery, and stop presenting `Workflow.idempotencyKey + cursor` as the
serialization guarantee.

**Is FS enforcement mechanizable?** D.1 yes. D.2 yes in principle with custom
ts-morph/ESLint/type-surface analysis, but not as currently stated through existing
checks or effect-language-service diagnostics. Mark it as designed and assign each
assertion to a concrete gate before treating it as enforceable.

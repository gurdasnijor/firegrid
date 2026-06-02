# RuntimeContext reconcile proposal v5 review

- **Task:** `tf-0awo.46`
- **Target:** `docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md` v5
- **Reviewer:** Codex review lane
- **Verdict:** **amend**

I re-opened the proposal's load-bearing citations rather than relying on the
folded reviews. Net: v5 is directionally sound and materially better than the
prior versions. The C2/C5 + SDD Gate claim verifies; return-and-re-drive is
source-falsified; the `Terminated`-only leak fix is the right shape; and the
blast-radius finding is broadly supported. It still needs three corrections
before I would accept it as decision-grade.

## Top findings

### 1. §5 still contradicts v5's own fresh-execution reframing

**Epistemic tier:** source-verified contradiction.

The proposal now says the live shape choice is "per-event run-to-completion
(A) vs the entity-lifetime parked body (B/C)" (`docs/proposals/...md:63-65`),
and §9 says the actor target spawns a **fresh execution per event**, "not"
return-and-re-drive (`docs/proposals/...md:576-579`). The analysis doc says the
same thing more explicitly: the RuntimeContext target is "one fresh handler
execution per session input" and "not one parked loop re-driven in place"
(`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md:115-118`).

But §5 still says `tf-tvg1` must include "a return-and-re-drive proof"
(`docs/proposals/...md:418`) and says per-event A "requires a new
return-and-re-drive proof" (`docs/proposals/...md:435-437`). It repeats the
same issue in the lean: A is "contingent on the return-and-re-drive proof"
(`docs/proposals/...md:469-471`), and §6 says D is not live until such a proof
exists (`docs/proposals/...md:478-479`).

That is no longer the right proof obligation for A after v5's own §9. The source
evidence falsifies re-driving returned executions: `armSession` returns when
`finalResult` is set (`packages/runtime/src/unified/signal.ts:147-155`), the
engine `resume` path also returns when `finalResult` is set
(`packages/runtime/src/engine/internal/engine-runtime.ts:182-185`), and the
`tf-e5rf` proof asserts the pre-resume execution is suspended with
`finalResult === undefined`
(`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:982-988`).

**Correction:** replace §5/§6 "return-and-re-drive proof" with the v5/analysis
proof obligation: fresh execution per session input over a durable consume
cursor, with per-key serialization, no double-send across recovery, and
multi-turn process continuity. Keep "return-and-re-drive" only as a rejected
option D mechanism.

### 2. §2.2 overclaims terminal-signal idempotency

**Epistemic tier:** source-verified bug in the illustrative fix text.

The proposal says the `Terminated` fix should use the same idempotency namespace
as cancel/close so "a cancel-then-natural-exit doesn't write two
distinctly-named terminal signals" (`docs/proposals/...md:265-270`). The snippet
then uses `session.terminated:${observation.contextId}:${observation.activityAttempt}`
(`docs/proposals/...md:287-292`).

That does not dedupe with existing cancel/close. Existing terminal signals use
`session.${operation}:${sessionId}` for `operation = "cancel" | "close"`
(`packages/runtime/src/unified/channel-bindings.ts:335-341`). The key is not
just metadata: `writeSessionInputSignal` passes `inputKey` as the signal `name`
(`packages/runtime/src/unified/channel-bindings.ts:126-142`), and signal identity
is `${executionId}|${name}` (`packages/runtime/src/unified/signal.ts:83-84`).
Therefore `session.cancel:<id>`, `session.close:<id>`, and
`session.terminated:<id>:<attempt>` are distinct signal rows.

The proposal's later parenthetical says duplicate terminal rows are benign
because the body consumes the first terminal and then final-result guards skip
future arms (`docs/proposals/...md:268-270`), which is consistent with the body
breaking on `kind === "terminal"` and then deregistering
(`packages/runtime/src/unified/subscribers/runtime-context.ts:131-153`) plus the
final-result guards above. But the "doesn't write two distinctly-named terminal
signals" sentence is false as written.

**Correction:** either remove the cross-operation dedupe claim, or specify a
single first-terminal-wins key such as `session.terminal:${contextId}` and accept
that cancel/close/exit reason conflict semantics must be defined. If the intended
behavior is operation-specific rows, say so and keep the "benign duplicate"
argument as an inference, not a fact.

Minor implementation note for the snippet: the current observer imports
`Context` only as a type (`packages/runtime/src/unified/observers.ts:34-35`).
A real patch using `Context.get(...)` must import the runtime `Context` value.

### 3. §9 blast-radius conclusion is mostly right, but one citation/name is wrong

**Epistemic tier:** conclusion source-verified with a citation correction.

The central blast-radius claim holds under code search: the only direct
`Workflow.suspend` in `packages/runtime/src/unified` product code is the
RuntimeContext loop (`packages/runtime/src/unified/subscribers/runtime-context.ts:113-120`).
The other `awaitSignal` call sites are await-once bodies:
`PermissionRoundtripWorkflow` waits once for a permission decision and then
returns (`packages/runtime/src/unified/subscribers/permission-and-tool.ts:105-169`);
webhook and peer observers await one fact signal and return
(`packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:313-349`,
`:368-390`). The wire tool workflow does not park; it activity-executes the tool,
relays once, and returns
(`packages/runtime/src/unified/subscribers/permission-and-tool.ts:203-208`,
`:237-283`).

Production wiring also supports the claim for the wire permission/tool path:
`FiregridHost` installs `buildPermissionRoundtripLayer()`,
`buildToolDispatchLayer(toolExecutor)`, and `JournalObserverLive`
(`packages/runtime/src/unified/host.ts:345-359`), and the observer forks those
workflows per `PermissionRequest` / host-dispatched `ToolUse`
(`packages/runtime/src/unified/observers.ts:57-86`). Workflow idempotency then
collapses duplicate observation replay by logical key
(`packages/runtime/src/unified/subscribers/permission-and-tool.ts:90-95`,
`:203-208`), so the precise statement is "fresh workflow per unique logical
event," not "every replayed journal row creates a durable new execution."

However, the analysis table cites
`mcp-host/tool-dispatch.ts` as "`ToolDispatchWorkflow`"
(`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md:78`).
That file defines `McpToolDispatchWorkflow`, not `ToolDispatchWorkflow`
(`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:644-680`), and its
facade executes `McpToolDispatchWorkflow` per MCP call
(`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:719-743`). The wire
`ToolDispatchWorkflow` lives in `subscribers/permission-and-tool.ts`.

**Correction:** split the §9 citation into two facts:

- wire codec path: `ToolDispatchWorkflow` in
  `subscribers/permission-and-tool.ts`, triggered by `JournalObserverLive`;
- MCP-entry path: `McpToolDispatchWorkflow` in `mcp-host/tool-dispatch.ts`,
  relay-free and per `ToolDispatch.call`.

## §0.1 pressure test

**Epistemic tier:** source-verified facts plus one inference to label.

The "dispatchable canon with Gate" half verifies. `runtime-design-constraints.md`
is `Doc-Class: dispatchable` (`docs/cannon/architecture/runtime-design-constraints.md:1-4`);
C2 says workflow-shaped subscribers handle one event and complete, and that the
forbidden shape spans many events for one entity
(`docs/cannon/architecture/runtime-design-constraints.md:258-280`); C5 says the
target has no parked entity body that spans the event stream
(`docs/cannon/architecture/runtime-design-constraints.md:361-379`). The SDD Gate
requires every new runtime SDD to include a `Constraint Check`
(`docs/cannon/architecture/runtime-design-constraints.md:558-581`), and a failing
bridge exception is not dispatchable
(`docs/cannon/architecture/runtime-design-constraints.md:581-596`). The same doc
asserts priority over older workflow-engine-era canon
(`docs/cannon/architecture/runtime-design-constraints.md:623-640`).

The unified SDD half also verifies: it was created later, on 2026-05-31
(`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:1-5`), says the substrate
is Workflow + DurableTable + Signal and "settled"
(`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:12-14`), and describes the
workflow body terminal action as `deregister`
(`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:20-35`). I found no
`Constraint Check` / bridge-exception language in that SDD.

So v5's core point is fair: this is not two equal docs casually disagreeing.
The more precise epistemic tier is:

- **source-verified:** the Gate exists; the unified SDD lacks the required check;
  the shipped/current RuntimeContext body is parked across inputs.
- **inference:** "shipped past the SDD Gate." It is a strong inference because the
  SDD postdates the Gate and the host installs the implemented workflow, but the
  proposal should avoid presenting "shipped past" as a literal source quote.

I would keep the framing, with wording like: "the unified SDD was implemented
without the Constraint Check / bridge exception required by dispatchable canon."

## Assertion tier cleanup

- **Source-verified:** `Terminated` is a real observation variant
  (`packages/protocol/src/session-facade/schema.ts:323-328`) and projection emits
  it (`packages/protocol/src/session-facade/schema.ts:554-561`); codec drain
  appends every output event without filtering by tag
  (`packages/runtime/src/unified/codec-adapter.ts:146-170`); observer currently
  drops anything except `PermissionRequest` and non-provider `ToolUse`
  (`packages/runtime/src/unified/observers.ts:57-89`).
- **Source-verified:** `CapturedServices` currently lacks `WorkflowEngineTable`
  (`packages/runtime/src/unified/observers.ts:48-52`), while
  `emitSessionTerminalSignal` requires `WorkflowEngineTable`
  (`packages/runtime/src/unified/channel-bindings.ts:287-306`) and `armSession`
  requires the engine table (`packages/runtime/src/unified/signal.ts:140-155`).
- **Inference, should stay labeled:** "`signal.ts` is mostly model-neutral."
  The durable row table and write/arm/recover pieces are reusable evidence
  (`packages/runtime/src/unified/signal.ts:54-77`, `:193-216`, `:266-305`), but
  the current rows carry `workflowName`, `executionId`, and optional
  `workflowPayloadJson` (`packages/runtime/src/unified/signal.ts:54-67`), so the
  implementation is workflow-specific even if the substrate idea is reusable.
- **Inference, not source fact:** "actor model already runs in production." The
  per-event workflow shapes are source-verified; calling that "actor model" is a
  taxonomy inference from C1/C2/C4, not something the code says.

## Punch list

1. `docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md:418`, `:435-437`, `:469-471`, `:478-479`:
   remove the remaining A-needs-return-and-re-drive language. Replace with the
   fresh-execution/durable-cursor proof obligations from the v5 analysis doc.
2. `docs/proposals/...md:265-270`, `:287-292`: fix the terminal-signal
   idempotency claim. The shown key does not dedupe with cancel/close signal keys.
3. `docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md:78` and
   proposal §9 summary: distinguish wire `ToolDispatchWorkflow` from MCP-entry
   `McpToolDispatchWorkflow`.
4. `docs/proposals/...md:7-9`, `:573-575`: qualify "`signal.ts` is mostly
   model-neutral" as inference/reusable-substrate framing, because the current
   implementation is workflow-execution-specific.
5. `docs/proposals/...md:30-54`: keep the §0.1 Gate framing, but phrase "shipped
   past the SDD Gate" as an evidence-backed inference, not as a directly quoted
   source fact.

With those amendments, I would accept v5.

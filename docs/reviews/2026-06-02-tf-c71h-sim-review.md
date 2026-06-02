# tf-c71h per-event RuntimeContext workbench sim review

- **Date:** 2026-06-02
- **Reviewer:** Codex, tf-tuxv
- **Subject:** PR #850 draft, `tf-c71h` per-event RuntimeContext workbench sim
- **Verdict:** **AMEND**

## Bottom line

The trace is useful evidence, but it is not decision-grade for selecting full
option A in proposal §0.1.

It is decision-grade only for this narrower claim: a fresh per-event handler can
deliver sequential `prompt` inputs and a terminal `close` for one `contextId`
through the real production codec adapter, reuse one live ACP process through
`startOrAttach`, and return after each input. That is enough to keep option A
viable and to retire the old "return-and-re-drive" framing for this subset.

It is **not** decision-grade for the complete option-A migration because the run
does not exercise the production permission/tool relay path, does not stress
concurrent inputs for one key, and uses a two-adapter workbench composition that
does not prove the single-adapter production wiring a cutover would need.
For B/C, this sim is not decision-grade either; it does not prove the parked body
must be blessed. It mainly identifies couplings option A must resolve.

## Findings

### 1. Transferability is narrower than the sim entrypoint claims

**Tier: source-verified fact.** The run never exercised permission/tool relay.
The driver says each prompt waits briefly for output because the fixture would
strand permission responses if it reached `requestPermission`
(`packages/tiny-firegrid/src/simulations/per-event-runtime-context/driver.ts:14`).
The trace summary confirms zero permission/tool/turn-complete outputs:
`snapshot_permission_request_count=0`, `snapshot_tool_use_count=0`,
`snapshot_turn_complete_count=0`, and output tags
`Ready,TextChunk,TextChunk,TextChunk` (trace line 309).

**Tier: source-verified fact.** Production relays are still explicitly addressed
to `RuntimeContextSessionWorkflow`: `relaySessionInput` sends to
`RuntimeContextSessionWorkflow` (`packages/runtime/src/unified/subscribers/permission-and-tool.ts:45`),
permission response computes that workflow execution id and relays to it
(`permission-and-tool.ts:134`, `permission-and-tool.ts:157`), and tool dispatch
does the same (`permission-and-tool.ts:250`, `permission-and-tool.ts:275`).
The observer really does trigger those sibling workflows per output event
(`packages/runtime/src/unified/observers.ts:53`).

**Tier: source-verified fact.** The workbench also avoids other production
RuntimeContext signal paths. It overrides `host.sessions.start` and
`session.cancel` with exported stubs so they do not arm the parked body
(`host.ts:457`, `host.ts:461`), while production `session.start` arms
`RuntimeContextSessionWorkflow` (`packages/runtime/src/unified/channel-bindings.ts:420`)
and production cancel/close emit terminal signals into that workflow
(`channel-bindings.ts:442`, `channel-bindings.ts:465`). The workbench covers
`session.close` by retargeting it to the per-event handler, but it does not test
`session.cancel`, and it does not define the production start semantics for an
option-A cutover.

**Tier: inference.** The finding correctly names the permission/tool coupling in
`docs/findings/tf-c71h-per-event-runtime-context-workbench.md:108` and
`docs/findings/tf-c71h-per-event-runtime-context-workbench.md:115`, but the
simulation entrypoint and host docblock overstate transferability. The index
description says the workbench "proves the load-bearing RuntimeContext session
loop can adopt" the per-event shape (`index.ts:7`). The host goal says the same
without the relay caveat (`host.ts:4`). The evidence actually proves the direct
session-input subset.

**Punch-list:**
- Amend `packages/tiny-firegrid/src/simulations/per-event-runtime-context/index.ts:7`
  to say "proves the direct session-input subset" or equivalent, not full
  RuntimeContext adoption.
- Amend `packages/tiny-firegrid/src/simulations/per-event-runtime-context/host.ts:4`
  to carry the same caveat.
- In `docs/findings/tf-c71h-per-event-runtime-context-workbench.md:130`, expand
  the migration coupling list beyond permission/tool and `host.permissions.respond`
  to include `session.start` and `session.cancel` semantics, or explicitly justify
  why those are outside the option-A cutover.

### 2. The per-key serialization proof is not satisfied; the workbench allocator would be unsafe under concurrent appends

**Tier: source-verified fact.** The spec asks the trace to show "two inputs racing
for one `contextId` are serialized" (`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md:170`).
The driver is sequential by construction (`driver.ts:4`, `driver.ts:71`), and the
finding admits concurrency was not stress-tested
(`docs/findings/tf-c71h-per-event-runtime-context-workbench.md:102`).

**Tier: source-verified fact.** The workbench sequence allocator is a count of
existing rows (`host.ts:301`). `writeAndExecute` then inserts by
`${contextId}:${seq}` and executes a per-event workflow with the request's
`inputKey` and that `seq` (`host.ts:319`, `host.ts:329`). The body only observes
`seq === cursor.consumed`; it does not enforce it (`host.ts:188`).

**Tier: inference.** With two concurrent appends for the same `contextId`, both
can plausibly read the same row count before either insert is visible. Because
the result of `insertOrGet` is ignored (`host.ts:320`), a losing writer could
still execute a distinct workflow idempotency key (`host.ts:137`) pointed at a
row key already occupied by the first writer. That could duplicate or reorder an
input rather than merely annotate `seq_matched_cursor=false`.

**Punch-list:**
- Amend proof #2 in
  `docs/findings/tf-c71h-per-event-runtime-context-workbench.md:58` to "sequential
  cursor sanity check", not "per-key ordering proof."
- Add a follow-up requirement for an atomic per-key append/sequence owner or a
  public-surface concurrency stress run before calling option A decision-grade
  for C1 owner serialization.
- Avoid using `seq_matched_cursor=true` trace lines as evidence for racing-input
  serialization; they are evidence only for the sequential driver path.

### 3. The two-adapter composition is benign for this trace, but it masks a production integration question

**Tier: source-verified fact.** The workbench builds one production adapter for
the per-event handler (`host.ts:450`) and another production adapter inside the
real factory (`host.ts:476`). Production `FiregridRuntime` takes one adapter
layer and provides it to the current RuntimeContext workflow
(`packages/runtime/src/unified/host.ts:328`, `packages/runtime/src/unified/host.ts:336`,
`packages/runtime/src/unified/host.ts:349`). The adapter registry is per adapter
instance (`packages/runtime/src/unified/codec-adapter.ts:406`); `startOrAttach`
reuses only entries in that instance-local registry (`codec-adapter.ts:408`).

**Tier: source-verified fact.** The trace opens one byte pipe (trace line 54) and
later `startOrAttach` calls are short no-op reattaches (trace lines 61, 133, 201,
269). That proves continuity inside the per-event adapter instance.

**Tier: inference.** This is likely a benign workbench artifact for direct
prompts because the factory's parked body never executes. It does not prove the
production cutover will have the right resource sharing once the relay/start/cancel
paths are retargeted. A production option-A implementation should use one adapter
instance for every path that can call `startOrAttach`, `send`, or `deregister`
for a context, or explicitly prove that separate registries cannot split session
process state.

**Punch-list:**
- Add a note near `host.ts:450` or in the finding's "What the sim does" section
  that the two-adapter shape is a workbench isolation artifact and not the desired
  production shape.
- Do not cite this trace as proof that relay-path adapter sharing works; the
  relay path did not run and the adapter instance used by the per-event handler is
  not the factory adapter.

### 4. "No double-send" is a mechanism inference, not trace proof

**Tier: source-verified fact.** The trace shows cursor advances for the three
prompt events and a terminal close (trace lines 102, 170, 238, 294). The send is
wrapped in `Activity.make` (`host.ts:225`) and the cursor advance is also
activity-memoized (`host.ts:236`).

**Tier: source-verified fact.** The spec's proof requirement was stronger:
crash plus recovery should re-invoke from the cursor without re-firing an
already delivered send (`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md:172`).
The finding admits full crash recovery is public-surface-blocked
(`docs/findings/tf-c71h-per-event-runtime-context-workbench.md:70`).

**Tier: inference.** The activity memoization argument is reasonable, but the
trace did not exercise the failure mode. The finding's proof title "Durable
cursor advances 0->1->2; no double-send" (`docs/findings/tf-c71h-per-event-runtime-context-workbench.md:65`)
should demote "no double-send" to an expected property of the mechanism, not a
trace-observed proof.

**Punch-list:**
- Rename proof #3 to "Durable cursor advances 0->1->2; no crash re-drive tested."
- Keep the activity memoization explanation, but label it inference/source-code
  rationale until a recovery run exists.

### 5. Methodology mostly holds; the namespace Tag workaround is not a fake adapter

**Tier: source-verified fact.** The host consumes the real adapter Tag via the
`Unified.*` namespace (`host.ts:68`, `host.ts:155`) and provides
`defaultProductionAdapterLayer()` (`host.ts:450`, `host.ts:471`). I found no
`Layer.succeed` replacement for `RuntimeContextSessionAdapter` in the sim; the
only stubs in this host are channel stubs for start/cancel (`host.ts:461`). The
driver imports the client SDK plus Effect and launches the ACP fixture process
(`driver.ts:25`, `driver.ts:31`). The sim has no `claimStatus` or verdict object;
the driver returns measurement fields and annotates the trace (`driver.ts:98`,
`driver.ts:119`).

**Tier: inference.** The eslint-airgap workaround is a smell in the rule design,
not a methodological violation. It consumes the same Tag object and the real
layer; it does not bypass the production spawn path.

**Punch-list:**
- No code correction required for this point.
- Keep the finding's tooling observation, but keep it clearly separate from the
  decision-grade evidence.

## Assertion inventory

- **Source-verified:** four fresh per-event executions, parked workflow registered
  but not executed, one real byte-pipe spawn, three prompt sends, terminal
  deregister, zero permission/tool outputs in the run, production relay hardcodes
  `RuntimeContextSessionWorkflow`, and the workbench has two adapter layers.
- **Inference:** option A remains viable for direct session input; permission/tool
  relay retargeting is a contained but unproven migration; two adapter instances
  are benign for this direct-path trace; Activity memoization should prevent
  double-send on retry.
- **Assertion / not yet proven:** full option-A transferability, C1 owner
  serialization for concurrent appends, crash-recovery no-double-send, and
  end-to-end permission/tool behavior after retargeting.

## Decision-grade answer for §0.1

For **A**: decision-grade for the session-input subset only. It proves "fresh
execution per direct input over durable cursor can reach and reuse the same
agent process" on the real adapter. It does not prove the full migration.

For **B/C**: not decision-grade. The trace does not supply new evidence that the
parked body must remain; it supplies evidence that current production wiring has
parked-body couplings.

For the proposal's **A vs B/C call**: use this as supporting evidence that A is
plausible and bounded, not as the deciding proof. The remaining decision-grade
work is: retarget and exercise permission/tool responses, specify start/cancel
semantics, prove concurrent per-key serialization, and either run or explicitly
waive crash-recovery no-double-send evidence.

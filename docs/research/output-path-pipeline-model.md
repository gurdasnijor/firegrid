# Research / Spike Prompt: Radical Substrate Simplification for `@firegrid/runtime`

## Premise

The durable substrate of `@firegrid/runtime` — the family of `Context.Tag`s, `Layer`s, and `DurableTable` instances that mediate writes to and reads from durable streams — has accumulated complexity that no local refactor can resolve. Multiple cleanup attempts (capability projection inlining, output-journal seam cleanup) have each produced plausible but incomplete answers because they're treating the symptom (Tag multiplication) rather than the cause (a multi-writer, multi-table durability model layered over data that is structurally single-writer-per-context).

This research is not a refactor scoping exercise. It is a **structural feasibility spike**: can the durable substrate be reorganized around a single primitive — a typed event log per runtime context — such that the current authority/subscriber/projection Tag taxonomy collapses to one appender, one log, and N derived projections per context?

The output of this research determines whether the next architectural move is a local cleanup (a few hundred lines, weeks) or a structural restructure (a few thousand lines, months). The wrong answer in either direction is expensive. The right answer is what the data supports.

## Convergence protocol

This spike must converge to one of three explicit models. Do not end with a
bag of observations.

| Model | Meaning | Next artifact |
|---|---|---|
| **Model A: Local cleanup** | The table-per-row-family substrate is justified. The problem is derived-view and Tag sprawl. | Local cleanup SDD for authority Tag reduction and Layer provision cleanup. |
| **Model B: Context event log** | Single-writer-per-context is structurally available. Per-context typed logs plus indexes should replace most runtime durable tables. | Structural SDD for `ContextEventLog`, command stream, and index migration. |
| **Model C: Hybrid** | Context-owned data can move to per-context logs, but namespace/control-plane data and some external writes must stay table/command-stream backed. | Hybrid SDD that names the exact split and forbids future ambiguity. |

The researcher should recommend exactly one model, with a short "why the other
two are wrong right now" section. If the data is incomplete, choose the safest
model supported by the evidence and list missing evidence as open questions.
Do not defer the model choice unless a named write path cannot be traced.

### Decision gates

Use these gates in order:

1. **Writer identity gate.** If any unavoidable durable write about a context is
   performed by a non-owning process and cannot be inverted through a command
   stream or host RPC, Model B is invalid.
2. **Control-plane gate.** If context registration or cross-context run listing
   is a first-class query, it must remain namespace-scoped or become a
   namespace-scoped command/index. Do not force it into a per-context log.
3. **Lookup gate.** If hot-path point lookups cannot be served by a fold-based
   or persistent index without weakening idempotency, the event-log model must
   include those indexes explicitly. "Replay and hope" is not an answer.
4. **Workflow gate.** If `@effect/workflow` durability already owns a lifecycle
   event, do not duplicate it in the context log unless a current runtime
   consumer needs that event outside workflow replay.
5. **Plane-split gate.** If the Host SDK split needs a public surface before
   the substrate can be replaced, name the compatibility surface. Do not let the
   SDK split publish a shape that the substrate spike already proves wrong.

### Required intermediate checkpoint

Before drafting any final recommendation, produce a short checkpoint with:

- the complete durable write-site table from Q1.1;
- a verdict for the four known potential violators in Q1.3;
- the complete point-lookup table from Q3.1;
- a provisional model choice: A, B, or C.

If the checkpoint cannot name a provisional model, stop and escalate the
specific untraceable paths. Do not continue broad research.

## The hypothesis to test

**Every durable write in the current `@firegrid/runtime` codebase originates in the host process that owns the runtime context the write is about.** If this holds, multi-writer durability is being paid for without being used, and the substrate can be reorganized around single-writer-per-context streams with command-stream inversion for external producers.

If this does *not* hold — if there exists a genuine, structurally necessary path where a process that does not own a context writes durably to that context's events — the table model is justified and the local cleanup is the right scope.

## Context the researcher needs

### What Firegrid is

Firegrid is a stream-native agent runtime. A "runtime context" is one execution of an agent (raw local process, ACP-protocol agent, or stdio-jsonl agent). A "host" is a process that owns and runs one or more contexts. Hosts are identified by `hostId`; contexts are identified by `contextId` and have a `host` binding declaring which host owns them.

Durable state lives on streams managed by `@durable-streams/client`. The package `effect-durable-operators` exposes `DurableTable`, a ksql-style materialized-table abstraction over a stream. Tables expose `insert`, `upsert`, `delete`, `get`, `rows()`, `insertOrGet` operations. Each table is backed by one stream.

### What currently exists

The runtime has **three durable tables**, each backed by its own stream, holding **six row families** across them:

| Table | Stream type | Row families |
|---|---|---|
| `RuntimeOutputTable` | host-owned (`host-{X}.runtimeOutput`) | `events`, `logs` |
| `RuntimeIngressTable` | host-owned (`host-{X}.runtimeIngress`) | `inputs`, `deliveries` |
| `RuntimeControlPlaneTable` | namespace-scoped (`{namespace}.firegrid.runtime`) | `contexts`, `runs` |

Plus per-context workflow engine streams (`host-{X}.context-{Y}.workflow`) and durable-tools streams (`host-{X}.durableTools`), which are workflow-engine infrastructure, not application data, and are out of scope for this spike except as caller-side context.

The runtime exposes **capability Tags** organized as follows:

- "Authorities" — `Context.Tag`s shaped as narrow write services (`{ append: (row) => Effect<row, E> }`, sometimes with multi-operation lifecycles like `claimInput`/`recordCompleted`).
- "Read views" — `Context.Tag`s shaped as `Stream<Row, E>` derived from `table.X.rows()`.
- "Derived views" — `Context.Tag`s shaped as `Sink<...>` or decoded/filtered `Stream<...>` over the read views. These are the locus of the current muddle.

Five files declare authority-style Tags:
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`
- `packages/runtime/src/authorities/runtime-control-plane-recorder.ts`
- `packages/runtime/src/durable-tools/internal/durable-wait-store.ts` (durable-tools infrastructure; secondary scope)

Subscriber files in `packages/runtime/src/agent-event-pipeline/subscribers/` consume read view Tags and write through authority Tags as scoped forked fibers.

Composition in `packages/runtime/src/agent-event-pipeline/session-runtime.ts` and `packages/runtime/src/host/raw-process-runtime.ts` provisions layers and orchestrates the foreground codec output write loop.

### The architectural rule the codebase aspires to

From `agent-event-pipeline/subscribers/README.md`:

> Subscribers depend on `Stream` capability tags, not table facades. Write through authority capability tags. Keep protocol-specific send behavior in codecs or active session capabilities.

This rule is partially expressed in code. The drift between the rule and the implementation is the surface symptom of the deeper question this spike answers.

### Why local cleanup is insufficient

Prior cleanup proposals concluded:

1. The derived-view Tags (Sinks, decoded streams) can be deleted; consumers project locally. **True, but treats the symptom.**
2. The projection patterns can be inlined; helpers are single-use. **True, but cosmetic.**
3. The authority taxonomy can be restated as "one write Tag plus one Stream Tag per row family." **True under the existing table model — but assumes the table model is the right primitive.**

The deeper question is whether the table model itself is the right primitive. If the data is structurally single-writer-per-context, the right primitive is a typed event log per context, not a table per row family across all contexts.

Other systems have converged on single-writer-per-consistency-unit as the framework primitive:

- **Temporal**: workflow is the consistency boundary; workflow history is single-writer.
- **Restate**: virtual object instance is the consistency boundary.
- **Flink**: operator partition is the consistency boundary.
- **Event-sourcing**: aggregate is the consistency boundary.

Firegrid currently has *no* single-writer boundary at the framework level. The producer-epoch fencing in `DurableTable.insertOrGet` defends against per-key collisions but does not impose a single-writer-per-context invariant. This may or may not be a problem the codebase actually needs to solve; that is what this spike determines.

### What changing this would buy

If the spike confirms single-writer-per-context is structurally available, reorganizing around it produces:

- One Tag per context for writes (`ContextEventAppender`), replacing 7+ Tags across 4 files.
- One Tag per context for reads (`ContextEventLog`), replacing 5+ stream Tags.
- N derived projections built locally at consumers from the event log, replacing 3+ decoded/Sink Tags.
- Run lifecycle moves from the namespace-scoped control plane to the per-context log (it's per-context data).
- Total ordering of all context events in one stream — no cross-table ordering reconstruction.
- Single-writer guarantees as a structural property, not a discipline.
- Per-context retention, replay, and isolation become natural at the stream layer.

The cost is a real architectural shift: building a typed-event-log abstraction over `DurableStream`, moving 6 row families into one event union schema, building materialized indexes for the point-lookup access patterns (idempotency checks), and inverting external-writer paths (CLI tools) to write to a command stream rather than appending to context streams directly.

### What changing this would break

- Stream-creation overhead per context. Per-context streams are cheap to create (Durable Streams' idempotent `create` tolerates `CONFLICT_EXISTS`), but it's a per-context startup cost.
- Cross-context queries become harder. "List all runs across all contexts on this host" today is a query against `RuntimeControlPlaneTable.runs`; tomorrow it's an enumeration over per-context streams (or a separate index).
- `DurableTable` doesn't fit the event-log shape perfectly. The cleaner primitive is `DurableStream` directly with a thin typed-event wrapper.
- Schema versioning gets stricter — the event union becomes the source-of-truth schema, and adding/changing variants needs explicit versioning.

## Candidate target surfaces

These sketches are not commitments; they are the minimum concrete shapes the
research must validate or reject.

### Model A: local cleanup surface

If the current table model survives, the workable model should be:

```txt
RuntimeOutputTable
  events: append + rows
  logs: append + rows

RuntimeIngressTable
  inputs: append/read + rows
  deliveries: claim/complete + rows

RuntimeControlPlaneTable
  contexts: insert/read + rows
  runs: append/read + rows
```

Derived Sinks and decoded Streams should be justified by multi-consumer demand
or deleted. Subscribers should either consume raw Stream tags and project
locally, or the model must explain why a derived Stream tag is a real boundary.

### Model B: per-context event-log surface

If single-writer-per-context holds, the workable model should look like:

```ts
export class ContextEventAppender extends Context.Tag(
  "@firegrid/runtime/ContextEventAppender",
)<ContextEventAppender, {
  readonly append: (
    event: RuntimeContextEventInput,
  ) => Effect.Effect<RuntimeContextEvent, RuntimeContextEventError>
}>() {}

export class ContextEventLog extends Context.Tag(
  "@firegrid/runtime/ContextEventLog",
)<ContextEventLog, Stream.Stream<RuntimeContextEvent, RuntimeContextEventError>>() {}
```

The event union must make current ordering and idempotency semantics explicit.
At minimum, the research should evaluate variants corresponding to:

- context lifecycle/history;
- run lifecycle;
- agent output;
- stdout/stderr log lines;
- ingress input accepted/sequenced;
- ingress delivery claimed/completed;
- tool result input appended;
- permission response input appended.

Context registration may still remain in a namespace-scoped control-plane
registry. Do not force registry data into a per-context log unless the write
and read paths justify it.

### Model C: hybrid surface

If only some row families are context-owned, the workable model should name the
split explicitly:

```txt
Namespace control plane
  contexts registry
  host/run indexes if required for listing
  command stream for external or cross-host requests

Per-context event log
  ordered context-owned runtime history
  derived projections and hot-path indexes

Workflow engine streams
  unchanged @effect/workflow durability
```

Hybrid is not a compromise bucket. It is valid only if each survivor outside
the context log has a named query, writer, or ownership reason.

## The questions this spike must answer

These are the only questions that matter. Everything else is downstream of these.

## Data collection templates

Use these table shapes in the deliverable. Adding columns is fine; removing
these columns is not.

### Durable write-site table

```md
| Write site | Current table/collection | Row family | Context id source | Running process | Owning host source | Match? | Invertible? | Notes |
|---|---|---|---|---|---|---|---|---|
| `path.ts:function` | `RuntimeOutputTable.events` | `AgentOutput` | `context.contextId` | owning host activity | `context.host.hostId` | yes | n/a | ... |
```

Definitions:

- **Running process** is the process/fiber that actually calls the durable
  write, not the user who requested it.
- **Owning host source** is the code path that proves which host owns the
  context.
- **Invertible** means a non-owning writer could instead emit a command that the
  owning host consumes and appends.

### Point-lookup table

```md
| Lookup site | Current table/collection | Key | Purpose | Hot/cold | Event-log replacement | Index needed? | Notes |
|---|---|---|---|---|---|---|---|
| `path.ts:function` | `RuntimeIngressTable.inputs` | `inputId` | ingress idempotency | hot | `InputSequenced` index by `inputId` | persistent | ... |
```

### Event-union mapping table

```md
| Current row family | Proposed event variant | Per-context? | Current write sites | Current read sites | Indexes |
|---|---|---|---|---|---|
| `RuntimeOutputTable.events` | `AgentOutputRecorded` | yes | ... | ... | by `eventId`, maybe by `sequence` |
```

### Plane-split reconciliation table

```md
| Host SDK / Client SDK commitment | Current symbol/path | Model A fate | Model B/C fate | Migration note |
|---|---|---|---|---|
| Runtime output observation | `RuntimeAgentOutputEvents` | project locally or keep narrow stream tag | derived from `ContextEventLog` | client surface remains `session.snapshot().agentOutputs` |
```

### Section 1: The single-writer hypothesis

**Q1.1.** For every code path in `packages/runtime/src/**` that produces a durable write (any call that ultimately results in `table.insert`, `table.upsert`, `table.delete`, or `table.insertOrGet`), trace:

1. The originating function and file.
2. The runtime context the write is about (the `contextId` field on the row, or the implicit context of the calling code).
3. The process identity that runs that code path (the host process owning the context, vs. a different host, vs. an external CLI, vs. a workflow engine fiber).
4. Whether the process identity matches the `hostId` field on the context's `host` binding.

**Output:** A table with one row per write site. Columns: `Write site (file:function) | Row family | Process identity | Context owner identity | Match`.

**Q1.2.** Identify every write site where the process identity does *not* match the context owner. For each:

- Describe the scenario (what code calls this; under what conditions).
- Assess whether the write could be inverted: would it be structurally possible for the originating process to send a *command* to the owning host, and have the owning host append the durable event?
- Identify what changes would be required for the inversion (new IPC channel, command stream, request/response shape).

**Output:** A list of write sites that violate single-writer-per-context, with an inversion assessment for each.

**Q1.3.** Specifically examine these known potential violators:

- **External CLI ingress** (`firegrid:run --prompt`): when invoked from a different process than the host running the target context, does the CLI append directly to the context's ingress stream? Trace through `packages/runtime/src/host/commands.ts:appendRuntimeIngress` and `packages/runtime/src/host/commands.ts:appendRuntimeIngressToOwner`.

- **Context insert from non-owning host**: the control plane (`RuntimeContextInsert.insertLocalContext`) creates context registry rows. Is this only ever called by the host that will own the context, or can host A register a context that host B will run?

- **Tool router producing ingress**: `runToolRouter` produces `tool_result` ingress rows. The tool router runs in the host process owning the context — but is the *target* context (where the ingress row lands) always the same as the host running the router?

- **Permission response paths** (ACP codec): permission responses originate as `PermissionResponse` agent input events. Where do they enter the system, and do they end up writing to the context they're for?

**Output:** A specific verdict for each of these four scenarios: single-writer-preservable / single-writer-violating / requires-inversion.

### Section 2: The event union

**Q2.1.** Given the current six row families (`events`, `logs`, `inputs`, `deliveries`, `contexts`, `runs`), produce a draft typed event union that subsumes all of them. The union should:

- Use Effect Schema (`Schema.Union(Schema.TaggedStruct(...), ...)`).
- Preserve every field currently on every row family.
- Discriminate by `_tag`.
- Identify which fields are common (`contextId`, sequence numbers, timestamps) and which are variant-specific.

**Output:** A complete `Schema.Union` declaration in TypeScript, plus a comparison table showing which current row-family fields map to which event-variant fields, with justification for any field renames or restructurings.

**Q2.2.** For each event variant in the proposed union, identify:

- The current write site(s) that would produce this event.
- The current read site(s) (subscribers, queries) that would consume this event.
- Whether the event is *per-context* (belongs on a per-context log) or *cross-context* (must stay in a namespace-scoped table).

**Output:** Per-variant write/read provenance, with a verdict on whether each variant belongs in the per-context log or elsewhere.

**Q2.3.** Examine the `contexts` row family specifically. The current `RuntimeContextRow` is a registry entry — host binding, namespace, context intent. It is queried *cross-context* (e.g., `readRuntimeContext(contextId)` looks up a context by id). It is updated by hosts other than the owning host (e.g., a CLI registers a context for a daemon to run).

Is the right model:
- (a) Context registration stays in a namespace-scoped control-plane table; only context *history* moves to per-context logs.
- (b) Context registration is itself an event on a namespace-scoped command stream; the control-plane table becomes a derived materialized view.

**Output:** A recommendation with rationale, plus an enumeration of which current write sites against `RuntimeControlPlaneTable.contexts` would change under each option.

### Section 3: The point-lookup access patterns

**Q3.1.** Enumerate every current `table.X.get(key)` call site in `packages/runtime/src/**`. For each:

- What is being looked up (which row family, which key)?
- Why is the lookup happening (idempotency check, existence test, retrieval for read)?
- Is the lookup on the "hot path" (every event, every request) or "cold path" (recovery, debugging)?

**Output:** A table of point-lookup sites with hot/cold classification.

**Q3.2.** For each hot-path point-lookup site identified in Q3.1:

- Determine whether a fold-based materialized index (`Map<key, event>` built by replaying the log) is performant enough at expected scale.
- Determine whether a separate persistent index (e.g., a `DurableTable` storing `(key, eventId)` pairs alongside the event log) is necessary.

**Output:** A per-site recommendation: fold-based-index / persistent-index / no-index-needed-redesign-the-access.

**Q3.3.** Specifically examine these known hot-path lookups:

- **Ingress idempotency** (`RuntimeIngressAppendAndGet.append`): looks up `inputs.get(inputId)` before sequencing. Required for idempotent re-runs after restart.

- **Delivery claim** (`RuntimeIngressDeliveryClaimAndComplete.claimInput`): looks up `deliveries.get(key)` before claiming. Required for at-most-once delivery semantics.

- **Tool result deduplication** (`runToolRouter`): looks up `findInput(toolResultInputId)` before appending. Required to avoid duplicate tool result rows.

- **Context resolution** (`readRuntimeContext`): looks up `contexts.get(contextId)`. Required on every host-side operation that needs context metadata.

For each, determine whether the lookup pattern survives the restructure as-is, requires a materialized index, or can be redesigned out of the hot path entirely.

**Output:** A specific verdict per lookup.

### Section 4: The codec session and workflow engine boundary

**Q4.1.** The `@effect/workflow` engine (used via `DurableStreamsWorkflowEngine`) has its own durability story. `runtime-context-workflow.ts` defines a `RuntimeContextWorkflow` with an activity that runs the codec. The workflow engine journals activity inputs/results to its own stream.

Trace which writes to the proposed `ContextEventLog` would happen *inside* a workflow activity vs. *outside* (e.g., during host-side ingress append, where there's no active workflow). Identify any cross-cutting concerns (does the workflow engine need to observe events on the context log? Does the context log need to know about workflow attempts?).

**Output:** A mapping of write sites to "inside-activity" vs. "outside-activity," with any cross-cutting concerns flagged.

**Q4.2.** The `AgentSession` Tag (in `agent-event-pipeline/codecs/contract.ts`) exposes `outputs: Stream<AgentOutputEvent, AgentCodecError>` as a struct field, not a separate Tag. The current codec output write loop in `session-runtime.ts` consumes this stream and writes through `RuntimeAgentOutputRowSink`.

Under the proposed model, would this loop write directly to `ContextEventAppender.append`, or would there be an intermediate codec-side transformation? Identify what changes about `AgentSession`'s shape (if anything) under the proposed model.

**Output:** A revised shape for `AgentSession` if it changes, or a confirmation that it doesn't.

**Q4.3.** Examine the ingress delivery subscriber (`runIngressDelivery`). It consumes `RuntimeIngressInputStream`, claims via `RuntimeIngressDeliveryClaimAndComplete`, and sends to `AgentSession.send`. Under the proposed model:

- The subscriber consumes `ContextEventLog` filtered to `InputSequenced` events.
- Claim becomes an `InputClaimed` event appended to the same log.
- Completion becomes an `InputDelivered` event.

Is there any reordering or race condition introduced by collapsing all of these onto a single stream where they were on two streams before? Specifically: does total ordering across input/sequenced/claimed/delivered events on one stream change the at-most-once semantics?

**Output:** A correctness assessment of the merged ordering. Identify any operations that today rely on independent ordering between the `inputs` and `deliveries` row families.

### Section 5: The external writer / command stream

**Q5.1.** If single-writer-per-context is structurally available, external writers (CLI, future SDK consumers, cross-host coordination) need a different ingress path. Three options:

- (a) **Command stream**: a namespace-scoped stream where external clients append commands (`RunPrompt`, `CreateContext`, etc.). Hosts subscribe and process commands for their owned contexts.
- (b) **RPC to owning host**: external clients call a host-side endpoint that internally appends.
- (c) **Hybrid**: command stream for cross-host / cross-process, direct append for in-process.

For each option, identify:
- The current external-writer call sites that would need to change.
- The new infrastructure required (stream, RPC framework, subscription mechanism).
- Compatibility with the existing CLI shape (`firegrid:run --prompt` in particular).

**Output:** A per-option assessment, with a recommendation.

**Q5.2.** Specifically examine the multi-host topology referenced in `packages/runtime/src/host/layers.ts`: the helper `FiregridLocalHostLive` derives a single-host-per-namespace identity; `FiregridRuntimeHostWithWorkflowLive` accepts explicit `hostId` for multi-host setups. Trace what cross-host writes exist in the current code (if any) and what the multi-host story is under the proposed single-writer-per-context model.

**Output:** A clear statement of how multi-host setups change (or don't) under the proposed model.

### Section 6: The plane-split commitments

**Q6.1.** Read `docs/sdds/SDD_FIREGRID_HOST_SDK.md` (or wherever the plane split is documented) and enumerate every Tag, Layer, or capability that the SDK plane split commits to exposing in `@firegrid/host-sdk`, `@firegrid/client-sdk`, or `@firegrid/cli`.

Compare against the proposed reduced surface (one `ContextEventAppender`, one `ContextEventLog`, plus the control-plane registry). For each plane-split commitment:

- Does it survive the restructure as-is?
- Does it survive in a different shape (and what's the migration)?
- Is it deleted (and what replaces it)?

**Output:** A reconciliation table mapping plane-split commitments to their fate under the restructure.

**Q6.2.** If the plane split is in flight, identify whether the restructure should:

- (a) **Block on the plane split landing**, then restructure on top.
- (b) **Replace the plane split's assumed surface** with the restructured surface, requiring the plane split to be redrafted.
- (c) **Run in parallel** with the plane split, with explicit coordination.

**Output:** A sequencing recommendation with rationale.

### Section 7: The `DurableTable` vs `DurableStream` boundary

**Q7.1.** The current substrate uses `DurableTable` (from `effect-durable-operators`) as the primary durability primitive. A typed event log per context is more naturally expressed as a `DurableStream` with schema-encoded events.

Two implementation options:

- (a) **Keep `DurableTable`**: one collection per context, primary-keyed by event id, with a discriminated `_tag` field on the row schema. Use `rows()` for the log stream; use `get(eventId)` for point lookups.
- (b) **Use `DurableStream` directly**: build a thin `ContextEventStream<Event>` wrapper that schema-encodes/decodes appends and reads. Materialized indexes live in separate `DurableTable`s as needed.

For each option, evaluate:
- Implementation cost (lines of new code).
- Fit with `effect-durable-operators` requirements (`TABLE.1` through `TABLE.28`).
- Whether it requires any upstream changes to `effect-durable-operators`.

**Output:** A per-option evaluation, with a recommendation.

**Q7.2.** Independent of which path is chosen in Q7.1: does the restructure require any net-new abstractions in `effect-durable-operators`, or does it work entirely with the existing surface?

Specifically: is there a missing `appendSink()`, `appendEvent(typedEvent)`, or per-stream sequence-allocation primitive that would meaningfully simplify the wrapper?

**Output:** A specific list of upstream changes that would simplify the restructure, with cost/benefit per change.

### Section 8: Test surface

**Q8.1.** Enumerate the tests in `packages/runtime/test/**` (or wherever runtime tests live) that:

- Construct `RuntimeOutputTable`, `RuntimeIngressTable`, or `RuntimeControlPlaneTable` directly.
- Mock specific authority Tags via `Layer.succeed(...)`.
- Integration-test the full `startRuntime` path end-to-end.

Categorize each test by what it would require to migrate under the restructure: trivial (same surface, different layer construction), moderate (some test logic refactor), substantial (rewritten against new primitives).

**Output:** A test-migration cost estimate per category, plus an overall test-refactor scope.

**Q8.2.** Identify any test that depends on cross-table ordering reconstruction (e.g., a test that asserts a run-started row was written before an output-events row by inspecting timestamps or sequences across tables). These tests would benefit from the restructure (total ordering becomes free) but may have implementation assumptions that don't transfer.

**Output:** A list of cross-table-ordering-dependent tests with migration notes.

## Deliverables

The spike should produce a single document with:

### 1. Executive verdict (~1 page)

A direct answer to the load-bearing question:

> Is single-writer-per-context structurally available in `@firegrid/runtime`'s current code?

If **yes**: a recommendation to proceed with the structural restructure, with a rough scope estimate (lines changed, files affected, weeks of work, test migration cost).

If **no**: enumeration of the structural blockers, an assessment of whether they can be removed (and at what cost), and a fallback recommendation (local cleanup or different structural approach).

### 2. Findings tables

The tables produced in Sections 1–8, in a "facts first" section that supports the verdict without interpretation. Reviewers should be able to disagree with the verdict but not with the data.

### 3. Proposed surface (if verdict is "yes")

A draft of the proposed reduced surface:

- The event union schema (full TypeScript).
- The `ContextEventAppender` Tag declaration.
- The `ContextEventLog` Tag declaration.
- Sketches of the migrated authority files (or their absence).
- Sketches of the migrated subscriber files.
- The proposed stream layout (per-context streams, control plane, command stream).
- The proposed materialized indexes (which point lookups need them; how they're implemented).

This is a sketch, not a final design — it's enough for reviewers to assess whether the restructure produces the simplification claimed.

### 4. Migration sequencing (if verdict is "yes")

A proposed PR sequence:

- Which changes can land independently.
- Which changes must land together.
- Dependencies on the plane split.
- Test migration interleaving.
- Risk-staging (smallest reversible change first).

### 5. Open questions

Anything the spike could not resolve, with a clear statement of what would need to be true to resolve each open question (e.g., "needs a load test against a realistic event volume," "needs a decision on multi-host topology priority").

## Constraints

- **No new abstractions invented during the spike**. The spike's job is to determine what's there and what could be simpler. Inventing new abstractions to express what's there is the failure mode that produced the current state.

- **No advocacy**. Both "single-writer-per-context is structurally available; do the restructure" and "it isn't; do the local cleanup" are valid conclusions. The spike's value is in producing the data and a defensible verdict, not in selling a direction.

- **Trace, don't infer**. Every claim in the deliverables must be backed by a file and line reference, a test that exercises a path, or a documented requirement. Inferences from naming conventions are not findings.

- **Time-box the spike**. The spike should take days, not weeks. If a question can't be answered in the time available, it goes in the open-questions section rather than being guessed at.

- **Read `effect-durable-operators` directly**. The TABLE.* requirement comments in `packages/effect-durable-operators/src/DurableTable.ts` are the authoritative description of what that package guarantees. Assumptions about durability semantics must be checked against those comments.

- **Read the existing READMEs critically**. The READMEs in `agent-event-pipeline/` and its subfolders describe an aspirational model. The spike's job is to determine whether the model is correct *and* whether the code reflects it. Both can be wrong independently.

## What success looks like

After this spike, the following can be decided with confidence:

1. **The architectural direction** for the next 1-3 months of substrate work — restructure or local cleanup.
2. **The order** in which work can proceed without rework.
3. **The risks** that determine whether the work is safe to start.
4. **The constraints** the plane split must respect (or be replanned around).
5. **The upstream changes** (if any) that should be proposed to `effect-durable-operators`.

If the spike concludes the restructure is right, the next document is a structural SDD against the proposed surface. If the spike concludes the restructure is wrong, the next document is the local-cleanup SDD with restored confidence that the local cleanup is sufficient.

The unacceptable outcome is starting either path without knowing which is right. The substrate's current state is unmanageable; another round of cleanup-by-abstraction will compound the problem. The spike is the gate that ensures the next move is the right one.

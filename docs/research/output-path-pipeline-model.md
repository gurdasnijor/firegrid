# Research Plan: Output-Path Pipeline Model in `@firegrid/runtime`

## Context for the researcher

You are auditing a subsystem inside `@firegrid/runtime`, Firegrid's stream-native agent runtime built on Effect-TS, `@effect/workflow`, and Durable Streams (via `effect-durable-operators`). The runtime hosts agent processes (raw local processes, ACP-protocol agents, stdio-jsonl agents) and journals their output as durable rows for downstream consumers (subscribers, the workflow engine, eventual SDK plane consumers).

The subsystem has an articulated boundary model documented in `packages/runtime/src/agent-event-pipeline/`:

```
sources → codecs → events → transforms → authorities ─┐
                                                       │ (Stream capability tags)
                                                       ▼
                                                  subscribers ─┐
                                                                │ (writes through authority tags)
                                                                ▼
                                                           authorities
```

The model is documented in three READMEs (`agent-event-pipeline/README.md`, `agent-event-pipeline/authorities/README.md` — implied by file structure, and `agent-event-pipeline/subscribers/README.md`) and stated as:

> Subscribers depend on `Stream` capability tags, not table facades. Write through authority capability tags. Keep protocol-specific send behavior in codecs or active session capabilities.

Two prior cleanup attempts have produced partial pictures:

1. **"Capability Projection Cleanup"** — proposed inlining single-use projection helpers (`projectStream`, `projectAppend`, `projectSink`) into call sites. Rejected after audit: the patterns being named are the standard `Layer.effect(Tag, Effect.map(TableTag, ...))` idiom over `DurableTable`'s existing `rows()` / `upsert(...)` surface, plus a missing `appendSink()` derived view that probably belongs upstream in `effect-durable-operators`.

2. **"Output Journal Seam Cleanup"** — proposed deleting derived-view tags (`RuntimeAgentOutputRowSink`, `RuntimeLogLineSink`, `RuntimeAgentOutputEvents`) from `runtime-output-journal.ts` and rewiring consumers to project locally from narrower tags. Partial — depended on assumptions about consumer counts and dataflow that haven't been fully traced.

The shared concern is: **the file `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts` exports seven `Context.Tag` declarations of three structural shapes (`AppendAndGet`, `Sink`, `Stream`) for one underlying `RuntimeOutputTable`. Some are consumed, some appear dead. The Sink and decoded-Stream tags appear to be derived views of the AppendAndGet writes and the raw `events.rows()` reads, suggesting structural redundancy.**

Adjacent to this, there are four other authority files with similar projection patterns (`runtime-ingress-appender.ts`, `runtime-ingress-delivery-tracker.ts`, `runtime-control-plane-recorder.ts`, `durable-tools/internal/durable-wait-store.ts`). They may or may not share the same redundancy pattern.

Your job is **not** to propose a fix. Your job is to produce the data and the model needed to know whether a clean pipeline model is hiding underneath this complexity, and to make the cost-benefit of consolidation legible.

## Why this needs research, not a code review

The existing analyses keep converging on plausible-but-incomplete answers because they each look at a slice:

- File-local audits show duplicated patterns but don't trace where the duplications terminate.
- Consumer-side traces miss dead exports.
- Layering-rule analyses (the README pattern) miss that some "derived views" exist for ergonomic reasons (Sinks for `Stream.run`) that the rule doesn't address.
- The plane-split SDD assumes certain tags survive as `@firegrid/host-sdk` exports, but no one has reconciled that list with actual current consumers.

The risk of acting on partial pictures: deleting a Tag that's consumed by a test or by an unshipped SDK surface; inlining a pattern that has a real abstraction value at a boundary not visible in any single file; rewriting a Sink as an authority write that has subtly different scoping or error-channel semantics than `Stream.run(sink)`.

The research goal is to enumerate the data flows completely, then determine whether the seven-tag surface is structurally three (write-authority, read-stream, derived-view) and the derived-views can be folded without semantic loss.

## What we already know

### Documented pattern (from `agent-event-pipeline/subscribers/README.md`)

Subscribers consume `Stream` capability tags, perform side effects through narrow durable write capabilities (`AppendAndGet`-shaped) or active codec/session capabilities. They are scoped fibers. They do not provide durable table layers. They do not access table facades directly.

### Confirmed consumers (from files audited)

| Tag | Confirmed consumer | File | Line shape |
|---|---|---|---|
| `RuntimeEventAppendAndGet` | `runRuntimeContext` (raw path) | `host/raw-process-runtime.ts` | `yield* RuntimeEventAppendAndGet` then `.append(row)` |
| `RuntimeLogLineAppendAndGet` | `runRuntimeContext` (raw path) | `host/raw-process-runtime.ts` | `yield* RuntimeLogLineAppendAndGet` then `.append(row)` |
| `RuntimeLogLineAppendAndGet` | `runStderrJournal` | `agent-event-pipeline/subscribers/stderr-journal.ts` | `yield* RuntimeLogLineAppendAndGet` then `.append(row)` |
| `RuntimeAgentOutputRowSink` | `runCodecRuntimeEventPipeline` | `agent-event-pipeline/session-runtime.ts` | `Stream.run(outputSink)` |
| `RuntimeAgentOutputEvents` | `runToolRouter` | `agent-event-pipeline/subscribers/tool-router.ts` | `yield* RuntimeAgentOutputEvents` then `.pipe(Stream.filter(...))` |

### Apparently unused (no consumer found in shared files)

- `RuntimeLogLineSink`
- `RuntimeOutputEvents`
- `RuntimeOutputLogs`

### Layer provision points (confirmed)

`RuntimeOutputJournalLayer` is provided in three places:

1. `host/runtime-context-workflow.ts` — wraps the Activity execute.
2. `host/raw-process-runtime.ts` — wraps `runCodecRuntimeContext` (likely redundant with #1, since the codec path runs inside the Activity).
3. `host/runtime-substrate.ts` — merged into `HostRuntimeObservationSubstrateLive`.

The relationship between #1, #2, and #3 has not been traced. There may be a legitimate reason for redundant provision, or this may be a layering accident.

### `DurableTable` surface (from `effect-durable-operators/src/DurableTable.ts`)

Each `CollectionFacade<Row, Key>` from a `DurableTable` exposes:

- `rows(): Stream.Stream<Row, DurableTableError>` (per `TABLE.28`)
- `upsert(row): Effect.Effect<void, DurableTableError>` (per `TABLE.11`)
- `insert`, `insertOrGet`, `delete`, `get`, `query`, `subscribe`
- **No** `appendSink()` or symmetric Sink-view of `upsert`

This means: deriving a Stream view from `DurableTable` is a one-liner (`table.events.rows()`). Deriving a Sink view requires writing `Sink.forEach(row => table.events.upsert(row))` inline.

### The plane-split context

A separate SDD (`SDD_FIREGRID_HOST_SDK.md`) proposes splitting `@firegrid/runtime` into `@firegrid/runtime`, `@firegrid/host-sdk`, `@firegrid/client-sdk`, `@firegrid/cli` over 7 PRs. The output-path tags may be part of the SDK surface; the plane-split SDD assumes certain tags survive but does not enumerate them against current consumers. This research should not block on the plane split, but should produce data the plane split can use.

## Research questions

These are the questions that, if answered, resolve whether a clean pipeline model exists underneath the current surface.

### Section A: Complete consumer enumeration

**A1.** For every `Context.Tag` exported by these files, list every consumer (production code, tests, type-only imports):

- `agent-event-pipeline/authorities/runtime-output-journal.ts`
- `agent-event-pipeline/authorities/runtime-ingress-appender.ts`
- `agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`
- `authorities/runtime-control-plane-recorder.ts`
- `durable-tools/internal/durable-wait-store.ts`

Method: search by Tag class name across `packages/runtime/**`, `packages/runtime/test/**`, `packages/host-sdk/**` (if exists), and any other in-monorepo consumers. Distinguish three consumption modes: (a) `yield*` in an Effect, (b) `Effect.provideService(Tag, ...)` or layer provision, (c) type-only re-export from a barrel.

Output: a table with columns `Tag | Consumer file | Consumption mode | Surrounding context (one-line)`.

**A2.** For every `Layer` exported by those same files, list every place it is provided. Method: search for `provide(LayerName)`, `provideMerge(LayerName)`, `Layer.mergeAll(..., LayerName, ...)`, and similar. Identify when a layer is provided multiple times along the same effect chain (redundant provision).

Output: a table with columns `Layer | Provision site | Effect/Layer chain it composes into | Notes (e.g., redundant)`.

**A3.** Reverse direction: for every place a `Stream`, `Sink`, or `AppendAndGet`-shaped value is *consumed* in subscriber-style code (forked fibers, `Stream.run`, `Stream.runForEach`, `Stream.runDrain`), identify whether the source is (a) a capability Tag, (b) a locally-built Stream, or (c) a struct field on a Tag service (like `AgentSession.outputs`).

Output: classification of every output-path consumption site by source kind.

### Section B: The codec output write path

**B1.** Trace the codec output write path end-to-end. Starting from `session.outputs` in `runCodecRuntimeEventPipeline`, document every transformation applied before durable write:

- error mapping
- sequencing (`Stream.mapAccum`)
- row construction (`outputRowFromAgentEvent`)
- terminal-event tracking (`Ref` set on `Terminated`)
- Sink termination (`Stream.run(outputSink)`)

For each step, identify whether the transformation is:
- pure (could live in `transforms/`)
- effectful but pipeline-local (must live in composition)
- consuming a capability (could be factored as a subscriber if the input stream became a Tag)

**B2.** Compare the codec output write path to `runStderrJournal`. Both consume a stream and write through an `AppendAndGet` authority. What are the structural differences?

- `runStderrJournal` takes `bytes: AgentByteStream` as a parameter (local stream, not a Tag).
- The codec output path consumes `session.outputs` (local stream from the `AgentSession` service, not a separate Tag).
- `runStderrJournal` writes through `RuntimeLogLineAppendAndGet.append` per-row using `Stream.mapEffect`.
- The codec output path writes through `RuntimeAgentOutputRowSink` using `Stream.run`.

Question: are these two paths the same pipeline pattern, expressed differently? Or are there semantic differences (error propagation, scoping, termination) that justify the different shapes?

**B3.** What would change if `AgentSession.outputs` were exposed as a separate `Context.Tag` (`AgentSessionOutputs`)? Would the codec output write path become a true subscriber (`runCodecOutputJournal` consuming `AgentSessionOutputs`)? Trace the requirement-channel implications.

### Section C: The decoded derived stream (`RuntimeAgentOutputEvents`)

**C1.** `RuntimeAgentOutputEvents` is `RuntimeOutputEvents` with `Stream.map(runtimeAgentOutputObservationFromRow).pipe(Stream.filterMap(value => value))` applied. The transform lives in `events/output.ts`. The decoded shape is only consumed by `runToolRouter`.

Is there any value in the decoded Tag existing as a separate capability, vs. the router constructing the decoded stream locally from `RuntimeOutputEvents` plus the transform?

Method: examine whether any future consumer (planned subscribers, SDK plane consumers, tests) needs the decoded shape pre-built. Check `firegrid-runtime-agent-event-pipeline.*` requirement IDs referenced in the codebase for any commitment to this Tag's existence.

**C2.** Is `RuntimeOutputEvents` (the *non*-decoded raw row Stream) actually unused, or is it consumed somewhere not yet identified? If unused: should it be deleted, or kept as a general capability for future consumers? If deleted, can the decoded shape be projected directly from `RuntimeOutputTable` inside the tool router, removing the need for both Tags?

### Section D: The Sink question

**D1.** `RuntimeAgentOutputRowSink` is `Sink.forEach(row => table.events.upsert(row))`. `RuntimeLogLineSink` has the same shape over logs. The first is consumed once (`session-runtime.ts` `Stream.run(outputSink)`); the second has no known consumer.

Question 1: are Sinks the right shape for these capabilities, or are they a workaround for the absence of an `appendSink()` derived view on `DurableTable`?

Question 2: if the codec output path were rewritten as `Stream.runForEach(row => eventAppendAndGet.append(row))`, what changes? Specifically:

- error channel: `AppendAndGet.append` returns `Effect<Row, unknown>`; `Stream.run(Sink)` returns `Effect<void, StreamError | SinkError>`. Are the error types compatible?
- scoping: `Sink.forEach` runs each effect in sequence within the consuming fiber. `Stream.runForEach(append)` does the same. Equivalent?
- termination: how does `Stream.takeUntil(({ event }) => event._tag === "Terminated")` interact with each form?

Question 3: if `effect-durable-operators` added `appendSink(): Sink.Sink<void, Row, never, DurableTableError>` as a derived view, would that change the answer? Specifically: would `RuntimeAgentOutputRowSink` become `Effect.map(RuntimeOutputTable, t => t.events.appendSink())`, eliminating the helper but keeping the Tag, or would the Tag still be redundant?

### Section E: Symmetry across the four other authority files

**E1.** For each of `runtime-ingress-appender.ts`, `runtime-ingress-delivery-tracker.ts`, `runtime-control-plane-recorder.ts`, `durable-wait-store.ts`:

- Enumerate the structural shapes of exported Tags: pure write (`AppendAndGet`), pure read (`Stream`), composed write (multi-source reads + Append), composed read (e.g., idempotent claim), Sink, derived/decoded Stream.
- Identify which Tags are consumed by exactly one subscriber/composition site (candidates for inlining into the consumer).
- Identify which Tags are consumed by multiple sites or planned-multi-site consumers (must remain as capabilities).

**E2.** Compare the projection patterns across all five files. Are there cases where the same conceptual pattern (e.g., "Stream view of table X.rows()") is expressed differently in different files, suggesting an inconsistency rather than a justified divergence?

**E3.** Are there cross-file patterns? For example: is there a "subscriber writes through one authority, observes another" pattern that recurs and could be factored?

### Section F: The plane-split surface

**F1.** Read `SDD_FIREGRID_HOST_SDK.md` and identify which of the output-path Tags are mentioned as part of the `@firegrid/host-sdk` export surface. Compare against the consumer enumeration from Section A: is the plane-split SDD assuming Tags survive that have no current consumers? Is it forgetting Tags that have current consumers?

**F2.** Does the plane-split SDD impose any constraints on the output-path Tag shape that this cleanup must preserve? For example: must `RuntimeEventAppendAndGet` remain in its current file path because the plane split moves files around it?

### Section G: The redundant `RuntimeOutputJournalLayer` provision

**G1.** Trace the effect chain from `RuntimeContextWorkflowLayer` through `runRuntimeContext` to `runCodecRuntimeContext`. Confirm whether the `Effect.provide(RuntimeOutputJournalLayer)` inside `runCodecRuntimeContext` is genuinely redundant with the same provision at the `runRuntimeContextActivity` boundary, or whether there's a subtle scoping/`Layer.memoize` reason both are required.

**G2.** Same question for `HostRuntimeObservationSubstrateLive` (in `runtime-substrate.ts`), which also merges `RuntimeOutputJournalLayer`. Where is `HostRuntimeObservationSubstrateLive` consumed, and does that consumption path also flow through `RuntimeContextWorkflowLayer`, or is it a separate chain (suggesting both provisions are needed for different paths)?

### Section H: Error and scoping invariants

**H1.** Document the error channel for each output-path consumer:

- `runRuntimeContext` raw path: `RuntimeContextError` after `mapRuntimeContextError`.
- `runStderrJournal`: `RuntimeContextError`.
- `runCodecRuntimeEventPipeline`'s `Stream.run(outputSink)` block: `RuntimeContextError` after `mapRuntimeContextError`.
- `runToolRouter`: `RuntimeContextError`.

Are these all reaching the authority through the same error-channel discipline? Is there any case where the current Sink/Stream Tag indirection is doing error-mapping work that a direct `AppendAndGet.append` call would skip?

**H2.** Document the `Scope` boundaries. `RuntimeOutputJournalLayer` is layer-provided; its underlying `RuntimeOutputTable` is `Scope`-acquired. When the Sink Tag is consumed via `Stream.run(outputSink)`, the Sink closes over the table reference. If the Tag were removed and the consumer called `RuntimeEventAppendAndGet.append` directly, would the scope semantics be identical?

### Section I: Test coverage of the current surface

**I1.** What tests, if any, exercise the output-path Tags directly? Categorize:

- Tests that instantiate `RuntimeOutputJournalLayer` and yield specific Tags.
- Tests that mock/fake specific Tags via `Layer.succeed(Tag, fake)`.
- Integration tests that go through `startRuntime` and exercise the full chain.

This determines the test refactoring cost of any consolidation. A Tag that's mocked in three integration tests is harder to delete than a Tag with no test consumers.

## Deliverables

The research should produce:

### 1. Consumer enumeration table (Section A)

A single Markdown table with one row per (Tag, consumer) pair across all five authority files, with columns:

```
Tag | Source file | Consumer file | Consumer kind (yield/provide/re-export) | Multiplicity (single/multi/none)
```

This is the load-bearing deliverable. Everything else is interpretation; this is data.

### 2. Layer provision graph (Section A2 + G)

A directed graph (Markdown is fine; Mermaid if helpful) showing which Layers provide which Tags, and which provision sites compose into which effect chains. Highlight redundant provisions.

### 3. Codec output path trace (Section B)

A step-by-step walkthrough of the `runCodecRuntimeEventPipeline` output-write loop, with each transformation classified (pure / pipeline-local / capability-consuming) and a comparison to `runStderrJournal`.

### 4. Sink semantic equivalence finding (Section D)

A clear answer to: "if `RuntimeAgentOutputRowSink` were replaced by `Stream.runForEach(eventAppendAndGet.append)` at the one call site, would the resulting behavior be identical?" with citations to the error-channel, scoping, and termination evidence.

### 5. Plane-split reconciliation (Section F)

A table comparing the plane-split SDD's claimed `@firegrid/host-sdk` exports against the actual consumer list. Flag mismatches in both directions.

### 6. Symmetry assessment (Section E)

For each of the five authority files, a classification of every exported Tag as one of:

- **Necessary**: multi-consumer or required-by-future-consumer capability.
- **Single-consumer**: candidate for inlining into the unique consumer.
- **Derived**: structurally a derived view of a more primitive Tag (Sink over `upsert`, decoded Stream over raw `rows()`); candidate for deletion if consumer projects locally.
- **Dead**: no consumer in production, test, or plane-split SDK surface.

### 7. Final assessment

A short prose section answering:

**Question 1.** Is there a single clean pipeline model hiding under the current surface? Specifically: does the data support reducing the seven output-path Tags to two `AppendAndGet` writes (events, logs) plus one `Stream` read (events) plus zero Sinks plus zero decoded views — with composition writing through `AppendAndGet` directly and the tool router projecting its decoded shape locally?

If yes: what are the blockers to that reduction (test refactoring, plane-split commitments, future planned consumers)?

If no: what is the smallest set of Tags that captures the actual capability surface, and why does each survivor justify its existence?

**Question 2.** Does the symmetry across the other four authority files support generalizing the same reduction pattern, or does each file have file-specific reasons to keep its current shape?

**Question 3.** Is there a candidate upstream change (e.g., `appendSink()` on `effect-durable-operators`) that, if made, would meaningfully simplify this cleanup? Or are all the relevant abstractions already in place at the right layer?

## Constraints

- **Do not propose code changes.** Produce data and interpretation only. Code changes are a separate document.
- **Do not assume the existing SDDs are correct.** If the consumer enumeration contradicts what the plane-split SDD assumes, flag the contradiction without resolving it.
- **Do not optimize for a specific framing.** Both "everything is a derived view, collapse to AppendAndGet + Stream" and "the current surface reflects real distinctions, keep it" are valid conclusions if the data supports them.
- **Quote file paths verbatim** when referencing files. The codebase has long paths and similar file names; precision matters.
- **Cite specific lines or symbols** when claiming a consumer or non-consumer relationship. "No consumer found" is a claim about a search; describe the search.

## Method notes

- Use `grep` / `rg` over `packages/runtime/**` and any sibling packages for Tag class names. Tag classes are `Context.Tag("@firegrid/runtime/X")<X, ...>`. Search for both the class name and the string identifier.
- Distinguish Tag class re-exports (in `index.ts` barrel files) from actual consumers.
- `Effect.provideService` and `Layer.succeed(Tag, ...)` are provision sites; `yield* Tag` and `Effect.flatMap(Tag, ...)` are consumption sites.
- For Stream-shaped Tags, also search for the Tag being passed to `Stream.provideService`.
- Read tests in `packages/runtime/test/**`, `packages/runtime/src/**/*.test.ts`, and any `__tests__/` directories.
- Check `host/index.ts` and similar barrel files for public re-exports that might constitute an external consumer surface.

## What success looks like

After this research, the next document (the actual cleanup SDD or refactor PR plan) can be written from facts rather than inferences. Specifically:

- Every Tag has a documented consumer list (including "none").
- Every redundant Layer provision is either justified or flagged for removal.
- The Sink-vs-direct-`append` question has a definitive answer, not a hand-wave about likely-equivalence.
- The plane-split SDD's output-path commitments are reconciled with reality.
- The symmetry question across the five authority files is answered with data, not by analogy from one file.

If the answer to "is there a single clean pipeline model" is yes, the data justifies the consolidation in a way reviewers can verify. If the answer is no, the survivors are each justified by named consumers and use cases.

Either outcome is acceptable. The unacceptable outcome is acting on partial data and discovering, mid-PR, that a "dead" Tag was actually consumed by a test, or that a "redundant" Layer provision was load-bearing for `Layer.memoize` reasons, or that the plane split was depending on a Tag shape we just deleted.
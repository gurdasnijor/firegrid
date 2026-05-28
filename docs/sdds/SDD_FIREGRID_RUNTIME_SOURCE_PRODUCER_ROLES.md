# SDD: Source / Producer Role Split In `packages/runtime/`

Status: **accepted** (path chosen, migration sequenced below)
Created: 2026-05-28
Owner: Firegrid Runtime
Related issue: #756 (umbrella for directory-refactor follow-ups), #757, #758, #759, #760, #761

Related specs / docs:

- `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
- `docs/cannon/architecture/runtime-design-constraints.md`
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
- `packages/runtime/ARCHITECTURE.md`
- `packages/runtime/src/producers/README.md`

## Decisions (recorded)

1. **Adopt Option 1** — flat Kafka-broker-style split. `sources/` for
   emitters (no row authority); `producers/` for topic-writers (write to
   `tables/`). Rationale below.
2. **Keep the name `producers/`** for the topic-writer tier. Kafka client
   vocab is the dominant term in the ecosystem; existing dep-cruiser /
   semgrep rules already use it. The conceptual ambiguity only existed
   because two roles shared the folder — with `sources/` standing apart,
   `producers/` reads unambiguously.
3. **Add a new `capabilities/` tier** for typed Producer capability
   `Context.Tag` declarations. Pure declarations only; importable from
   both `producers/` (provides Live) and `subscribers/` (consumes).
   Mirrors how `events/` works (pure schemas, importable from any tier).
4. **Split `verified-webhook-ingest/`** into the tier folders now (not
   later). It is the only Connect-shaped feature in the tree; leaving it
   as an exception under an otherwise flat-split layout is debt that gets
   harder to clean up once another adapter copies the pattern. Future
   external adapters (Linear, Slack, GitHub) land into the tier folders
   directly.

## Problem

The `producers/` folder under `packages/runtime/src/` collects two roles that
the rest of the codebase has started treating as distinct:

1. **Emitters of events.** Live boundaries that produce a typed event stream
   and do not touch durable rows.
   - `producers/sandbox/` — sandbox process boundary, exposes
     `AgentByteStream` and process events.
   - `producers/codecs/` — `AgentSession` (Effect Context.Tag) carrying
     `outputs: Stream<AgentOutputEvent, ...>` plus a scoped `send`.

   Neither imports `tables/`. Neither writes durable rows.

2. **Authoritative writers to durable tables ("topics").** Things that take
   an event stream (from an emitter, or from a webhook, or from a workflow
   step) and append rows to a specific `DurableTable`.
   - `tables/scheduled-prompt-append.ts:appendScheduledPromptIntent`
     (mis-placed in `tables/`; see #756 D).
   - `composition/host-public.ts:appendRuntimeIngress`
     (mis-placed in `composition/`; see #756 D).
   - `producers/ingress-writers/` — the documented but unbuilt home for
     these (see #756 E).

The folder name `producers/` reads against both roles. As an industry term it
matches role 2 (a Kafka-style "producer to a topic"). As a folder containing
`sandbox/` and `codecs/` it reads as role 1 (a "source of events"). The
previously deprecated `sources/` alias for the public subpath captures the
ambiguity in a single artifact: the same surface had two reasonable names
because two roles were collected at peer level.

The conflation has produced concrete debt:

- The `subscribers/` → `producers/` import ban (correct for the
  authoritative-writer role) blocks Shape D subscribers from importing the
  emitter contracts (`AgentSession`) — which they wouldn't need to import
  anyway if the role were named clearly, because emitters don't appear in a
  subscriber's `R` channel.
- `tables/scheduled-prompt-append.ts` and
  `composition/host-public.ts:appendRuntimeIngress` are role-2 functions in
  role-1-or-3 folders. Both folders' READMEs explicitly disclaim the
  responsibility. The author left a comment justifying the misplacement.
- `producers/ingress-writers/` cannot be populated without resolving which
  role `producers/` *means*.

This SDD proposes a vocabulary and a tier split that aligns with prior art
in stream processing systems.

## Prior Art Survey

Across stream processing engines the same two roles consistently appear, and
in journal-based systems they get distinct names.

### Apache Kafka (broker + clients)

- **Producer** — client that appends records to a topic. Owns
  serialization, key partitioning, idempotency, and the `send()` surface.
- **Consumer** — client that reads from a topic.
- **Topic** — durable, partitioned, append-only log.

"Producer" in Kafka is unambiguous: it writes to a topic. There is no
"source" at the broker layer.

### Kafka Connect

A higher-level framework for moving data into and out of Kafka.

- **Source Connector** — pulls data from an external system *into* a Kafka
  topic. Internally constructs a Producer client to do the actual writes.
  Examples: Debezium MySQL connector, JDBC source, file source.
- **Sink Connector** — pushes data from a Kafka topic *to* an external
  system. Internally constructs a Consumer.

Connect explicitly nests the two: a Source Connector *contains* a Producer.
The Source role is "I know how to listen to an external system and turn it
into events"; the Producer role is "I know how to write events to topic X
durably and idempotently". Both responsibilities exist in a single Source
Connector, but they are named distinctly inside its implementation.

### Kafka Streams (processor API)

- **Source Processor** — a topology node that reads from a Kafka topic.
- **Sink Processor** — a topology node that writes to a Kafka topic.
- **Stream Processor** — a transformation node in between.

Same split as Connect, just inside the topology DSL. A Source Processor
*reads* a topic; a Sink Processor *writes* a topic. Note: Streams uses
"Source" for the reader role, opposite to Connect, because Streams sits on
top of existing topics rather than ingesting external data into them.

### Apache Flink

- **Source** (`Source` API / legacy `SourceFunction`) — connects to an
  external system, emits events into the dataflow. Examples: KafkaSource,
  FileSource.
- **Sink** — terminal node writing to an external system.
- **Operator** — transformation node.

Flink is significant for *not* having a producer/journaler tier distinct
from the source. The dataflow itself is the abstraction; durability is
provided by checkpointing rather than an explicit log layer between
source and operator. Flink treats Source's job as "emit into the dataflow"
and the dataflow's job as "remember enough to recover". This is the
opposite design choice from Kafka Connect.

### Apache Beam

- **PTransform** — the generic transformation unit.
- **Read** transforms — IO sources (`KafkaIO.read()`, `TextIO.read()`).
- **Write** transforms — IO sinks.

Beam is purely Source/Sink, no Producer/Journaler tier — but Beam, like
Flink, hides the durable journal behind the runner.

### Apache Pulsar

Identical Kafka-family vocabulary: Producer (writes to topic), Consumer
(reads from topic), Source Connector and Sink Connector for external
adapters.

### NATS JetStream

- **Publisher** — writes messages to a Stream.
- **Consumer** — reads from a Stream.
- **Stream** — persistent message log.

"Publisher" is the Producer-equivalent name; the source-vs-publisher split
is left to application-level adapters.

### Akka Streams / Reactive Streams / Effect

- **Source** — emits elements as a `Stream`/`Publisher`.
- **Flow / operator** — transformation.
- **Sink** — terminal consumer.

Pure in-memory stream libraries have no durable journal and therefore no
producer-to-topic abstraction. Their `Sink` plays the role of a terminal
writer (which may incidentally write to durable storage). Effect's
`Stream`/`Sink` are in this lineage.

### Synthesis

Across systems that explicitly model a durable journal as their middle
layer (Kafka, Pulsar, NATS), the two roles get distinct names:

| Role | Kafka / Pulsar | Kafka Streams | NATS | Flink / Beam |
| --- | --- | --- | --- | --- |
| External → system emitter | Source Connector | (n/a, sits on topics) | Source app | Source |
| Writer to durable topic | Producer | Sink Processor | Publisher | (fused into Source) |
| Reader of durable topic | Consumer | Source Processor | Consumer | (fused into operators) |
| System → external writer | Sink Connector | (n/a) | Sink app | Sink |

The systems with an explicit durable middle layer (top three rows) all
distinguish the emitter role from the topic-writer role. The systems
without one (Flink/Beam) fuse them.

`firegrid` *has* an explicit durable middle layer — `tables/` are the
topics. Its naming should follow Kafka-family prior art, not Flink/Beam.

## Mapping Firegrid To The Kafka-Family Pattern

If `tables/` are firegrid's topics, then:

| Industry role | Firegrid current location | Firegrid target |
| --- | --- | --- |
| Topic (durable journal) | `tables/` | `tables/` (unchanged) |
| Source (external → emitter) | `producers/sandbox/`, `producers/codecs/` | `sources/` |
| Producer (writer to topic) | `producers/ingress-writers/` (planned), `tables/scheduled-prompt-append.ts` (mis-placed), `composition/host-public.ts:appendRuntimeIngress` (mis-placed) | `producers/` (re-scoped) or `journalers/` |
| Operator (pure transform) | `transforms/` | `transforms/` (unchanged) |
| Consumer (reads topic, acts) | `subscribers/` | `subscribers/` (unchanged) |
| Sink Connector (system → external) | none yet | (future) |

The dataflow becomes:

```text
sources/ -> producers/ -> tables/ -> transforms/ -> subscribers/
            (a.k.a.       (topics)   (operators)   (consumers)
            journalers)
```

Each Source is a pure emitter exposing an Effect `Stream` (or a session
contract whose output is a `Stream`). Each Producer is a layer that takes a
Source's stream and a `tables/` write capability, and binds them into a
`Layer.scopedDiscard` (or equivalent) that journals events to the table. The
Producer's body looks like `stream.pipe(Stream.run(Sink.forEach(append)))`.

The Effect-native shape lines up cleanly:

- Source contract: `Layer<SomeSourceTag>` where `SomeSourceTag` provides a
  `Stream` or a session whose `outputs: Stream<...>` field is the emitter.
  Pure read.
- Producer contract: `Layer<never, E, SourceTag | TableWriteTag>` —
  a no-output driver layer that owns the `Stream.run(append)` body.
- Subscriber contract: depends on a typed `Stream` over a `tables/` read
  capability, plus any Producer-supplied write capability tag.

## Why This Resolves The Outstanding Items

- **A (naming)** — `sources/` regains a precise meaning (emitter, no
  durable writes). `producers/` regains a precise meaning (topic writer).
  No more aliased subpaths competing for the same role.

- **D (append authority leaking)** —
  `appendScheduledPromptIntent` and `appendRuntimeIngress` are Producer-
  shaped functions and move into `producers/` cleanly. `tables/` and
  `composition/` shed the disclaimer paragraphs.

- **E (`producers/ingress-writers/`)** — the whole `producers/` tier IS
  the ingress-writers tier under the new mapping. The
  `producers/ingress-writers/` subfolder becomes redundant; ingress writers
  just live directly under `producers/`.

- **F (verified-webhook-ingest split)** — `verified-webhook-ingest/`
  bundles an emitter, a producer, and a table. Under Kafka-Connect
  vocabulary this is a "Source Connector" (a single feature that brings
  external data in). Two paths consistent with the new vocab:
  - Treat it as canonical: each external adapter is a self-contained
    feature folder, parallel to `sources/` and `producers/` but bundled
    per adapter. Matches Kafka Connect physically.
  - Treat it as exceptional: split into `sources/webhook-ingest/`,
    `producers/webhook-ingest-writer.ts`, `tables/webhook-ingest-facts.ts`.
    Matches Kafka Streams' flat layout.
  Either is internally consistent under the new mapping. This SDD does not
  pin one; it is an explicit follow-up.

- **G (`runtime-context-session*`)** — orthogonal to source/producer naming
  and not addressed here.

- **The subscribers → producers tier rule** — stays. Under the new
  mapping the rule means "subscribers don't write rows" — which is precisely
  the invariant the existing dep-cruiser rule was reaching for. Subscribers
  may still depend on **typed Producer capability tags** through the
  `R` channel; the Tag is allowed to live in `channels/` or a new
  `capabilities/` folder. This is the "typed capability tag" path proposed
  in `producers/ingress-writers/README.md` (PR #760), now naturally fitting
  the renamed tier.

## Options

### Option 1: Kafka-broker-style flat split — **ACCEPTED**

```text
packages/runtime/src/
├── events/
├── tables/                    # topics
├── sources/                   # emitters — return Stream or session
│   ├── sandbox/
│   └── codecs/
├── producers/                 # writers to topics
│   ├── per-context-output.ts     # AgentSession.outputs -> RuntimeOutputTable
│   ├── runtime-input-append.ts   # external input -> RuntimeControlPlaneTable.inputIntents
│   └── scheduled-prompt-append.ts
├── transforms/
├── channels/
├── subscribers/
└── composition/
```

- Pro: each tier names exactly one role; matches Kafka client vocab; the
  dataflow `sources → producers → tables → transforms → subscribers`
  reads as one direction.
- Pro: resolves D and E by construction.
- Con: partially reverts PR #758 (which deprecated `sources/` as an alias);
  the **subpath name** comes back but its meaning is now narrower than the
  old alias was. The old `sources/sandbox` lived next to ingress-writers in
  the same folder; the new `sources/sandbox` lives in a tier with no row
  authority.
- Con: external adapters that bundle source+producer+table (today's
  `verified-webhook-ingest/`) now have to choose between adjacent-feature
  style and tier-style. F becomes a follow-on decision.

### Option 2: Kafka-Connect-style nesting — rejected

```text
packages/runtime/src/
├── events/
├── tables/
├── connectors/                # per-adapter bundles (Connect-style)
│   ├── sandbox/
│   │   ├── source.ts             # AgentByteStream / process emitter
│   │   └── producer.ts           # bytes -> RuntimeOutputTable rows
│   ├── codecs/
│   │   ├── source.ts             # AgentSession contract + stdio-jsonl + acp
│   │   └── producer.ts           # AgentSession.outputs -> RuntimeOutputTable
│   ├── verified-webhook-ingest/  # already shaped this way
│   └── runtime-input/
│       └── producer.ts           # external input -> input intents
├── transforms/
├── channels/
├── subscribers/
└── composition/
```

- Pro: makes `verified-webhook-ingest/` the canonical shape rather than
  the exception.
- Pro: a contributor adding a Linear or Slack ingress adapter has a
  clear, self-contained landing zone.
- Con: deep nesting; per-adapter folders mix two roles that we are
  otherwise trying to keep separate at tier level.
- Con: a "producer that doesn't have its own source" (e.g., a workflow
  step that writes a row) has no obvious home.

### Option 3: Flink-style fused source (status quo + cleanup) — rejected

Keep `producers/` as one folder for both roles; close out the umbrella
items by relaxing the `subscribers/ ✗ producers/` rule with a narrow
carveout for Shape D writers. No structural rename.

- Pro: no churn.
- Con: the conceptual overload remains; the producer/source ambiguity
  recurs every time a new ingress adapter lands.

## Rationale For The Chosen Path

### Why Option 1 over Option 2

The reality on disk already wants the flat split. Two of three things in
today's `producers/` are pure emitters (`sandbox/`, `codecs/`) — they
neither import `tables/` nor write rows. The "topic-writer" role is
currently scattered across `tables/scheduled-prompt-append.ts` and
`composition/host-public.ts:appendRuntimeIngress` as homeless functions.
Option 1 is just naming what's there.

Option 2 (Connect-nesting) would force us to disassemble
`composition/host-live.ts` to extract per-adapter Producer files that
don't currently exist as standalone modules. That's a much larger
restructure, undertaken before we have multiple external adapters to
justify the bundle shape. If future adapters concentrate at the system
edge in a way that argues for re-bundling, we can revisit; today there is
exactly one (`verified-webhook-ingest/`) and we don't want it to dictate
the tier shape.

### Why keep `producers/` (not rename to `journalers/`)

Kafka client "Producer" is the dominant vocabulary in stream processing
systems with an explicit durable topic layer (Kafka, Pulsar, NATS).
Existing dep-cruiser and semgrep rules already reference `producers/`;
keeping the name minimizes rename mechanics. The conceptual ambiguity
went away the moment `sources/` lifted the emitter role out of the folder.

### Why a new `capabilities/` folder for Tags

The Tag is a contract, not behavior — it is to a `Layer` what an event
schema is to an event row. `events/` already establishes the pattern:
pure declarations, importable from any tier. A peer `capabilities/`
folder for Effect `Context.Tag` declarations:

- keeps the `subscribers/ ✗ producers/` dep-cruiser rule precise and
  mechanically enforceable (subscribers depend on Tags from
  `capabilities/`, never on `producers/` files);
- avoids overloading `channels/`, whose existing meaning is "wire-edge
  live routing" (`host-control/`, `routes/`, `router.ts`);
- avoids a file-naming convention (`*-live.ts` vs `*-tag.ts`) that
  dep-cruiser doesn't model cleanly.

### Why split `verified-webhook-ingest/` now

It is small (one schema, one key encoder, one ingest adapter). Living as
the only Connect-shaped feature in an otherwise flat-split tree is
conceptual debt that gets harder to clean up once another adapter copies
the pattern. Future adapters (Linear, Slack, GitHub) land cleanly into
the tier folders. If a future requirement argues for re-bundling under
Connect-style nesting, that decision is reversible — re-bundling three
small files is cheap, but unwinding the convention "external adapters
bundle their own table+writer" once two or three of them exist would not
be.

## Target Tier Graph

After migration:

```text
packages/runtime/src/
├── events/                    # 1.  pure event/row schemas
├── capabilities/              # 1b. pure Effect Context.Tag declarations (NEW)
├── tables/                    # 2.  durable topics (DurableTable definitions)
├── sources/                   # 3a. emitters — return Stream / session contract
│   ├── sandbox/
│   ├── codecs/
│   └── webhook-ingest/        # (was: verified-webhook-ingest/ — emitter half)
├── producers/                 # 3b. topic writers — consume Stream, append to tables
│   ├── per-context-output.ts
│   ├── runtime-input-append.ts
│   ├── scheduled-prompt-append.ts
│   └── webhook-ingest-writer.ts
├── transforms/                # 4.  pure row/event transforms
├── channels/                  # 5.  wire-edge live routing
├── subscribers/               # 6.  Shape B/C/D consumers
└── composition/               # 7.  Layer wiring only
```

### Dep-cruiser rule updates

| Tier | May import | Must not import |
| --- | --- | --- |
| `events/` | (none from runtime tree) | everything else |
| `capabilities/` | `events/`, `tables/` (Tag schemas may reference row types) | `sources/`, `producers/`, `transforms/`, `channels/`, `subscribers/`, `composition/` |
| `tables/` | `events/` | everything else from runtime |
| `sources/` | `events/`, `capabilities/` | `tables/`, peers (`producers/`, `transforms/`, `channels/`), `subscribers/`, `composition/` |
| `producers/` | `events/`, `capabilities/`, `tables/`, `sources/` | peers (`transforms/`, `channels/`), `subscribers/`, `composition/` |
| `transforms/` | `events/` (current) | unchanged |
| `channels/` | `events/`, `tables/`, `capabilities/` | `sources/`, `producers/`, `subscribers/`, `composition/` |
| `subscribers/` | `events/`, `capabilities/`, `tables/`, `transforms/`, `channels/` | `sources/`, `producers/`, `composition/` |
| `composition/` | every lower-order folder (Layer assembly only) | nothing imports `composition/` |

The critical change: subscribers depend on Producer capabilities through
**Tags in `capabilities/`**, never by importing `producers/` directly.
This preserves the "subscribers don't write rows" invariant mechanically.

## Sequenced PR Plan

Five active migration PRs, each landable independently behind a single
deprecation window for the legacy public subpaths. PRs already open are
either independent (land them) or blocked by this decision (close and
roll forward).

### Status of currently open PRs

| PR | Disposition |
| --- | --- |
| #757 (stale doc sweep) | **Land.** Independent of this decision. |
| #758 (sandbox imports → `producers/` canonical) | **Close.** Superseded by PR-M1 which moves the canonical name back to `sources/`. |
| #759 (test layout mirrors src/) | **Land.** Independent. |
| #760 (`producers/ingress-writers/` scaffold) | **Close.** The whole subfolder becomes redundant under Option 1; its job is absorbed into the renamed `producers/` tier. |
| #761 (this SDD) | **Land** to record the decision. |

### PR-M1 — Foundation: `capabilities/` tier + `sources/` tier

Scope:

- Create `packages/runtime/src/capabilities/README.md` (empty otherwise).
- Move `producers/sandbox/` → `sources/sandbox/`.
- Move `producers/codecs/` → `sources/codecs/`.
- Update all internal imports (one-time depth fix + path rename).
- Add public subpath exports `@firegrid/runtime/sources/sandbox` and
  `@firegrid/runtime/sources/codecs` in `packages/runtime/package.json`.
- Keep `@firegrid/runtime/producers/sandbox` and
  `@firegrid/runtime/producers/codecs` as deprecation-window aliases.
- Update `.dependency-cruiser.cjs` to declare `sources/`, `capabilities/`,
  and the new `subscribers/ ✗ sources/` ban.
- Update `.semgrep.yml` host-sdk import patterns to allow
  `@firegrid/runtime/sources/*`.
- Update `scripts/runtime-public-surface-check.mjs` required-surface list.
- Update `packages/runtime/ARCHITECTURE.md` and the target-tree doc to
  describe the two tiers.

Verification: typecheck + full vitest + all four boundary scripts.

### PR-M2 — `scheduled-prompt-append` into `producers/`

Scope:

- Create `capabilities/scheduled-prompt-ingress.ts` with
  `ScheduledPromptIngressAppender` `Context.Tag`.
- Move `tables/scheduled-prompt-append.ts` →
  `producers/scheduled-prompt-append.ts`. The Live binding now consumes
  the Tag from `capabilities/` and is provided by the host layer.
- Update `subscribers/scheduled-prompt/workflow.ts` to depend on the
  Tag from `capabilities/`, not on the producer module.
- Update `composition/host-live.ts` to provide the Live binding.
- Update `tables/README.md` to drop the "Known exception" paragraph.

Verification: typecheck + targeted vitest (`test/subscribers/scheduled-prompt/`,
`test/tables/`) + scripts.

### PR-M3 — `appendRuntimeIngress` into `producers/`

Scope:

- Create `capabilities/runtime-input-ingress.ts` with
  `RuntimeInputAppender` `Context.Tag`.
- Create `producers/runtime-input-append.ts` with the Live binding,
  carrying the body currently inline in
  `composition/host-public.ts:appendRuntimeIngress`.
- Reduce `composition/host-public.ts:appendRuntimeIngress` to a thin
  facade that resolves the Tag and forwards.
- Update `composition/host-live.ts` to provide the Live binding.

Verification: typecheck + vitest (`test/composition/`, host-public callers
in factory/flamecast if any) + scripts.

### PR-M4 — Split `verified-webhook-ingest/`

Scope:

- Move the fact-row schema → `tables/webhook-ingest-facts.ts`.
- Move the key encoder → `transforms/webhook-ingest-key.ts` (pure).
- Move the ingest adapter → `sources/webhook-ingest/` and
  `producers/webhook-ingest-writer.ts` (the writer half consumes the
  source stream and appends to `tables/webhook-ingest-facts`).
- Update host-sdk webhook entrypoints accordingly.
- Delete `packages/runtime/src/verified-webhook-ingest/`.

Verification: typecheck + vitest
(`test/verified-webhook-ingest/adapter.test.ts` moves to follow the new
homes) + scripts.

### PR-M5 — Cleanup + docs

Scope:

- Delete `producers/ingress-writers/` scaffold (purpose absorbed into
  `producers/`).
- Sweep `packages/runtime/ARCHITECTURE.md`, the target-tree doc, and the
  per-folder READMEs to reflect the final tier graph + dep-cruiser rule
  table.
- Sweep `test/` layout if PR-M4 changed test homes
  (test layout follows the rules in #759).
- Audit `@firegrid/runtime/producers/{sandbox,codecs}` alias callsites
  outside the runtime package; track remaining external callers.

### PR-M6 — (Deferred) Drop legacy aliases

After at least one release with the deprecation aliases in place:

- Remove `./producers/sandbox` and `./producers/codecs` exports from
  `packages/runtime/package.json`.

## Open Items Not In Scope For This SDD

- **G (`runtime-context-session` vs `runtime-context-session-workflow`)** —
  orthogonal naming question; handled in a separate follow-up.
- **C (channels/ cutover)** — independent of source/producer split;
  channels keep their existing role under the new mapping.
- **Future external adapter shape** — if Linear / Slack / GitHub adapters
  arrive and pull toward Connect-style bundles, revisit Option 2 then.

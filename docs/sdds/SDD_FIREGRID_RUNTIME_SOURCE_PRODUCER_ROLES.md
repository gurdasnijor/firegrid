# SDD: Source / Producer Role Split In `packages/runtime/`

Status: draft proposal
Created: 2026-05-28
Owner: Firegrid Runtime
Related issue: #756 (umbrella for directory-refactor follow-ups), #757, #758, #759, #760

Related specs / docs:

- `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
- `docs/cannon/architecture/runtime-design-constraints.md`
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
- `packages/runtime/ARCHITECTURE.md`
- `packages/runtime/src/producers/README.md`

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

### Option 1: Kafka-broker-style flat split (proposed)

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

### Option 2: Kafka-Connect-style nesting

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

### Option 3: Flink-style fused source (status quo + cleanup)

Keep `producers/` as one folder for both roles; close out the umbrella
items by relaxing the `subscribers/ ✗ producers/` rule with a narrow
carveout for Shape D writers. No structural rename.

- Pro: no churn.
- Con: the conceptual overload remains; the producer/source ambiguity
  recurs every time a new ingress adapter lands.

## Recommendation

**Option 1** (Kafka-broker-style flat split).

Reasoning: firegrid already commits to an explicit durable topic layer
(`tables/`), which is the Kafka-family architectural assumption.
Naming the tiers around the Kafka-broker producer/consumer split makes the
dataflow read in one direction with no overloaded roles, and resolves the
recorded debt items D and E by construction. The Connect-nesting option
(Option 2) is more attractive *only if* multiple external adapters are
imminent; absent that, the flat split keeps the tier graph small.

Option 2 should be re-evaluated together with item F when the next
external ingress adapter (Linear / Slack / GitHub / similar) lands.

## Migration Sketch (if Option 1 is accepted)

This is a sketch, not a step-by-step. A separate implementation SDD or PR
should pin the order.

1. Pause / close PRs #758 (naming alias deprecation) and #760
   (`producers/ingress-writers/` scaffold) since both presume the current
   tier naming. PR #757 (stale doc sweep) and PR #759 (test layout)
   are independent of the naming question and can land as-is.
2. Add `sources/` to the public-surface map and the dep-cruiser rules. Its
   tier position is **3a**, peer with the renamed `producers/` (3b),
   peer with `transforms/` and `channels/`. `sources/` may NOT import
   `tables/`.
3. Move `producers/sandbox/` → `sources/sandbox/`. Move
   `producers/codecs/` → `sources/codecs/`. Update internal imports.
   Add `@firegrid/runtime/sources/sandbox` and
   `@firegrid/runtime/sources/codecs` exports; keep the
   `@firegrid/runtime/producers/*` aliases for a deprecation window.
4. Move `tables/scheduled-prompt-append.ts` → `producers/scheduled-prompt-append.ts`.
   Introduce a typed capability tag (e.g., `ScheduledPromptIngressAppender`)
   in `channels/` so the Shape D subscriber depends on the Tag, not on
   `producers/`.
5. Move `composition/host-public.ts:appendRuntimeIngress` into a new
   `producers/runtime-input-append.ts` exporting a `RuntimeInputAppender`
   capability layer. `composition/host-public.ts` becomes pure wiring
   that re-exports the host facade and depends on the new capability.
6. Delete the `producers/ingress-writers/` scaffold (its purpose is
   absorbed into the renamed `producers/`).
7. Update dep-cruiser to express the new rules:
   - `sources/` may import `events/` only. Not `tables/`.
   - `producers/` may import `events/`, `tables/`, `sources/`.
   - `subscribers/` may import `events/`, `tables/`, `transforms/`,
     `channels/`. Not `sources/`, not `producers/`.
   - `channels/` may import `events/`, `tables/`. (Capability tags only;
     no Live bindings depending on `producers/`.)
8. Update ARCHITECTURE.md and the target-tree doc to reflect the new tiers.
9. Update `test/` layout: `test/sources/`, `test/producers/`.

## Open Questions

- Should the renamed tier be `producers/` (Kafka client vocab) or
  `journalers/` (more descriptive)? The SDD assumes `producers/`; both are
  reasonable.
- Where do typed Producer capability tags live? `channels/` is the
  natural fit (a channel is a wire-edge capability); a new `capabilities/`
  folder is also defensible.
- F (`verified-webhook-ingest/`) — split into tier folders, or keep as an
  adjacent self-contained adapter? Re-evaluate once another external
  adapter is imminent.

## Decisions Required

Before any code moves, this SDD needs explicit yes/no on:

- Adopt Option 1 (flat Kafka-broker split)?
- Rename to `producers/` or `journalers/`?
- Where do capability tags live (`channels/` vs new folder)?

The three open PRs (#758, #760) are blocked on the first decision. PR #757
(docs) and PR #759 (test layout) are independent and can land regardless.

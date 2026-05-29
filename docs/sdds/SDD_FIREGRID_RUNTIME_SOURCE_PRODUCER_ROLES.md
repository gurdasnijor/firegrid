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

## Revision — `connectors/` For External Adapters

Status: appended after the initial decision. Triggered by a stress-test
question: "if Linear/GitHub/Slack ingress is on the roadmap, how does an
implementer build one?" The tier-only model answers "edit `sources/`,
`producers/`, `capabilities/`, `tables/`, and `composition/`" — five
folders for one self-contained feature. That's the wrong cognitive shape
for a per-feature adapter, even though it's the right shape for shared
runtime infrastructure.

This revision adds **`connectors/`** as a peer tier whose unit-of-thought
is the adapter, not the role. It does not change PR-M1/M2/M3. It revises
PR-M4 (`verified-webhook-ingest/` split) and shapes how external adapters
land in the future.

### Two organizing principles, not one

The runtime now has two orthogonal layout principles:

1. **Tier folders** for shared runtime infrastructure used across many
   features. `sources/sandbox/` is consumed by every codec and by the
   workflow-driven runtime; `sources/codecs/` is consumed by every agent
   session; `producers/` topic-writers are reused across subscribers;
   `capabilities/` Tags are imported from everywhere. Tier-shape fits
   because each piece is genuinely cross-cutting.

2. **Connector folders** for self-contained external adapters where one
   feature owns its source + writer + schema together. `connectors/linear/`
   contains everything for the Linear integration — the implementer's
   mental unit is "Linear," not "the source half of Linear plus the
   producer half of Linear plus the table schema of Linear plus the
   capability tag for Linear." Bundle-shape fits because the pieces are
   only consumed by each other.

The two principles do not compete. Tier folders hold what's *shared*;
connector folders hold what's *bespoke*. A new external adapter does not
touch any tier folder — it lands as one new `connectors/<name>/` folder
plus one wiring line in `composition/host-live.ts`.

### The `ConnectorAdapter<E, F>` primitive

Boundary enforcement moves from "five dep-cruiser rules across five tier
folders" to "one type signature." The Effect-native shape:

```ts
// events/connector-adapter.ts
export interface ConnectorAdapter<Event, Fact, Tag = never> {
  /** Wire-edge: where the external system delivers events. */
  readonly route: HttpRoute

  /** Emitter half: HTTP bytes -> typed events. Pure (no tables/, no
   *  Effect side-effects beyond signature verification). */
  readonly source: (
    request: HttpRequest,
  ) => Effect.Effect<Stream.Stream<Event, ConnectorSourceError>, ConnectorSourceError>

  /** Writer half: event -> durable fact row. Requires the
   *  ExternalIngressAppender capability Tag from capabilities/. */
  readonly journal: (
    event: Event,
  ) => Effect.Effect<Fact, ConnectorJournalError, ExternalIngressAppender | Tag>

  /** Pure schemas for the event union and the journaled row. */
  readonly factSchema: Schema.Schema<Fact>
  readonly eventSchema: Schema.Schema<Event>

  /** Identity for telemetry / composition wiring. */
  readonly id: string
}
```

The field types encode the role boundaries that dep-cruiser would
otherwise enforce per-file: `source` returns a `Stream` with no
`tables/` reachability; `journal` requires the appender Tag so it cannot
short-circuit to a direct table write; `factSchema` is a pure value.

A composition helper:

```ts
// composition/compose-connector.ts
export const composeConnector = <E, F>(
  adapter: ConnectorAdapter<E, F>,
): Layer.Layer<never, never, ExternalIngressAppender | HttpRouter>
```

wires the adapter's `route` onto the host's HTTP router, runs
`source(request) |> Stream.mapEffect(adapter.journal)`, and Layer-merges
into the runtime. `composition/host-live.ts` takes
`readonly ConnectorAdapter<unknown, unknown>[]` and merges each.

### Per-adapter folder shape

```text
connectors/
├── README.md                         # explains the unit; documents the convention
├── linear/
│   ├── README.md
│   ├── index.ts                      # LinearConnector: ConnectorAdapter<LinearEvent, LinearFact>
│   ├── schema.ts                     # LinearEvent union + LinearFact row schemas
│   └── signature.ts                  # HMAC-SHA256 verification helper
├── github/                           # (future)
├── slack/                            # (future)
└── webhook/                          # generalized base — see PR-M4 below
    └── (the post-rework `verified-webhook-ingest/`)
```

Internal file structure is the implementer's choice. The folder boundary
is what dep-cruiser rules against. One file is fine for small adapters;
the suggested splits above are conventions, not requirements.

### Tier position and dep-cruiser rules

`connectors/` is logical position **3c**, peer with `sources/` (3a),
`producers/` (3b), `transforms/` (4), `channels/` (5).

| Tier | May import | Must not import |
| --- | --- | --- |
| `connectors/<name>/` | `events/`, `capabilities/`, `tables/`, `transforms/`, `channels/` | `sources/`, `producers/`, `subscribers/`, `composition/`, **any other `connectors/<other-name>/`** |

The "no cross-connector imports" rule is the load-bearing one: it keeps
each adapter a closed unit. If two adapters need to share code, that code
goes into a tier folder (`transforms/`, `capabilities/`) or into
`connectors/webhook/` (the generalized base) — not into one connector
importing another.

### How PR-M4 changes under this revision

PR-M4 was: "split `verified-webhook-ingest/` across `sources/`,
`producers/`, `tables/`."

PR-M4 becomes: "rework `verified-webhook-ingest/` as
`connectors/webhook/`, exposing the shared verified-webhook base as a
`ConnectorAdapter` factory that concrete adapters (Linear, GitHub, …)
parameterize."

The substantive content (HMAC verification, fact schema, table) stays
together as one connector. The "generalized" base is a function that
takes a per-adapter configuration (header name, secret resolution,
event-decoder schema) and returns a `ConnectorAdapter<E, F>`. Linear's
adapter becomes one call to that factory; future adapters likewise.

### Effect on the migration sequence

| PR | Disposition under revision |
| --- | --- |
| PR-M1 (foundation) | **No change.** Tiers are still right for sandbox/codecs/capabilities. Already on disk via #762. |
| PR-M2 (scheduled-prompt-append) | **No change.** A runtime-internal writer, not an external adapter. |
| PR-M3 (appendRuntimeIngress) | **No change.** Same reasoning. |
| PR-M4 | **Reshaped** as described above. |
| PR-M5 (cleanup) | **Add**: connector layout docs, `composeConnector` helper. |
| PR-M6 (alias drop) | **No change.** |

A new **PR-M3.5 (Linear connector spike)** lands between PR-M3 and PR-M4
to stress-test `ConnectorAdapter` against a concrete adapter *before*
PR-M4 commits to the primitive shape for the verified-webhook rework.
The spike findings inform PR-M4; if the primitive grinds, PR-M4 either
adopts a revised shape or this revision is itself revised.

### Distinguishing tier-internal `sources/`/`producers/` from connectors

A judgment call for future code:

- Sandbox, codecs, and any future *internal* boundary used across
  multiple features → `sources/`. The producers/writers that journal
  *internal* runtime data flow → `producers/`. Tags consumed by multiple
  subscribers → `capabilities/`.
- An external system whose events become rows for one feature →
  `connectors/<name>/`. Even if the connector internally has an emitter
  half and a writer half, they live together because nothing outside the
  connector consumes them.

If in doubt: would another feature reasonably depend on this piece in
isolation? If yes, tier. If no, connector.

## Target Tier Graph

After migration:

```text
packages/runtime/src/
├── events/                    # 1.  pure event/row schemas + ConnectorAdapter shape
├── capabilities/              # 1b. pure Effect Context.Tag declarations
├── tables/                    # 2.  durable topics (DurableTable definitions)
├── sources/                   # 3a. internal emitters
│   ├── sandbox/
│   └── codecs/
├── producers/                 # 3b. internal topic writers
│   ├── per-context-output.ts
│   ├── runtime-input-append.ts
│   └── scheduled-prompt-append.ts
├── connectors/                # 3c. external adapters — one folder per adapter (post-PR-M4)
│   ├── README.md
│   ├── webhook/               # generalized verified-webhook base (was verified-webhook-ingest/)
│   ├── linear/                # PR-M3.5 spike, then production adapter
│   ├── github/                # (future)
│   └── slack/                 # (future)
├── transforms/                # 4.  pure row/event transforms
├── channels/                  # 5.  wire-edge live routing
├── subscribers/               # 6.  Shape B/C/D consumers
└── composition/               # 7.  Layer wiring only (incl. composeConnector helper)
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
| `connectors/<name>/` | `events/`, `capabilities/`, `tables/`, `transforms/`, `channels/` | `sources/`, `producers/`, `subscribers/`, `composition/`, **any other `connectors/<other>/`** |
| `channels/` | `events/`, `tables/`, `capabilities/` | `sources/`, `producers/`, `connectors/`, `subscribers/`, `composition/` |
| `subscribers/` | `events/`, `capabilities/`, `tables/`, `transforms/`, `channels/` | `sources/`, `producers/`, `connectors/`, `composition/` |
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

### PR-M3.5 — Linear connector spike

Scope:

- Define `events/connector-adapter.ts` exporting the
  `ConnectorAdapter<E, F>` shape and `ConnectorSourceError` /
  `ConnectorJournalError` schemas.
- Define `capabilities/external-ingress-appender.ts` exporting the
  `ExternalIngressAppender` Tag.
- Add `tables/external-ingress-facts.ts` for journaled webhook facts
  (delivery-id keyed, idempotent).
- Add `connectors/README.md` documenting the connector unit, the
  "no cross-connector imports" rule, and the recommended internal layout.
- Add `connectors/linear/index.ts` implementing
  `LinearConnector: ConnectorAdapter<LinearEvent, LinearFact>`, plus
  `connectors/linear/schema.ts` and `connectors/linear/signature.ts`.
- Add `composition/compose-connector.ts` with `composeConnector(adapter)`.
- Integration test under `test/connectors/linear/` that:
  - posts a captured Linear webhook payload at the route;
  - asserts the durable row landed in `external-ingress-facts`;
  - asserts an HMAC mismatch is rejected and writes no row;
  - asserts replay of the same delivery-id is idempotent.

Verification: typecheck + vitest (targeted) + dep-cruiser (new
`connectors/` rules) + surface check (new tier).

Findings dictate whether PR-M4 proceeds as planned or the
`ConnectorAdapter` shape needs revision. The spike is the gate.

### PR-M4 — Rework `verified-webhook-ingest/` as `connectors/webhook/`

Scope (assuming PR-M3.5 lands the primitive cleanly):

- Move `verified-webhook-ingest/` to `connectors/webhook/`.
- Refactor its body to expose a `makeVerifiedWebhookConnector(config):
  ConnectorAdapter<E, F>` factory parameterized by signature header,
  secret resolution, and event-decoder schema.
- Retarget the Linear connector from PR-M3.5 at
  `makeVerifiedWebhookConnector` so its `signature.ts` collapses into a
  config object.
- Update host-sdk webhook entrypoints to consume the new connector
  surface.
- Delete `packages/runtime/src/verified-webhook-ingest/`.

Verification: typecheck + vitest
(`test/verified-webhook-ingest/adapter.test.ts` moves to
`test/connectors/webhook/`) + scripts.

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
- **Future external adapter shape** — addressed by the connectors/
  revision above. Tier-internal infrastructure stays tier-shaped; external
  adapters bundle per-feature under `connectors/`. Stress-tested by the
  PR-M3.5 Linear spike.

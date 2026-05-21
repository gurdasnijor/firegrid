# tf-8ryo — Runtime directory structure design + host-sdk leak inventory

Date: 2026-05-21
Status: DESIGN / INVENTORY (no production file moves; decides tf-bffo's moves)
Bead: tf-8ryo (P1) — blocks tf-bffo (runtime control-plane cleanup); related
tf-5n1z EPIC, tf-4cik.2 (sources README)
Owner: Lane 5 (opus)
Amends: `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` §"Host-SDK / Runtime /
Protocol Firewall" (the substrate-box boundary), grounded in
`SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` (channels = the doorway).

NON-GOALS: no production file moves (tf-bffo does those), no behavior changes, no
deletion of the load-bearing control-request dispatcher / request-row bridge.

## §0 The load-bearing principle (Gurdas, ratified 2026-05-21)

The authority Tags — `RuntimeControlRequests`, `RuntimeContextInsert`,
`RuntimeRuns`, `RuntimeAgentOutputEvents`, `RuntimeAgentOutputAfterEvents`,
`RuntimeControlPlaneRecorderLive` — are **migration-era kernel internals: the
write-ownership / commit-points for durable collection families.** They are NOT a
public doorway and must NOT become a second upper-runtime API layer.

**The privileged durable core is the KERNEL (`packages/runtime/src/kernel/`).**
You do NOT import the kernel directly into a program — you reach it through
**drivers that expose CHANNELS**. Channels are the single doorway: code above the
kernel boundary (host topology composition, app, client) accesses durable state
through channel contracts (`@firegrid/protocol/channels`) whose durable
implementations live in `kernel/channels`, not through
`Runtime*Insert`/`Runtime*Requests`-style service doors.

(Naming: "substrate" is the right word for the whole-Firegrid thesis — "one
substrate primitive, DurableTable" — but it is overloaded and too floaty for an
internal directory. The internal box is named **kernel**: a well-defined
privileged core reached only through drivers/channels. See §3 glossary.)

So the design has three jobs:
1. Kill the ambiguous "authorities" taxonomy (two unrelated dirs named the same;
   "authority" used as both role AND domain).
2. Make the kernel a visible directory boundary, with write-ownership inside and
   channels as the only sanctioned cross-boundary surface.
3. Co-locate the durable channel IMPLEMENTATIONS into `kernel/channels` so
   host-sdk cannot read as a second substrate doorway (ownership split below).

## §1 Current-state inventory

### §1.1 runtime/src — the two "authorities" + the umbrella

```
packages/runtime/src/
  authorities/                         # ROLE-named dir (control-plane write-owners)
    runtime-control-plane-recorder.ts  # DEFINES RuntimeContextInsert, RuntimeRuns,
                                        #   RuntimeControlRequests, RuntimeControlPlaneRecorderLive
    time.ts                            # authorityNowIso (clock helper)
    index.ts  README.md
  control-plane/                       # awkward umbrella
    control-request-dispatcher.ts      # RuntimeControlRequestReconciler + dispatcher +
                                        #   RuntimeControlRequestSideEffects (the request-row→reflected bridge; LOAD-BEARING)
    index.ts                           # re-exports ../authorities (the umbrella smell)
  agent-event-pipeline/
    authorities/                       # ROLE-named dir #2 (output write-owners) — the COLLISION
      runtime-output-journal.ts        # DEFINES RuntimeAgentOutputEvents(Layer) (output journal write-owner)
      runtime-output-public.ts         # RuntimeAgentOutputAfterEvents (public output projection)
    codecs/ {acp, stdio-jsonl, contract.ts, index.ts}   # external-effect adapters (codec)
    sources/ {byte-stream.ts, sandbox}                  # external-effect adapters (sandbox/byte)
    transforms/  subscribers/  events/ {contract,output,stage-contracts}
    session-byte-stream-adapter.ts  tool-execution/ {runtime-agent-tool-execution, runtime-tool-call-workflow}
  streams/ {runtime-observation-streams.ts, sources.ts} # observation stream sources
  verified-webhook-ingest/ {adapter, keys, table}       # external-effect adapter (webhook ingest)
  workflow-engine/ {DurableStreamsWorkflowEngine, workflows, internal, tool-execution}
  index.ts  runtime-errors.ts  README.md
```

The problems:
- **Two dirs named `authorities/`** (`src/authorities` = control-plane write-owners;
  `src/agent-event-pipeline/authorities` = output write-owners). Same word, two
  unrelated domains. "authority" is simultaneously a role (unique write-owner) and
  used as a domain folder.
- **`control-plane/index.ts` re-exports `../authorities`** — `control-plane` is an
  umbrella over (request-row daemon + control-plane write-owners) without owning
  either cleanly. Per the bead: do NOT treat `control-plane` as already-canonical.
- **No explicit kernel boundary** — write-owners, pipeline stages, and
  external-effect adapters sit as peers; nothing says "this is the write-ownership
  interior; channels are the doorway."

### §1.2 host-sdk substrate-shaped surfaces (the parallel-entrypoint risk)

Files importing `RuntimeControlPlaneTable` / `RuntimeOutputTable` /
`RuntimeControlPlaneRecorderLive` / `RuntimeControlRequestControlPlaneLive`:

```
host/channels/host-control/index.ts                 # channel Live bindings → control plane  (→ kernel/channels)
host/channels/host-sessions-create-or-load-live.ts  # channel Live binding                   (→ kernel/channels)
host/channels/session-agent-output/index.ts         # channel Live binding → output table    (→ kernel/channels)
host/channels/session-permission/index.ts           # channel Live binding                   (→ kernel/channels)
host/channels/session-self/index.ts                 # channel Live binding                   (→ kernel/channels)
host/agent-tool-host-live.ts                         # agent-tool host → control plane writes
host/commands.ts                                     # startRuntime / appendRuntimeIngress
host/control-request-side-effects.ts                 # dispatcher side-effect arm (host-side)
host/layers.ts                                       # composes RuntimeControlPlaneRecorderLive + RuntimeControlRequestControlPlaneLive
host/per-context-runtime-output.ts                   # per-context RuntimeOutputTable wiring
host/runtime-substrate.ts                            # runtime substrate wiring exposed in host-sdk
host/runtime-context-workflow-runtime.ts             # workflow runtime composition
host/runtime-context-session/codec-adapter.ts        # reaches into workflow/session substrate
```

## §2 Target tree — domain-first, kernel explicit

A single `kernel/` directory makes the write-ownership interior explicit. Inside
it, organize by **domain** (control-plane, observation, channels, webhook-ingest,
workflow-engine); the write-owner ROLE is expressed by file naming, not by a
`authorities/` folder. The agent-event-pipeline keeps the pipeline STAGES
(adapters/transforms), which are not write-owners and stay OUTSIDE the kernel.

```
packages/runtime/src/
  kernel/                             # THE kernel (privileged durable core; reached only via drivers/channels; NOT a public import surface)
    control-plane/                    # domain: control requests + context/run durable state
      recorder.ts                     # ← authorities/runtime-control-plane-recorder.ts
                                      #   (write-owners: RuntimeContextInsert, RuntimeRuns, RuntimeControlRequests, recorder Live)
      request-dispatcher.ts           # ← control-plane/control-request-dispatcher.ts (the request-row→reflected bridge; KEEP, do not delete)
      time.ts                         # ← authorities/time.ts
      index.ts                        # explicit exports; NO re-export umbrella
    observation/                      # domain: agent-output journal + public projection
      output-journal.ts               # ← agent-event-pipeline/authorities/runtime-output-journal.ts (RuntimeAgentOutputEvents write-owner)
      output-public.ts                # ← agent-event-pipeline/authorities/runtime-output-public.ts (RuntimeAgentOutputAfterEvents)
      observation-streams.ts          # ← streams/runtime-observation-streams.ts (+ streams/sources.ts)
      index.ts
    channels/                         # the DURABLE channel implementations (Live bindings over kernel state)
                                      #   ← host-sdk/host/channels/* (host-control, session-agent-output, session-permission,
                                      #   session-self, host-sessions-create-or-load-live). protocol owns the CONTRACTS;
                                      #   the kernel owns these Live IMPLEMENTATIONS; host-sdk only COMPOSES them.
    webhook-ingest/                   # ← verified-webhook-ingest/ (adapter, keys, table)
    workflow-engine/                  # ← workflow-engine/ (already a clean domain; moves under kernel/)
    index.ts                          # the kernel's internal barrel (runtime-internal; not for above-box consumers)
  agent-event-pipeline/               # the PIPELINE STAGES (external-effect adapters; NOT write-owners; OUTSIDE the kernel)
    codecs/ sources/ transforms/ subscribers/ events/ tool-execution/
    session-byte-stream-adapter.ts
  index.ts  runtime-errors.ts  README.md
```

Notes:
- **No directory named `authorities` anywhere.** The two collide-named dirs become
  `kernel/control-plane` and `kernel/observation`.
- **Channel Live implementations co-locate into `kernel/channels`** (the ratified
  Bucket-A correction): protocol owns channel contracts/Tags/schemas; the kernel
  owns the durable Live bindings; host-sdk only COMPOSES them (§4).
- **`control-plane` is no longer a top-level umbrella** — it's a domain INSIDE
  `kernel/`, owning both the recorder (write-owners) and the request-dispatcher
  (the daemon), with explicit exports and no `../authorities` re-export.
- **`workflow-engine`, `verified-webhook-ingest`, `streams` move under
  `kernel/`** because they are kernel interior (durable state machines /
  ingest write-owner / observation sources). The agent-event-pipeline ADAPTERS
  (codecs/sources/transforms) stay outside the kernel — they convert external
  effects INTO durable rows but are not the row write-owners.
- **The kernel's `index.ts` is runtime-internal.** Above-kernel consumers
  (host topology, app) should depend on channel contracts, not on this barrel.
  Narrowing the export surface so the authority Tags are not re-exported as
  upper-runtime API is the longer-term move (sequenced below; coordinate with the
  channelization that already routes client/host through channels).

### Alternative considered (rejected): keep `authorities/` as the role word

Renaming both dirs to a shared role word (`capabilities/`, `commit-points/`,
`write-owners/`) was considered. Rejected because it preserves the "role as
directory" smell (the same critique that sank "authorities") and does not make the
kernel explicit. Domain-first under an explicit `kernel/` is the intelligible
structure; the role is a file-naming + glossary concern, not a dir.

## §3 Naming glossary

| Term | Decision |
| --- | --- |
| **authority** (as a directory) | RETIRED. No dir named `authorities`. |
| **authority** (as a concept/term in docs) | KEEP narrowly, meaning "the unique write-owner / commit-point for a durable collection family, INSIDE the kernel." Not a public doorway. |
| **substrate** | RESERVED for the whole-Firegrid thesis ("one substrate primitive, DurableTable"). NOT used as an internal directory name — too overloaded/floaty for a dir. |
| **kernel** | NEW explicit internal boundary: `packages/runtime/src/kernel/`. The privileged durable core (write-ownership / authority Tags / durable state machines / ingest / observation write-owners / durable channel implementations). You do NOT import the kernel directly into a program — you reach it through drivers that expose channels. |
| **driver** | the thing that exposes a kernel capability AS a channel. The durable channel Live implementations in `kernel/channels` are the drivers; host-sdk composes them, app/client consume the channel contract. |
| **recorder** | the control-plane write-owner module (RuntimeContextInsert/RuntimeRuns/RuntimeControlRequests + RuntimeControlPlaneRecorderLive). |
| **request-dispatcher** | the control-request reconciler daemon + the request-row→reflected bridge (load-bearing; the kernel-internal Pattern-1 implementation behind callable channels). |
| **journal** / **output-public** | the observation write-owner + its public projection. |
| **channel** | the ONLY sanctioned above-kernel doorway to durable state. Contract/Tag/schema in `@firegrid/protocol/channels`; durable Live implementation in `kernel/channels`; host-sdk composes. |
| **control-plane** | a DOMAIN inside the kernel, not a top-level umbrella dir. |

## §4 host-sdk leak inventory + classification

Three buckets. Bucket A stays; B moves below the kernel; C becomes/aligns to
channel implementations (often already in flight under named beads).

### Bucket A — TRUE composition / projection edge (CORRECT in host-sdk; keep)

Per the ratified ownership split, host-sdk only COMPOSES Layers (topology
assembly + projection edges) and NEVER owns durable-state wiring:

- `host/layers.ts`, `host/config-live.ts` — host TOPOLOGY composition (assemble the
  kernel Live Layers + channel layers into a runnable host). Composition is the
  legitimate host-sdk role; stays. (It composes `RuntimeControlPlaneRecorderLive` +
  `RuntimeControlRequestControlPlaneLive` from the kernel — composition, not
  ownership.)
- `host/mcp-host.ts`, `mcp-channel-metadata.ts`, `runtime-context-mcp-base-url.ts`
  — MCP projection edge (tf-r8ib classified this; keep as named projection edge).

### Bucket B — KERNEL-INTERNAL that should move BELOW the box (into runtime/kernel)

These own/expose durable-state wiring from host-sdk; they are kernel interior, not
composition or projection edge:

- **`host/channels/*` channel Live bindings** (host-control, session-agent-output,
  session-permission, session-self, host-sessions-create-or-load-live) — these ARE
  durable channel IMPLEMENTATIONS (Live bindings touching `RuntimeControlPlaneTable`
  / `RuntimeOutputTable`). **RATIFIED CORRECTION (overrides the earlier "keep in
  host-sdk" rec): co-locate into `kernel/channels`.** protocol owns the channel
  CONTRACTS; the kernel owns the durable Live implementations; host-sdk only
  composes them. Reason: bindings in host-sdk make host-sdk read as a SECOND
  substrate doorway; co-location makes "channels are the only doorway" enforceable.
  (The `host-control-request.ts` / `host-session-create-or-load-request.ts` factory
  helpers in `@firegrid/protocol/launch` that these bindings consume also belong on
  the kernel side of the line — they take a `RuntimeControlPlaneTableService` and
  compose durable ops; revisit their home as part of the co-location.)
- `host/runtime-substrate.ts` — runtime substrate wiring (HostRuntimeObservationStreamsLive,
  RuntimeAgentToolExecutionLive). Move to `runtime/kernel` so host-sdk does not
  re-expose kernel Live Layers.
- `host/per-context-runtime-output.ts` — per-context RuntimeOutputTable layer
  wiring. Kernel interior (output read composition). Move below; the client already
  reaches output through the SessionAgentOutput channel + its own cache (tf-qu7l).
  Coordinate with tf-aq4d (snapshot output-read extraction) — same machinery.
- `host/control-request-side-effects.ts` — the dispatcher's side-effect arm. It is
  the runtime control-request mechanism living in host-sdk; belongs with the
  request-dispatcher in `kernel/control-plane` (or a runtime host-composition
  module), not as a host-sdk top-level.

### Bucket C — should become / align to channel implementations (mostly in-flight)

- `host/runtime-context-session/codec-adapter.ts` + `session-byte-stream-adapter`
  reaches — byte-stream conversion + stdin writer. **Already tracked: tf-pisb**
  (Workstream C — relocate adapter bodies below runtime; host-sdk retains adapter
  selection/composition only). Defer to tf-pisb; this design just confirms the
  classification.
- `host/agent-tools/execution/*` — depends on runtime workflow/tool execution +
  channel-catalog internals. The tool-call lowering is a binding edge, but its
  dependency on workflow-engine internals + the ChannelInventory catalog is a
  substrate reach. Classify: the lowering stays (composition edge); the
  workflow/catalog dependency should resolve through the kernel's public-ish
  runtime composition + the channel contracts, not direct internal imports.
  Coordinate with tf-zd8s's ChannelInventory retirement.
- `host/agent-tool-host-live.ts` — agent-tool host that writes control-plane rows.
  The write should go through the relevant channel binding (it partly does post-
  tf-aago); residual direct-table writes are a leak to close as the channelization
  completes.

## §5 Migration slices (for tf-bffo — sequence)

Each slice is a behavior-preserving move/rename; no logic changes.

1. **Slice 1 — create the kernel + move the two authorities dirs.**
   `mkdir kernel/`; move `authorities/` → `kernel/control-plane/`
   (recorder.ts + time.ts), `control-plane/control-request-dispatcher.ts` →
   `kernel/control-plane/request-dispatcher.ts`; delete the
   `control-plane/index.ts` `../authorities` re-export umbrella, replace with
   `kernel/control-plane/index.ts` explicit exports. Move
   `agent-event-pipeline/authorities/*` → `kernel/observation/`. Update imports.
   Net: zero `authorities/` dirs; `control-plane` is a kernel domain.
2. **Slice 2 — move the rest of the kernel interior.** `verified-webhook-ingest/` →
   `kernel/webhook-ingest/`; `streams/` → `kernel/observation/`;
   `workflow-engine/` → `kernel/workflow-engine/`. Keep agent-event-pipeline
   stages where they are. Update imports + `runtime/src/index.ts`.
3. **Slice 3 — co-locate the channel Live implementations + narrow the export
   surface.** (a) Move `host-sdk/host/channels/*` durable Live bindings into
   `kernel/channels` (protocol keeps contracts; host-sdk keeps composition only);
   revisit the `@firegrid/protocol/launch` `*-request.ts` factory helpers' home as
   part of this. (b) Stop re-exporting the authority Tags as upper-runtime API from
   `runtime/src/index.ts`; above-kernel consumers route through channels. This is
   the load-bearing §0 correction. Per the §9 consumer audit, the above-box doorway
   (client-sdk/cli) is ALREADY channel-clean, so (b) is mechanical re-pointing + a
   3-file reach-past migration; (a) is the channel-binding relocation. Keep as a
   tf-bffo sub-step (§9.3 verdict).
4. **Slice 4 — host-sdk Bucket B relocation.** Move `runtime-substrate.ts`,
   `per-context-runtime-output.ts`, `control-request-side-effects.ts` below into
   `kernel/`, leaving host-sdk with composition + projection edges only. Coordinate
   Bucket C with tf-pisb (codec/byte adapters) + tf-zd8s (ChannelInventory).

Slices 1–2 are pure renames (low risk, do first). Slice 3 carries the channel-
binding co-location + the export-surface trim (the architectural payload). Slice 4
+ Bucket C coordinate with named in-flight beads.

## §6 Acceptance check (per the bead)

- [x] No target tree with two unrelated directories named `authorities`.
- [x] Domain-first target tree with an explicit kernel.
- [x] Naming glossary (authority retired as dir; kept as narrow doc term; kernel
  vs substrate distinguished).
- [x] Target homes decided: recorder + dispatcher → `kernel/control-plane`;
  output journal/public + streams → `kernel/observation`; channel Live bindings →
  `kernel/channels`; webhook ingest + workflow engine → `kernel/`; the host-sdk
  Bucket-B files → below into `kernel/`.
- [x] host-sdk leak inventory + classification (A compose/project-only / B
  move-below incl. channel bindings / C channel-align) + migration slices.
- [x] Load-bearing dispatcher / request-row bridge preserved (moved, not deleted).
- [x] Authority tags framed as migration-era kernel internals, not a public
  doorway; channels are the single above-kernel doorway.

## §7 Resolutions (Gurdas ratified 2026-05-21)

1. **Slice 3 scope** — RESOLVED: SUB-BEAD of tf-bffo (the §9 consumer audit shows
   the above-box doorway is already channel-clean; the work is bounded). No
   separate peer bead.
2. **Channel bindings co-location** — RESOLVED (overrides the earlier "leave in
   host-sdk" rec): CO-LOCATE the durable channel Live bindings into
   `kernel/channels`. Ratified ownership split — protocol owns contracts/Tags/
   schemas; kernel owns durable implementations; host-sdk only composes. Reflected
   in §2 + §4 Bucket B + §5 Slice 3.
3. **`agent-event-pipeline` vs kernel** — RESOLVED: pipeline adapter stages stay a
   sibling OUTSIDE `kernel/` (they are the boundary INTO the kernel, not interior).
4. **Box name** — RESOLVED: `kernel/` (not `substrate/`); "substrate" reserved for
   the whole-Firegrid thesis. See §3 glossary.

## §8 Cross-references

- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` §"Firewall" — the boundary
  this amends (kernel explicit; channels = doorway; kernel owns durable channel
  implementations, host-sdk composes)
- `docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` — channels as the
  above-box doorway
- `packages/runtime/src/{authorities,control-plane,agent-event-pipeline/authorities}`
  — the current ambiguous taxonomy
- `packages/host-sdk/src/host/{runtime-substrate,per-context-runtime-output,control-request-side-effects}.ts`
  — Bucket B leak surface
- tf-bffo (impl — consumes this design); tf-pisb (codec/byte adapter relocation,
  Bucket C); tf-zd8s (ChannelInventory retirement, Bucket C); tf-aq4d (snapshot
  output-read extraction, overlaps per-context-runtime-output)

## §9 Slice-3 consumer audit (read-only; de-risks the export-surface narrowing)

Mirrors tf-aago's consumer-audit method. Full authority-Tag set audited:
**control-plane** — `RuntimeContextInsert(Live)`, `RuntimeContextRead`,
`RuntimeLocalContextResolver`, `RuntimeRunAppendAndGet`, `RuntimeControlRequests`,
`RuntimeContexts`, `RuntimeRuns`, `RuntimeControlPlaneRecorderLive`;
**observation** — `RuntimeAgentOutputEvents(Layer)`, `RuntimeAgentOutputAfterEvents`.

### §9.0 The headline finding

**The true above-box doorway is ALREADY channel-clean.** `@firegrid/client-sdk`
and `@firegrid/cli` have ZERO authority-Tag usage in `src/` (only one client-sdk
*test* reads `RuntimeAgentOutputAfterEvents` as a harness shortcut). `apps/factory`
does not exist. So Slice 3 is NOT a large external-consumer migration — the
channel-collapse wave (tf-aago/tf-qu7l/tf-jbtu/tf-05jj) already moved the
app-facing surface onto channels. What remains are monorepo-internal consumers:
box-internal code, host-sdk host-adapter glue, the Bucket-B files, and a small
reach-past tail.

### §9.1 Consumer classification

| Consumer (src) | Tags used | Role | Disposition |
| --- | --- | --- | --- |
| `runtime/src/{authorities,control-plane,agent-event-pipeline/authorities,workflow-engine/workflows/runtime-context*,streams/runtime-observation-streams}` | all (define + use) | **Kernel-interior** | No migration. Slices 1–2 relocate them inside `kernel/`; imports re-point. |
| `runtime/src/index.ts` | re-exports the full set | **The export surface** | THIS is what Slice 3 narrows: stop re-exporting authority Tags as upper-runtime API. The single load-bearing change. |
| `host-sdk/src/host/channels/*` (host-control, session-agent-output, session-permission, session-self, host-sessions-create-or-load-live) | `RuntimeControlPlaneTable`, `RuntimeOutputTable` (durable Live bindings) | **Durable channel IMPLEMENTATION** (ratified: kernel-owned, not host-sdk) | MOVE to `kernel/channels` (Bucket B; §4). host-sdk keeps composition only. The §0/§2 co-location. |
| `host-sdk/src/host/layers.ts`, `config-live.ts` | `RuntimeControlPlaneRecorderLive`, `RuntimeLocalContextResolver`, `RuntimeAgentOutputEvents` | **Topology composition** (host-sdk's legitimate role: assemble kernel Live Layers + channel layers) | KEEP. Re-point imports to `kernel/`. Composition consumes kernel Live Layers; it is the legitimate host composition root, not doorway-as-API. |
| `host-sdk/src/host/agent-tool-host-live.ts` | `RuntimeContextInsert`, `RuntimeContextRead`, `RuntimeAgentOutputAfterEvents` | **Host-adapter glue** (captures services for AgentToolHost) | KEEP (re-point). The `RuntimeAgentOutputAfterEvents` read overlaps Bucket B / per-context-output (channel-migration tail, §9.2). |
| `host-sdk/src/host/commands.ts`, `internal/runtime-context-helpers.ts` | `RuntimeContextRead` | **Host-execution read** (ingress/start context resolution) | KEEP as host-adapter (re-point). Optional later: route through a context-read channel; NOT required for Slice 3. |
| `host-sdk/src/host/mcp-host.ts` | `RuntimeLocalContextResolver` | **MCP projection edge** (tf-r8ib classified) | KEEP (re-point). |
| `host-sdk/src/host/runtime-substrate.ts`, `per-context-runtime-output.ts` | `RuntimeControlPlaneRecorderLive`, `RuntimeAgentOutputAfterEvents` | **Bucket B (kernel-internal re-exposed by host-sdk)** | MOVE below into `kernel/` (already in §4 Bucket B / §5 Slice 4). |
| `tiny-firegrid/src/simulations/{inv1-stream-zip-body,phase0-wave-2b-stream-zip-restart-replay}/host.ts` | `RuntimeAgentOutputAfterEvents` (read), `RuntimeControlPlaneRecorderLive` (compose) | **Sim host: legitimate compose + a reach-past READ** | The compose is fine (sim is a host). The direct `yield* RuntimeAgentOutputAfterEvents` READ is a reach-past → should use the `SessionAgentOutputChannel` (channel-migration tail, §9.2). |
| `host-sdk/src/host/sync-run.ts` | — | **FALSE POSITIVE** (comment mentions `RuntimeContextInsert`; no import/use) | None. |
| Tests: `runtime/test/authorities/provider-uniqueness.test.ts`, `host-sdk/test/host/{sync-run-integration,authority-context,runtime-context-workflow-core}.test.ts`, `client-sdk/test/firegrid.layer-hoisting.test.ts` | various | **Test harness** | Re-point imports. Test-harness reads of the Tags are acceptable (white-box). The client-sdk test reading `RuntimeAgentOutputAfterEvents` is a harness shortcut, not a product-surface leak. |

### §9.2 Channel-migration candidates (the small tail, NOT kernel-interior)

Only these genuinely *should go through a channel* rather than re-pointing:
1. The two sim hosts' direct `RuntimeAgentOutputAfterEvents` READ → migrate to the
   `SessionAgentOutputChannel` ingress stream (the same surface client-sdk already
   uses post-Sim 1). Bounded: 2 sim files.
2. `agent-tool-host-live.ts`'s `RuntimeAgentOutputAfterEvents` read + any residual
   direct control-row writes → route through the relevant channel bindings as the
   host-adapter channelization completes (overlaps Bucket B + the post-tf-aago
   channelization). Bounded: 1 file.

(Distinct from the channel-binding RELOCATION — moving `host/channels/*` durable
Live bindings into `kernel/channels` — which is a move, not a migration: the
bindings keep their logic, just change home + ownership. That is Slice 3(a).)

Everything else is either kernel-interior, legitimate host-sdk composition
(re-point only), or already-scheduled Bucket B.

### §9.3 Sizing verdict — SUB-BEAD of tf-bffo (answers Q1)

**Slice 3 is a sub-bead of tf-bffo, not its own bead.** Rationale:
- The app-facing doorway is already channel-clean (client-sdk/cli/app = zero), so
  there is no large external-consumer migration to project-manage separately.
- The dominant work is mechanical: re-point kernel-interior + host composition
  imports to the `kernel/` path (rides along with Slices 1–2), relocate the
  `host/channels/*` Live bindings into `kernel/channels` (Slice 3a), and stop
  re-exporting the Tags from `runtime/src/index.ts` (one file).
- The genuine channel-migration tail is 3 files (2 sim hosts + 1 host-adapter
  read), all using an already-existing channel (`SessionAgentOutputChannel`).
- The Bucket-B relocation is already its own Slice 4.

So Slice 3 = "relocate `host/channels/*` Live bindings → `kernel/channels` +
narrow `runtime/src/index.ts` exports + re-point host composition imports +
migrate the 3-file reach-past tail to `SessionAgentOutputChannel`." **RATIFIED: a
tf-bffo sub-step, not a peer bead** (§7.1).

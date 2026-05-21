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

## §0 The load-bearing principle (Gurdas correction)

The authority Tags — `RuntimeControlRequests`, `RuntimeContextInsert`,
`RuntimeRuns`, `RuntimeAgentOutputEvents`, `RuntimeAgentOutputAfterEvents`,
`RuntimeControlPlaneRecorderLive` — are **migration-era substrate internals: the
write-ownership / commit-points for durable collection families.** They are NOT a
public doorway and must NOT become a second upper-runtime API layer.

**The single doorway above the substrate box is CHANNELS.** Code above the
substrate boundary (host topology composition, app, client) accesses durable
state through channel contracts (`@firegrid/protocol/channels` + their bindings),
not through `Runtime*Insert`/`Runtime*Requests`-style service doors. The target
directory structure must make the **substrate box explicit** and keep the
write-owners inside it.

So the design has two jobs:
1. Kill the ambiguous "authorities" taxonomy (two unrelated dirs named the same;
   "authority" used as both role AND domain).
2. Make the substrate box a visible directory boundary, with write-ownership
   inside and channels as the only sanctioned cross-boundary surface.

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
- **No explicit substrate-box boundary** — write-owners, pipeline stages, and
  external-effect adapters sit as peers; nothing says "this is the write-ownership
  interior; channels are the doorway."

### §1.2 host-sdk substrate-shaped surfaces (the parallel-entrypoint risk)

Files importing `RuntimeControlPlaneTable` / `RuntimeOutputTable` /
`RuntimeControlPlaneRecorderLive` / `RuntimeControlRequestControlPlaneLive`:

```
host/channels/host-control/index.ts                 # channel Live bindings → control plane
host/channels/host-sessions-create-or-load-live.ts  # channel Live binding
host/channels/session-agent-output/index.ts         # channel Live binding → output table
host/channels/session-permission/index.ts           # channel Live binding
host/channels/session-self/index.ts                 # channel Live binding
host/agent-tool-host-live.ts                         # agent-tool host → control plane writes
host/commands.ts                                     # startRuntime / appendRuntimeIngress
host/control-request-side-effects.ts                 # dispatcher side-effect arm (host-side)
host/layers.ts                                       # composes RuntimeControlPlaneRecorderLive + RuntimeControlRequestControlPlaneLive
host/per-context-runtime-output.ts                   # per-context RuntimeOutputTable wiring
host/runtime-substrate.ts                            # runtime substrate wiring exposed in host-sdk
host/runtime-context-workflow-runtime.ts             # workflow runtime composition
host/runtime-context-session/codec-adapter.ts        # reaches into workflow/session substrate
```

## §2 Target tree — domain-first, substrate box explicit

A single `substrate/` directory makes the write-ownership interior explicit.
Inside it, organize by **domain** (control-plane, observation, webhook-ingest,
workflow-engine); the write-owner ROLE is expressed by file naming, not by a
`authorities/` folder. The agent-event-pipeline keeps the pipeline STAGES
(adapters/transforms), which are not write-owners.

```
packages/runtime/src/
  substrate/                          # THE substrate box (write-ownership interior; NOT a public doorway)
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
    webhook-ingest/                   # ← verified-webhook-ingest/ (adapter, keys, table)
    workflow-engine/                  # ← workflow-engine/ (already a clean domain; moves under substrate/)
    index.ts                          # the substrate box's internal barrel (runtime-internal; not for above-box consumers)
  agent-event-pipeline/               # the PIPELINE STAGES (not write-owners)
    codecs/ sources/ transforms/ subscribers/ events/ tool-execution/
    session-byte-stream-adapter.ts
  index.ts  runtime-errors.ts  README.md
```

Notes:
- **No directory named `authorities` anywhere.** The two collide-named dirs become
  `substrate/control-plane` and `substrate/observation`.
- **`control-plane` is no longer a top-level umbrella** — it's a domain INSIDE
  `substrate/`, owning both the recorder (write-owners) and the request-dispatcher
  (the daemon), with explicit exports and no `../authorities` re-export.
- **`workflow-engine`, `verified-webhook-ingest`, `streams` move under
  `substrate/`** because they are substrate interior (durable state machines /
  ingest write-owner / observation sources). The agent-event-pipeline ADAPTERS
  (codecs/sources/transforms) stay outside the box — they convert external effects
  INTO durable rows but are not the row write-owners.
- **The substrate box's `index.ts` is runtime-internal.** Above-box consumers
  (host topology, app) should depend on channel contracts, not on this barrel.
  Narrowing the export surface so the authority Tags are not re-exported as
  upper-runtime API is the longer-term move (sequenced below; coordinate with the
  channelization that already routes client/host through channels).

### Alternative considered (rejected): keep `authorities/` as the role word

Renaming both dirs to a shared role word (`capabilities/`, `commit-points/`,
`write-owners/`) was considered. Rejected because it preserves the "role as
directory" smell (the same critique that sank "authorities") and does not make the
substrate box explicit. Domain-first under an explicit `substrate/` box is the
intelligible structure; the role is a file-naming + glossary concern, not a dir.

## §3 Naming glossary

| Term | Decision |
| --- | --- |
| **authority** (as a directory) | RETIRED. No dir named `authorities`. |
| **authority** (as a concept/term in docs) | KEEP narrowly, meaning "the unique write-owner / commit-point for a durable collection family, INSIDE the substrate box." Not a public doorway. |
| **substrate box** | NEW explicit boundary: `packages/runtime/src/substrate/`. Holds write-ownership + durable state machines + ingest + observation write-owners. |
| **recorder** | the control-plane write-owner module (RuntimeContextInsert/RuntimeRuns/RuntimeControlRequests + RuntimeControlPlaneRecorderLive). |
| **request-dispatcher** | the control-request reconciler daemon + the request-row→reflected bridge (load-bearing; the runtime-internal Pattern-1 implementation behind callable channels). |
| **journal** / **output-public** | the observation write-owner + its public projection. |
| **channel** | the ONLY sanctioned above-box doorway to durable state (protocol contract + host-sdk/runtime binding). |
| **control-plane** | a DOMAIN inside the substrate box, not a top-level umbrella dir. |

## §4 host-sdk leak inventory + classification

Three buckets. Bucket A stays; B moves below the substrate box; C becomes/aligns
to channel implementations (often already in flight under named beads).

### Bucket A — TRUE binding-edge composition (CORRECT in host-sdk; keep)

Per the One Substrate firewall, host-sdk OWNS channel bindings + host topology
composition. These touch substrate tables BY DESIGN (the binding edge):

- `host/channels/*` (host-control, session-agent-output, session-permission,
  session-self, verified-webhook, host-sessions-create-or-load-live) — these ARE
  the channel Live Layer implementations (typed views over runtime DurableTables).
  Correct home. (Longer-term they could relocate to a `runtime/substrate/channels`
  if we want bindings co-located with the box, but that is NOT required and is out
  of tf-bffo scope; the firewall permits host-sdk to own bindings.)
- `host/layers.ts`, `host/config-live.ts` — host TOPOLOGY composition (compose the
  substrate Live Layers + channel layers into a runnable host). Composition is a
  binding-edge concern; stays. (It composes `RuntimeControlPlaneRecorderLive` +
  `RuntimeControlRequestControlPlaneLive` — that is composition, not a substrate
  leak, but see Bucket B for whether the *composition root* belongs in a runtime
  host-composition module.)
- `host/mcp-host.ts`, `mcp-channel-metadata.ts`, `runtime-context-mcp-base-url.ts`
  — MCP projection edge (tf-r8ib classified this; keep as named binding edge).

### Bucket B — SUBSTRATE-INTERNAL that should move BELOW the box (into runtime/substrate)

These expose runtime substrate wiring from host-sdk; they are interior, not
binding edge:

- `host/runtime-substrate.ts` — runtime substrate wiring (HostRuntimeObservationStreamsLive,
  RuntimeAgentToolExecutionLive). Candidate to move to `runtime/substrate` (or be
  consumed via a channel/runtime composition entrypoint) so host-sdk does not
  re-expose substrate Live Layers.
- `host/per-context-runtime-output.ts` — per-context RuntimeOutputTable layer
  wiring. Substrate interior (output read composition). Move below the box; the
  client already reaches output through the SessionAgentOutput channel + its own
  cache (tf-qu7l). Coordinate with tf-aq4d (the snapshot output-read extraction
  candidate) — this is the same machinery.
- `host/control-request-side-effects.ts` — the dispatcher's side-effect arm. It is
  the runtime control-request mechanism living in host-sdk; belongs with the
  request-dispatcher in `substrate/control-plane` (or a runtime host-composition
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
  substrate reach. Classify: the lowering stays (binding edge); the
  workflow/catalog dependency should resolve through the substrate box's
  public-ish runtime composition + the channel contracts, not direct internal
  imports. Coordinate with tf-zd8s's ChannelInventory retirement.
- `host/agent-tool-host-live.ts` — agent-tool host that writes control-plane rows.
  The write should go through the relevant channel binding (it partly does post-
  tf-aago); residual direct-table writes are a leak to close as the channelization
  completes.

## §5 Migration slices (for tf-bffo — sequence)

Each slice is a behavior-preserving move/rename; no logic changes.

1. **Slice 1 — create the substrate box + move the two authorities dirs.**
   `mkdir substrate/`; move `authorities/` → `substrate/control-plane/`
   (recorder.ts + time.ts), `control-plane/control-request-dispatcher.ts` →
   `substrate/control-plane/request-dispatcher.ts`; delete the
   `control-plane/index.ts` `../authorities` re-export umbrella, replace with
   `substrate/control-plane/index.ts` explicit exports. Move
   `agent-event-pipeline/authorities/*` → `substrate/observation/`. Update imports.
   Net: zero `authorities/` dirs; `control-plane` is a substrate domain.
2. **Slice 2 — move the rest of the box interior.** `verified-webhook-ingest/` →
   `substrate/webhook-ingest/`; `streams/` → `substrate/observation/`;
   `workflow-engine/` → `substrate/workflow-engine/`. Keep agent-event-pipeline
   stages where they are. Update imports + `runtime/src/index.ts`.
3. **Slice 3 — narrow the box's export surface (the substrate-box-not-doorway
   move).** Stop re-exporting the authority Tags as upper-runtime API from
   `runtime/src/index.ts`; above-box consumers route through channels. This is the
   load-bearing §0 correction; sequence it AFTER the channelization is complete
   enough that no above-box consumer still needs the raw Tags (audit first, like
   the tf-aago compat audit). May be its own bead if the consumer audit is large.
4. **Slice 4 — host-sdk Bucket B relocation.** Move `runtime-substrate.ts`,
   `per-context-runtime-output.ts`, `control-request-side-effects.ts` below the box
   (into `substrate/`), leaving host-sdk with binding-edge + topology composition
   only. Coordinate Bucket C with tf-pisb (codec/byte adapters) + tf-zd8s
   (ChannelInventory).

Slices 1–2 are pure renames (low risk, do first). Slice 3 is the architectural
payload (needs a consumer audit). Slice 4 + Bucket C coordinate with named
in-flight beads.

## §6 Acceptance check (per the bead)

- [x] No target tree with two unrelated directories named `authorities`.
- [x] Domain-first target tree with an explicit substrate box.
- [x] Naming glossary (authority retired as dir; kept as narrow doc term).
- [x] Target homes decided: recorder + dispatcher → `substrate/control-plane`;
  output journal/public + streams → `substrate/observation`; webhook ingest +
  workflow engine → `substrate/`; the host-sdk Bucket-B files → below the box.
- [x] host-sdk leak inventory + classification (A keep / B move-below / C
  channel-align) + migration slices.
- [x] Load-bearing dispatcher / request-row bridge preserved (moved, not deleted).
- [x] Authority tags framed as migration-era substrate internals, not a public
  doorway; channels are the single above-box doorway.

## §7 Open questions for coordinator / Gurdas

1. **Slice 3 scope**: narrowing the authority-Tag export surface needs an
   above-box consumer audit (who still imports `RuntimeControlRequests` etc.
   outside the box). Should that be a sub-bead of tf-bffo or its own bead? (It's
   the real architectural payload; Slices 1–2 are cosmetic renames.)
2. **Channel bindings co-location**: leave host-sdk owning `host/channels/*`
   (firewall-permitted), or relocate channel Live Layers to
   `runtime/substrate/channels` so bindings sit with the box? Recommend LEAVE
   (firewall permits; lower churn) unless there's a reason to co-locate.
3. **`agent-event-pipeline` vs `substrate`**: the pipeline stages
   (codecs/sources/transforms) are external-effect adapters — keep them as a
   sibling of `substrate/`, or nest under `substrate/adapters/`? Recommend sibling
   (they are the boundary INTO the box, not interior).

## §8 Cross-references

- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` §"Firewall" — the boundary
  this amends (substrate box explicit; channels = doorway)
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
| `runtime/src/{authorities,control-plane,agent-event-pipeline/authorities,workflow-engine/workflows/runtime-context*,streams/runtime-observation-streams}` | all (define + use) | **Box-interior** | No migration. Slices 1–2 relocate them inside `substrate/`; imports re-point. |
| `runtime/src/index.ts` | re-exports the full set | **The export surface** | THIS is what Slice 3 narrows: stop re-exporting authority Tags as upper-runtime API. The single load-bearing change. |
| `host-sdk/src/host/layers.ts`, `config-live.ts` | `RuntimeControlPlaneRecorderLive`, `RuntimeLocalContextResolver`, `RuntimeAgentOutputEvents` | **Host-adapter glue / topology composition** (firewall-permitted: "Live Layers for runtime-defined capability Tags") | KEEP. Re-point imports to `substrate/`. Composition must wire the substrate Live Layers somewhere; this is the legitimate host composition root, not doorway-as-API. |
| `host-sdk/src/host/agent-tool-host-live.ts` | `RuntimeContextInsert`, `RuntimeContextRead`, `RuntimeAgentOutputAfterEvents` | **Host-adapter glue** (captures services for AgentToolHost) | KEEP (re-point). The `RuntimeAgentOutputAfterEvents` read overlaps Bucket B / per-context-output (channel-migration tail, §9.2). |
| `host-sdk/src/host/commands.ts`, `internal/runtime-context-helpers.ts` | `RuntimeContextRead` | **Host-execution read** (ingress/start context resolution) | KEEP as host-adapter (re-point). Optional later: route through a context-read channel; NOT required for Slice 3. |
| `host-sdk/src/host/mcp-host.ts` | `RuntimeLocalContextResolver` | **MCP-edge route resolution** (tf-r8ib classified) | KEEP (re-point). |
| `host-sdk/src/host/runtime-substrate.ts`, `per-context-runtime-output.ts` | `RuntimeControlPlaneRecorderLive`, `RuntimeAgentOutputAfterEvents` | **Bucket B (substrate-internal re-exposed by host-sdk)** | MOVE below the box (already in §4 Bucket B / §5 Slice 4). |
| `tiny-firegrid/src/simulations/{inv1-stream-zip-body,phase0-wave-2b-stream-zip-restart-replay}/host.ts` | `RuntimeAgentOutputAfterEvents` (read), `RuntimeControlPlaneRecorderLive` (compose) | **Sim host: legitimate compose + a reach-past READ** | The compose is fine (sim is a host). The direct `yield* RuntimeAgentOutputAfterEvents` READ is a reach-past → should use the `SessionAgentOutputChannel` (channel-migration tail, §9.2). |
| `host-sdk/src/host/sync-run.ts` | — | **FALSE POSITIVE** (comment mentions `RuntimeContextInsert`; no import/use) | None. |
| Tests: `runtime/test/authorities/provider-uniqueness.test.ts`, `host-sdk/test/host/{sync-run-integration,authority-context,runtime-context-workflow-core}.test.ts`, `client-sdk/test/firegrid.layer-hoisting.test.ts` | various | **Test harness** | Re-point imports. Test-harness reads of the Tags are acceptable (white-box). The client-sdk test reading `RuntimeAgentOutputAfterEvents` is a harness shortcut, not a product-surface leak. |

### §9.2 Channel-migration candidates (the small tail, NOT box-internal)

Only these genuinely *should go through a channel* rather than re-pointing:
1. The two sim hosts' direct `RuntimeAgentOutputAfterEvents` READ → migrate to the
   `SessionAgentOutputChannel` ingress stream (the same surface client-sdk already
   uses post-Sim 1). Bounded: 2 sim files.
2. `agent-tool-host-live.ts`'s `RuntimeAgentOutputAfterEvents` read + any residual
   direct control-row writes → route through the relevant channel bindings as the
   host-adapter channelization completes (overlaps Bucket B + the post-tf-aago
   channelization). Bounded: 1 file.

Everything else is either box-interior, legitimate host-adapter composition
(re-point only), or already-scheduled Bucket B.

### §9.3 Sizing verdict — SUB-BEAD of tf-bffo (answers Q1)

**Slice 3 is a sub-bead of tf-bffo, not its own bead.** Rationale:
- The app-facing doorway is already channel-clean (client-sdk/cli/app = zero), so
  there is no large external-consumer migration to project-manage separately.
- The dominant work is mechanical: re-point box-interior + host-adapter imports to
  the `substrate/` path (rides along with Slices 1–2) and stop re-exporting the
  Tags from `runtime/src/index.ts` (one file).
- The genuine channel-migration tail is 3 files (2 sim hosts + 1 host-adapter
  read), all using an already-existing channel (`SessionAgentOutputChannel`).
- The Bucket-B relocation is already its own Slice 4.

So Slice 3 = "narrow `runtime/src/index.ts` exports + re-point host-adapter imports
+ migrate the 3-file reach-past tail to `SessionAgentOutputChannel`." That fits
inside tf-bffo as a sub-step; minting a separate bead would add coordination
overhead disproportionate to a 3-file channel-migration + an export-surface trim.
(If Gurdas prefers isolation for the export-surface trim specifically — because it
is the one behavior-surface change vs the cosmetic renames — it could be a thin
sub-bead; but it does not need to be a peer of tf-bffo.)

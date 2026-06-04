# FINDING — packages/client-sdk/src/firegrid.ts empirical baseline

Bead: `tf-tw49` · gates: `tf-ivl6` (refactor)

This is a measurement artifact, not a refactor design. The bead surfaced
8 concerns; this doc classifies each against direct-source evidence and,
where useful, trace evidence from
`packages/firelab/.simulate/runs/2026-05-20T00-00-43-070Z__codex-acp-tool-calls/trace.jsonl`
(4017 spans / 90.012s window / driver = codex-agent-acp). The
60-sec-grep heuristic was applied first: 6 of 8 concerns settle from
direct source-read of `firegrid.ts` alone; 2 (#1, #7) are
source-verified and trace-amplified for magnitude.

For each concern: **EVIDENCE** (source / trace), **VERDICT**
(`source-verified` / `trace-amplified` / `structural-only`), **IMPLICATION**
(what `tf-ivl6` should plan for).

File state at this measurement:

```bash
wc -l packages/client-sdk/src/firegrid.ts
# 1010
grep -c "Schema\.decodeUnknown" packages/client-sdk/src/firegrid.ts
# 11
grep -n "^const make = " packages/client-sdk/src/firegrid.ts
# 456:const make = (config: ResolvedConfig) =>
grep -n "^const firegridServiceLayer" packages/client-sdk/src/firegrid.ts
# 987:const firegridServiceLayer = Layer.scoped(
```

`make` body spans lines 456→987 = **531 lines** (bead filed against 470,
total file was 982 in dispatch → drift continues).

## Run summary (codex-acp-tool-calls)

`simulate:perf` reports 4017 spans across a 90.012s window. Top
self-time is dominated by long-lived durable-stream `rows()` subscriptions:

```text
1. 15173ms self  host    firegrid.agent_event_pipeline.acp.prompt
2. 15150ms self  driver  firegrid.durable_table.rows
3. 15007ms self  driver  firegrid.durable_table.rows
4. 14991ms self  driver  firegrid.durable_table.rows
5. 14939ms self  driver  firegrid.durable_table.rows
6. 11718ms self  driver  firegrid.durable_table.rows
7.  6788ms self  driver  firegrid.durable_table.rows
8.  5061ms self  driver  firegrid.side.driver
9.  2948ms self  driver  firegrid.durable_table.rows
10. 2675ms self  driver  firegrid.durable_table.rows
11. 1823ms self  host    firegrid.workflow_engine.execution.execute
12. 1778ms self  codec   firegrid.host.codec.start_session
```

```bash
pnpm --filter firelab simulate:perf \
  2026-05-20T00-00-43-070Z__codex-acp-tool-calls \
  --top 12 --idle-threshold-ms 1000
```

Driver-side `firegrid.client.*` calls in this run:

```bash
jq -r '.name' "$TRACE" | grep '^firegrid\.client\.' | sort | uniq -c
#  6 firegrid.client.runtime_input_intent.append
#  1 firegrid.client.runtime_context_request.append
#  1 firegrid.client.runtime_start_request.append
#  1 firegrid.client.session.create_or_load
#  6 firegrid.client.session.prompt
#  1 firegrid.client.session.start
```

Sample is **~7 client SDK call sites** + repeated prompt input writes. Per-call
amplification of underlying durable-table activity is the key question
for concerns #1 and #7.

## Per-concern verdicts

### #1 Per-call layer construction — **`trace-amplified`**

**Source.** `outputLayerForContext` (`firegrid.ts:327-340`) constructs
`RuntimeOutputTable.layer({…})` from `config + context`. It is invoked
inside the BODY of:

- `readSnapshot` at `firegrid.ts:504` (inside `Effect.gen` →
  `Effect.provide(outputLayerForContext(config, context))`)
- `waitForAgentOutputObservation` at `firegrid.ts:574` (same pattern)

Both call sites are inside `Effect.scoped` so the layer DOES tear down
correctly per call. There is no caching; every snapshot read and every
wait acquires a fresh `RuntimeOutputTable.layer`.

**Trace.** 80 `firegrid.durable_table.layer.acquire` spans for the
4017-span sim window; by namespace:

```bash
jq -r 'select(.name=="firegrid.durable_table.layer.acquire")
  | .attributes["firegrid.durable_table.namespace"]' "$TRACE" \
  | sort | uniq -c
#   1 firegrid.durableTools
#   2 firegrid.runtime
#  75 firegrid.runtimeOutput
#   1 firegrid.sandboxSupervisor
#   1 firegrid.workflow
```

75 of 80 acquires are for `firegrid.runtimeOutput`. Even after netting
out the 42 host-side per-context-writer acquires (parent ∈
`firegrid.runtime_output.per_context.*`), at least 18 are immediately
under driver-side scopes — i.e., **at least 18 client-SDK-rooted
RuntimeOutput layer acquires per ~7 SDK call sites** = ~2.5x amplification
per public surface call. Long-lived `durable_table.rows` stream spans
(items 2-7 in the top-self-time table, 6.7-15.2s each) are the
downstream cost of each acquire — each layer brings up a `createStreamDB`
preload + an open subscription that runs for the wait window.

**Implication for tf-ivl6.** Hoist the `RuntimeOutputTable` layer per
*context* (not per call) once the client knows the contextId. Caller-scope
binding (Layer.scoped at session-handle creation, reused across snapshot
+ all waits on that handle) eliminates the per-call acquire/preload and
collapses the cohort of long-lived `rows()` streams to one per session.

### #2 sessionId / contextId conflation — **`source-verified`**

**Source.** `firegrid.ts:826` and `firegrid.ts:843`:

```ts
// inside makeSessionHandle
sessionId,
contextId: sessionId,
```

89 combined references to `sessionId` / `contextId` across the file. The
`FiregridSessionHandle` interface (`firegrid.ts:160-174`) carries BOTH
fields and binds them to the same value. The same pattern at line 843
inside `prompt`:

```ts
yield* Effect.annotateCurrentSpan({
  "firegrid.context.id": sessionId,
  …
})
```

**Verdict.** Source-verified. The two identifiers are aliases in the
session-handle path. The bead frames this as a conflation; reading the
code, it appears to be an intentional 1:1 mapping at the session-handle
seam (session handles ARE bound to a single context). There is no
observable runtime cost.

**Implication for tf-ivl6.** Naming hygiene only — pick one field name
on the handle (`contextId`) and drop the other, or rename to make the
relationship explicit (`contextId = sessionAsContext(sessionId)`). No
hot-path consequence.

### #3 Two layer entry points — **`source-verified`**

**Source.** Three exported layers (`firegrid.ts:983-1010`):

```ts
export const FiregridControlPlaneTableLive = Layer.unwrapEffect(
  Effect.flatMap(FiregridConfig, configuredFiregridControlPlaneLayer),
)

const firegridServiceLayer = Layer.scoped(
  Firegrid,
  Effect.flatMap(FiregridConfig, (cfg) =>
    Effect.flatMap(resolveConfig(cfg), make)),
)

/** Requires RuntimeControlPlaneTable from scope. */
export const FiregridLive = firegridServiceLayer

/** FiregridLive + its own control-plane layer. */
export const FiregridStandaloneLive = FiregridLive.pipe(
  Layer.provide(FiregridControlPlaneTableLive),
)
```

Two service entry points — `FiregridLive` (requires
`RuntimeControlPlaneTable` from scope, co-tenanted with the host) and
`FiregridStandaloneLive` (provides its own control plane). The
intentional distinction is documented inline.

**Verdict.** Source-verified, **and the duality is load-bearing**: the
comment at `firegrid.ts:963-969` says co-locating the control plane with
the runtime host gives both sides one materialized RuntimeContext index.
Standalone clients (browsers, snapshot-only scenarios) need the
self-contained variant.

**Implication for tf-ivl6.** This is not a defect, but the surface area
of the trio (`FiregridControlPlaneTableLive`, `FiregridLive`,
`FiregridStandaloneLive`) is easy to mis-use. Consider an explicit
`FiregridLive.standalone` / `FiregridLive.coTenanted` factory or named-arg
constructor so the choice is obvious to consumers. Refactor scope: docs
+ naming, not removal.

### #4 Schema decode dupes — **`source-verified`**

**Source.** 11 `Schema.decodeUnknown(...)` call sites
(`firegrid.ts:345, 352, 359, 366, 373, 380, 387, 394, 401, 410, 419`).
Each is wrapped in its own `decode*` function defined at module level.
Each call constructs the decoder inline:

```ts
// firegrid.ts:380 (example, repeated 11x with different schemas)
const decodeSessionAttachInput = (request) =>
  Schema.decodeUnknown(FiregridClientOperations.sessions.attach.inputSchema, {
    onExcessProperty: "error",
  })(request).pipe(Effect.mapError(cause => new LaunchInputError({ cause })))
```

The error-mapping pattern is identical across all 11. The decoder for
each schema is rebuilt per call — `Schema.decodeUnknown(schema, opts)`
allocates a closure each time, not memoized.

**Verdict.** Source-verified. Two issues stacked:
1. **Per-call decoder allocation.** Effect Schema's `decodeUnknown`
   compiles the parser on each invocation unless you hoist
   `Schema.decodeUnknown(schema, opts)` to a module-level const and
   call it (still costs an allocation per call but skips compilation).
2. **Boilerplate duplication.** 11 nearly-identical `decode*` functions;
   a generic helper (e.g., `decodeWith<Input, Error>(schema, makeError)`)
   would compress to one.

**Implication for tf-ivl6.** Hoist decoders to module-level constants
(zero-cost change), then collapse the 11 wrappers behind a single
`decodeWith` helper. Hot-path benefit is real but small (decode runs once
per public-surface call, not per loop iteration); main win is
maintenance + auditability.

### #5 `make()` size drift — **`source-verified`**

**Source.** `make = (config: ResolvedConfig) => Effect.gen(function* () {…})`
opens at line 456 and closes at line 987 inside `firegridServiceLayer`.

```bash
awk 'NR==456,NR==987' packages/client-sdk/src/firegrid.ts | wc -l
# 532
```

**531 lines** in the `make` body. Bead was filed at 470; the dispatch
re-measured at "now 982" file total. Today: 1010 file total, 531-line
`make`. **Drift continues.**

**Verdict.** Source-verified, and growing. Inside `make` are at least:

```
make(config)
├── resolveContext           (firegrid.ts:466-472)
├── readSnapshot             (firegrid.ts:474-515)
├── open                     (firegrid.ts:517-520)
├── watchContexts            (firegrid.ts:522-539)
├── waitForAgentOutputObservation (firegrid.ts:541-587)
├── waitForAgentOutput       (firegrid.ts:589-603)
├── waitForPermissionRequest (firegrid.ts:605-629)
├── waitUntilContextReady    (firegrid.ts:631-639)
├── appendRuntimeInputIntent (firegrid.ts:641-672)
├── createContextRequest     (firegrid.ts:674-721)
├── appendRuntimeStartRequest (firegrid.ts:723-757)
├── permissionResponseInput   (firegrid.ts:759-786)
├── appendDecodedPermissionResponseIntent (firegrid.ts:788-790)
├── makeSessionHandle        (firegrid.ts:792-870)
├── createOrLoadSession      (firegrid.ts:872-893)
├── attachSession            (firegrid.ts:895-900)
└── return Firegrid.of({ … })
```

**Implication for tf-ivl6.** Decompose `make` by SUBSURFACE: snapshot ops
(resolveContext, readSnapshot, open, watchContexts), wait ops
(waitForAgentOutputObservation, waitForAgentOutput,
waitForPermissionRequest, waitUntilContextReady), append ops
(appendRuntimeInputIntent, appendRuntimeStartRequest, createContextRequest,
permissionResponseInput, appendDecodedPermissionResponseIntent), and
session-handle factory. Each subsurface is a standalone module that
returns a closed-over op-bag given `(config, control, output-layer-factory)`.

### #6 Two observation shapes — **`source-verified`**

**Source.** The snapshot surface (`firegrid.ts:121-129`) holds BOTH raw
event rows AND derived observations side-by-side:

```ts
export interface RuntimeContextSnapshot {
  readonly contextId: string
  readonly context?: RuntimeContext
  readonly status?: RuntimeRunEventRow["status"]
  readonly runs: ReadonlyArray<RuntimeRunEventRow>
  readonly events: ReadonlyArray<RuntimeEventRow>          // raw rows
  readonly logs: ReadonlyArray<RuntimeLogLineRow>
  readonly agentOutputs: ReadonlyArray<RuntimeAgentOutputObservation>  // derived
}
```

And `snapshotFromJournal` (`firegrid.ts:435-438`) derives `agentOutputs`
from `events` per call:

```ts
const agentOutputs = events.flatMap(row => {
  const observation = runtimeAgentOutputObservationFromRow(row)
  return Option.isSome(observation) ? [observation.value] : []
})
```

A third shape (`RuntimePermissionRequestObservation`) is exported through
this module (line 71 re-export) and derived from `RuntimeAgentOutputObservation`
inside `waitForPermissionRequest` via
`runtimePermissionRequestObservationFromAgentOutput` (firegrid.ts:618, 623).

**Verdict.** Source-verified. The snapshot surface intentionally returns
both shapes so callers can choose: raw `events` for debugging /
materialized-row clients, decoded `agentOutputs` for normalized
consumption. The duality is a public-surface choice, not a bug — but the
on-the-fly `runtimeAgentOutputObservationFromRow` decoding per snapshot
duplicates work clients could share.

**Implication for tf-ivl6.** Consider memoizing the
`row → observation` decode in a derived-projection layer so multiple
snapshot reads on the same context don't re-decode the same rows. Pure
source-level change; no public-surface breakage if `agentOutputs` stays
on the snapshot interface.

### #7 Snapshot full-table scans — **`trace-amplified`**

**Source.** `readSnapshot` (`firegrid.ts:474-515`) issues 3 separate
`*.query` calls, each of which is a FULL `.toArray.filter(row.contextId === ctx)`
over the whole TanStack collection:

```ts
const runs = yield* control.runs.query((coll) =>
  coll.toArray.filter(row => row.contextId === contextId))      // L480
…
const events = yield* outputTable.events.query((coll) =>
  coll.toArray.filter(row => row.contextId === contextId))      // L499
const logs = yield* outputTable.logs.query((coll) =>
  coll.toArray.filter(row => row.contextId === contextId))      // L501
```

Then `snapshotFromJournal` (`firegrid.ts:431-443`) re-filters the
already-narrowed arrays:

```ts
const events = inputs.events.filter(row => row.contextId === contextId)
  .sort(compareJournalRows)                                     // L432-434
const logs = inputs.logs.filter(row => row.contextId === contextId)
  .sort(compareJournalRows)                                     // L439-441
```

So a single snapshot does:
- 3 full-table `toArray.filter` scans (lines 480, 499, 501)
- 2 redundant re-filters of already-filtered arrays (lines 433, 440)
- 1 flatMap over events to derive `agentOutputs` (line 435)

The bead frames this as `O(n×m)`; the precise shape is
`O(n_runs + n_events + n_logs + m_events + m_logs)` per snapshot, where
n_x is total rows across all contexts in the collection.

**Trace.** Query distribution from the codex-acp run:

```bash
jq -r 'select(.name=="firegrid.durable_table.query")
  | .attributes["firegrid.durable_table.name"]
    + "/" + .attributes["firegrid.durable_table.collection"]' "$TRACE" \
  | sort | uniq -c | sort -rn | head -5
# 319 firegrid.durableTools.waits/waits
#  29 firegrid.runtime.runs/runs
#  28 firegrid.runtimeOutput.events/events
#  21 firegrid.runtime.lifecycleRequests/lifecycleRequests
#  16 firegrid.durableTools.completions/completions
```

29 + 28 + 21 = 78 full-table scans on runs/events/logs collections
during the 90s window. Row-count distribution on `durable_table.query`
spans:

```bash
jq -r 'select(.name=="firegrid.durable_table.query")
  | .attributes["firegrid.durable_table.query.row_count"]' "$TRACE" \
  | sort -n | uniq -c | tail -8
#  18 6
#  17 7
#  19 8
#  37 9
#  25 10
#  16 11
#  27 12
#  40 13
#  58 14
```

Many queries return 14 rows; full-table scans grow linearly in
cross-context volume.

**Implication for tf-ivl6.** Two tractable fixes:
1. **Drop the redundant re-filters** in `snapshotFromJournal` (lines 433,
   440) — the producer already filtered. Pure mechanical removal.
2. **Replace `.toArray.filter` with an indexed lookup** if DurableTable's
   TanStack collection supports a per-key index (or maintain an in-memory
   `contextId → rows` index in the snapshot reader). Larger refactor;
   gate on whether snapshot is on a hot path in real usage (this run has
   no direct snapshot calls in the client.* span set, so the cost shows
   up indirectly via `query` row-count growth).

### #8 `waitForPermissionRequest` entanglement — **`source-verified`**

**Source.** `waitForPermissionRequest` (`firegrid.ts:605-629`) delegates
DIRECTLY to `waitForAgentOutputObservation` with a permission-filter
predicate, and double-extracts the permission shape on match:

```ts
const waitForPermissionRequest = (
  contextId, request,
): Effect.Effect<SessionPermissionRequestWaitOutput, …> =>
  Effect.gen(function* () {
    const input = yield* decodeSessionPermissionRequestWaitInput(request)
    const matched = yield* waitForAgentOutputObservation(
      contextId,
      input,
      observation =>
        Option.isSome(runtimePermissionRequestObservationFromAgentOutput(observation)),  // call #1
    )
    return Option.match(matched, {
      onNone: () => ({ matched: false, timedOut: true }) as const,
      onSome: output => {
        const permission = runtimePermissionRequestObservationFromAgentOutput(output)  // call #2 (same row)
        return Option.isSome(permission)
          ? ({ matched: true, request: permission.value } as const)
          : ({ matched: false, timedOut: true } as const)
      },
    })
  })
```

Entanglement is twofold:
1. **Same machinery, different output shape.** PermissionRequest waits
   ride the same `output.events.rows().pipe(filterMap(...))` projection
   as agent-output waits (see `firegrid.ts:561-571`). When the bead
   refers to entanglement, this is the substrate: both wait kinds share
   the per-call `outputLayerForContext` + projectionWait flow.
2. **Double-decode on match.** `runtimePermissionRequestObservationFromAgentOutput`
   is called twice on the same matched row — once as the predicate
   (line 618), once to extract `permission.value` (line 623). If the
   row no longer satisfies the predicate by the time we run it again,
   the wait reports `{ matched: false, timedOut: true }` — an
   inconsistency window between predicate-eval and result-extraction.

**Verdict.** Source-verified.

**Implication for tf-ivl6.** Two changes worth bundling:
1. Predicate + extractor as one operation — pass an `Option<T>`-returning
   extractor to `waitForAgentOutputObservation` (or its successor) so a
   matched observation is captured as the extracted T at predicate time.
2. Lift the projection-source distinction at the type level — if there's
   a future PermissionRequest-specific row stream, branding it (mirrors
   the `ProjectionStream` work in PR #440) would prevent the entanglement
   becoming a footgun.

## Verdict matrix

| # | Concern | 60-sec grep | Trace amplification | Verdict | Affects hot path? |
|---|---|---|---|---|---|
| 1 | per-call layer construction | ✓ (firegrid.ts:327, called inside L504 + L574) | ✓ (75/80 acquires for runtimeOutput; 9 long-lived rows spans 6.7-15.2s) | source-verified + trace-amplified | **yes (per call)** |
| 2 | sessionId/contextId conflation | ✓ (firegrid.ts:826, 843; 89 refs) | n/a | source-verified, **structural-only** | no |
| 3 | 2 layer entry points | ✓ (firegrid.ts:1000 vs 1008; comment at L963-969) | n/a | source-verified, **load-bearing distinction** | no |
| 4 | schema decode dupes | ✓ (11 sites, all identical wrapper shape) | n/a | source-verified | minor (1 decode per public-surface call) |
| 5 | `make()` 470 → 531 lines | ✓ (file 1010 today; make spans 456-987) | n/a | source-verified, drift continuing | no |
| 6 | two observation shapes | ✓ (snapshot has both raw events + derived agentOutputs) | n/a | source-verified, **intentional dual surface** | no |
| 7 | snapshot O(n×m) | ✓ (3 full-table scans + 2 redundant re-filters per snapshot) | ✓ (29+28+21 = 78 scans; many queries returning 14 rows) | source-verified + trace-amplified | yes (per snapshot) |
| 8 | waitForPermissionRequest entanglement | ✓ (delegates to waitForAgentOutputObservation; double-decode) | n/a | source-verified | indirectly (shares #1 cost via shared projection) |

## What tf-ivl6 should address vs. deprioritize

**High-priority refactor surface (hot-path data):**
- **#1 per-call layer construction** — biggest measurable cost; hoist
  `RuntimeOutputTable.layer` per session-handle, not per call.
- **#7 snapshot full-table scans** — drop the redundant re-filters (free
  win) and consider an indexed `contextId → rows` projection.

**Medium-priority (mechanical, low risk):**
- **#4 schema decode dupes** — hoist decoders + collapse 11 wrappers
  behind one `decodeWith` helper.
- **#5 `make()` decomposition** — split by subsurface (snapshot / wait /
  append / session-factory). The make-body drift is the canary, not the
  bug.
- **#8 waitForPermissionRequest entanglement** — predicate+extractor
  unification; lift dependency on agent-output wait substrate to a
  shared internal helper.

**Low-priority (structural-only, no observable cost):**
- **#2 sessionId/contextId conflation** — naming hygiene only. Pick one
  name on `FiregridSessionHandle` or document the alias.
- **#3 two layer entry points** — keep both, but consider a single
  `FiregridLive.{standalone,coTenanted}(...)` factory so the choice is
  declarative.
- **#6 two observation shapes** — public surface choice; the only refactor
  win is memoizing the `row → observation` decode internally.

## Follow-up query set

Use this minimum query set for future client-sdk-perf comparisons:

```bash
TRACE=packages/firelab/.simulate/runs/<RUN>/trace.jsonl

# Per-call layer acquire amplification (concern #1)
jq -r 'select(.name=="firegrid.durable_table.layer.acquire")
  | .attributes["firegrid.durable_table.namespace"]' "$TRACE" \
  | sort | uniq -c

# Full-table scan pressure (concern #7)
jq -r 'select(.name=="firegrid.durable_table.query")
  | .attributes["firegrid.durable_table.name"]
    + "/" + .attributes["firegrid.durable_table.collection"]' "$TRACE" \
  | sort | uniq -c | sort -rn | head

# Long-lived rows() subscriptions (downstream of concern #1)
jq -r 'select(.name=="firegrid.durable_table.rows") | .durationMs // (.endTime - .startTime)/1e6' "$TRACE" \
  | sort -n | tail -10

# Client-side surface call site coverage
jq -r '.name' "$TRACE" | grep '^firegrid\.client\.' | sort | uniq -c
```

## Bounds

- This baseline used **one** sim (`codex-acp-tool-calls`,
  `2026-05-20T00-00-43-070Z`). It exercises session create/load + 6
  prompts but not all client.* surfaces (no explicit `wait.forAgentOutput`
  / `wait.forPermissionRequest` / `snapshot` driver call in this run's
  client.* span list — the durable-table query pressure observed there
  comes via the host-side per-context outputs + the workflow engine /
  wait router). A targeted snapshot-heavy or wait-heavy sim would
  amplify #1 + #7 further; for the dispatch's purpose (classify which
  concerns are real-via-data vs structural-only) the source-grep
  evidence is the load-bearing artifact for 6 of 8.
- The 75 runtimeOutput layer.acquire spans include host-side per-context
  output-writer acquires (42 of them, parent ∈
  `firegrid.runtime_output.per_context.*`). The remaining ≥18 are
  client-SDK-rooted; the exact split between client vs host residue
  depends on fiber-parenting visibility in this trace (15 acquires had
  no parent span in the trace file).
- `make()` line measurement is from current main + the PR #440 / #448 /
  PR #441 lineage; future merges may shift line numbers but not the
  body-size trend.

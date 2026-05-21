# tf-qu7l — client-sdk read-path methods → channel surface (rewire plan)

Status: PLANNING (execution HELD on lane 1's tf-05jj Slice B landing)
Owner: Lane 5 (opus)
Bead: tf-qu7l (P1)
Dep: GATED on tf-05jj Slice B (lane 1) — both touch client-sdk/firegrid.ts read/observation region; parallel execution would collide. Rebase onto Slice B, THEN route the read methods.
Context: tf-aago (PR #560) collapsed the WRITE half (§1.2 #3); this is the deferred READ half. Channels already exist on main (tf-zd8s).

This is the STABLE analysis. Channel Tag names are final (tf-zd8s merged); only
the exact firegrid.ts line regions firm up after Slice B cleans the observation
area.

## 1. Read methods → channel mapping (current firegrid.ts)

| Method | Current impl (substrate read) | Target channel | Feasibility |
| --- | --- | --- | --- |
| `firegrid.watchContexts(pred)` | `control.contexts.subscribe(...)` with predicate filter (RuntimeContext stream) | `HostContextsChannel` (ingress over `control.contexts.rows()`) | CLEAN — both read contexts.rows(); ~18 LOC → ~4 |
| `session.whenReady` / `waitUntilContextReady(contextId)` | `projectionWait(control.contexts.rows(), ctx => ctx.contextId === contextId)` | **HostContextsChannel** (NOT SessionLifecycle — see ⚠ below) | CLEAN if HostContexts; ~8 LOC → ~4 |
| `firegrid.snapshot` / `open(contextId).snapshot` / `session.snapshot()` / `readSnapshot(contextId)` | `resolveContext` + `control.runs.query` + `getOutputService(context)` → `outputTable.events/logs.query` → `snapshotFromJournal` | `HostContextSnapshotChannel` / `HostSessionSnapshotChannel` (callable, Pattern 2 direct-query) | COUPLED — see §3; the big LOC block but the hard one |

### ⚠ whenReady channel discrepancy (flag for coordinator)

The dispatch mapped `whenReady → SessionLifecycle (ingress)`. But the CURRENT
`waitUntilContextReady` waits on `control.contexts.rows()` (the context ROW
materializing), which is `HostContextsChannel`'s stream — NOT
`SessionLifecycleChannel`, whose stream is `control.runs.rows().filter(contextId)`
(RuntimeRunEventSchema = run lifecycle events, a different fact).

- Test `CLIENT_SESSION.6` ("whenReady completes from RuntimeContext projection
  state before prompt append") + its `materializeContextRequest` helper (which
  inserts the context row) confirm whenReady's current contract = **context
  materialized**, not "a run event fired".
- Routing whenReady through SessionLifecycle would CHANGE its semantics (wait for
  a run event instead of context materialization) and break CLIENT_SESSION.6.
- **Recommendation**: route whenReady through `HostContextsChannel` (matching
  current contexts.rows semantics) with a `runHead`-style first-match on
  `contextId`. Reserve `SessionLifecycleChannel` for a future "wait for
  started/exited run status" method if one is wanted — that's a NEW semantic, not
  whenReady's. Confirm with coordinator before executing.

## 2. Ingress routing (watchContexts + whenReady) — the clean wins

`HostContextsChannel` is `IngressChannel<RuntimeContextSchema>` over
`control.contexts.rows()`. Client standalone-default Layer (mirror the tf-aago
`HostControlChannelsStandaloneLive` pattern; lane 3's host-sdk
`HostControlChannelsLive` already provides the host-side binding):

```
HostContextsChannel binding.stream = control.contexts.rows()
  watchContexts(pred)  = channel.binding.stream.pipe(Stream.filter(pred))   // + PreloadError mapping
  whenReady(contextId) = projectionWait(channel.binding.stream, c => c.contextId === contextId)
```

This needs a client standalone-default `HostContextsChannel` Layer (requires only
`RuntimeControlPlaneTable`, like the write channels). The binding is a pure
stream over `control.contexts.rows()` — no output-machinery coupling. Add a
protocol/launch factory `makeHostContextsChannel(control)` if lane 3 didn't
provide a client-consumable one (host-sdk's HostControlChannelsLive builds it
inline; check after Slice-B rebase whether a shared factory exists or I add one,
same dedup discipline as tf-aago's host-control-request.ts).

LOC: deletes the inline `watchContexts` subscribe block (~18) + `waitUntilContextReady`
projectionWait (~8); replaces with channel dispatch (~8 total). Net ~ -18.

## 3. Snapshot routing — the coupled block (the hard part)

`readSnapshot` is the largest read block and is coupled to client-internal
output machinery:

- `getOutputService(context)` — a **stateful Ref<Map<contextId, OutputContextHandle>>**
  cache (tf-ivl6 / tf-tw49 perf optimization: one RuntimeOutputTable layer per
  contextId, shared across snapshot + wait calls). Lives inside the client
  `make()` closure.
- `outputLayerForContext(config, context)` — builds the per-context
  RuntimeOutputTable layer from the context's host stream prefix.
- `snapshotFromJournal` — assembles the snapshot from context + runs + events +
  logs + normalized agentOutputs.

The host-sdk `HostContextSnapshotChannel` binding (`snapshotForContext` in
host-control/index.ts) does the SAME reads but via `RuntimeHostConfig` +
`outputLayerForContext(config, context)` — the HOST's config, NOT the client's
per-context cache. **The client cannot consume the host-sdk snapshot binding**
(no RuntimeHostConfig; different output-reading path).

### The tension

To route client snapshot through `HostContextSnapshotChannel.binding.call`, the
client needs a standalone-default snapshot binding that owns the output reading.
But:

1. The output reading uses the **stateful Ref cache** (`getOutputService`), which
   lives in the `make()` closure. A `Layer.succeed(channel, ...)` binding provided
   to the client service can close over `getOutputService` ONLY if the binding is
   built INSIDE `make()` (after the Ref is created) and provided via a scoped
   sub-layer — awkward but possible.
2. The **tf-ivl6 layer-hoisting test** (`firegrid.layer-hoisting.test.ts`) asserts
   exactly ONE RuntimeOutputTable layer.acquire per contextId across multiple
   snapshot + wait calls. A naive snapshot binding that rebuilds the output layer
   per call would REGRESS that test. So the binding MUST reuse the cache.

### Options for snapshot

- **3A — Build the snapshot channel binding inside `make()`** closing over
  `getOutputService` (preserves the cache), provide it as an in-closure
  `Layer.succeed(HostContextSnapshotChannel, ...)`. Then `readSnapshot` becomes
  `channel.binding.call({contextId})`. Deletes the standalone `readSnapshot`
  method body but KEEPS `getOutputService` + `outputLayerForContext` +
  `snapshotFromJournal` (now inside the binding). **Net LOC ~neutral** — the logic
  moves into the binding rather than shrinking. Indirection added; cache + test
  preserved.
- **3B — Leave snapshot as-is.** It's a read composite (Pattern 2 direct-query)
  legitimately coupled to the client's output cache. The synthesis §1.2 #3 named
  WRITE helpers as targets; snapshot is not in that list. Routing it through a
  channel adds indirection without LOC reduction (the cache machinery stays).
- **3C — Re-evaluate AFTER Slice B.** Lane 1's tf-05jj Slice B "cleans the
  observation region" — it may restructure `getOutputService` / the output
  machinery. If Slice B extracts the output-reading into a reusable
  capability/Tag, snapshot channel-routing becomes clean (the binding consumes
  that capability, no in-closure Ref gymnastics). **This is why execution is
  gated on Slice B.**

### Recommendation

- Do the ingress wins (§2: watchContexts + whenReady) regardless — clean, real
  LOC reduction, no coupling.
- For snapshot: **decide AFTER rebasing onto Slice B** (3C). If Slice B exposes a
  reusable output-read capability, do 3A cleanly. If not, prefer 3B (leave
  snapshot) + flag that the ~150 LOC target isn't reachable without resolving the
  output-cache/tf-ivl6 tension, which is a bigger refactor than a channel rewire.

## 4. The ~150 LOC target reality

tf-aago got the write half (net -61). This task + tf-fyyk (prompt) are cited as
what reaches ~150. Honest assessment:

- Ingress wins (§2): ~ -18 LOC.
- Snapshot (§3): ~neutral (3A) or 0 (3B) — the output-cache machinery
  (~120 LOC: getOutputService + outputLayerForContext + OutputContextHandle +
  snapshotFromJournal + the Ref + finalizer) does NOT delete by channel routing
  alone; it's load-bearing perf state pinned by tf-ivl6.
- tf-fyyk (prompt): blocked on the egress-void-vs-row-return contract decision.

→ The ~150 target likely requires either (a) Slice B extracting the output
machinery out of firegrid.ts, or (b) accepting that the output-cache is
irreducible client state and re-baselining the target. Flag this honestly rather
than force a cosmetic shrink.

## 5. Execution order (on Slice-B-landed signal)

1. `git fetch origin main && git rebase origin/main` (onto Slice B's cleaned
   observation region).
2. Re-read the post-Slice-B `getOutputService` / output machinery — does Slice B
   expose a reusable output-read capability? Decide snapshot 3A vs 3B (§3C).
3. Route watchContexts → HostContextsChannel (ingress); whenReady →
   HostContextsChannel (NOT SessionLifecycle — §1 ⚠; confirm w/ coordinator).
4. Add client standalone-default `HostContextsChannel` Layer + (if needed) a
   shared protocol/launch `makeHostContextsChannel(control)` factory (dedup
   discipline from tf-aago: factory consumed by both client default + host-sdk
   HostControlChannelsLive).
5. Snapshot per the §3 decision.
6. Wire FiregridLive to provide the new standalone-default Layer(s).
7. `rg "@firegrid/host-sdk" packages/client-sdk/src` → 0 (preserve tf-aago invariant).
8. `pnpm preflight` green (full gate — incl. the tf-ivl6 layer-hoisting test).
9. `bash scripts/task-exit.sh tf-qu7l`.

## 6. Coordination flags — RESOLVED (coordinator confirmed all 3)

- **whenReady semantics** (§1 ⚠) — **RESOLVED: route through HostContextsChannel.**
  Coordinator confirmed the SessionLifecycle mapping was an unverified Tag-name
  guess; whenReady's contract is "context materialized" (contexts.rows). Preserve
  exact semantics + keep CLIENT_SESSION.6 green. RESERVE SessionLifecycle for a
  future "wait for started/exited run status" method (NEW semantic, separate bead
  — do NOT bend it to whenReady).
- **Snapshot 3A vs 3B** (§3C) — **RESOLVED: decide after Slice-B rebase; default 3B.**
  Leave snapshot as-is UNLESS Slice B extracts the output-read into a reusable
  capability/Tag, in which case 3A becomes clean. Do NOT force 3A for
  channel-purity if it only adds indirection at neutral LOC — the tf-ivl6
  output-cache is legitimate perf state, not grab-bag.
- **~150 LOC target** (§4) — **RESOLVED: recalibrated.** The ~150 was a Sim-2
  estimate assuming full read+prompt collapse. The output-cache (~120 LOC) is
  irreducible by channel routing (tf-ivl6-pinned). Real win measured as "bespoke
  read paths channelized + grab-bag eliminated", NOT "firegrid.ts = 150 LOC".
  Coordinator flagging this as a synthesis-doc estimate correction to Gurdas.
  Don't chase 150 by deleting legitimate perf state.
- **client-sdk → host-sdk invariant**: preserved (tf-aago established it; the new
  ingress bindings use protocol/launch factories + client standalone defaults,
  no host-sdk import).

THE TWO PINS to keep green through execution: `CLIENT_SESSION.6` (whenReady
contract) + `firegrid.layer-hoisting.test.ts` (tf-ivl6 output-cache).

## 7. Cross-references

- `packages/client-sdk/src/firegrid.ts` — readSnapshot/watchContexts/
  waitUntilContextReady/getOutputService/outputLayerForContext/snapshotFromJournal
- `packages/protocol/src/channels/host-control.ts` — HostContextsChannel,
  SessionLifecycleChannel, HostContextSnapshotChannel, HostSessionSnapshotChannel
- `packages/host-sdk/src/host/channels/host-control/index.ts` — host-side bindings
  (snapshotForContext, contexts ingress, lifecycle forSession) — reference for the
  read semantics; client cannot consume directly (needs RuntimeHostConfig)
- `packages/client-sdk/test/firegrid.layer-hoisting.test.ts` — tf-ivl6 output-cache
  invariant (the constraint on snapshot routing)
- tf-aago PR #560 — write-half precedent + the standalone-default + shared-factory
  dedup pattern to mirror
- tf-05jj Slice B (lane 1) — the gating dependency (observation-region cleanup)

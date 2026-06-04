# SDD: Session-Scoped Per-Event Observation Surface

Status: draft — framing for coordinator review + Gurdas signoff, NO code
Created: 2026-05-18
Owner: Firegrid Client SDK (sidecar `sidecar/session-observation`)

Resolves: `packages/firelab/FINDINGS.md` → TFIND-040.

Gated only on TFIND-030 (landed #329, typed `AgentOutputEvent`). NOT gated on
#332. **Explicit open decision deferred to #332:** the attach-point (session
handle vs context handle vs both) — named with tradeoffs here, not committed.

Related code (verified on `origin/main`):

- `packages/client-sdk/src/firegrid.ts` — `FiregridSessionHandle`
  (`wait.forAgentOutput`/`forPermissionRequest`, `snapshot()`),
  `RuntimeContextHandle`, `watchContexts`, internal
  `waitForAgentOutputObservation`
- `@firegrid/protocol/session-facade` — `RuntimeAgentOutputObservation`
  (typed `event: AgentOutputEvent` since #329), `runtimeAgentOutputObservationFromRow`

---

## 1. The gap is real (verified)

The public client offers, per session:

- `wait.forAgentOutput(req)` / `wait.forPermissionRequest(req)` — **single
  shot**: internally `output.events.rows() |> filterMap(observationFromRow)
  |> filter(...) |> Stream.runHead`. First match, then done.
- `snapshot()` — full re-read of the journal.
- `watchContexts(pred)` — a Stream, but **context-row** level
  (`control.contexts.subscribe`), not per-output-event.

There is **no continuous per-event session stream**. Consumers that want
incremental agent output must poll `snapshot()` or open
`RuntimeOutputTable`/`RuntimeControlPlaneTable` substrate tables directly
(evidenced by the Codex ACP test and TFIND-040). Both break the client
abstraction: snapshot polling is O(journal) per tick and racy; opening
substrate tables bypasses the projection/typing the client exists to provide.

Crucially the substrate primitive already exists and is already used
internally: `waitForAgentOutputObservation` builds exactly
`RuntimeOutputTable.events.rows()` (a live tail) → `filterMap(
runtimeAgentOutputObservationFromRow)` → `filter`. A `subscribe()` surface is
that pipeline **without** the terminal `Stream.runHead`. The gap is purely
the absent public surface, not a missing capability.

## 2. Proposed surface

A session-scoped Stream of TFIND-030 typed observations plus optional
`wait.*` enrichments:

```
subscribe(req?: {
  afterSequence?: number          // resume cursor (same field wait.* uses)
  // future: tag/predicate filters — see Q3
}): Stream.Stream<RuntimeAgentOutputObservation, PreloadError>
```

- **Element type:** `RuntimeAgentOutputObservation` (protocol projection;
  `event` is the typed `AgentOutputEvent`). This is the public, stable
  contract and is unaffected by TFIND-035's internal decoder consolidation
  (TFIND-035 retains the protocol projection observation by signoff).
- **Resumption:** `afterSequence` cursor (same semantics as
  `SessionAgentOutputWaitInput.afterSequence`) so a consumer can reconnect
  without gaps/dupes. The stream is monotonic by `(activityAttempt,
  sequence)`.
- **Termination:** define explicitly — does the stream complete on a
  terminal run event (`exited`/`failed`) or stay open (live tail) until the
  scope closes? Recommend: stays open until scope close (a live tail;
  terminal status is observable as its own event/`snapshot()`), matching the
  underlying `rows()` tail. Q2.
- **Error channel:** `PreloadError` (consistent with `wait.*`/`snapshot()`).
- **Lifecycle:** scoped (Effect `Scope`); unsubscribe on scope close, like
  `watchContexts`.
- **Reuse:** factor the existing internal pipeline so `wait.forAgentOutput`
  becomes `subscribe(...) |> filter |> runHead` — one code path, no behavior
  drift between wait and subscribe.

## 3. Attach-point options (NAMED, NOT COMMITTED — decision pending #332)

Gurdas constraint: enumerate with tradeoffs; final choice waits for #332's
client-handle shape.

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A. Session handle** | `session.subscribe()` on `FiregridSessionHandle` | Symmetric with existing `session.wait.*`/`snapshot()`; natural for app code holding a session; sessionId-scoped | Requires a session handle (`createOrLoad`/`attach`); **#332 may reshape the handle** — surface churn risk |
| **B. Context handle** | `.subscribe()` on `RuntimeContextHandle` (`launch()`/`open(contextId)`) | Lowest primitive; contextId-addressable; symmetric with `open`/`watchContexts`; independent of session-handle reshape | Less ergonomic for session-shaped consumers; `RuntimeContextHandle` is currently snapshot-only (TFIND-001 tension) |
| **C. Both** | shared stream impl exposed on both handles | Serves low-level and session consumers; impl is one pipeline | Two public surfaces to keep consistent; larger doc/test surface |

**Recommendation framing (not a commitment):** the *stream implementation*
is attach-point-agnostic (keyed by contextId, which both handles carry), so
the engineering risk of deferring the attach point is low — build the
pipeline; bind it to the handle(s) #332 settles on. Name this an **explicit
open decision pending #332**; do not block TFIND-040 design on it.

## 4. Narrow framing questions (no code until answered)

- **Q1 — attach point:** A / B / C. *Explicitly deferred to post-#332* per
  Gurdas; recorded here as open, not blocking the rest of the design.
- **Q2 — termination semantics:** live tail until scope close (recommended),
  or auto-complete on terminal run event? Affects consumer loop ergonomics.
- **Q3 — surface breadth:** minimal `subscribe()` (Stream only) vs. also
  enriching `wait.*` (e.g. predicate/`untilTag`, `wait.next(cursor)`).
  Recommend: land `subscribe()` first (the keystone primitive); `wait.*`
  enrichments as a tracked follow-up, not this PR (smallest sound surface).
- **Q4 — permission/tool sub-streams:** expose only the generic observation
  stream, or also typed conveniences (`subscribe()` filtered to
  `PermissionRequest`) mirroring `wait.forPermissionRequest`? Recommend:
  generic stream only now; conveniences are sugar over it (follow-up).

## 5. Scope / non-goals

- No substrate or protocol schema change — this is a client-sdk surface over
  the existing projection (`RuntimeAgentOutputObservation`) and the existing
  `RuntimeOutputTable.events.rows()` tail.
- Not a separate-process transport (TFIND-008), not the host reconciler
  (TFIND-039), not a runtime-intent enrichment (TFIND-038).
- Relates to TFIND-035 only as a *consumer* of the typed observation; the
  subscribe contract is stable across that consolidation (projection
  observation retained by signoff). No coupling.

## 6. Verification plan (post-signoff, for the impl PR)

- `pnpm turbo run typecheck`; full CI gate set
  (`lint && lint:dead && lint:dup && lint:deps`) + `turbo run test`.
- Tests: a deterministic streaming test (emit N agent-output rows, assert the
  stream yields N typed observations in `(activityAttempt, sequence)` order,
  resumes correctly from `afterSequence`, and that `wait.forAgentOutput`
  refactored onto `subscribe` keeps identical behavior — emit-then-observe
  discipline, deterministic cursor, no snapshot-poll race).
- CI-confirmed green before reporting.

## 7. Acceptance gate

This document is the deliverable. No production code until Q1–Q4 (Q1
explicitly deferred to #332) are dispositioned. Implementation lands on
`sidecar/session-observation` scoped to the chosen shape. FINDINGS.md ledger
is coordinator-owned.

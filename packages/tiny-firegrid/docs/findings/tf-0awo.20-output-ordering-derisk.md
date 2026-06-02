# tf-0awo.20 — output-ordering de-risk for the §12 cutover's `compareJournalRows` deletion

**Bead:** `tf-0awo.20` · **Sim:** `comp-derisk-ordering` · **Date:** 2026-06-02
**Spec under test:** `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` §3.1 + §12 Seam 1b
**Run:** `.simulate/runs/2026-06-02T11-21-34-980Z__comp-derisk-ordering/trace.jsonl`

## The question

The §12 cutover deletes the client-sdk `compareJournalRows` (activityAttempt,
sequence) sort (`client-sdk/src/firegrid.ts:399-403`, used assembling the
snapshot aggregate) and the per-context output cache, relying on the **host-wide
append-ordered `RuntimeOutputTable.events` read** to deliver order intrinsically
(`effect-durable-operators` `DurableTable.ts:124-128` — `rows()` replays initial
state in monotonic append order). The one uninstrumented edge the SDD names: can
a workflow **retry's output drain interleave with the prior attempt's tail**, so
that within one `contextId` the host-wide append order ≠ `(attempt, sequence)`?

## What the sim does (real production code, no backdoor)

`host(env)` composes the real `FiregridHost({ codec: "acp" })` and adds a
host-scoped observer that subscribes to the **host-wide** `RuntimeOutputTable.events`
projection — the exact read the cutover relies on — emitting one
`firegrid.sim.output_order_probe` span per row in append order with
`(append_index, activity_attempt, sequence, context_id)`. The driver
(`@firegrid/client-sdk` only) launches the **real** official ACP TypeScript SDK
example agent as a genuine subprocess (`src/bin/fake-acp-agent-process.ts` — real
codec, real sandbox, real per-context drain), starts it, and issues three public
prompts, the third after a `session.close()` — a deliberate probe for whether a
**second drain** is reachable through the public surface (close → terminal →
deregister → per-context `Scope.close` → re-prompt). Progress is **not** gated on
`session.wait.forAgentOutput` (in the `FiregridHost` composition that is the §3.1
*dead* per-context read — no writer feeds it); a bounded settle lets the real
drain append, and the host-wide observer is the instrument.

## Trace evidence (the deliverable)

Run outcome `DriverCompleted`. The `output_order_probe` spans:

| append_index | activity_attempt | sequence | context_id |
|---|---|---|---|
| 0 | 1 | 0 | ctx_09e3ee46… |
| 1 | 1 | 1 | ctx_09e3ee46… |
| 2 | 1 | 2 | ctx_09e3ee46… |
| 3 | 1 | 3 | ctx_09e3ee46… |
| 4 | 1 | 4 | ctx_09e3ee46… |
| 5 | 1 | 5 | ctx_09e3ee46… |
| 6 | 1 | 6 | ctx_09e3ee46… |

- **append order == `(attempt, sequence)` order**, `sequence` contiguous 0–6, no
  gap, no duplicate, one `context_id`.
- **`firegrid.unified.adapter.start_or_attach`: 1 span, `attempt = 1`.** Three
  `firegrid.unified.session.body` runs (the three prompts) — all the **same**
  execution/attempt. **0 `deregister` spans.**
- No tool-result-relay failure marker (§3.2 did not fire here; the turn stalled
  on a permission request whose host-side ACP wait timed out → `Cancelled` *after*
  driver completion).

## Finding

**Single-drain ordering is intrinsic — `compareJournalRows` is a no-op reorder on
the publicly-reachable path (sim-confirmed).** Output rows are written by one
forked drain per `contextId` stamping a single monotonic `sequenceRef`
(`codec-adapter.ts:156-162`), so the host-wide append order *is* `(attempt,
sequence)` order. The trace confirms it directly: `append_index == sequence` for
every row. Deleting the client sort does not reorder anything in this regime.

**The retry/interleave scenario `compareJournalRows`'s multi-attempt key guards is
not reachable through the public client surface.** The sim produced exactly one
attempt (`attempt=1`) across three prompts and a close→re-prompt, and **no second
drain** (0 deregisters; the single `start_or_attach`). This matches source
(decision-grade, verified this session):

- `DEFAULT_ATTEMPT = 1` is a **constant** on every public prompt/start path
  (`channel-bindings.ts:75,123`); multi-attempt is "the rare case … addressed by
  callers using the channel router directly with the explicit attempt" — not the
  public client surface.
- `startOrAttach` is a **no-op attach** when the `contextId` is already registered
  (`codec-adapter.ts:404-407`, the `attempt` arg ignored) → at most one drain /
  one `sequenceRef` per `contextId` per host-process lifetime.
- `recoverPendingSignals` **resumes the same** `(contextId, attempt=1)` execution
  and **skips** executions with a `finalResult` (`signal.ts:283-301`) — recovery
  does not bump the attempt or fork a second drain.

**Conclusion for the cutover:** deleting `compareJournalRows` is **safe** for every
state reachable through the public client surface — there is one attempt, one
monotonic `sequenceRef`, one append-ordered stream, and `append == sequence` (sim
+ source). The multi-attempt sort it provides is dead weight on that path.

## Residual — named, not silently created (epistemic tiers)

- **Not exercised by this sim (public-surface boundary):** the *explicit
  channel-router multi-attempt* path and a *host restart / crash-recovery*
  boundary. A tiny-firegrid driver may only use `@firegrid/client-sdk`, which
  pins `attempt=1`, so a public-surface sim **structurally cannot** reach a second
  drain — which is itself the de-risk result, not a sim gap.
- **Source-analysis (not sim-confirmed):** even were a second drain created, the
  prior drain cannot interleave — `deregister` does `Scope.close(entry.scope)`
  (`codec-adapter.ts:497-502`), which interrupts and **awaits** the forked drain
  fiber before returning, and a restart kills the prior process outright. So the
  cross-attempt boundary is sequenced, not concurrent. This was **not** reproduced
  here (close produced 0 deregisters in-window — the turn was stalled on a pending
  permission), so it remains analysis.
- **Follow-up if the cutover ever makes multi-attempt live:** if the explicit
  channel-router attempt-bump or a recovery-driven re-spawn is promoted to a
  reachable path, re-run an ordering sim against *that* trigger before relying on
  the bare host-wide read; the `(attempt, sequence)` ordering then has to be
  re-established as a property of the read (or the deregister-flush-before-respawn
  invariant proven), because two drains at distinct attempts each restart
  `sequence` at 0.

## Triage

Supports the §3.1/§12 cutover (de-risks an assumption); not a spec/impl gap in
current production. The one thing that *would* be an implementation gap — a second
concurrent drain interleaving — is unreachable on the public path and structurally
prevented in-process by the no-op attach.

/**
 * Fluent-runtime build-step acceptance specs — committed coverage DATA.
 *
 * These are the red→green acceptance gates for the fluent runtime redesign,
 * ported verbatim from `docs/reviews/fluent-effect-review-1.md` Appendix C/D
 * into firelab's `CoverageSpec` shape. They are the objective criteria each
 * build-order step builds toward: the gates name the host-substrate spans that
 * step must emit, so the spec is RED until the step lands and GREEN once it does.
 *
 * Why this is DATA and not (yet) attached to running sims:
 *   The oracle only counts a gate when a referenced span fires HOST-SIDE
 *   (`firegrid.side != "driver"`, coverage.ts). The fluent engine runs in-process
 *   today, so a fluent sim is `launchHost:false` → every span is `side=driver` →
 *   any gate here would be permanently vacuous (the documented stopgap footgun).
 *   These specs become gradable — flip from perma-red to genuine red→green —
 *   ONLY after the two enabling steps land:
 *     1. the fluent host/worker harness (review Appendix B: claim→replay→drive→ack
 *        stood up as the firelab "host", so engine spans are runner-controlled
 *        `side=host`, unforgeable); and
 *     2. the oracle's HOST_SUBSTRATE adopts FLUENT_HOST_SUBSTRATE (below) so these
 *        gates are legal (not lint-rejected) and gradable.
 *   Until then they live here as reviewed, locked acceptance criteria — NOT bolted
 *   onto hostless sims (which would silently read perma-not-covered).
 *
 * When a witness sim is stood up for a step, import its spec here and attach it to
 * the host-launching simulation's `coverage`. Each spec's header carries its
 * witness + mutation-harness (negative control) from the review.
 *
 * Vocabulary discipline mirrors coverage.ts: a gate names a span ONLY through
 * named/hasChild/hasDescendant; `attr(s, "k")` reads attribute VALUES (never
 * names). `startMs`/`endMs` express ordering/correlation in stock CEL.
 */
import { type CoverageSpec } from "./coverage.ts"

// ── The fluent host-substrate vocabulary the redesign must emit (review §Appendix
// C). This is the proposed retarget of the oracle's HOST_SUBSTRATE for fluent
// witnesses — every span NAME the gates below reference lives here. Adopting it in
// coverage.ts is enabling-step 2 (Firelab lane). Kept as data so a build-step sim,
// once host-launching, gates on a name the driver cannot forge.
export const FLUENT_HOST_SUBSTRATE: ReadonlySet<string> = new Set([
  "journal.step", // one durable step — the named-key unit (Appendix A)
  "journal.append", // a fenced append (§5.2.1 producer idempotency)
  "step.action", // the user side-effect; a TRIPWIRE — must not fire on a replayed step
  "durable.sleep", // a durable timer park
  "timer.schedule", // TimerScheduled appended (the park intent)
  "timer.fire", // the scheduled-append SOURCE woke us (external; unforgeable)
  "worker.claim", // a subscription claim, lease acquired (§7.2)
  "worker.ack", // ack / heartbeat (§7.2/§7.3)
  "session.drive", // replay + advance of a session under a held claim
  "race.settle", // a race/select resolution (carries the loser semantic)
  "child.spawn", // a durable child session (ChildSpawned) — not Effect.fork
  "cancel.delivered", // interruption delivered to an in-flight drive
  "state.cas", // a CAS append to keyed object state
  "stream.close", // terminal close of a finite stream (Completed/Failed)
  "sandbox.run", // a Layer-provided sandbox activity (shared with core)
  "durable.wait", // the event-park twin of durable.sleep (review D.3)
  "wait.register", // WaitRegistered appended (the wait park intent)
  "child.result", // a child publishing its terminal result as an event (review D.5)
])

// ── Shared claim (so it doesn't drift across specs). ──
const stepsDidNotError = {
  id: "steps.did_not_error",
  description: "no durable step ended in error",
  claim: "spans.filter(s, named(s, \"journal.step\")).all(s, !errored(s))",
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 1 — replay: named keys are sound under concurrent replay (Appendix A).
//   Witness: issue N steps under Effect.all(concurrency:"unbounded"), complete,
//   then re-drive against the SAME journal in one process (both epochs, one trace).
//   Mutation harness: positional construction-order keys -> on replay the
//   concurrent steps mis-key -> served=="executed" / step.action fires -> RED.
//   Build-order step 1 (named-key `step` primitive).
// ════════════════════════════════════════════════════════════════════════════
export const replayCoverage: CoverageSpec = {
  gates: [
    {
      id: "replay.path_entered", // vacuity anchor — the replay epoch ran a journaled step
      description: "the replay epoch served at least one step from the journal",
      claim: "spans.exists(s, named(s, \"journal.step\") && attr(s, \"replayed\") == \"true\")",
    },
    {
      id: "replay.served_from_journal", // the soundness invariant (decision-span form)
      description: "every replayed step was served from the journal, none re-executed",
      claim: "spans.filter(s, named(s, \"journal.step\") && attr(s, \"replayed\") == \"true\").all(r, attr(r, \"served\") == \"journal\")",
    },
    stepsDidNotError,
  ],
  corroborations: [
    {
      id: "replay.tripwire_clear", // scoped absence — sound only because epoch 1 fired step.action
      description: "no side effect re-executed under a replayed step",
      claim: "spans.filter(s, named(s, \"step.action\")).all(a, attr(a, \"replayed\") == \"false\")",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 2 — durable-sleep: wake-durable, not just replay-durable.
//   Witness: schedule a sleep, crash the drive BEFORE TimerFired, restart, let
//   the Timer SOURCE fire. Mutation harness: revert sleep to Effect.sleep
//   (process-local) -> timer.schedule + timer.fire never fire -> RED.
//   Build-order step 5 (scheduled-append timer source).
// ════════════════════════════════════════════════════════════════════════════
export const durableSleepCoverage: CoverageSpec = {
  gates: [
    {
      id: "sleep.intent_durable",
      description: "the park intent (TimerScheduled) was appended before waiting",
      claim: "spans.exists(s, named(s, \"timer.schedule\"))",
    },
    {
      id: "sleep.woken_by_source", // unforgeable: a process-local timer cannot emit this
      description: "the wake came from the scheduled-append source, not a local timer",
      claim: "spans.exists(s, named(s, \"timer.fire\"))",
    },
    {
      id: "sleep.resumed_via_wake",
      description: "a sleep resumed via the external wake (woke_via=wake), not replay or local sleep",
      claim: "spans.exists(s, named(s, \"durable.sleep\") && attr(s, \"woke_via\") == \"wake\")",
    },
    {
      id: "sleep.intent_precedes_park", // structural: parking sleeps appended their intent as a child
      description: "every parking sleep emitted its TimerScheduled before suspending",
      claim: "spans.filter(s, named(s, \"durable.sleep\") && attr(s, \"woke_via\") == \"park\").all(s, hasChild(s, \"timer.schedule\"))",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 3 — fenced-append: §5.2.1 producer idempotency (fences WRITERS).
//   Witness: drive a step, force a retry of the SAME (producerId,epoch,seq)
//   append (crash between append and ack). Mutation harness: drop the producer
//   headers (or a non-atomic store with no epoch bump) -> the retry double-writes
//   -> a second journal.append{retry:true, deduped:false} -> RED.
//   Build-order step 2 (FencedWriter in effect-durable-streams).
// ════════════════════════════════════════════════════════════════════════════
export const fencedAppendCoverage: CoverageSpec = {
  gates: [
    {
      id: "append.retry_path_entered", // vacuity anchor
      description: "a retried append occurred",
      claim: "spans.exists(s, named(s, \"journal.append\") && attr(s, \"retry\") == \"true\")",
    },
    {
      id: "append.retries_deduped",
      description: "every retried append was deduped server-side, never double-written",
      claim: "spans.filter(s, named(s, \"journal.append\") && attr(s, \"retry\") == \"true\").all(a, attr(a, \"deduped\") == \"true\")",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 4 — worker-loop: claim -> drive -> ack, plus §7.3 generation fencing
//   (fences WORKERS — distinct from Spec 3) and the next_wake turn loop.
//   Witness: two workers race a claim; the slow one acks late (stale generation);
//   a message arrives mid-turn. Mutation harness A: drive without claiming ->
//   no acquired claim -> claim.acquired fails -> RED. Mutation harness B: a stale
//   ack is NOT fenced -> cursor double-advances -> fencing gate fails -> RED.
//   Build-order step 4 (worker loop).
// ════════════════════════════════════════════════════════════════════════════
export const workerLoopCoverage: CoverageSpec = {
  gates: [
    {
      id: "claim.acquired", // orphan-drive mutation flips this to false
      description: "a worker acquired the subscription lease",
      claim: "spans.exists(s, named(s, \"worker.claim\") && attr(s, \"outcome\") == \"acquired\")",
    },
    {
      id: "drive.under_claim", // every acquired claim drove a session (downward walk only)
      description: "every acquired claim drove a session — no drive outside a claim",
      claim: "spans.filter(s, named(s, \"worker.claim\") && attr(s, \"outcome\") == \"acquired\").all(c, hasDescendant(c, \"session.drive\"))",
    },
    {
      id: "ack.completed",
      description: "a done-ack closed a turn",
      claim: "spans.exists(s, named(s, \"worker.ack\") && attr(s, \"done\") == \"true\")",
    },
    {
      id: "fencing.stale_ack_rejected", // §7.3 — witness must produce a stale ack (else vacuous)
      description: "every stale-generation ack was fenced, never advancing the cursor",
      claim: "spans.filter(s, named(s, \"worker.ack\") && attr(s, \"generation_stale\") == \"true\").all(a, attr(a, \"fenced\") == \"true\")",
    },
    {
      id: "turn_loop.rewoke", // next_wake=true on a mid-turn arrival — the free turn loop
      description: "a message arriving mid-turn triggered a follow-up wake",
      claim: "spans.exists(s, named(s, \"worker.ack\") && attr(s, \"next_wake\") == \"true\")",
    },
  ],
  corroborations: [
    {
      id: "claim.contended", // the losing worker saw ALREADY_CLAIMED (any span ok here)
      description: "a second worker observed the lease already held",
      claim: "spans.exists(s, named(s, \"worker.claim\") && attr(s, \"outcome\") == \"already_claimed\")",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 5 — race: TWO facets of the Part-1 landmine, not one.
//   (a) winner-record: the WINNER must be journaled (so replay is deterministic);
//       Effect.raceAll does NOT do this. NOT a choice — gate it either way.
//   (b) loser-fate: do LOSERS keep running and journal (restate) vs get interrupted.
//   Written for "preserve restate semantics" on both. Witness: race fast vs slow,
//   complete, re-drive. Mutation A: Effect.raceAll (no winner record) ->
//   winner_journaled=="false" -> RED. Mutation B: Effect.race (interrupt) ->
//   losers_journaled=="false" -> RED.
//   INVERSE (loser-fate only): if the team chooses interruption, invert (b) to
//   attr(r,"losers_journaled") == "false" and make its mutation the let-finish path.
//   NOTE (review §Still open): the race WITNESS must not assert which branch wins
//   (wall-clock flake); assert the determinism property (a) + replay reproduction.
//   Build-order: combinators (decide loser-fate before wiring).
// ════════════════════════════════════════════════════════════════════════════
export const raceCoverage: CoverageSpec = {
  gates: [
    {
      id: "race.settled", // vacuity anchor
      description: "a race/select resolved",
      claim: "spans.exists(s, named(s, \"race.settle\"))",
    },
    {
      id: "race.winner_journaled", // facet (a) — not a choice; replay-determinism of the race
      description: "the race winner index was journaled, so replay resolves it deterministically",
      claim: "spans.filter(s, named(s, \"race.settle\")).all(r, attr(r, \"winner_journaled\") == \"true\")",
    },
    {
      id: "race.losers_journaled", // facet (b) — the chosen loser-fate semantic, mechanically enforced
      description: "race losers kept running and journaled their step (restate semantics)",
      claim: "spans.filter(s, named(s, \"race.settle\")).all(r, attr(r, \"losers_journaled\") == \"true\")",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 6 — further semantics: closure, cancellation, durable child, sandbox,
//   keyed-state CAS. Each gate carries a one-line mutation harness:
//     closure       NC: read-to-tail without close          -> no stream.close      -> RED
//     cancellation  NC: in-process abort / swallow          -> no cancel.delivered  -> RED
//     child.spawn   NC: route through Effect.fork           -> no child.spawn       -> RED
//     sandbox.run   NC: neuter the provider Layer           -> no sandbox.run       -> RED
//     state.cas     NC: concurrent writers, no single-writer -> conflict==true      -> RED
//   Build-order step 3 (closure) + step 6 (sandbox Layer) + cut-durable-surface.
// ════════════════════════════════════════════════════════════════════════════
export const substrateSemanticsCoverage: CoverageSpec = {
  gates: [
    {
      id: "closure.terminal_record",
      description: "a finite turn closed its stream with a terminal record (reader tells done from idle)",
      claim: "spans.exists(s, named(s, \"stream.close\") && attr(s, \"terminal\") == \"completed\")",
    },
    {
      id: "cancel.interruption_delivered",
      description: "a CancellationRequested fact interrupted an in-flight drive (not the in-process abort path)",
      claim: "spans.exists(s, named(s, \"cancel.delivered\"))",
    },
    {
      id: "spawn.durable_child",
      description: "a durable child session was forked with its own stream (not an ephemeral Effect.fork)",
      claim: "spans.exists(s, named(s, \"child.spawn\"))",
    },
    {
      id: "sandbox.layer_provided",
      description: "the Layer-provided sandbox activity ran as a journaled step",
      claim: "spans.exists(s, named(s, \"sandbox.run\"))",
    },
    {
      id: "state.cas_serialized",
      description: "every CAS append to keyed state was accepted in sequence (single-writer per key)",
      claim: "spans.filter(s, named(s, \"state.cas\")).all(c, attr(c, \"conflict\") == \"false\")",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// durable.wait — the event-park twin of durable.sleep (review D.3 + D.4).
//   Witness: register a wait, deliver a NON-matching event (must re-suspend), then
//   a matching one (must resolve). The non-matching delivery is mandatory — else
//   wait.nonmatch_resuspends is vacuous green. Mutation: make the wait
//   process-local (block a fiber, no WaitRegistered) -> dies on restart -> RED.
//   Build-order: the one new primitive; four of six agent tools bottom out here.
// ════════════════════════════════════════════════════════════════════════════
export const durableWaitCoverage: CoverageSpec = {
  gates: [
    {
      id: "wait.intent_durable",
      description: "the wait registered its intent before suspending",
      claim: "spans.exists(s, named(s, \"durable.wait\") && hasChild(s, \"wait.register\"))",
    },
    {
      id: "wait.woken_by_append",
      description: "a parked wait resumed via an external append (woke_via=wake)",
      claim: "spans.exists(s, named(s, \"durable.wait\") && attr(s, \"woke_via\") == \"wake\")",
    },
    {
      id: "wait.nonmatch_resuspends", // witness MUST deliver a non-match, else vacuous
      description: "a wake whose event did not match the predicate re-suspended, it did not resolve",
      claim: "spans.filter(s, named(s, \"durable.wait\") && attr(s, \"matched\") == \"false\").all(s, attr(s, \"outcome\") == \"resuspended\")",
    },
    {
      id: "wait.predicate_matched", // D.4 — a CEL-predicated wait resolved on a real match
      description: "a CEL-predicated wait resolved on an event that satisfied the predicate",
      claim: "spans.exists(s, named(s, \"durable.wait\") && attr(s, \"matched\") == \"true\" && attr(s, \"predicate\") != \"\")",
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Cross-session join / route (review D.5) — the one new spec SHAPE: a span in
//   session B causally keyed to an event from session A, via a deterministic id.
//   Witness: parent spawns a child with a DETERMINISTIC result id ("child-1");
//   child runs and publishes its terminal result; the parent's durable.wait
//   resolves on it. Mutation A (join): child does not publish -> parent.woke_on_child
//   fails -> RED. Mutation B (cancel): a cancel targeted at session B is delivered
//   to the requester instead -> cancel.cross_session fails.
//   Build-order: spawn/spawn_all + cross-session cancel.
// ════════════════════════════════════════════════════════════════════════════
export const crossSessionCoverage: CoverageSpec = {
  gates: [
    {
      id: "child.published_result", // anchor: the child reached terminal and published
      description: "the child session published its terminal result as an event",
      claim: "spans.exists(s, named(s, \"child.result\") && attr(s, \"result.id\") == \"child-1\")",
    },
    {
      id: "parent.woke_on_child", // the causal link — parent wait keyed to the child's result
      description: "the parent's wait resolved on the child's published result (the spawn-join)",
      claim: "spans.exists(s, named(s, \"durable.wait\") && attr(s, \"matched.event\") == \"child-1\")",
    },
  ],
  corroborations: [
    {
      id: "cancel.cross_session", // session_cancel(other): delivered to a session ≠ requester
      description: "a cancel was delivered to a session other than the one that requested it",
      claim: "spans.exists(s, named(s, \"cancel.delivered\") && attr(s, \"target\") != attr(s, \"requester\"))",
    },
  ],
}

// ── Build-order traceability: each spec ↔ its review build-order step + the spans
// it gates on + the condition under which it flips GREEN. The index a build-team
// member reads to know which witness to stand up next (review §Build order).
export interface FluentBuildStepSpec {
  readonly buildStep: string
  readonly title: string
  readonly spec: CoverageSpec
  readonly emitsSpans: ReadonlyArray<string>
  /** What must be true for this spec's verdict to flip to production-path-covered. */
  readonly greenWhen: string
}

export const FLUENT_BUILD_STEPS: ReadonlyArray<FluentBuildStepSpec> = [
  {
    buildStep: "1",
    title: "Named-key `step` primitive (Effect.Service)",
    spec: replayCoverage,
    emitsSpans: ["journal.step", "step.action"],
    greenWhen: "the named-key step emits journal.step{replayed,served} host-side and step.action does not fire on a replayed step",
  },
  {
    buildStep: "2",
    title: "FencedWriter in effect-durable-streams",
    spec: fencedAppendCoverage,
    emitsSpans: ["journal.append"],
    greenWhen: "a retried (producerId,epoch,seq) append is deduped server-side, emitting journal.append{retry,deduped} host-side",
  },
  {
    buildStep: "3 + 6",
    title: "Terminal records/close, cancellation, durable child, sandbox Layer, keyed-state CAS",
    spec: substrateSemanticsCoverage,
    emitsSpans: ["stream.close", "cancel.delivered", "child.spawn", "sandbox.run", "state.cas"],
    greenWhen: "each substrate behavior emits its host-side span (note: sandbox.run may land earliest — see the merged sandbox-activity replay work)",
  },
  {
    buildStep: "4",
    title: "Worker loop (claim → replay → drive → ack)",
    spec: workerLoopCoverage,
    emitsSpans: ["worker.claim", "session.drive", "worker.ack"],
    greenWhen: "the worker harness claims, drives under the claim, acks done, and fences stale-generation acks — all host-side",
  },
  {
    buildStep: "5",
    title: "Scheduled-append timer source (durable sleep)",
    spec: durableSleepCoverage,
    emitsSpans: ["durable.sleep", "timer.schedule", "timer.fire"],
    greenWhen: "a sleep parks (timer.schedule), the source materializes the wake (timer.fire), and the drive resumes woke_via=wake",
  },
  {
    buildStep: "combinators",
    title: "race / select (decide loser-fate first)",
    spec: raceCoverage,
    emitsSpans: ["race.settle"],
    greenWhen: "the race winner index is journaled (facet a) and the chosen loser-fate is mechanically observed (facet b)",
  },
  {
    buildStep: "primitive: durable.wait",
    title: "durable.wait event-park twin (+ CEL predicates)",
    spec: durableWaitCoverage,
    emitsSpans: ["durable.wait", "wait.register"],
    greenWhen: "a wait registers intent, a non-matching wake re-suspends, and a matching/predicated wake resolves — host-side",
  },
  {
    buildStep: "spec-shape: cross-session",
    title: "Cross-session join / route (spawn-join, cross-session cancel)",
    spec: crossSessionCoverage,
    emitsSpans: ["child.result", "durable.wait", "cancel.delivered"],
    greenWhen: "a child publishes a deterministic-id result the parent's wait resolves on; a cross-session cancel reaches a session ≠ requester",
  },
]

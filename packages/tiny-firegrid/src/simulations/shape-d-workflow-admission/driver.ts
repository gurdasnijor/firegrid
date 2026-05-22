import { Console, Effect } from "effect"
import {
  type ScheduledProbeResult,
  shapeDAdmissionRuntime,
  type ToolProbeResult,
  type WaitProbeResult,
} from "./host.ts"

// tf-28b8 verdict. Per probe: which Shape the subscriber needs, the load-bearing
// workflow capability, and the empirical evidence. The classification answers
// "which target subscribers truly need Shape D workflow machinery" — Shape C is a
// keyed handler over DurableTable; Shape D adds @effect/workflow execution
// bindings (Activity / DurableDeferred / DurableClock).
interface ShapeDAdmissionVerdict {
  readonly verdict: "GREEN"
  readonly tool: { readonly shape: "C"; readonly result: ToolProbeResult }
  readonly wait: { readonly shape: "C"; readonly result: WaitProbeResult }
  readonly scheduled: { readonly shape: "D"; readonly result: ScheduledProbeResult }
}

const assertInvariant = (
  condition: boolean,
  message: string,
  detail: unknown,
) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(
      `tf-28b8 shape-d-workflow-admission invariant failed: ${message}; ${
        JSON.stringify(detail)
      }`,
    ))

export const shapeDWorkflowAdmissionDriver:
  Effect.Effect<ShapeDAdmissionVerdict, unknown> = Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => shapeDAdmissionRuntime)

    const tool = yield* runtime.runToolProbe
    const wait = yield* runtime.runWaitProbe
    const scheduled = yield* runtime.runScheduledProbe

    // ── Probe 1: tool execution -> Shape C ───────────────────────────────────
    // Shape C gives at-most-once from the durable result row alone: 3 deliveries,
    // 1 genuine execution, 1 physical side effect, identical results.
    yield* assertInvariant(
      tool.shapeC.deliveries === 3 &&
        tool.shapeC.genuineExecutions === 1 &&
        tool.shapeC.sideEffectRuns === 1 &&
        tool.shapeC.resultsAllEqual,
      "tool Shape C did not fence the external effect to once via the durable result row",
      tool.shapeC,
    )
    // Shape D (Activity) gives the SAME at-most-once across replay: the Activity
    // result memoizes, so the effect runs once. Equal outcome => Activity
    // memoization is NOT the load-bearing capability; durable result identity is.
    yield* assertInvariant(
      tool.shapeD.gen1Result === tool.shapeD.gen2Result &&
        tool.shapeD.sideEffectRuns === 1,
      "tool Shape D Activity did not memoize the external effect across reconstruction",
      tool.shapeD,
    )

    // ── Probe 2: wait routing -> Shape C ─────────────────────────────────────
    // A durable completion row recovers from durable state alone after a crash —
    // no in-memory waiter, no engine re-arm. The race reduces to reading rows.
    yield* assertInvariant(
      wait.observedPendingBeforeResolve &&
        wait.resolvedFromStateAfterCrash &&
        wait.recoveredValue === "approved",
      "wait Shape C durable completion did not reconstruct from state after crash",
      wait,
    )
    yield* assertInvariant(
      wait.raceWinner === "winner-a",
      "wait Shape C race (first-valid-terminal-wins over rows) did not resolve",
      wait,
    )

    // ── Probe 3: scheduled prompt -> Shape D ─────────────────────────────────
    // Only the DurableClock-parked body auto-recovers its wall-clock wakeup on
    // reconstruction. The Shape C due-time row does NOT fire itself — it is
    // observable only by an external poll. So a true-future wake genuinely needs
    // the Shape D timer binding.
    yield* assertInvariant(
      scheduled.shapeD.suspendedBeforeCrash &&
        scheduled.shapeD.pendingWakeupBeforeCrash === 1 &&
        scheduled.shapeD.autoCompletedAfterRestart,
      "scheduled Shape D DurableClock did not auto-recover the wakeup after restart",
      scheduled.shapeD,
    )
    yield* assertInvariant(
      !scheduled.shapeC.autoFiredAfterRestart &&
        scheduled.shapeC.observableOnlyByExternalPoll,
      "scheduled Shape C due-time row unexpectedly self-fired without an external tick",
      scheduled.shapeC,
    )

    const verdict: ShapeDAdmissionVerdict = {
      verdict: "GREEN",
      tool: { shape: "C", result: tool },
      wait: { shape: "C", result: wait },
      scheduled: { shape: "D", result: scheduled },
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tf28b8.verdict": verdict.verdict,
      "firegrid.tf28b8.tool.shape": "C",
      "firegrid.tf28b8.wait.shape": "C",
      "firegrid.tf28b8.scheduled.shape": "D",
    })

    yield* Console.log(
      [
        "tf-28b8 shape-d-workflow-admission: GREEN",
        "",
        "  Tool execution  -> Shape C (durable result identity, NOT Activity memoization)",
        `    Shape C: ${tool.shapeC.deliveries} deliveries, ${tool.shapeC.genuineExecutions} genuine exec, ${tool.shapeC.sideEffectRuns} physical side effect`,
        `    Shape D: Activity memoized -> ${tool.shapeD.sideEffectRuns} physical side effect (same once)`,
        "    => at-most-once is owned by the toolUseId-keyed durable row (C3); Activity adds nothing for correctness.",
        "",
        "  Wait routing    -> Shape C (durable completion, NOT a DurableDeferred mailbox)",
        `    pending observed=${wait.observedPendingBeforeResolve}, recovered-from-state=${wait.resolvedFromStateAfterCrash} value=${wait.recoveredValue}`,
        `    race first-valid-terminal-wins=${wait.raceWinner}`,
        "    => completion + race are pure DurableTable reads (C4); only the TIMEOUT bound needs the Shape D clock.",
        "",
        "  Scheduled prompt -> Shape D (DurableClock IS load-bearing)",
        `    Shape D: parked w/ pending wakeup=${scheduled.shapeD.pendingWakeupBeforeCrash}, auto-completed after restart=${scheduled.shapeD.autoCompletedAfterRestart}`,
        `    Shape C: auto-fired after restart=${scheduled.shapeC.autoFiredAfterRestart} (false), observable only by external poll=${scheduled.shapeC.observableOnlyByExternalPoll}`,
        "    => a true-future wake has no producer; only the engine clock recovers it. The Shape C alternative is polling/external-trigger.",
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.withSpan("firegrid.tf28b8.verdict", {
      kind: "internal",
      attributes: { "firegrid.tf28b8.scope": "shape-d-workflow-admission" },
    }),
  )

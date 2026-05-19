# Claim 1 — provideMerge as cycle-perpetuation mechanism

## Claim & test (restated)

HYPOTHESIS: the 33 `Layer.provideMerge` sites collectively create the
`RuntimeToolUseExecutorLive` ↔ `runtimeContextWorkflowSupportLayer`
cycle; specifically, `provideMerge` keeps a merged tag in the layer's
OUTPUT context, letting a downstream layer re-consume it and close the
cycle.

TEST: print both declarations, establish the actual R/ROut, identify
which `provideMerge` calls (if converted to `provide`) would break the
cycle, and count how many of the 33 are inside/composing these two
layers.

## The two named layers (cited)

**`RuntimeToolUseExecutorLive`** — `packages/host-sdk/src/host/runtime-substrate.ts:91`.
ROut: `RuntimeToolUseExecutor` (`runtime-substrate.ts:92`). R: captured
at `runtime-substrate.ts:94` via
`Effect.context<RuntimeToolUseExecutorHostEnvironment>()`, where that
env = `DurableWaitRowLookup | DurableWaitRowUpsert |
DurableWaitCompletionRowLookup | DurableWaitCompletionRowUpsert |
AgentToolHost` (`runtime-substrate.ts:35-40`).

**`runtimeContextWorkflowSupportLayer`** —
`packages/host-sdk/src/host/runtime-context-workflow-support.ts:39-53`.
`RuntimeContextWorkflowNativeLayer` piped through five operators;
`RuntimeToolUseExecutorLive` is `Layer.provideMerge`d at
`runtime-context-workflow-support.ts:46`, with
`HostRuntimeObservationSubstrateLive` plain-`Layer.provide`d *into* it at
`:47`.

## What the trace actually shows

There is **no 2-node `A ↔ B` Layer cycle**. The relationship is
one-directional containment: `runtimeContextWorkflowSupportLayer`
*consumes* `RuntimeToolUseExecutorLive` by nesting it as a `provideMerge`
argument (`runtime-context-workflow-support.ts:46`).
`RuntimeToolUseExecutorLive` does not consume anything
`runtimeContextWorkflowSupportLayer` provides — its entire R channel is
the `DurableWait* | AgentToolHost` set (`runtime-substrate.ts:35-40`).
The support layer is terminally consumed via
`Effect.provide(runtimeContextWorkflowSupportLayer(...))` into a workflow
execution (`host/commands.ts:79`, `host/agent-tool-host-live.ts:202`);
its output is never merged back into a layer feeding
`RuntimeToolUseExecutorLive`.

The maintainer comment states the genuine phenomenon verbatim: *"The
only defect was that the executor's OWN `DurableWait*` RIn was never
discharged — it flowed out as an unsatisfiable support-layer RIn (**the
layer required what it provided**)"*
(`runtime-context-workflow-support.ts:28-31`). That is a single
localized **required-what-it-provided self-edge** on the `DurableWait*`
tags, internal to `runtimeContextWorkflowSupportLayer`'s composition,
already deliberately structured (provide vs provideMerge chosen per tag:
`provideMerge` at `:44` keeps `DurableWait*` in ROut for the SDD
shared-store invariant; plain `Layer.provide(HostRuntimeObservationSubstrateLive)`
at `:47` discharges the executor's RIn). This is verified directly
against the source, not inferred from the graph.

Per the hard constraint, the hypothesis is **miscategorized** (it posits
a distributed-33-site A↔B cycle; the source shows a localized,
deliberately-managed self-edge) — stated as a finding, not reframed.

## Count of the 33 implicated

`grep -rn 'Layer\.provideMerge(' packages apps --include='*.ts' | grep -v
-e '\.test\.' -e '/test/'` yields exactly **33** real calls (comment
lines at `layers.ts:271`, `runtime-context-mcp-base-url.ts:19`
excluded). Sites *inside or directly composing* the two named layers:
`runtime-substrate.ts:81` (inside `HostRuntimeObservationSubstrateLive`)
and `runtime-context-workflow-support.ts:44, 45, 50, 51, 52` — **6
sites**. The offending `DurableWait*`-in-ROut self-edge is governed by
exactly the `:44`/`:47` provide-vs-provideMerge choice (≤5 decisive).
The remaining 27 (e.g. `cli/src/bin/run.ts:433-434`,
`apps/factory/src/host.ts:187-188`,
`runtime/src/durable-tools/DurableToolsWaitFor.ts:50-51`) are unrelated
compositions and do not participate in this edge — directly refuting
"the 33 collectively create the conditions."

## Verdict

The named 2-node cycle does not exist (one-directional containment,
terminally `Effect.provide`d). The genuine phenomenon is a single
localized required-what-it-provided self-edge, `provideMerge`-related but
already deliberately managed in-place; only ~6 of 33 sites are even
adjacent, 27 are unrelated. The hypothesis as stated (collective 33-site
perpetuation of an A↔B cycle) is not supported by the source.

VERDICT: REFUTED

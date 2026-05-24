// Wave A runtime semantic-tree boundary fixtures (tf-r1mv).
// Dedicated test file: only the 5 Wave A rules include this path, so
// fixtures here do not cross-fire with rules in dup-detection.ts. Within
// this file, where Wave A rules genuinely overlap on a pattern (e.g.
// producers/ banned by transforms, tables, and subscribers tiers), the
// affected lines carry multiple ruleid annotations.

declare const tablesAlpha: unknown
declare const channelsAlpha: unknown
declare const transformsAlpha: unknown
declare const producersAlpha: unknown
declare const eventsAlpha: unknown
declare const someAppendDef: unknown
declare const someAiPromptDef: unknown
declare const someLegacyEventDef: unknown
declare const Activity: { make: (opts: unknown) => unknown }
declare const Workflow: {
  suspend: (instance: unknown) => unknown
  execute: (workflow: unknown, payload: unknown) => unknown
}
declare const WorkflowEngine: {
  WorkflowEngine: unknown
  WorkflowInstance: unknown
}
declare const DurableDeferred: {
  make: (id: string, opts: unknown) => unknown
  await: (deferred: unknown) => unknown
}
declare const DurableClock: { sleep: (opts: unknown) => unknown }
// These four declares are themselves positive cases for R-C1
// (firegrid-composition-no-legacy-imports): the rule's identifier-only regex
// matches their identifiers wherever they appear, which is exactly what we
// want — composition/ must not even `declare` the legacy body-driver names.
// ruleid: firegrid-composition-no-legacy-imports
declare const RuntimeContextWorkflowNative: unknown
// ruleid: firegrid-composition-no-legacy-imports
declare const RuntimeContextWorkflowNativeLayer: unknown
// ruleid: firegrid-composition-no-legacy-imports
declare const executeRuntimeContextWorkflow: (a: unknown, b: unknown, c: unknown) => unknown
// ruleid: firegrid-composition-no-legacy-imports
declare const RuntimeContextWorkflowRuntime: unknown
declare const someInstance: unknown
declare const someWorkflow: unknown
declare const somePayload: unknown
declare const someEffectfulReturn: unknown

// ---------------------------------------------------------------------------
// R-T1 firegrid-transforms-purity-import-boundary
//
// Symbol-level positives: Effect/Layer/Context/Stream/Scope identifier
// imports from "effect" (including the type-only form), @effect/workflow
// package import, Activity/Workflow/DurableDeferred/DurableClock namespace
// usage, and exports returning Effect.Effect<>. Folder-path positives
// (transforms -> tables/channels/etc.) are covered by the dep-cruiser rule
// `runtime-transforms-no-higher-tier-import`. The Effect pure-helpers and
// review-time @effect/<sub> negatives sit at the end.
// ---------------------------------------------------------------------------

// ruleid: firegrid-transforms-purity-import-boundary
import { Effect as fakeEffectRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import { Layer as fakeLayerRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import { Context as fakeContextRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import { Stream as fakeStreamRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import { Scope as fakeScopeRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import type { Effect as fakeEffectTypeRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import type { Layer as fakeLayerTypeRT1 } from "effect"
// ruleid: firegrid-transforms-purity-import-boundary
import type { Scope as fakeScopeTypeRT1 } from "effect"

// Workflow-substrate namespace usage (Activity/Workflow/DurableDeferred/
// DurableClock identifiers) is ALSO banned by R-T1; the existing R-S1b
// positive cases below (under "R-S1b ..." section) cross-fire for R-T1,
// so the multi-annotated lines there cover R-T1's workflow-namespace bans.
// Keeping a single source of positives avoids duplicating fixture lines
// across two near-identical rules.

// Return-type Effect.Effect on an exported function (R-T1 ban):
// ruleid: firegrid-transforms-purity-import-boundary
declare function fakeImpureTransformRT1(state: unknown): Effect.Effect<unknown, never, never>

// Negatives — pure Effect helpers (Schema/Option/Either/Match/Predicate/Array)
// are allowed and must NOT trigger R-T1.
// ok: firegrid-transforms-purity-import-boundary
import { Schema as fakeSchemaRT1 } from "effect"
// ok: firegrid-transforms-purity-import-boundary
import { Option as fakeOptionRT1 } from "effect"
// ok: firegrid-transforms-purity-import-boundary
import { Either as fakeEitherRT1 } from "effect"
// ok: firegrid-transforms-purity-import-boundary
import { Match as fakeMatchRT1 } from "effect"
// ok: firegrid-transforms-purity-import-boundary
import { Predicate as fakePredicateRT1 } from "effect"
// ok: firegrid-transforms-purity-import-boundary
import { Array as fakeArrayRT1 } from "effect"
// ok: firegrid-transforms-purity-import-boundary
import type { Schema as fakeSchemaTypeRT1 } from "effect"
// Review-time @effect/<sub> packages (NOT silently blocked here — these are
// architecture-review territory against transforms/README §"May import").
// ok: firegrid-transforms-purity-import-boundary
import { someAiPromptDef as fakeAiRT1 } from "@effect/ai"
// ok: firegrid-transforms-purity-import-boundary
import { someAppendDef as fakePlatformRT1 } from "@effect/platform"
// Valid `../events/*` import (the new semantic-tree event-vocab home) must
// NOT trigger R-T1:
// ok: firegrid-transforms-purity-import-boundary
import { eventsAlpha as fakeEventsRT1 } from "../events/agent-input.ts"

// NOTE: Folder-direction positive cases (events->tables, tables->transforms,
// subscribers->producers, runtime-context->producers, etc.) live in
// dep-cruiser tests; this fixture only covers semgrep symbol/regex rules.
// See .dependency-cruiser.cjs for the path-direction rules.

// ---------------------------------------------------------------------------
// R-S1b firegrid-shape-c-runtime-context-no-workflow-machinery
//
// Uses literal Activity/Workflow/WorkflowEngine/DurableDeferred/DurableClock
// so the regex matches. Cross-fire matrix (multi-annotated below):
//   - R-T1 (transforms) ALSO bans Activity.*/Workflow.*/DurableDeferred.*/
//     DurableClock.* — every namespace-call line is co-annotated R-T1.
//   - tf-zchu (existing Shape C subscriber rule, paths includes
//     /semgrep-tests/**) fires on Activity.make / Workflow.suspend /
//     Workflow.execute / WorkflowEngine.* — co-annotated.
//   - C4 (existing DurableDeferred-on-RuntimeContext rule, paths includes
//     /semgrep-tests/**) fires on DurableDeferred.* — co-annotated.
// ---------------------------------------------------------------------------

function* tfWaveARS1bFixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary, firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const activityMake = Activity.make({ name: "noop", execute: undefined })
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary, firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  yield Workflow.suspend(someInstance)
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary, firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  yield Workflow.execute(someWorkflow, somePayload)
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const engineTag = WorkflowEngine.WorkflowEngine
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const instanceTag = WorkflowEngine.WorkflowInstance
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary, firegrid-c4-no-new-durable-deferred-runtime-wait
  const ddMake = DurableDeferred.make("tool:ctx:tu", { success: undefined })
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary, firegrid-c4-no-new-durable-deferred-runtime-wait
  const ddAwait = DurableDeferred.await(ddMake)
  // ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary
  const dcSleep = DurableClock.sleep({ name: "wait", duration: undefined, inMemoryThreshold: undefined })
  return void [activityMake, engineTag, instanceTag, ddMake, ddAwait, dcSleep]
}

// Cross-fire: @effect/workflow is also banned by R-T1, and the Wave C
// host-sdk rule HC1 evaluates this fixture too because explicit-file
// `semgrep --test` mode ignores `paths.include`.
// ruleid: firegrid-shape-c-runtime-context-no-workflow-machinery, firegrid-transforms-purity-import-boundary, firegrid-host-sdk-no-effect-workflow-import
import { someAppendDef as fakeWfImportRS1b } from "@effect/workflow"

// #691 Shape C session-seam compatibility: R-S1b does NOT ban Context.Tag
// usage or `Layer.succeed` in subscribers/runtime-context-session/. The
// canonical session seam shape is a typed capability tag + Layer.succeed
// implementation; those constructs must remain allowed by R-S1b so the
// merged #691 seam continues to lint clean.
// ok: firegrid-shape-c-runtime-context-no-workflow-machinery
declare const RuntimeContextSessionTag: { readonly _tag: "Context.Tag" }
// ok: firegrid-shape-c-runtime-context-no-workflow-machinery
declare const RuntimeContextSessionLayer: { readonly _tag: "Layer.succeed" }

// ---------------------------------------------------------------------------
// R-C1 firegrid-composition-no-legacy-imports
//
// Uses exact legacy body-driver symbol names so the \b-anchored regex matches.
// Legacy-symbol identifiers and the legacy mailbox / kernel / archive import
// paths are unique to R-C1 in this file. NOTE: the rule's identifier-only
// regex matches the symbol literals anywhere in the file (including comments)
// — earlier section-header text is rewritten to use generic words to avoid
// drive-by matches outside the positive cases below.
// ---------------------------------------------------------------------------

function* tfWaveARC1Fixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-composition-no-legacy-imports
  const a: unknown = RuntimeContextWorkflowNative
  // ruleid: firegrid-composition-no-legacy-imports
  const b: unknown = RuntimeContextWorkflowNativeLayer
  // ruleid: firegrid-composition-no-legacy-imports
  const c = executeRuntimeContextWorkflow(undefined, undefined, undefined)
  // ruleid: firegrid-composition-no-legacy-imports
  const d: unknown = RuntimeContextWorkflowRuntime
  return void [a, b, c, d]
}
// Cross-fire: the legacy mailbox subpath is also blocked by the new
// workflow-engine host-sdk rule (R-CW1) because it sits under the
// `@firegrid/runtime/workflow-engine/` legacy root.
// ruleid: firegrid-composition-no-legacy-imports, firegrid-host-sdk-no-runtime-workflow-engine-import
import { someAppendDef as fakeAppendDefRC1 } from "@firegrid/runtime/workflow-engine/runtime-input-deferred"

// ---------------------------------------------------------------------------
// R-CW1 firegrid-host-sdk-no-runtime-workflow-engine-import
// R-CS1 firegrid-host-sdk-no-runtime-streams-import
//
// Cleanup-wave preservation visibility: new host-sdk imports of the legacy
// `@firegrid/runtime/workflow-engine` and `@firegrid/runtime/streams` roots
// are blocked. Existing sites are baselined as Wave D / D-D deletion
// targets (see semgrep-error-baseline.json). The regex catches the exact
// root subpath and any deeper path under it.
// ---------------------------------------------------------------------------

// Bare-root positives.
// ruleid: firegrid-host-sdk-no-runtime-workflow-engine-import
import { someAppendDef as fakeWfEngineRCW1A } from "@firegrid/runtime/workflow-engine"
// ruleid: firegrid-host-sdk-no-runtime-streams-import
import { someAppendDef as fakeStreamsRCS1A } from "@firegrid/runtime/streams"

// Deep-subpath positives (the regex includes a trailing `[/"]` so deeper
// imports also fail — closes the hole the bare-quote pattern would leave).
// ruleid: firegrid-host-sdk-no-runtime-workflow-engine-import
import { someAppendDef as fakeWfEngineRCW1B } from "@firegrid/runtime/workflow-engine/workflows/wait-for"
// ruleid: firegrid-host-sdk-no-runtime-streams-import
import { someAppendDef as fakeStreamsRCS1B } from "@firegrid/runtime/streams/sources"

// Re-export form (semgrep regex matches `from\s+"..."`, which catches both
// import and re-export statements).
// ruleid: firegrid-host-sdk-no-runtime-workflow-engine-import
export { someAppendDef as fakeWfEngineRCW1Reexport } from "@firegrid/runtime/workflow-engine"
// ruleid: firegrid-host-sdk-no-runtime-streams-import
export { someAppendDef as fakeStreamsRCS1Reexport } from "@firegrid/runtime/streams"

// Negatives — target-tree subpaths are the sanctioned host-sdk import shape
// per docs/architecture/2026-05-22-runtime-physical-target-tree.md §"Public
// Package Subpaths" and must NOT trigger either rule. These exercise that
// the regexes anchor at the legacy root names rather than the broader
// `@firegrid/runtime` prefix.
// ok: firegrid-host-sdk-no-runtime-workflow-engine-import, firegrid-host-sdk-no-runtime-streams-import
import { tablesAlpha as fakeTablesNeg } from "@firegrid/runtime/tables/runtime-context-state"
// ok: firegrid-host-sdk-no-runtime-workflow-engine-import, firegrid-host-sdk-no-runtime-streams-import
import { channelsAlpha as fakeChannelsNeg } from "@firegrid/runtime/channels"
// ok: firegrid-host-sdk-no-runtime-workflow-engine-import, firegrid-host-sdk-no-runtime-streams-import
import { transformsAlpha as fakeTransformsNeg } from "@firegrid/runtime/transforms"
// ok: firegrid-host-sdk-no-runtime-workflow-engine-import, firegrid-host-sdk-no-runtime-streams-import
import { producersAlpha as fakeSubscribersNeg } from "@firegrid/runtime/subscribers/runtime-context"

void [
  fakeWfEngineRCW1A,
  fakeStreamsRCS1A,
  fakeWfEngineRCW1B,
  fakeStreamsRCS1B,
  fakeAppendDefRC1,
  fakeTablesNeg,
  fakeChannelsNeg,
  fakeTransformsNeg,
  fakeSubscribersNeg,
]

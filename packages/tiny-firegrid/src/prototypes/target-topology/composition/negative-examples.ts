// composition/negative-examples.ts — the DELIBERATE FALSIFIERS.
//
// Happy-path typecheck alone is insufficient. This file proves the topology
// CATCHES shape violations by asserting (with `@ts-expect-error`) that wrong
// shapes FAIL to typecheck. Each `@ts-expect-error` is itself checked: if the
// line below it ever stops being an error, `tsc` fails on the unused directive.
// So this file passing means "the violation was caught"; it failing means
// either the violation slipped through OR the harness drifted.

import { Activity } from "@effect/workflow"
import { Effect, Layer } from "effect"
import type { ProtoRuntimeError } from "../errors.ts"
import type { RuntimeContext } from "../events/index.ts"
import { RuntimeContextStateStore } from "../tables/runtime-context-state-store.ts"
import { AgentSessionStubLayer } from "../producers/agent-session.ts"
import { HostLive, HostLiveShapeC } from "./host-live.ts"

// ── Falsifier 1: a "Shape C" subscriber that reaches for Activity.make ───────
//
// The author intends Shape C (keyed state, no workflow machinery). Calling
// Activity.make to wrap a step grows `WorkflowEngine | WorkflowInstance` into
// `R`. HostLiveShapeC provides NO workflow substrate, so the requirement leaks.

const impostorShapeC = (context: RuntimeContext) =>
  Effect.gen(function* () {
    const store = yield* RuntimeContextStateStore
    const state = yield* store.load(context)
    // VIOLATION: a Shape C handler must not earn workflow machinery. This single
    // call moves the subscriber from Shape C to Shape D in the type system.
    yield* Activity.make({ name: "proto.oops", execute: Effect.void })
    yield* store.save(context, state)
  })

// CONTROL (must typecheck): the SAME handler MINUS the Activity.make call
// composes cleanly to `never` against the Shape C host. This proves the failure
// below is specifically the workflow machinery, not a broken harness.
const honestShapeC = (context: RuntimeContext) =>
  Effect.gen(function* () {
    const store = yield* RuntimeContextStateStore
    const state = yield* store.load(context)
    yield* store.save(context, state)
  })

export const honestShapeCRunnable: Effect.Effect<void, ProtoRuntimeError, never> =
  Effect.provide(honestShapeC({ contextId: "ctx-1" }), HostLiveShapeC)

// @ts-expect-error — VIOLATION CAUGHT: impostorShapeC's R still contains
// WorkflowEngine|WorkflowInstance (from Activity.make), which HostLiveShapeC does
// not provide, so this is not Effect<..., never>. The shape violation fails tsc.
export const caughtByShapeCHost: Effect.Effect<void, ProtoRuntimeError, never> =
  Effect.provide(impostorShapeC({ contextId: "ctx-1" }), HostLiveShapeC)

// Same impostor through the FULL host (which carries the workflow substrate)
// typechecks — i.e. the only thing wrong was claiming Shape C while needing
// Shape D wiring. It IS a correctly-shaped Shape D subscriber once the engine is
// in scope. This isolates the falsifier to the missing capability, not the body.
export const impostorIsActuallyShapeD: Effect.Effect<void, ProtoRuntimeError, never> =
  Effect.provide(impostorShapeC({ contextId: "ctx-1" }), HostLive)

// ── Falsifier 2: missing capability wiring in the host layer ─────────────────
//
// A host that forgets to provide a capability a subscriber names cannot erase
// `R` to `never`. Here only AgentSession is provided; the state store the Shape
// C handler loads is missing.
const HostMissingStateStore = Layer.mergeAll(AgentSessionStubLayer)

// @ts-expect-error — VIOLATION CAUGHT: RuntimeContextStateStore is not provided,
// so it leaks into R and this is not Effect<..., never>. Missing capability
// wiring is statically visible.
export const caughtMissingWiring: Effect.Effect<void, ProtoRuntimeError, never> =
  Effect.provide(honestShapeC({ contextId: "ctx-1" }), HostMissingStateStore)

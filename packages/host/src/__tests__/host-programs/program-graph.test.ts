import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  HostPrograms,
  SubstrateHostBoot,
  type WithHostOptions,
} from "../../index.js"
import * as HostRoot from "../../index.js"
import {
  createSubstrateStream,
  seedPendingScheduledWork,
  seedPendingTimer,
  startTestServer,
  stopTestServer,
  waitForCompletionState,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// launchable-substrate-host.RUNTIME_COMPOSITION.1
// launchable-substrate-host.RUNTIME_COMPOSITION.3
// launchable-substrate-host.HOST_PROCESS.2
// launchable-substrate-host.SERVER_RUNTIME_API.1
// launchable-substrate-host.SERVER_RUNTIME_API.2
// launchable-substrate-host.SERVER_RUNTIME_API.3
//
// A graph composed from HostPrograms.timerSubscriber() resolves a
// past-due timer through the same single-shot substrate primitive.
// The graph is the only host-program mechanism.
describe("HostProgramGraph — timer subscriber via graph", () => {
  it("a graph-driven timer subscriber resolves a past-due timer through the substrate fold", async () => {
    const streamUrl = await createSubstrateStream("graph-timer")
    const completionId = "c-graph-timer"
    const dueAtMs = Date.now() - 500
    await seedPendingTimer(streamUrl, completionId, dueAtMs)

    const TimerOnly = HostProgramGraph.define({
      name: "timer-only",
      layer: HostPrograms.timerSubscriber(),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
          const r = completion?.result as { dueAtMs: number } | undefined
          expect(r?.dueAtMs).toBe(dueAtMs)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: TimerOnly,
            }),
          ),
        ),
      ),
    )
  })
})

// launchable-substrate-host.RUNTIME_COMPOSITION.3
//
// Graph names are diagnostic labels supplied in process. Empty labels
// are rejected so future read-only diagnostics have useful display
// values, but uniqueness is not enforced because there is no global
// graph registry.
describe("HostProgramGraph — diagnostic name validation", () => {
  it("normalizes non-empty names and rejects empty graph labels", () => {
    const graph = HostProgramGraph.define({
      name: "  prototype  ",
      layer: Layer.empty,
    })
    expect(graph.name).toBe("prototype")

    expect(() =>
      HostProgramGraph.define({
        name: "   ",
        layer: Layer.empty,
      }),
    ).toThrow(/non-empty/)
  })
})

// launchable-substrate-host.HOST_PROCESS.2
//
// HostPrograms.scheduledWorkSubscriber composes the same way and
// resolves a past-due scheduled_work completion via the substrate
// single-shot primitive.
describe("HostProgramGraph — scheduled-work subscriber via graph", () => {
  it("a graph-driven scheduled-work subscriber resolves a past-due completion preserving whenMs and opaque input", async () => {
    const streamUrl = await createSubstrateStream("graph-sw")
    const completionId = "c-graph-sw"
    const whenMs = Date.now() - 500
    const input = { kind: "demo", payload: 42 }
    await seedPendingScheduledWork(streamUrl, completionId, whenMs, input)

    const ScheduledOnly = HostProgramGraph.define({
      name: "scheduled-only",
      layer: HostPrograms.scheduledWorkSubscriber(),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
          const r = completion?.result as
            | { whenMs: number; input: unknown }
            | undefined
          expect(r?.whenMs).toBe(whenMs)
          expect(r?.input).toEqual(input)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: ScheduledOnly,
            }),
          ),
        ),
      ),
    )
  })

  it("composing both helpers in a single graph layer resolves both kinds", async () => {
    const streamUrl = await createSubstrateStream("graph-both")
    const idTimer = "c-both-timer"
    const idSw = "c-both-sw"
    await seedPendingTimer(streamUrl, idTimer, Date.now() - 500)
    await seedPendingScheduledWork(streamUrl, idSw, Date.now() - 500, { v: 1 })

    const Both = HostProgramGraph.define({
      name: "both",
      layer: Layer.mergeAll(
        HostPrograms.timerSubscriber(),
        HostPrograms.scheduledWorkSubscriber(),
      ),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idTimer,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          const s = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                idSw,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(t?.state).toBe("resolved")
          expect(s?.state).toBe("resolved")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({ streamUrl, program: Both }),
          ),
        ),
      ),
    )
  })
})

// launchable-substrate-host.RUNTIME_COMPOSITION.8
//
// Caller-supplied local-map discovery is a typed user-space pattern,
// not a substrate-provided helper. The host does not export a
// "discoverHostProgram(map, key)" helper; callers index into their
// own typed object. This test demonstrates the pattern as code while
// also asserting the host root surface does not provide a registry-
// shaped helper.
describe("HostProgramGraph — caller-supplied local-map discovery (no registry)", () => {
  it("a caller-defined typed map indexed by string key drives host program selection without dynamic import or substrate-side registry", async () => {
    const streamUrl = await createSubstrateStream("graph-discovery")
    const completionId = "c-discovery"
    await seedPendingTimer(streamUrl, completionId, Date.now() - 500)

    // Caller-supplied local map. Substrate is unaware of this map;
    // it is ordinary user-space code.
    const programs = {
      prototype: HostProgramGraph.define({
        name: "prototype",
        layer: HostPrograms.timerSubscriber(),
      }),
      empty: HostProgramGraph.define({
        name: "empty",
        layer: Layer.empty,
      }),
    } as const
    const selectedKey: keyof typeof programs = "prototype"

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: programs[selectedKey],
            }),
          ),
        ),
      ),
    )

    // Negative structural: no registry helper / dynamic-discovery
    // function exists on the host root.
    const banned = ["discoverHostProgram", "loadHostProgram", "registerHostProgram"]
    const surface = Object.keys(HostRoot)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

// launchable-substrate-host.RUNTIME_COMPOSITION.9
//
// Negative structural — host program graph definitions are not
// fetched from durable state. Asserted by inspecting that the
// public option type does not accept a stream-URL / completion-id /
// projection-id reference for the program. WithHostOptions and
// AttachedHostOptions accept a HostProgramGraph value, not a string
// reference.
describe("HostProgramGraph — graph not fetched from durable state", () => {
  it("the program option is a typed HostProgramGraph value, not a stream-stored reference", () => {
    // Type-level: the following is a valid WithHostOptions; the
    // existence of `program: HostProgramGraph` on the type is the
    // contract.
    const opts: WithHostOptions = {
      mode: "attached",
      streamUrl: "http://example.invalid/substrate/none",
      clientId: "noop",
      program: HostProgramGraph.define({
        name: "inline",
        layer: Layer.empty,
      }),
    }
    expect(opts.program?.name).toBe("inline")

    // No surface-level helper accepts a string-keyed durable
    // reference — guarded against names that would suggest such a
    // pattern.
    const banned = [
      "loadGraphFromStream",
      "fetchHostProgram",
      "graphFromDurableState",
    ]
    const surface = Object.keys(HostRoot)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

// launchable-substrate-host.NO_CONTROL_PLANE.1
// launchable-substrate-host.NO_CONTROL_PLANE.2
// launchable-substrate-host.SERVER_RUNTIME_API.2
//
// The new graph + helper exports do not introduce mutation
// endpoints, network listeners, or substrate runtime primitives at
// the host root. Banned-name guard mirrors the Slice 6 posture.
describe("HostProgramGraph — no control plane / no substrate primitives leaked at host root", () => {
  it("the host root surface contains no server / listen / port / http / router / endpoint / diagnostics names", () => {
    const bannedSubstrings = [
      "Server",
      "Listener",
      "Listen",
      "Port",
      "Http",
      "HTTP",
      "Router",
      "Endpoint",
      "Fastify",
      "Express",
      "Diagnostics",
    ]
    const surface = Object.keys(HostRoot)
    const offenders = surface.filter((name) =>
      bannedSubstrings.some((b) => name.includes(b)),
    )
    expect(offenders).toEqual([])
  })

  it("the host root does not re-export substrate runtime primitives (Choreography, Projection, Work, EventPlane, runTimerSubscriber, etc.)", () => {
    const banned = [
      "Choreography",
      "Projection",
      "Work",
      "WorkProducer",
      "WorkClaim",
      "EventPlane",
      "runTimerSubscriber",
      "runScheduledWorkSubscriber",
      "runProjectionMatchSubscriber",
      "processReadyWorkItem",
      "createPendingCompletion",
      "resolveCompletion",
      "rebuildProjection",
      "openSubstrateDb",
      "DurableWaits",
    ]
    const surface = Object.keys(HostRoot)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

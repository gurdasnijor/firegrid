import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import {
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Scope,
} from "effect"

// Self-contained host-compose. This simulation deliberately does NOT import
// packages/tiny-firegrid/src/configurations/ (slated for deletion; sims own
// their host compose). This is the agent-free current durable-streams-backed
// host path: FiregridRuntimeHostLive composes the native @effect/workflow
// engine (Workflow.make + DurableDeferred) over the durable-streams control
// plane, with a deterministic stdio-jsonl child as the sandbox (no LLM).
const composeDurableStreamsHost = (opts: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: string
  readonly localProcessEnv?: TinyFiregridSimulationEnv["localProcessEnv"]
}): Layer.Layer<FiregridHost, unknown> =>
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  FiregridRuntimeHostLive({
    durableStreamsBaseUrl: opts.baseUrl,
    namespace: opts.namespace,
    hostId: opts.hostId,
    hostSessionId: `${opts.hostId}-session`,
    input: true,
    ...(opts.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: opts.localProcessEnv }),
  })

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client + substrate-barrier deterministic polling. */

// Deterministic, agent-FREE local-process runtime: a tiny Node child that
// emits exactly one JSONL assistant line then exits. No real LLM, no real
// provider — the substrate property under test is durable workflow/table +
// runtime-context recovery across a host-generation restart, not agent IO.
const deterministicChildCode = [
  "console.log(JSON.stringify({",
  '  type: "assistant",',
  "  message: {",
  '    content: [{ type: "text", text: "tiny-firegrid-durable-restart" }]',
  "  }",
  "}))",
].join("\n")

const deterministicArgv = [
  globalThis.process.execPath,
  "--input-type=module",
  "-e",
  deterministicChildCode,
] as const

// makeHost and the driver never share an in-process value. They rendezvous
// ONLY through the durable substrate: the contextId is derived
// deterministically from the same external key (env.runId) on both sides.
const externalKeyId = (env: TinyFiregridSimulationEnv): string => env.runId

const contextIdFor = (env: TinyFiregridSimulationEnv): string =>
  sessionContextIdForExternalKey({
    source: "tiny-firegrid",
    id: externalKeyId(env),
  })

interface DurableStreamsRestartResult {
  // Pre-restart: gen-1 host durably bound the context + persisted >=1 run
  // event, observed by the public client snapshot.
  readonly wroteDurableState: boolean
  readonly preRestartContextBound: boolean
  readonly preRestartRunCount: number
  readonly preRestartHostId: string | undefined
  // makeHost deterministically tore down host-generation-1 and brought up a
  // fresh host-generation-2 over the SAME durable baseUrl + namespace.
  readonly runtimeRestarted: boolean
  // Post-restart: a FRESH public-client snapshot still resolves the durable
  // RuntimeContext (workflow/table fact) recovered by host-generation-2.
  readonly recoveredWorkflowState: boolean
  readonly recoveredTableFact: boolean
  readonly postRestartContextBound: boolean
  readonly postRestartRunCount: number
  readonly postRestartHostId: string | undefined
}

const HOST_GEN_1 = "gen1"
const HOST_GEN_2 = "gen2"

// The durable sentinel makeHost publishes ONLY through the substrate so the
// driver can falsifiably observe that the restart happened. It is a
// runtime-input intent row on the same namespace-scoped control plane the
// public client writes to; the driver reads it back through the same table
// surface (no in-process channel, no kernel import).
const RESTART_SENTINEL_INTENT_ID = "tiny-durable-restart:gen2-recovered"

const controlPlaneTableLayer = (env: TinyFiregridSimulationEnv) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
      contentType: "application/json",
    },
  })

// ---------------------------------------------------------------------------
// makeHost: Option (a). ONE layer that internally owns
// host-generation-1 -> deterministic durable barrier -> host-generation-2
// (recover), synchronized with the driver ONLY through the durable
// substrate. The runner forks `Layer.launch(makeHost(env))`; the build phase
// runs gen-1 + barrier + restart, then yields gen-2's FiregridHost context as
// the layer output (kept alive for the rest of the run by `Layer.launch`).
// ---------------------------------------------------------------------------
const makeRestartingHost = (env: TinyFiregridSimulationEnv) => {
  const contextId = contextIdFor(env)

  const orchestration = Effect.gen(function*() {
    const parentScope = yield* Effect.scope

    // --- host-generation-1: distinct hostId, dedicated child scope ---
    const gen1Scope = yield* Scope.make()
    yield* Layer.buildWithScope(
      composeDurableStreamsHost({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        hostId: HOST_GEN_1,
        ...(env.localProcessEnv === undefined
          ? {}
          : { localProcessEnv: env.localProcessEnv }),
      }),
      gen1Scope,
    )

    // --- durable barrier: wait until gen-1 has durably bound the driver's
    // context AND persisted >=1 run event. Read through the SAME durable
    // substrate the public client uses (namespace-scoped control plane). ---
    const barrierDeadline = (yield* Clock.currentTimeMillis) + 90_000
    const observeGen1Persisted = Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const ctx = yield* control.contexts.get(contextId)
      const runs = yield* control.runs.query(coll =>
        coll.toArray.filter(row => row.contextId === contextId))
      return {
        bound: Option.isSome(ctx),
        runCount: runs.length,
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(controlPlaneTableLayer(env)),
    )

    while (true) {
      if ((yield* Clock.currentTimeMillis) >= barrierDeadline) break
      const observed = yield* observeGen1Persisted.pipe(
        Effect.catchAll(() => Effect.succeed({ bound: false, runCount: 0 })),
      )
      if (observed.bound && observed.runCount >= 1) break
      yield* Clock.sleep("500 millis")
    }

    // --- RESTART: tear down host-generation-1 entirely. ---
    yield* Scope.close(gen1Scope, Exit.void)

    // Publish the restart sentinel ONLY through the durable substrate so the
    // driver can falsifiably observe the generation boundary via the public
    // client surface (it polls control-plane input intents for this id).
    yield* Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      yield* control.inputIntents.insertOrGet({
        intentId: RESTART_SENTINEL_INTENT_ID,
        contextId,
        kind: "message",
        authoredBy: "system",
        payload: { type: "text", text: "host-generation-2 recovered" },
        createdAt: new Date(0).toISOString(),
      }).pipe(Effect.catchAll(() => Effect.void))
    }).pipe(
      Effect.scoped,
      Effect.provide(controlPlaneTableLayer(env)),
      Effect.catchAll(() => Effect.void),
    )

    // --- RECOVER: build host-generation-2 (fresh, distinct hostId) over the
    // SAME durable baseUrl + namespace into the long-lived parent scope. It
    // reconciles the durable control plane left by gen-1. Its FiregridHost
    // context is the layer output, kept alive by `Layer.launch`. ---
    const gen2Context = yield* Layer.buildWithScope(
      Layer.fresh(composeDurableStreamsHost({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        hostId: HOST_GEN_2,
        ...(env.localProcessEnv === undefined
          ? {}
          : { localProcessEnv: env.localProcessEnv }),
      })),
      parentScope,
    )

    return gen2Context
  })

  return Layer.scopedContext(orchestration)
}

// ---------------------------------------------------------------------------
// driver: PUBLIC Firegrid client only. Writes durable launch/runtime-input
// intent, observes gen-1 durable binding via snapshot, then observes the
// durable RuntimeContext + run journal RECOVERED after the makeHost-internal
// restart. The restart itself is confirmed falsifiably by reading the
// substrate-published restart sentinel through the control-plane table.
// ---------------------------------------------------------------------------
const durableStreamsRestartDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<DurableStreamsRestartResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const contextId = contextIdFor(env)

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: externalKeyId(env),
      },
      runtime: local.jsonl({
        argv: [...deterministicArgv],
        agent: "tiny-firegrid-deterministic",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    // Durable runtime-input intent + start request (public surface).
    yield* session.prompt({
      payload: "tiny-firegrid durable-streams restart probe",
      idempotencyKey: `${env.runId}:turn-1`,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(30),
        ),
      ),
    )
    yield* session.start()

    // --- pre-restart: poll the public snapshot until gen-1 durably bound the
    // context AND a run event landed. ---
    const preDeadline = (yield* Clock.currentTimeMillis) + 90_000
    let preRestartContextBound = false
    let preRestartRunCount = 0
    let preRestartHostId: string | undefined
    while (!(preRestartContextBound && preRestartRunCount >= 1)) {
      if ((yield* Clock.currentTimeMillis) >= preDeadline) break
      const snap = yield* session.snapshot().pipe(
        Effect.catchAll(() =>
          Effect.succeed(undefined)),
      )
      if (snap !== undefined) {
        preRestartContextBound = snap.context !== undefined
        preRestartRunCount = snap.runs.length
        preRestartHostId = snap.context?.host.hostId
      }
      if (preRestartContextBound && preRestartRunCount >= 1) break
      yield* Clock.sleep("500 millis")
    }
    const wroteDurableState = preRestartContextBound && preRestartRunCount >= 1

    // --- observe the restart falsifiably: the substrate-published sentinel
    // intent only exists once makeHost has closed gen-1 and is recovering on
    // gen-2. Read it back through the same control-plane table the public
    // client writes to (no in-process channel). ---
    const restartDeadline = (yield* Clock.currentTimeMillis) + 90_000
    let runtimeRestarted = false
    while (!runtimeRestarted) {
      if ((yield* Clock.currentTimeMillis) >= restartDeadline) break
      const sentinel = yield* Effect.gen(function*() {
        const control = yield* RuntimeControlPlaneTable
        return yield* control.inputIntents.get(RESTART_SENTINEL_INTENT_ID)
      }).pipe(
        Effect.scoped,
        Effect.provide(controlPlaneTableLayer(env)),
        Effect.catchAll(() => Effect.succeed(Option.none())),
      )
      if (Option.isSome(sentinel)) {
        runtimeRestarted = true
        break
      }
      yield* Clock.sleep("500 millis")
    }

    // --- post-restart: a FRESH public snapshot must still resolve the durable
    // RuntimeContext + run journal recovered by host-generation-2. ---
    const postDeadline = (yield* Clock.currentTimeMillis) + 60_000
    let postRestartContextBound = false
    let postRestartRunCount = 0
    let postRestartHostId: string | undefined
    while (!postRestartContextBound) {
      if ((yield* Clock.currentTimeMillis) >= postDeadline) break
      const snap = yield* firegrid.open(contextId).snapshot.pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )
      if (snap !== undefined) {
        postRestartContextBound = snap.context !== undefined
        postRestartRunCount = snap.runs.length
        postRestartHostId = snap.context?.host.hostId
      }
      if (postRestartContextBound) break
      yield* Clock.sleep("500 millis")
    }

    const recoveredTableFact = runtimeRestarted && postRestartContextBound
    const recoveredWorkflowState =
      recoveredTableFact && postRestartRunCount >= preRestartRunCount &&
      postRestartRunCount >= 1

    return {
      wroteDurableState,
      preRestartContextBound,
      preRestartRunCount,
      preRestartHostId,
      runtimeRestarted,
      recoveredWorkflowState,
      recoveredTableFact,
      postRestartContextBound,
      postRestartRunCount,
      postRestartHostId,
    }
  })

export const durableStreamsBackedPipelineSimulation = {
  id: "durable-streams-backed-pipeline",
  description:
    "Deterministic substrate-property simulation: writes durable workflow/table + runtime-context state via the public Firegrid client, restarts the runtime (a fresh host generation reconciling the same durable-streams baseUrl + namespace), and asserts the state is recovered through the public client snapshot.",
  makeHost: env => makeRestartingHost(env),
  driver: durableStreamsRestartDriver,
  summarize: result => ({
    wroteDurableState: result.wroteDurableState,
    runtimeRestarted: result.runtimeRestarted,
    recoveredWorkflowState: result.recoveredWorkflowState,
    recoveredTableFact: result.recoveredTableFact,
    preRestartContextBound: result.preRestartContextBound,
    preRestartRunCount: result.preRestartRunCount,
    preRestartHostId: result.preRestartHostId,
    postRestartContextBound: result.postRestartContextBound,
    postRestartRunCount: result.postRestartRunCount,
    postRestartHostId: result.postRestartHostId,
  }),
  localize: result =>
    result.wroteDurableState && !result.recoveredTableFact
      ? [
        "Gen-1 durably bound the RuntimeContext, but a fresh post-restart snapshot did not recover it.",
        "Inspect the durable control-plane stream and the host-generation-2 reconcile path for the namespace.",
      ]
      : [
        "Inspect the DuckDB span tables for the control-plane reconcile, workflow recover, and snapshot read paths across both host generations.",
      ],
} satisfies TinyFiregridSimulation<DurableStreamsRestartResult>

/* eslint-enable local/no-fixed-polling */

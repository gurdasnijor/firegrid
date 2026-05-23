// Low-level wire-edge representative.
//
// Per SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md §"Edge Packages" each
// edge adapter owns only wire translation; it must not invent session,
// prompt, permission, output, or tool semantics independently.
//
// This file is the raw "drive the Sessions turn by string target"
// helper used in the negative-shape probe assertions. The public-shape
// proof lives in `client.ts` — that is the blackbox the test exercises
// for both turn shapes (Launch + Sessions). Both files share the
// absence of route-Live / handler / state imports (asserted in
// `probe.test.ts`).
//
// inputIds are caller-supplied (deterministic) — no Math.random in the
// proof.

import { Chunk, Effect, Stream } from "effect"
import type { ChannelRouter } from "./router.ts"
import type { RuntimeRouteSet } from "./runtime-routes.ts"

export interface EdgeTurnResult {
  readonly sessionId: string
  readonly contextId: string
  readonly promptReceipt: { readonly intentId: string; readonly contextId: string; readonly acceptedAt: string }
  readonly observations: ReadonlyArray<unknown>
  readonly terminalExitCode: number
}

export interface EdgeTurnInput {
  readonly externalKey: { readonly source: string; readonly id: string }
  /** Caller-supplied deterministic input identity. */
  readonly inputId: string
  readonly prompt: string
}

export const runEdgeTurn = (
  router: ChannelRouter<{
    readonly "host.sessions.create_or_load": RuntimeRouteSet["hostSessionsCreateOrLoad"]
    readonly "host.sessions.start": RuntimeRouteSet["hostSessionsStart"]
    readonly "session.prompt": RuntimeRouteSet["sessionPrompt"]
    readonly "session.agent_output": RuntimeRouteSet["sessionAgentOutput"]
  }>,
  input: EdgeTurnInput,
): Effect.Effect<EdgeTurnResult, unknown> =>
  Effect.gen(function*() {
    const handle = (yield* router.dispatch.call(
      "host.sessions.create_or_load",
      { externalKey: input.externalKey },
    )) as { sessionId: string; contextId: string }

    yield* router.dispatch.call("host.sessions.start", {
      sessionId: handle.sessionId,
    })

    const promptReceipt = (yield* router.dispatch.send("session.prompt", {
      sessionId: handle.sessionId,
      inputId: input.inputId,
      payload: input.prompt,
    })) as { intentId: string; contextId: string; acceptedAt: string }

    const observations = yield* router.dispatch
      .waitFor("session.agent_output", {
        contextId: handle.contextId,
        afterSequence: -1,
      })
      .pipe(
        Stream.takeUntil((observation) =>
          (observation as { _tag: string })._tag === "Terminated"),
        Stream.runCollect,
        Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
      )

    const terminal = observations.at(-1) as
      | { _tag: "Terminated"; exitCode: number }
      | undefined
    if (terminal === undefined || terminal._tag !== "Terminated") {
      return yield* Effect.fail(
        new Error("edge: stream ended without Terminated observation"),
      )
    }

    return {
      sessionId: handle.sessionId,
      contextId: handle.contextId,
      promptReceipt,
      observations,
      terminalExitCode: terminal.exitCode,
    }
  })

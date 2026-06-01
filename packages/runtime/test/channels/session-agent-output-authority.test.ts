// tf-r06u.8 — parent→child agent-output authority (the R7 "unwired, not just
// uncovered" finding).
//
// RE-HOME NOTE (#746/#748): the deleted regressions
// `wait-for-session-agent-output.test.ts` (#746) and
// `agent-tool-host-live.test.ts` (#748) targeted the Shape-D tool-dispatch
// stack that #765 REMOVED wholesale — `subscribers/tool-dispatch/{tool-host,
// tool-use-to-effect,runtime-agent-tool-execution}.ts`, `AgentToolHost`, and
// `composition/host-live.ts` no longer exist. Their literal symbols cannot be
// restored. Their CAPABILITY re-homes onto the unified surface, split across
// the .8/.9 pair:
//   - #746 (an agent's `wait_for session.agent_output` routes a child's output,
//     keyed + authorized) → re-homed HERE, over the production
//     `sessionAgentOutputObservationRoute` + the new FK authority.
//   - #748 (`session_new` child-start preserves the parent agent runtime when
//     agentKind matches) → re-homes WITH the spawn/spawn_all writer in
//     tf-r06u.9 (child-start is the spawn path; .8 has no spawn).
import { Response } from "@effect/ai"
import {
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
import {
  CurrentRuntimeContext,
  local,
  makeHostStreamPrefix,
  makeRuntimeContext,
  normalizeRuntimeIntent,
  type HostId,
  type RuntimeContext,
  RuntimeContextSchema,
  RuntimeControlPlaneTable,
} from "@firegrid/protocol/launch"
import { FiregridRuntimeObservationSourceNames } from "@firegrid/protocol/observations"
import {
  RuntimeAgentOutputObservationSchema,
  type RuntimeAgentOutputObservation,
} from "@firegrid/protocol/session-facade"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  AuthorizedSessionAgentOutputRouterLive,
  makeAuthorizedSessionAgentOutputChannel,
  makeRuntimeChannelRouter,
  RuntimeChannelRouter,
  sessionAgentOutputObservationRoute,
  UnauthorizedChildObservation,
} from "../../src/channels/index.ts"

const PARENT = "ctx_parent"
const CHILD = "ctx_child"

const observation = (
  contextId: string,
  sequence: number,
): RuntimeAgentOutputObservation => ({
  source: FiregridRuntimeObservationSourceNames.agentOutputEvents,
  sessionId: contextId as RuntimeAgentOutputObservation["sessionId"],
  contextId: contextId as RuntimeAgentOutputObservation["contextId"],
  activityAttempt: 1,
  sequence,
  _tag: "TextChunk",
  event: {
    _tag: "TextChunk",
    part: Response.textDeltaPart({ id: `p-${sequence}`, delta: `chunk-${sequence}` }),
  },
})

// A schema-valid context row, optionally naming a parent (the FK under test).
const contextRow = (
  contextId: string,
  parentContextId?: string,
): RuntimeContext => {
  const hostId = "host_authority_test" as HostId
  return makeRuntimeContext({
    contextId,
    createdAtMs: 0,
    ...(parentContextId === undefined ? {} : { parentContextId }),
    runtime: normalizeRuntimeIntent(local.jsonl({ argv: ["node", "agent.js"] })),
    host: {
      hostId,
      streamPrefix: makeHostStreamPrefix({ namespace: "authority-test", hostId }),
      boundAtMs: 0,
    },
  })
}

// Stub the control-plane contexts index: `contexts.get` returns seeded rows.
// The authority check reads only `contexts.get(childId)`, so this is the
// minimal seam to "seed links directly".
const stubControl = (
  rows: Record<string, RuntimeContext>,
): RuntimeControlPlaneTable["Type"] =>
  ({
    contexts: {
      get: (id: string) => Effect.succeed(Option.fromNullable(rows[id])),
    },
  }) as unknown as RuntimeControlPlaneTable["Type"]

// Stub the base (pre-authority) SessionAgentOutputChannel: per-context streams.
const stubUnderlying = (
  rowsByContext: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
): SessionAgentOutputChannelService => ({
  forContext: contextId =>
    makeIngressChannel({
      target: SessionAgentOutputChannelTarget,
      schema: RuntimeAgentOutputObservationSchema,
      sourceClass: "static-source",
      stream: Stream.fromIterable(rowsByContext[contextId] ?? []),
    }),
})

describe("parentContextId FK on the context row (tf-r06u.8)", () => {
  it("round-trips through makeRuntimeContext + the schema when present", async () => {
    const row = contextRow(CHILD, PARENT)
    expect(row.parentContextId).toBe(PARENT)
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(RuntimeContextSchema)(row),
    )
    expect(decoded.parentContextId).toBe(PARENT)
  })

  it("is absent for a top-level context (no parent)", () => {
    expect(contextRow(CHILD).parentContextId).toBeUndefined()
  })
})

describe("makeAuthorizedSessionAgentOutputChannel (tf-r06u.8 — FK authority)", () => {
  const authorizedFor = (
    rows: Record<string, RuntimeContext>,
    outputs: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
    observingContextId = PARENT,
  ) =>
    makeAuthorizedSessionAgentOutputChannel({
      underlying: stubUnderlying(outputs),
      control: stubControl(rows),
      observingContextId,
    })

  const head = (channel: SessionAgentOutputChannelService, childId: string) =>
    Stream.runHead(channel.forContext(childId).binding.stream)

  it("yields the child's output when the observer parents the child", async () => {
    const authorized = authorizedFor(
      { [CHILD]: contextRow(CHILD, PARENT) },
      { [CHILD]: [observation(CHILD, 0)] },
    )
    const result = await Effect.runPromise(head(authorized, CHILD))
    expect(Option.getOrThrow(result).contextId).toBe(CHILD)
  })

  it("denies (not-parent) when the child is parented by another context", async () => {
    const authorized = authorizedFor(
      { [CHILD]: contextRow(CHILD, "ctx_other") },
      { [CHILD]: [observation(CHILD, 0)] },
    )
    const error = await Effect.runPromise(Effect.flip(head(authorized, CHILD)))
    expect(error).toBeInstanceOf(UnauthorizedChildObservation)
    expect((error as UnauthorizedChildObservation).reason).toBe("not-parent")
  })

  it("denies (not-parent) when the child is top-level (no parentContextId)", async () => {
    const authorized = authorizedFor(
      { [CHILD]: contextRow(CHILD) },
      { [CHILD]: [observation(CHILD, 0)] },
    )
    const error = await Effect.runPromise(Effect.flip(head(authorized, CHILD)))
    expect((error as UnauthorizedChildObservation).reason).toBe("not-parent")
  })

  it("denies (unknown-context) when no context row exists for the child", async () => {
    const authorized = authorizedFor({}, { [CHILD]: [observation(CHILD, 0)] })
    const error = await Effect.runPromise(Effect.flip(head(authorized, CHILD)))
    expect((error as UnauthorizedChildObservation).reason).toBe("unknown-context")
  })

  it("does not leak a sibling's output the observer does not parent", async () => {
    // Observer parents CHILD but NOT ctx_sibling.
    const authorized = authorizedFor(
      {
        [CHILD]: contextRow(CHILD, PARENT),
        ctx_sibling: contextRow("ctx_sibling", "ctx_other"),
      },
      {
        [CHILD]: [observation(CHILD, 0)],
        ctx_sibling: [observation("ctx_sibling", 0)],
      },
    )
    const error = await Effect.runPromise(Effect.flip(head(authorized, "ctx_sibling")))
    expect((error as UnauthorizedChildObservation).reason).toBe("not-parent")
  })
})

describe("authorized session.agent_output route dispatch (tf-r06u.8)", () => {
  const dispatchWaitFor = (
    channel: SessionAgentOutputChannelService,
    sessionId: string,
  ) =>
    makeRuntimeChannelRouter([sessionAgentOutputObservationRoute(channel)]).dispatch({
      target: String(SessionAgentOutputChannelTarget),
      verb: "wait_for",
      payload: { sessionId, afterSequence: -1 },
    })

  it("returns the child observation through the wait_for route when authorized", async () => {
    const authorized = makeAuthorizedSessionAgentOutputChannel({
      underlying: stubUnderlying({ [CHILD]: [observation(CHILD, 0)] }),
      control: stubControl({ [CHILD]: contextRow(CHILD, PARENT) }),
      observingContextId: PARENT,
    })
    const result = (await Effect.runPromise(
      dispatchWaitFor(authorized, CHILD),
    )) as RuntimeAgentOutputObservation
    expect(result.contextId).toBe(CHILD)
    expect(result.sequence).toBe(0)
  })

  it("fails the dispatch (wrapping UnauthorizedChildObservation) when not the parent", async () => {
    const authorized = makeAuthorizedSessionAgentOutputChannel({
      underlying: stubUnderlying({ [CHILD]: [observation(CHILD, 0)] }),
      control: stubControl({ [CHILD]: contextRow(CHILD, "ctx_other") }),
      observingContextId: PARENT,
    })
    const error = await Effect.runPromise(Effect.flip(dispatchWaitFor(authorized, CHILD)))
    // The route stream fails typed; the router surfaces it as an invocation
    // failure carrying the UnauthorizedChildObservation cause.
    expect(JSON.stringify(error)).toContain("UnauthorizedChildObservation")
  })
})

describe("AuthorizedSessionAgentOutputRouterLive (tf-r06u.8 — observer = CurrentRuntimeContext)", () => {
  const runDispatch = (
    observerRow: RuntimeContext,
    rows: Record<string, RuntimeContext>,
    outputs: Record<string, ReadonlyArray<RuntimeAgentOutputObservation>>,
    sessionId: string,
  ) =>
    Effect.gen(function*() {
      const router = yield* RuntimeChannelRouter
      return yield* router.dispatch({
        target: String(SessionAgentOutputChannelTarget),
        verb: "wait_for",
        payload: { sessionId, afterSequence: -1 },
      })
    }).pipe(
      Effect.provide(
        AuthorizedSessionAgentOutputRouterLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(SessionAgentOutputChannel, stubUnderlying(outputs)),
              Layer.succeed(RuntimeControlPlaneTable, stubControl(rows)),
              Layer.succeed(CurrentRuntimeContext, observerRow),
            ),
          ),
        ),
      ),
    )

  it("authorizes against the ambient CurrentRuntimeContext as the observing parent", async () => {
    const result = (await Effect.runPromise(
      runDispatch(
        contextRow(PARENT),
        { [CHILD]: contextRow(CHILD, PARENT) },
        { [CHILD]: [observation(CHILD, 0)] },
        CHILD,
      ),
    )) as RuntimeAgentOutputObservation
    expect(result.contextId).toBe(CHILD)
  })

  it("denies when the ambient context does not parent the requested child", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runDispatch(
          contextRow(PARENT),
          { [CHILD]: contextRow(CHILD, "ctx_other") },
          { [CHILD]: [observation(CHILD, 0)] },
          CHILD,
        ),
      ),
    )
    expect(JSON.stringify(error)).toContain("UnauthorizedChildObservation")
  })
})

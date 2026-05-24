import type {
  RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  makeRawRuntimeContextByteSession,
  prepareRawRuntimeContextInput,
  type RuntimeRawByteSession,
} from "../producers/codecs/session-byte-stream-adapter.ts"
import {
  Effect,
  Scope,
} from "effect"
import {
  type RuntimeContextWorkflowSessionService,
} from "../subscribers/runtime-context-session/handler.ts"
import {
  makeRuntimeContextSessionAdapterService,
  makeRuntimeContextSessionCommandSender,
  makeRuntimeContextWorkflowSessionService,
  openRuntimeContextByteStream,
  runtimeContextSessionOwnerSessionId,
  scopedRuntimeContextWorkflowSessionLayer,
  type RuntimeContextSessionAdapterRequirements,
} from "./runtime-context-session-adapter-common.ts"

const ownerSessionIdFor = (
  context: RuntimeContext,
  activityAttempt: number,
) => runtimeContextSessionOwnerSessionId("raw", context, activityAttempt)

export const makeRawRuntimeContextWorkflowSessionService:
  Effect.Effect<
    RuntimeContextWorkflowSessionService,
    never,
    RuntimeContextSessionAdapterRequirements
  > =
  makeRuntimeContextSessionAdapterService<RuntimeRawByteSession>(({
    writer,
    stdinClaim,
    captured,
    scope,
    sessions,
  }) => {
    const startSession = (
      context: RuntimeContext,
      activityAttempt: number,
      _key: string,
    ) =>
      Effect.gen(function* () {
        const bytes = yield* Scope.extend(
          openRuntimeContextByteStream(context).pipe(Effect.provide(captured)),
          scope,
        )
        const started = yield* makeRawRuntimeContextByteSession({
          context,
          activityAttempt,
          ownerSessionId: ownerSessionIdFor(context, activityAttempt),
          bytes,
          writer,
        })
        return {
          session: started.session,
          run: started.run.pipe(
            Effect.catchAll(cause =>
              Effect.logError("[host-sdk] raw runtime session failed").pipe(
                Effect.annotateLogs({ contextId: context.contextId, cause }),
              )),
          ),
        }
      })

    const sendCommand = makeRuntimeContextSessionCommandSender<RuntimeRawByteSession>({
      ownerKind: "raw",
      stdinClaim,
      prepare: (context, session, command) =>
        prepareRawRuntimeContextInput(context, session, command.event),
    })

    return makeRuntimeContextWorkflowSessionService({
      ownerKind: "raw",
      sessions,
      scope,
      startSession,
      sendCommand,
    })
  })

export const RawRuntimeContextWorkflowSessionLive = scopedRuntimeContextWorkflowSessionLayer(
  makeRawRuntimeContextWorkflowSessionService,
)

// Shape C: Stateful keyed subscriber, NO workflow machinery.
//
//   R = RuntimeContextStateStore   (owns durable state for the contextId key)
//     | AgentSession               (live dispatch)
//     | RuntimeToolUseExecutor      (live dispatch)
//     | HostPromptChannel           (egress / write-side dispatch)
//     | RuntimeAgentOutputWrite     (write-side authority)
//
// CRUCIALLY: `WorkflowEngine` does NOT appear in `R`. This is the C2 target for
// `RuntimeContextWorkflowNative`: a per-event handler keyed by `contextId`, not
// a context-lifetime parked body. The handler materializes for one event, LOADS
// state, runs a PURE transition, SAVES, dispatches actions through capability
// tags, and returns. It does not wait for the next unrelated event and does not
// reconstruct progress by scanning history.

import { Effect } from "effect"
import type { RuntimeContext, RuntimeContextTargetEvent } from "../../events/index.ts"
import { RuntimeContextStateStore } from "../../tables/runtime-context-state-store.ts"
import { RuntimeAgentOutputWrite } from "../../tables/runtime-output-table.ts"
import { AgentSession } from "../../producers/agent-session.ts"
import { RuntimeToolUseExecutor } from "../../producers/tool-use-executor.ts"
import { HostPromptChannel } from "../../channels/index.ts"
import { transitionRuntimeContextEvent } from "../../transforms/transitions.ts"
import { ProtoRuntimeError } from "../../errors.ts"

export const handleRuntimeContextEvent = (
  context: RuntimeContext,
  event: RuntimeContextTargetEvent,
): Effect.Effect<
  void,
  ProtoRuntimeError,
  | RuntimeContextStateStore
  | AgentSession
  | RuntimeToolUseExecutor
  | HostPromptChannel
  | RuntimeAgentOutputWrite
> =>
  Effect.gen(function* () {
    const store = yield* RuntimeContextStateStore
    const session = yield* AgentSession
    const executor = yield* RuntimeToolUseExecutor
    const prompt = yield* HostPromptChannel
    const outputWrite = yield* RuntimeAgentOutputWrite

    // LOAD durable state for this key.
    const state = yield* store.load(context)

    // PURE transition over the single event.
    const result = transitionRuntimeContextEvent(state, event)

    // SAVE next state.
    yield* store.save(context, result.state)

    // Dispatch actions through capability tags (never past the channel router).
    yield* Effect.forEach(result.actions, (action) => {
      switch (action._tag) {
        case "AppendOutput":
          return outputWrite.append(context.contextId, action.observation)
        case "SendToAgent":
          return Effect.zipRight(
            session.send({ contextId: context.contextId, text: action.text }),
            // The protocol egress binding fails with `unknown`; the handler
            // owns it as an expected channel-dispatch error.
            prompt.binding
              .append({ contextId: context.contextId, text: action.text })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProtoRuntimeError({ reason: `prompt dispatch: ${String(cause)}` }),
                ),
              ),
          )
        case "ExecuteTool":
          return executor.execute({
            contextId: context.contextId,
            toolUseId: action.toolUseId,
            toolName: "",
            input: undefined,
          })
      }
    })
  })

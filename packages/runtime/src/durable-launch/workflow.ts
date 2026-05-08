import { Activity, Workflow } from "@effect/workflow"
import { RuntimeLaunchRequestSchema } from "@firegrid/protocol/launch"
import { Effect, Option, Schema, Stream } from "effect"
import { commandForLaunch } from "./command.ts"
import { SandboxProvider, type ProcessOutputChunk } from "./execution/sandbox.ts"
import {
  asLaunchError,
  mapLaunchError,
  RuntimeLaunchError,
} from "./errors.ts"
import {
  appendProcessEvent,
  journalOutputChunk,
} from "./journal.ts"
import {
  LaunchTerminalStateSchema,
  ProcessAttemptResultSchema,
} from "./schema.ts"
import { RuntimeLaunchDb } from "./store.ts"

export const LaunchAgentWorkflow = Workflow.make({
  name: "firegrid.launch-agent",
  payload: Schema.Struct({
    launchId: Schema.String,
  }),
  success: LaunchTerminalStateSchema,
  error: RuntimeLaunchError,
  // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.8
  idempotencyKey: ({ launchId }) => launchId,
})

export const LaunchAgentWorkflowLayer = LaunchAgentWorkflow.toLayer(
  Effect.fn(function* runLaunchAgent({ launchId }) {
    const db = yield* RuntimeLaunchDb

    const launch = yield* Activity.make({
      name: "firegrid.launch-agent.read-launch-request",
      success: RuntimeLaunchRequestSchema,
      error: RuntimeLaunchError,
      // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.1
      execute: db.getLaunchRequest(launchId).pipe(
        Option.match({
          onNone: () =>
            Effect.fail(asLaunchError("readLaunch", `launch request not found: ${launchId}`, launchId)),
          onSome: Effect.succeed,
        }),
      ),
    })

    const processAttempt = yield* Activity.make({
      name: "firegrid.launch-agent.run-process-attempt",
      success: ProcessAttemptResultSchema,
      error: RuntimeLaunchError,
      execute: Effect.gen(function* () {
        const activityAttempt = yield* Activity.CurrentAttempt
        const provider = yield* SandboxProvider
        const command = yield* commandForLaunch(launch)
        const sandbox = yield* Effect.acquireRelease(
          provider.getOrCreate({
            labels: {
              firegridLaunchId: launch.launchId,
            },
            workingDir: launch.runtime.config.cwd,
            providerConfig: {
              launchId: launch.launchId,
            },
          }),
          sandbox => provider.destroy(sandbox).pipe(Effect.ignore),
        ).pipe(
          mapLaunchError("sandbox.getOrCreate", "failed to get or create sandbox", launch.launchId),
        )

        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.2
        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3
        // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.4
        yield* appendProcessEvent(db, {
          launchId: launch.launchId,
          activityAttempt,
          provider: launch.runtime.provider,
          status: "started",
        })

        const appendFailed = (
          message: string,
        ) =>
          appendProcessEvent(db, {
            launchId: launch.launchId,
            activityAttempt,
            provider: launch.runtime.provider,
            status: "failed",
            message,
          })

        const streamProcess = provider.stream(sandbox, command).pipe(
          Stream.mapAccum(0, (sequence, chunk) => [
            sequence + 1,
            { sequence, chunk },
          ] as const),
          Stream.tap(({ chunk, sequence }) => {
            if (chunk.type === "exit") return Effect.void
            // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7
            return journalOutputChunk(db, launch, activityAttempt, sequence, chunk)
          }),
          Stream.filter((item): item is {
            readonly sequence: number
            readonly chunk: Extract<ProcessOutputChunk, { readonly type: "exit" }>
          } =>
            item.chunk.type === "exit",
          ),
          Stream.runHead,
          Effect.mapError(cause =>
            asLaunchError("sandbox.stream", "failed while streaming process output", launch.launchId, cause),
          ),
          Effect.flatMap(Option.match({
            onNone: () =>
              Effect.fail(asLaunchError(
                "sandbox.stream",
                "process stream ended without an exit chunk",
                launch.launchId,
              )),
            onSome: ({ chunk: exit }) =>
              appendProcessEvent(db, {
                launchId: launch.launchId,
                activityAttempt,
                provider: launch.runtime.provider,
                status: "exited",
                exitCode: exit.exitCode,
                ...(exit.signal === undefined ? {} : { signal: exit.signal }),
              }).pipe(Effect.as({
                activityAttempt,
                exitCode: exit.exitCode,
                ...(exit.signal === undefined ? {} : { signal: exit.signal }),
              })),
          })),
          Effect.catchAll(error =>
            appendFailed(error.message).pipe(Effect.zipRight(Effect.fail(error))),
          ),
        )

        return yield* streamProcess
      }),
    })

    return {
      launchId,
      status: processAttempt.exitCode === 0 ? "completed" as const : "failed" as const,
      activityAttempt: processAttempt.activityAttempt,
      exitCode: processAttempt.exitCode,
    }
  }),
)

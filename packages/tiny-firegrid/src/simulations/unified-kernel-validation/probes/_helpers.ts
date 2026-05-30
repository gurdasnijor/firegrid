/**
 * Shared probe helpers. Live alongside the probes (not under a generic
 * `util.ts`) so the probe code stays self-contained inside the
 * simulation folder.
 */

import type { WorkflowEngineTableService } from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import { Duration, Effect, Option, Stream } from "effect"

/**
 * Bounded passive wait for an execution's finalResult to land. Returns
 * `true` if it landed within the timeout, `false` otherwise. Used by
 * probes to verify the kernel-signal recovery path completed without
 * a driver re-drive.
 */
export const awaitFinalLanded = (
  engineTable: WorkflowEngineTableService,
  executionId: string,
  timeout: Duration.Duration = Duration.seconds(3),
): Effect.Effect<boolean, unknown> =>
  engineTable.executions.get(executionId).pipe(
    Effect.flatMap((opt) =>
      Option.match(opt, {
        onSome: (exec) =>
          exec.finalResult !== undefined
            ? Effect.succeed(true)
            : engineTable.executions.rows().pipe(
              Stream.filter((row) =>
                row.executionId === executionId &&
                row.finalResult !== undefined),
              Stream.runHead,
              Effect.timeoutOption(timeout),
              Effect.map((o) => Option.flatten(o)),
              Effect.map(Option.isSome),
            ),
        onNone: () => Effect.succeed(false),
      }),
    ),
  )

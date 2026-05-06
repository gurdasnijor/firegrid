import type { ProjectionSnapshot } from "./projection.ts"
import {
  type ReadyWorkItem,
  type ReadyWorkProjection,
} from "../schema/ready-work.ts"

// ready-work-projection.READY_WORK_PROJECTION.2, .3, .4, .5, .6, .9
// ready-work-projection.SOURCE_PROJECTIONS.3
// Pure derivation: a run is ready-derived iff state=blocked AND has a
// blockedOnCompletionId AND the referenced completion is resolved.
// Rejected/cancelled completions and terminal runs do not derive ready work.
export function deriveReadyWork(
  snapshot: ProjectionSnapshot,
): ReadyWorkProjection {
  const readyWork = new Map<string, ReadyWorkItem>()
  for (const run of snapshot.runs.values()) {
    if (run.state !== "blocked") continue
    if (run.blockedOnCompletionId === undefined) continue
    const completion = snapshot.completions.get(run.blockedOnCompletionId)
    if (completion === undefined) continue
    if (completion.state !== "resolved") continue
    readyWork.set(run.runId, {
      runId: run.runId,
      completionId: completion.completionId,
      result: completion.result,
    })
  }
  return { foldVersion: snapshot.foldVersion, readyWork }
}

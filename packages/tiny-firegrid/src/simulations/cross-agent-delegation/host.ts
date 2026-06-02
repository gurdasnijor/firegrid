import { defaultProductionAdapterLayer, FiregridRuntime } from "@firegrid/runtime/unified"
import type { TinyFiregridHostEnv } from "../../types.ts"

// Real production host: the unified FiregridRuntime composed with the real
// production adapter (spawns real subprocesses via the local-process source).
// No sim-only backdoor — the only fixture is the spawn-target program the driver
// names in its runtime intent (a deterministic stdio-jsonl agent; no API key).
export const host = (
  env: TinyFiregridHostEnv,
): ReturnType<typeof FiregridRuntime> =>
  FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  )

import { FiregridHost } from "@firegrid/runtime/unified"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const host = (
  env: TinyFiregridHostEnv,
): ReturnType<typeof FiregridHost> =>
  FiregridHost({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    codec: "acp",
  })

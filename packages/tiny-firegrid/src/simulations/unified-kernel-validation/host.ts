import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"
import {
  FiregridHost as RuntimeFiregridHost,
} from "@firegrid/runtime/unified"
import type { Layer } from "effect"

export const unifiedKernelValidationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  RuntimeFiregridHost({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    codec: "acp",
  })

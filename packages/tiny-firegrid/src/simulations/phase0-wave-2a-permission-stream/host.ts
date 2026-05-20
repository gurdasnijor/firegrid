import type { Layer } from "effect"
import type { FiregridHost } from "@firegrid/host-sdk"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { inv1StreamZipBodyHost } from "../inv1-stream-zip-body/host.ts"

export const phase0Wave2APermissionStreamHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => inv1StreamZipBodyHost(env)

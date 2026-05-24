import type { ServeError } from "@effect/platform/HttpServerError"
import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import type { Layer } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { darkFactoryHost } from "../dark-factory/host.ts"

export const agenticPatternsPrimitiveProfileHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> =>
  darkFactoryHost(env, { toolProfile: "primitive" })

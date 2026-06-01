import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import { FiregridHost } from "@firegrid/runtime/unified"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const host = (
  env: TinyFiregridHostEnv,
): ReturnType<typeof FiregridHost> =>
  FiregridHost({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    codec: "acp",
    envPolicy: RuntimeEnvResolverPolicy.withPolicy({
      authorizedBindings: [["FIREGRID_FAKE_ACP_FIXTURE", "FIREGRID_FAKE_ACP_FIXTURE"]],
      lookupEnv: (name) =>
        name === "FIREGRID_FAKE_ACP_FIXTURE"
          ? "cancel"
          : env.processEnv[name],
    }),
  })

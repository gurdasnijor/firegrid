/**
 * tf-ll90.5.1 — shape-c terminal-ordering proof host.
 *
 * The REAL `FiregridRuntime` factory with the production codec adapter and the
 * production channel bindings + `JournalObserverLive` — NO overrides. The
 * terminal-ordering invariant (terminal completion binds the durable lifecycle,
 * not raw agent_output) lives entirely in production code, so this host composes
 * it unchanged and the driver exercises it through the public client surface.
 *
 * The only host-level configuration is the env-binding resolver policy that
 * authorizes `ANTHROPIC_API_KEY` for the real `claude-acp` spawn — the same
 * production `RuntimeEnvResolverPolicy` every real-ACP sim uses. It is host
 * composition, not a behavioral backdoor: the terminal path under test is the
 * default `FiregridRuntime` close/cancel binding.
 */

import {
  defaultProductionAdapterLayer,
  FiregridRuntime,
} from "@firegrid/runtime/unified"
import { sessionAgentOutputChannel } from "@firegrid/runtime/channels"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import type { Layer } from "effect"
import type { ChannelRegistration } from "@firegrid/protocol/channels"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const contextId = "session:tiny-firegrid:shape-c-terminal-ordering"

export const shapeCTerminalOrderingHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
	  FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [
          ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
        ],
        lookupEnv: name => env.processEnv[name],
      }),
    ),
	  )

export const shapeCTerminalOrderingChannels = (
  env: TinyFiregridHostEnv,
): ReadonlyArray<ChannelRegistration> => [
  sessionAgentOutputChannel({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    contextId,
  }),
]

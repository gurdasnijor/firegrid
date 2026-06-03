/**
 * tf-r06u.36 — natural-exit terminal-deregister proof host.
 *
 * The REAL `FiregridRuntime` factory with the production codec adapter and the
 * production `JournalObserverLive` (which now carries the `Terminated` →
 * terminal-input wiring). No overrides — the leak fix lives in production code,
 * so this host composes it unchanged and the driver exercises it through the
 * public client surface.
 */

import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"
import {
  defaultProductionAdapterLayer,
  DurableStreamsLive,
  FiregridRuntime,
} from "@firegrid/runtime/unified"
import { Layer } from "effect"

export const naturalExitTerminalHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  FiregridRuntime(
    {
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
    ),
  )

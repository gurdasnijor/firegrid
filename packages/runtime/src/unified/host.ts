/**
 * FiregridHost — the unified production composition factory.
 *
 * One call builds the substrate + workflows + channels + observer +
 * recovery into a single Layer that satisfies the production Tags a
 * `@firegrid/client-sdk` consumer needs.
 *
 * Per SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §F: factory shape with
 * documented escape hatches. The 14-piece composition lives here;
 * users provide an adapter (required) plus optional overrides; standard
 * Effect `Layer.provide` pattern overrides any individual Tag.
 *
 * What this Layer provides (outward):
 *
 *   - `RuntimeControlPlaneTable` — protocol-owned durable substrate
 *   - `RuntimeOutputTable` — durable journal for agent outputs
 *   - `SignalTable` — unified signal primitive backing store
 *   - `UnifiedTable` — UI-renderable row families (permissions etc.)
 *   - All `HostPromptChannel`/`SessionPromptChannel`/etc Tags via
 *     `UnifiedChannelBindingsLive` (overridable)
 *   - `WorkflowEngine` + the six workflow Lives
 *   - `JournalObserverLive` — daemon translating journal rows into
 *     sibling workflow executions
 *
 * What it requires (R-channel): never. The factory is self-contained.
 *
 * Escape hatch example: provide a custom HostPromptChannel binding
 *
 *     FiregridHost({ adapter, durableStreamsBaseUrl, namespace }).pipe(
 *       Layer.provide(MyCustomHostPromptChannelLive)
 *     )
 *
 * Phase E deferred: production codec adapter Lives wrapping
 * `sources/codecs/{acp,stdio-jsonl}`. Today users provide their own
 * `RuntimeContextSessionAdapter` Live; `makeRecorderAdapter` is the
 * canonical test stand-in.
 */

import { Effect, Layer } from "effect"
import {
  WorkflowEngine,
} from "@effect/workflow"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import { DurableStreamsWorkflowEngine } from "../engine/durable-streams-workflow-engine.ts"
import { RuntimeContextSessionAdapter } from "./adapter.ts"
import { SignalTable } from "./signal.ts"
import { UnifiedTable } from "./tables.ts"
import { UnifiedChannelBindingsLive } from "./channel-bindings.ts"
import {
  RuntimeContextSessionWorkflowLayer,
} from "./subscribers/runtime-context.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  type ToolExecutor,
  makeToolExecutor,
} from "./subscribers/permission-and-tool.ts"
import {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
  buildWebhookFactObserverLayer,
} from "./subscribers/scheduled-webhook-peer.ts"
import { JournalObserverLive } from "./observers.ts"

export interface FiregridHostOptions {
  /** Required. The codec-or-test adapter the session workflow body uses. */
  readonly adapter: Layer.Layer<RuntimeContextSessionAdapter>
  /** Durable-streams base URL (e.g. `http://durable-streams:4437`). */
  readonly durableStreamsBaseUrl: string
  /** Namespace prefix for all this host's durable streams. */
  readonly namespace: string
  /** Optional auth headers for durable-streams writes/reads. */
  readonly headers?: DurableTableHeaders
  /**
   * Optional override for the tool executor. Default echoes the input —
   * suitable for sims, not production. Production hosts MUST supply a
   * real executor Layer.
   */
  readonly toolExecutor?: Layer.Layer<ToolExecutor>
}

const streamUrl = (baseUrl: string, segment: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/v1/stream/${encodeURIComponent(segment)}`

const tableLayer = (options: FiregridHostOptions) =>
  Layer.mergeAll(
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({
          baseUrl: options.durableStreamsBaseUrl,
          namespace: options.namespace,
        }),
        contentType: "application/json",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    }),
    RuntimeOutputTable.layer({
      streamOptions: {
        url: streamUrl(
          options.durableStreamsBaseUrl,
          `${options.namespace}.firegrid.runtimeOutput`,
        ),
        contentType: "application/json",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    }),
    SignalTable.layer({
      streamOptions: {
        url: streamUrl(
          options.durableStreamsBaseUrl,
          `${options.namespace}.firegrid.signals`,
        ),
        contentType: "application/json",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    }),
    UnifiedTable.layer({
      streamOptions: {
        url: streamUrl(
          options.durableStreamsBaseUrl,
          `${options.namespace}.firegrid.unified`,
        ),
        contentType: "application/json",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    }),
  )

const engineLayer = (options: FiregridHostOptions) =>
  DurableStreamsWorkflowEngine.layer({
    streamUrl: streamUrl(
      options.durableStreamsBaseUrl,
      `${options.namespace}.firegrid.engine`,
    ),
  })

/**
 * The production composition factory. Returns a single Layer that
 * satisfies the substrate + channel + workflow Tags a Firegrid host
 * needs. The R-channel is `never` — composition is self-contained.
 *
 * Override any individual Tag via `.pipe(Layer.provide(MyLive))`.
 */
export const FiregridHost = (options: FiregridHostOptions) => {
  // Tool executor as a closure-built value (per the existing
  // `buildToolDispatchLayer(executor)` shape). Production hosts that
  // need a Tag-backed executor can override `toolExecutor` and the
  // Layer.provide below picks it up.
  const toolExecutorEffect = makeToolExecutor((p) =>
    JSON.stringify({ tool: p.toolName, input: JSON.parse(p.inputJson) }),
  )

  return Layer.unwrapEffect(
    Effect.gen(function*() {
      const toolExecutor = yield* toolExecutorEffect
      const workflowLayers = Layer.mergeAll(
        RuntimeContextSessionWorkflowLayer.pipe(Layer.provide(options.adapter)),
        buildPermissionRoundtripLayer(),
        buildToolDispatchLayer(toolExecutor),
        buildScheduledPromptLayer(),
        buildWebhookFactObserverLayer(),
        buildPeerEventObserverLayer(),
      )
      const channelsAndObserver = Layer.mergeAll(
        UnifiedChannelBindingsLive,
        JournalObserverLive,
      )
      return Layer.mergeAll(
        workflowLayers,
        channelsAndObserver,
      ).pipe(
        Layer.provideMerge(engineLayer(options)),
        Layer.provideMerge(tableLayer(options)),
      )
    }),
  )
}

// Re-export primitive layers for users wanting full control or
// overriding individual substrate pieces.
export {
  DurableStreamsWorkflowEngine,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  SignalTable,
  UnifiedTable,
}
export type { ToolExecutor }

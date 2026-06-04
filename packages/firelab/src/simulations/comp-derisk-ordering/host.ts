/**
 * comp-derisk-ordering host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4), plus the tf-0awo.20 §3.1/§12-Seam-1b
 * output-ordering probe.
 *
 * The host is `firegridHost(options)` (prod == sim); the only sim-specific
 * addition is the harness-private `outputOrderProbe`, which subscribes to the
 * HOST-WIDE `RuntimeOutputTable.events` projection (resolved from the composed
 * host) and emits one span per row in append order (appendIndex,
 * activityAttempt, sequence, contextId). The trace is the deliverable; this
 * layer computes no verdict. The probe is an observer over the canonical host —
 * NOT host-composition wiring.
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { defaultProductionAdapterLayer, RuntimeOutputTable } from "@firegrid/runtime/unified"
import { Effect, Layer, Stream } from "effect"
import type {
  FiregridHost,
  FirelabHostEnv,
} from "../../types.ts"

const pathFromHere = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname)

const outputOrderProbe = Layer.scopedDiscard(
  Effect.gen(function*() {
    const output = yield* RuntimeOutputTable
    yield* output.events.rows().pipe(
      Stream.zipWithIndex,
      Stream.runForEach(([row, appendIndex]) =>
        Effect.void.pipe(
          Effect.withSpan("firegrid.sim.output_order_probe", {
            kind: "internal",
            attributes: {
              "firegrid.sim.append_index": appendIndex,
              "firegrid.sim.activity_attempt": row.activityAttempt,
              "firegrid.sim.sequence": row.sequence,
              "firegrid.context.id": row.contextId,
            },
          }),
        ),
      ),
      Effect.catchAllCause(() => Effect.void),
      Effect.forkScoped,
    )
  }),
)

export const host = (
  env: FirelabHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  outputOrderProbe.pipe(
    Layer.provideMerge(
      firegridHost({
        spec: { namespace: env.namespace },
        adapter: defaultProductionAdapterLayer(),
        backend: DurableStreamsLive.configuredWith({
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
        }),
        ingress: {
          transport: "durable-streams",
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
          streamId: "comp-derisk-ordering",
          gatewayExternalKey: {
            source: "firelab",
            id: "comp-derisk-ordering-gateway",
          },
          gatewayRuntime: local.jsonl({
            agent: "official-acp-typescript-sdk-example",
            argv: [
              process.execPath,
              pathFromHere("../../../../../node_modules/tsx/dist/cli.mjs"),
              pathFromHere("../../bin/fake-acp-agent-process.ts"),
            ],
            agentProtocol: "acp",
          }),
        },
      }),
    ),
  )

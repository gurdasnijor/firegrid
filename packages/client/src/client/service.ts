import { Context, Effect, Layer } from "effect"
import {
  Projection,
  ProjectionLive,
  SubstrateProducerLive,
  WorkProducer,
} from "@durable-agent-substrate/substrate"
import { makeWorkFacet, type SubstrateClientWork } from "./work.ts"

// launchable-substrate-host.CLIENT_SURFACE.1
// launchable-substrate-host.CLIENT_SURFACE.2
// launchable-substrate-host.CLIENT_COMPATIBILITY.4
// launchable-substrate-host.PACKAGING.7
//
// SubstrateClient is the Effect-native app-facing client tag. The Live
// layer accepts a small config and internally composes the substrate
// producer + projection layers, so consumers never see raw stream URLs,
// StreamDB collections, or DSS envelopes at the client root
// (CLIENT_SURFACE.7).
export interface SubstrateClientConfig {
  readonly streamUrl: string
  readonly clientId: string
  readonly contentType?: string
}

export interface SubstrateClientService {
  // launchable-substrate-host.CLIENT_SURFACE.3
  // launchable-substrate-host.CLIENT_SURFACE.6
  readonly work: SubstrateClientWork
}

export class SubstrateClient extends Context.Tag(
  "substrate/SubstrateClient",
)<SubstrateClient, SubstrateClientService>() {}

// launchable-substrate-host.PACKAGING.7
// launchable-substrate-host.CLIENT_COMPATIBILITY.4
// SubstrateClientLive composes its own dependencies internally so the
// resulting layer has zero remaining requirements. The same client
// capability surfaces in withHost-style helpers in later slices.
export const SubstrateClientLive = (
  cfg: SubstrateClientConfig,
): Layer.Layer<SubstrateClient> => {
  const projectionLayer = ProjectionLive({
    streamUrl: cfg.streamUrl,
    ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
  })
  const producerLayer = SubstrateProducerLive({
    streamUrl: cfg.streamUrl,
    ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
  })

  // Build the SubstrateClient service inside a scope so the underlying
  // ProjectionLive's StreamDB lifetime is tied to the SubstrateClient
  // layer's scope.
  const clientLayer = Layer.scoped(
    SubstrateClient,
    Effect.gen(function* () {
      const projection = yield* Projection
      const workProducer = yield* WorkProducer
      return {
        work: makeWorkFacet(
          projection,
          (...args) => workProducer.declareWork(...args),
          {
            streamUrl: cfg.streamUrl,
            ...(cfg.contentType !== undefined
              ? { contentType: cfg.contentType }
              : {}),
          },
        ),
      } satisfies SubstrateClientService
    }),
  )

  return Layer.provide(
    clientLayer,
    Layer.mergeAll(projectionLayer, producerLayer),
  ).pipe(
    // The internal projection-acquire failure mode is a defect from the
    // client root; consumers do not handle a raw projection-read error
    // when constructing the client.
    Layer.orDie,
  )
}

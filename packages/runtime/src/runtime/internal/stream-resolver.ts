import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Context, Data, Effect, Layer, type Scope } from "effect"
import type {
  BootMode,
  FiregridRuntimeStreamIdentity,
} from "../service.ts"

// firegrid-runtime-process.RUNTIME_PACKAGE.2
// firegrid-runtime-process.CONFIG_SURFACE.5
//
// Internal DI services for the runtime construction layer. Attached
// vs embedded-dev are different live providers of the same
// `RuntimeStreamResolver` Tag; the resolver, in turn, is the only
// thing the core runtime layer depends on. The embedded resolver
// itself depends on two further internal services so the test
// surface can drive the resolver without booting a real
// DurableStreamTestServer / calling DurableStream.create:
//
//   • EmbeddedDurableStreams  — start a scoped Durable Streams
//     endpoint (default Live wraps DurableStreamTestServer).
//   • DurableStreamAdmin      — create / ensure a substrate stream
//     (default Live wraps DurableStream.create).
//
// The core runtime layer never names DurableStreamTestServer or
// DurableStream.create. Tests can fake any layer in the chain.

// ────────────────────────────────────────────────────────────────
// Errors

export class RuntimeStartupError extends Data.TaggedError(
  "firegrid/RuntimeStartupError",
)<{
  readonly reason: string
  readonly cause?: unknown
}> {}

// ────────────────────────────────────────────────────────────────
// EmbeddedDurableStreams

export interface EmbeddedDurableStreamsConfig {
  readonly host: string
  readonly port: number
}

export interface EmbeddedDurableStreamsService {
  readonly start: (
    cfg: EmbeddedDurableStreamsConfig,
  ) => Effect.Effect<{ readonly url: string }, RuntimeStartupError, Scope.Scope>
}

export class EmbeddedDurableStreams extends Context.Tag(
  "firegrid/internal/EmbeddedDurableStreams",
)<EmbeddedDurableStreams, EmbeddedDurableStreamsService>() {}

export const EmbeddedDurableStreamsLive: Layer.Layer<EmbeddedDurableStreams> =
  Layer.succeed(EmbeddedDurableStreams, {
    start: (cfg) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const s = new DurableStreamTestServer({
              host: cfg.host,
              port: cfg.port,
            })
            await s.start()
            return s
          },
          catch: (cause) =>
            new RuntimeStartupError({
              reason: "embedded DurableStreamTestServer start",
              cause,
            }),
        }),
        (s) => Effect.promise(() => s.stop()),
      ).pipe(Effect.map((s) => ({ url: s.url }))),
  })

// ────────────────────────────────────────────────────────────────
// DurableStreamAdmin

export interface DurableStreamAdminCreateInput {
  readonly streamUrl: string
  readonly contentType: string
}

export interface DurableStreamAdminService {
  readonly create: (
    input: DurableStreamAdminCreateInput,
  ) => Effect.Effect<void, RuntimeStartupError>
}

export class DurableStreamAdmin extends Context.Tag(
  "firegrid/internal/DurableStreamAdmin",
)<DurableStreamAdmin, DurableStreamAdminService>() {}

export const DurableStreamAdminLive: Layer.Layer<DurableStreamAdmin> =
  Layer.succeed(DurableStreamAdmin, {
    create: (input) =>
      Effect.tryPromise({
        try: () =>
          DurableStream.create({
            url: input.streamUrl,
            contentType: input.contentType,
          }),
        catch: (cause) =>
          new RuntimeStartupError({
            reason: `creating substrate stream ${input.streamUrl}`,
            cause,
          }),
      }).pipe(Effect.asVoid),
  })

// ────────────────────────────────────────────────────────────────
// RuntimeStreamResolver

export interface ResolvedStream {
  readonly bootMode: BootMode
  readonly streamIdentity: FiregridRuntimeStreamIdentity
}

export interface RuntimeStreamResolverService {
  readonly resolve: Effect.Effect<ResolvedStream>
}

export class RuntimeStreamResolver extends Context.Tag(
  "firegrid/internal/RuntimeStreamResolver",
)<RuntimeStreamResolver, RuntimeStreamResolverService>() {}

// Attached resolver: trust the supplied URL; no embedded server, no
// stream creation.
export const attachedResolverLayer = (
  streamUrl: string,
): Layer.Layer<RuntimeStreamResolver> =>
  Layer.succeed(RuntimeStreamResolver, {
    resolve: Effect.succeed({
      bootMode: "attached",
      streamIdentity: { streamUrl },
    } satisfies ResolvedStream),
  })

export interface EmbeddedResolverConfig {
  readonly host: string
  readonly port: number
  readonly streamName: string
  readonly contentType: string
}

// Embedded-dev resolver: depend on EmbeddedDurableStreams +
// DurableStreamAdmin. The resolver doesn't know about
// DurableStreamTestServer or DurableStream.create at all.
export const embeddedResolverLayer = (
  cfg: EmbeddedResolverConfig,
): Layer.Layer<
  RuntimeStreamResolver,
  never,
  EmbeddedDurableStreams | DurableStreamAdmin
> =>
  Layer.scoped(
    RuntimeStreamResolver,
    Effect.gen(function* () {
      const embedded = yield* EmbeddedDurableStreams
      const admin = yield* DurableStreamAdmin
      const { url } = yield* embedded
        .start({ host: cfg.host, port: cfg.port })
        .pipe(Effect.orDie)
      const parsed = new URL(url)
      const streamUrl = `${url}/substrate/${cfg.streamName}`
      yield* admin
        .create({ streamUrl, contentType: cfg.contentType })
        .pipe(Effect.orDie)
      const resolved: ResolvedStream = {
        bootMode: "embedded-dev",
        streamIdentity: {
          streamUrl,
          streamName: cfg.streamName,
          host: cfg.host,
          port: Number(parsed.port) || cfg.port,
        },
      }
      return { resolve: Effect.succeed(resolved) }
    }),
  )

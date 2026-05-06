import { Context, Effect, Layer } from "effect"
import type {
  BootMode,
  FiregridRuntimeStreamIdentity,
} from "../service.ts"

// firegrid-runtime-process.RUNTIME_PACKAGE.2
// firegrid-runtime-process.BINARIES.7
// firegrid-runtime-process.CONFIG_SURFACE.6
//
// Firegrid runtime startup is attached-only. Durable Streams server
// lifecycle belongs outside Firegrid, so this resolver only trusts a
// caller-provided stream URL and never launches or creates a stream.

interface ResolvedStream {
  readonly bootMode: BootMode
  readonly streamIdentity: FiregridRuntimeStreamIdentity
}

interface RuntimeStreamResolverService {
  readonly resolve: Effect.Effect<ResolvedStream>
}

export class RuntimeStreamResolver extends Context.Tag(
  "firegrid/internal/RuntimeStreamResolver",
)<RuntimeStreamResolver, RuntimeStreamResolverService>() {}

export const attachedResolverLayer = (
  streamUrl: string,
): Layer.Layer<RuntimeStreamResolver> =>
  Layer.succeed(RuntimeStreamResolver, {
    resolve: Effect.succeed({
      bootMode: "attached",
      streamIdentity: { streamUrl },
    } satisfies ResolvedStream),
  })

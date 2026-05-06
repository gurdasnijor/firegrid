import { Context, Effect, Layer } from "effect"

// firegrid-remediation-hardening.EFFECT_CONSISTENCY.5
// firegrid-runtime-process.CONFIG_SURFACE.4
// launchable-substrate-host.HOST_CONFIGURATION.7
//
// IdGen is the kernel's portable ID-generation seam. Substrate domain
// modules (producer, internal-claim, waits, event-client) yield from
// this service rather than importing `node:crypto.randomUUID`, so the
// portable kernel stays runnable in browser bundles and tests can
// override identity generation via a deterministic Layer without
// per-call override fields proliferating across every entry point.
//
// IdGenLive uses `globalThis.crypto.randomUUID`, which is supported
// in Node 19+ and every modern browser. It is the single canonical
// source of randomness for kernel IDs; node:crypto is reserved for
// platform-edge modules outside the portable kernel.

export interface IdGenService {
  readonly nextId: Effect.Effect<string>
}

export class IdGen extends Context.Tag("Substrate/IdGen")<
  IdGen,
  IdGenService
>() {}

export const IdGenLive: Layer.Layer<IdGen> = Layer.succeed(IdGen, {
  nextId: Effect.sync(() => globalThis.crypto.randomUUID()),
})

// runtime-keyed-subscriber: the minimal subscriber-runtime helper for Shape C
// keyed handlers. Drives per-event handler materializations from a tail source
// with in-key serialization (via a per-key mutex) and cross-key concurrency.
//
// Production manifestation of tf-4fy3's Outcome B evidence
// (`packages/tiny-firegrid/src/simulations/per-key-subscriber-push-restart/`).
// Generic over (key, event, error, requirements) — owns no RuntimeContext-
// specific knowledge. Downstream Shape C handler lanes wire the typed-event
// source and supply the keyed handler.
//
// This module is internal infrastructure, exported via the
// `@firegrid/runtime/runtime-keyed-subscriber` subpath. It is NOT part of the
// broad `@firegrid/runtime` public surface.

export {
  makePerKeyMutex,
  type PerKeyMutex,
} from "./per-key-mutex.ts"

export {
  runKeyedDispatch,
  type KeyedEvent,
  type RunKeyedDispatchOptions,
} from "./keyed-dispatch.ts"

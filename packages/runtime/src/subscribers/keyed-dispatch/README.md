# subscribers/keyed-dispatch/

SHAPE: C infrastructure

Generic keyed-dispatch helper for Shape C subscribers. It consumes a typed
`Stream` of `{ key, event }` facts, serializes same-key handler calls with a
per-key mutex, and lets different keys progress concurrently.

This folder is infrastructure for subscriber materialization; it does not own
RuntimeContext state, does not read or write durable tables directly, and does
not import workflow machinery. Call sites supply the typed durable source and
the per-event handler.

Public subpath: `@firegrid/runtime/subscribers/keyed-dispatch`.

Compatibility alias: `@firegrid/runtime/runtime-keyed-subscriber` points here
until remaining external consumers retarget.

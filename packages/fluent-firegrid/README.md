# @firegrid/fluent-firegrid

Restate-shaped Firegrid primitives directly over Effect and Durable Streams.

This package is currently a keystone slice: `service`, `client`, and a handler
context with durable `ctx.run(name, fn)` replayed from an append-only journal.

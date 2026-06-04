# @firegrid/fluent-firegrid

Restate sdk-gen-shaped Firegrid primitives directly over Effect and Durable
Streams.

This package is a keystone slice for a generator-based Operation/Future API:
`gen`, `execute`, `run`, `sleep`, `all`, `race`, `any`, `allSettled`, `select`,
and `spawn` run through a scheduler backed by an append-only Durable Streams
journal.

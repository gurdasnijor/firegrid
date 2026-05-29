# producers/

Logical pipeline position: **3b** (peer with `sources/`, `transforms/`,
`channels/`). May import `events/`, `capabilities/`, `tables/`, `sources/`.
Must not import peers (`transforms/`, `channels/`), `subscribers/`, or
`composition/`.

Source: `docs/sdds/SDD_FIREGRID_RUNTIME_SOURCE_PRODUCER_ROLES.md`,
`docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

**Topic writers** — Kafka-client "Producer" role: layers that consume a
`Stream` from `sources/` (or from another live boundary), and append
durable rows to a specific `DurableTable` in `tables/`. A producer module
provides a `Layer` (and optional accompanying `Context.Tag` declared in
`capabilities/`) so that consumers downstream can depend on the *capability*
rather than on this folder.

Producers are not subscribers — they do not read keyed rows and dispatch
behavior. They translate live streams into authoritative durable writes.

Producers have no owned RuntimeContext state. Their `R` channel names
transport/session tags from `sources/`, an `IdGenerator`, and `Scope`.

This folder is **currently empty** (other than this README) following the
PR-M1 cutover that moved `sandbox/` and `codecs/` to `sources/`. Concrete
topic-writer modules land here in PR-M2 (scheduled-prompt-append) and
PR-M3 (runtime-input-append).

## May import

- `events/`, `capabilities/`, `tables/`, `sources/`
- protocol schemas
- `effect`, `@effect/platform`, transport SDKs

## Must not import

- peer-tier `transforms/`, `channels/`
- `subscribers/`, `composition/`
- `_archive/`

## Subscribers depend on Tags, not on this folder

The `subscribers/ ✗ producers/` dep-cruiser rule is enforced. A subscriber
that needs a producer's write capability depends on the Tag in
`capabilities/`, which the host layer satisfies with the producer's Live
binding. Subscribers never import files in this folder directly.

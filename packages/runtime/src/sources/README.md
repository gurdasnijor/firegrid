# sources/

Logical pipeline position: **3a** (peer with `transforms/`, `channels/`). May
import `events/` and `capabilities/`. Must not import `tables/`, peers
(`transforms/`, `channels/`), `subscribers/`, or `composition/`.

Source: `docs/sdds/SDD_FIREGRID_RUNTIME_SOURCE_PRODUCER_ROLES.md`,
`docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

**Emitters** — Kafka Connect "Source" role: live boundaries that produce
a typed event stream. A source module exposes either an Effect `Stream<E>`
directly, or a session contract (a `Context.Tag` service whose `outputs`
field is a `Stream`).

Sources have **no row authority**. They do not import `tables/`, do not
hold a `DurableTable` write capability, and do not append rows. Turning a
source's stream into durable rows is the job of the owning runtime write
authority/provider layer.

Sources have no owned RuntimeContext state. Their `R` channel names
transport edges (process bytes, external HTTP, codec bytes), an
`IdGenerator`, and `Scope`.

## Layout

- `sandbox/` — sandbox providers (`AgentByteStream`,
  `LocalProcessSandboxProvider`, `EffectAiSandboxProvider`,
  `SandboxProvider` contract). The runtime's live boundary for "run this
  work somewhere".
- `codecs/` — `AgentSession` live codec implementations (`acp/`,
  `stdio-jsonl/`) and the `AgentSession`/codec contract surface. Each codec
  takes a byte stream (typically from `sandbox/`) and exposes an
  `AgentSession` whose `outputs: Stream<AgentOutputEvent, ...>` is the
  emitter surface.

## May import

- `events/`, `capabilities/`
- protocol schemas
- `effect`, `@effect/platform`, transport SDKs

## Must not import

- `tables/` (no row authority)
- peer-tier `transforms/`, `channels/`
- `subscribers/`, `composition/`
- `_archive/`

## Public subpaths

- `@firegrid/runtime/sources/sandbox`
- `@firegrid/runtime/sources/sandbox/local-process-from-env`
- `@firegrid/runtime/sources/codecs`
- `@firegrid/runtime/sources/codecs/session-byte-stream-adapter`
- `@firegrid/runtime/sources/codecs/acp/stdio-edge`
- `@firegrid/runtime/sources/codecs/agent-adapters` (also re-exported at
  the historical `@firegrid/runtime/agent-adapters` subpath)

The legacy `@firegrid/runtime/producers/{sandbox,codecs}*` back-compat subpaths
have been retired; use the `sources/*` subpaths above.

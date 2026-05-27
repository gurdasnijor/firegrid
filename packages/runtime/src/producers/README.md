# producers/

Logical pipeline position: **3** (peer with `transforms/`, `channels/`). May
import `events/` and `tables/`. Peers do not import each other. Must not
import `subscribers/` or `composition/`.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

Shape A live-boundary producers and append authorities: scoped, live work
that turns boundary events into durable rows. Producers are not subscribers
— they do not read keyed rows and dispatch behavior; they translate a live
boundary (process stdout, codec session, external webhook) into durable
row appends.

Producers have no owned RuntimeContext state; their `R` channel only names
transport/session tags, `IdGenerator`, and `Scope`.

Layout:

- `sandbox/` — sandbox providers (`AgentByteStream`, `LocalProcessSandboxProvider`,
  `EffectAiSandboxProvider`, `SandboxProvider` contract)
- `codecs/` — `AgentSession` live codec implementations (`acp/`,
  `stdio-jsonl/`) and the `AgentSession`/codec contract surface
- `ingress-writers/` — **scaffold (README only)**. Append authorities that
  bridge live sources into durable tables (target contents:
  `per-context-output.ts` for `AgentSession.outputs -> RuntimeOutputTable.events`,
  `runtime-input-append.ts` for external input -> ingress intent rows). Two
  existing helpers belong here but currently live in `tables/` and
  `composition/` because the `subscribers/` → `producers/` tier rule blocks
  the direct move. See `ingress-writers/README.md` and #756 for the
  resolution paths.

## May import

- `events/`, `tables/`
- protocol schemas
- `effect`, `@effect/platform`, transport SDKs

## Must not import

- peer-tier `transforms/`, `channels/`
- `subscribers/`, `composition/`
- `WorkflowEngine`, `WorkflowInstance`, `Workflow.make`, `Activity.make`,
  `DurableDeferred` — producers are Shape A live-boundary producers, not
  workflow-shaped subscribers

A producer that needs durable wait or memoization is the wrong shape; route
through a Shape D subscriber.

## DO

```ts
// ingress-writers/per-context-output.ts
yield* RuntimeOutputTable.events.append(eventRow)   // append authority
```

## DO NOT

```ts
// ingress-writers/per-context-output.ts
const memoized = yield* Activity.make(/* ... */)   // workflow machinery in a producer
```

## Scaffold status

Empty subfolders staged. Wave 2 moves `producers/sandbox/`,
`producers/codecs/`, and
`tables/per-context-output.ts` into this tree, and
introduces `runtime-context-input-facts.ts` as the input-fact append authority.
The public subpath `@firegrid/runtime/producers/runtime-context-input-facts` is
reserved for that Wave 2 export.

# Target Directory Topology — R-shape prototype (tf-1r0o)

Prototype of the **physical structure** for the production runtime pipeline
described in
[`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md)
and
[`docs/cannon/architecture/runtime-design-constraints.md`](../../../../../docs/cannon/architecture/runtime-design-constraints.md).

This is a **topology proof**, not a runnable simulation. Its acceptance is the
`tsc --noEmit` gate plus the path map in [`PATH_MAP.md`](./PATH_MAP.md):

- the positive composition typechecks only because every capability a subscriber
  names in `R` is provided by the host layer (`composition/host-live.ts`);
- the deliberate falsifiers in `composition/negative-examples.ts` **fail** to
  typecheck, and each is guarded by a `@ts-expect-error` that TypeScript itself
  verifies is load-bearing (an unused directive is a compile error). Passing
  `tsc` therefore means "the violations were caught."

It is intentionally inert at runtime: capability layers are stubs. The proof is
in the **types**, which mirror the real production types named in the cannon
doc.

## The canonical shape

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

The host's dataflow graph is the `Layer` composition. A subscriber's
requirements channel (`R`) declares what kind of subscriber it is.

## Folders (the dataflow graph, left to right)

| Folder | Role | Owns | Examples here |
|---|---|---|---|
| `events/` | runtime fact & identity types | `RuntimeContext`, `RuntimeContextTargetEvent` | imports protocol row schemas, never redeclares them |
| `tables/` | durable state-of-record capability tags + polarity split | state store; output `*Read`/`*Write` tags | `RuntimeContextStateStore`, `RuntimeAgentOutputRead/Write` |
| `producers/` | Shape A live boundaries + side-effect executors | live session, tool executor | `AgentSession`, `RuntimeToolUseExecutor` |
| `transforms/` | **pure** `(state,event)->(state,actions)` reducers | nothing (pure) | `transitionRuntimeContextEvent` |
| `channels/` | typed wire-edge capability tags | host service tags typed by protocol contracts | `HostPromptChannel`, `SessionAgentOutputChannel` |
| `subscribers/shape-b/` | projection (read-only) | nothing | `projectionConsumer` |
| `subscribers/shape-c/` | stateful keyed subscriber, **no** workflow machinery | durable state for one key | `handleRuntimeContextEvent` |
| `subscribers/shape-d/` | workflow-shaped subscriber | workflow execution identity | `toolCallSubscriber` + `ToolCallWorkflow` |
| `composition/` | the topology declaration (`Layer.mergeAll`) + wiring proofs | wiring, not capabilities | `host-live.ts`, `negative-examples.ts` |

(Shape A is not a subscriber folder — it is the live producer boundary, so it
lives in `producers/`. The task asked for Shape **B/C/D** subscriber folders.)

## Import direction (the load-bearing rule)

```text
@firegrid/protocol   (wire record & channel CONTRACTS — owns schemas)
        ▲
        │  runtime folders import protocol; protocol imports nothing from runtime
        │
events/ ──▶ tables/ ──▶ producers/ ──▶ transforms/ ──▶ channels/
        └────────────────────────┬───────────────────────────┘
                                  ▼
                          subscribers/  (shape-b, shape-c, shape-d)
                                  ▼
                          composition/  (root Layer)
```

Rules enforced by structure (and, where noted, by `tsc`):

1. **Protocol-owned schemas are never moved into runtime folders.**
   `events/` imports `RuntimeEventRow` / `RuntimeIngressInputRow` from
   `@firegrid/protocol`; `channels/` imports `IngressChannel` / `EgressChannel`
   / `ChannelTarget` from `@firegrid/protocol/channels`. Neither redeclares a
   protocol schema. This is the C7 boundary.
2. **`composition/` depends on everything; nothing depends on `composition/`.**
   The Layer graph is the only place topology is declared.
3. **`transforms/` is pure** — no Effect environment, no imports from
   `producers/` or `channels/`. Reviewer test: callable in a unit test with no
   Effect env.
4. **Polarity is in the type.** A subscriber whose `R` mentions a `*Write` tag
   or an `EgressChannel` is an authority for that table/edge; `*Read` /
   `IngressChannel` means observer.

## What `R` tells you (static enforcement boundary)

| `R` contains | Shape | Meaning |
|---|---|---|
| only a typed read source (`*Read`, `IngressChannel`) | B | projection / observer |
| a state store tag (+ live/channel tags), **no** `WorkflowEngine` | C | owns durable state for a key, per-event handler |
| `WorkflowEngine` / `WorkflowInstance` | D | workflow-shaped; must justify the machinery |
| only transport/session/id tags | A (producer) | codec / live boundary |

## How to run the proof

```bash
pnpm --filter @firegrid/tiny-firegrid typecheck   # must be green
```

Green means: the positive wiring holds **and** both falsifiers are caught. To
see a falsifier fire, delete a `@ts-expect-error` in
`composition/negative-examples.ts` and re-run — `tsc` reports the leaked
`WorkflowEngine` (or missing state-store) requirement.

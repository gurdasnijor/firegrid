# Verdict: GREEN - replaceable

Sim 1 validates the strong-form deletion claim for `SessionAgentOutputChannel`: the public `session.wait.forAgentOutput` path was rewritten to read through the channel contract, and the sim observed the same three agent-output events in the same order through all four former parallel paths.

## Channel Slice Added

- Protocol contract: `@firegrid/protocol/channels` now owns the channel primitives and factories for ingress, egress, bidirectional, and callable channels, with their durable binding shapes (`TypedStream`, `AppendTarget`, bidirectional stream+append, `CallTarget`) in `packages/protocol/src/channels/index.ts:30`, `packages/protocol/src/channels/index.ts:52`, `packages/protocol/src/channels/index.ts:62`, `packages/protocol/src/channels/index.ts:71`, `packages/protocol/src/channels/index.ts:88`, `packages/protocol/src/channels/index.ts:105`, `packages/protocol/src/channels/index.ts:127`, `packages/protocol/src/channels/index.ts:147`, and `packages/protocol/src/channels/index.ts:172`.
- Protocol `SessionAgentOutputChannel`: target `session.agent_output`, ingress registration over `RuntimeAgentOutputObservationSchema`, and Context.Tag service identity live at `packages/protocol/src/channels/index.ts:197`, `packages/protocol/src/channels/index.ts:199`, and `packages/protocol/src/channels/index.ts:208`. The protocol export surface includes `./channels` at `packages/protocol/package.json:44` and namespace export at `packages/protocol/src/index.ts:3`.
- Host Live Layer: the live binding stays below the protocol line and wires `SessionAgentOutputChannel` to `RuntimeOutputTable.events.rows()` filtered through `runtimeAgentOutputObservationFromRow` in `packages/host-sdk/src/host/channels/session-agent-output/index.ts:45`, `packages/host-sdk/src/host/channels/session-agent-output/index.ts:56`, and `packages/host-sdk/src/host/channels/session-agent-output/index.ts:72`. Host composition installs that Live Layer in `packages/host-sdk/src/host/layers.ts:260` and `packages/host-sdk/src/host/runtime-substrate.ts:66`.
- ChannelInventory remains a host-sdk transition bridge, not a protocol API: host-sdk re-exports protocol primitives while keeping `ChannelInventory`, `makeChannelInventory`, `ChannelInventoryLive`, `findChannel`, and `channelMetadata` in `packages/host-sdk/src/host/channel.ts:1`, `packages/host-sdk/src/host/channel.ts:42`, `packages/host-sdk/src/host/channel.ts:50`, `packages/host-sdk/src/host/channel.ts:56`, `packages/host-sdk/src/host/channel.ts:61`, and `packages/host-sdk/src/host/channel.ts:97`. The sim path does not use inventory lookup.

## Rewritten Path

The product rewrite target is `session.wait.forAgentOutput`. The client now constructs a browser-safe protocol ingress channel over the resolved runtime output table in `packages/client-sdk/src/firegrid.ts:358`, wraps projection waits as `waitForIngressChannelProjection` in `packages/client-sdk/src/firegrid.ts:377`, and routes `waitForAgentOutputObservation` through that channel in `packages/client-sdk/src/firegrid.ts:650` and `packages/client-sdk/src/firegrid.ts:670`.

`hostProjectionObserver` was also rerouted as a regression harness path: it now depends on `SessionAgentOutputChannel` and reads `output.forContext(...).binding.stream` in `packages/host-sdk/src/host/projection-observer.ts:17` and `packages/host-sdk/src/host/projection-observer.ts:22`.

## Static Lowering Check

The four direction binding types map cleanly to DurableTable-style primitive signatures:

- Ingress lowers to typed rows/stream observation: `IngressChannel.binding` is `TypedStreamBinding.stream` at `packages/protocol/src/channels/index.ts:30` and `packages/protocol/src/channels/index.ts:52`; `SessionAgentOutputChannel` binds it to `RuntimeOutputTable.events.rows()` in `packages/host-sdk/src/host/channels/session-agent-output/index.ts:56`.
- Egress lowers to append: `AppendTargetBinding.append(payload)` and `makeEgressChannel` are defined at `packages/protocol/src/channels/index.ts:35` and `packages/protocol/src/channels/index.ts:127`.
- Callable lowers to request/response call: `CallTargetBinding.call(request)` and `makeCallableChannel` are defined at `packages/protocol/src/channels/index.ts:42` and `packages/protocol/src/channels/index.ts:172`.
- Bidirectional lowers to stream + append: the bidirectional channel carries both `stream` and `append` in one binding at `packages/protocol/src/channels/index.ts:71` and `packages/protocol/src/channels/index.ts:147`.

## Sim Evidence

Sim source lives under `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/`. The host side registers the three non-product observer paths in `host.ts`: channel-backed `hostProjectionObserver` at `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/host.ts:62`, direct `RuntimeAgentOutputAfterEvents.forContext` at `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/host.ts:85`, and raw `RuntimeOutputTable.events.rows()` at `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/host.ts:117`. The driver emits two `TextChunk`s and one `TurnComplete`, waits through `session.wait.forAgentOutput`, then compares all observer snapshots in `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/driver.ts:40`, `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/driver.ts:64`, `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/driver.ts:92`, and `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim1-agent-output-collapse/driver.ts:150`.

Successful run:

```text
pnpm --filter @firegrid/tiny-firegrid simulate:run sim1-agent-output-collapse --timeout-ms 120000
run: 2026-05-20T23-53-46-473Z__sim1-agent-output-collapse
trace: packages/tiny-firegrid/.simulate/runs/2026-05-20T23-53-46-473Z__sim1-agent-output-collapse/trace.jsonl
```

Trace evidence from that run:

- Client channel wait spans for `session.agent_output` ingress: `trace.jsonl:146`, `trace.jsonl:147`, `trace.jsonl:226`, `trace.jsonl:227`, `trace.jsonl:236`, `trace.jsonl:237`, `trace.jsonl:255`, `trace.jsonl:256`.
- Runtime decoded and appended the three expected events: `TextChunk` at `trace.jsonl:222` / `trace.jsonl:232`, second `TextChunk` at `trace.jsonl:233` / `trace.jsonl:242`, and `TurnComplete` at `trace.jsonl:243` / `trace.jsonl:260`.
- All three alternate paths recorded identical signatures: `hostProjectionObserver` at `trace.jsonl:247`, `RuntimeAgentOutputAfterEvents.forContext` at `trace.jsonl:251`, and raw `RuntimeOutputTable.events.rows()` at `trace.jsonl:253`.
- GREEN verdict span: `trace.jsonl:261` recorded `firegrid.simulation.rewritten_path=session.wait.forAgentOutput` and `firegrid.simulation.event_signatures=1:TextChunk:SIM1_AGENT_OUTPUT_COLLAPSE:one|2:TextChunk:SIM1_AGENT_OUTPUT_COLLAPSE:two|3:TurnComplete:stop`.

## Acceptance Tests

- `pnpm --filter @firegrid/protocol typecheck` passed.
- `pnpm --filter @firegrid/host-sdk typecheck` passed.
- `pnpm --filter @firegrid/client-sdk typecheck` passed.
- `pnpm --filter @firegrid/tiny-firegrid typecheck` passed.
- `pnpm --filter @firegrid/client-sdk exec vitest run test/firegrid.sessions.test.ts test/firegrid.layer-hoisting.test.ts` passed: 13 tests across 2 files.
- `pnpm --filter @firegrid/tiny-firegrid simulate:run sim1-agent-output-collapse --timeout-ms 120000` passed with the GREEN trace above.
- `pnpm run verify` passed end to end after the channel split, product-path rewrite, sim source, and finding were in place.

## Ergonomic Helper / Cycle 2 API Gap

This sim needed one visible helper, `waitForIngressChannelProjection`, to make `wait_for(channel)` ergonomic in the client without importing host-sdk. It is currently client-internal at `packages/client-sdk/src/firegrid.ts:377`; Cycle 2 should decide whether a protocol-owned projection verb becomes public once there is a second cross-package consumer.

## Dispatch Implication

Cycle 1 Sim 1 supports the deletion plan: `SessionAgentOutputChannel` can replace the four parallel agent-output read paths without behavior change for the load-bearing three-event case. The tf-kddg finish-line contribution is the narrow split placement now implemented here: protocol owns the channel contract/tag/schema and host-sdk owns the Live Layer. Cycle 2 can target removal of duplicate agent-output observer paths, with the only carveout candidate being the public placement of the ergonomic `wait_for(channel)` helper rather than the channel semantics themselves.

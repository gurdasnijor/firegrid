# Convergence Scoreboard

## Current Read

Use a two-number score:

| Dimension | Current Read | Meaning |
| --- | ---: | --- |
| Substrate boundary | 90-93% | Runtime/host-sdk dependency direction, durable-tools deletion, workflow ownership, import guardrails, carveout shrinkage |
| Surface hygiene | 75-80% | Public exports, package READMEs, simulation methodology, operation catalogs, span names, example imports |

Gary's original 90-93% convergence number remains correct for substrate
boundary work. The companion assessment correctly adds that public-surface
discipline is lower and is now the dominant private-beta risk.

## Finish-Line Metric

Primary scoreboard:

```bash
git show origin/main:.dependency-cruiser.cjs | grep -A 16 currentHostSdkSubstrateDebt
```

As of the assessed wave, the current host-sdk substrate debt list is:

- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/host-sdk/src/host/control-request-reconciler.ts`
- `packages/host-sdk/src/host/internal/runtime-context-helpers.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/runtime-input-deferred.ts`
- `packages/host-sdk/src/host/session-log-channel.ts`

Dispatch rule: every boundary lane should either reduce this list, explain why a
named file must remain temporarily, or move a public-surface leak that is
blocking reduction.

## Gaps That Are OK To Ship With

Acceptable for private beta:

- one clearly named compatibility shim with no runtime behavior;
- historical docs outside `docs/cannon/` as long as public READMEs and cannon
  point at the right source of truth;
- engine-native `streamWait` / `streamWaitAny` deferred if measured Firegrid
  overhead is small relative to provider/model latency;
- `session_new_all` deferred as optional ergonomics while repeated
  `session_new` remains sufficient;
- package-internal table access inside transport implementations, if public
  docs and exports expose only protocol/session/channel semantics.

Not acceptable for private beta:

- host-sdk owning live workflow engines, runtime control-plane dispatchers, or
  durable input delivery mechanics as public or semi-public composition surface;
- examples or methodology docs that teach `hostProjectionObserver`,
  `RuntimeControlPlaneTable`, workflow handles, stream URLs, or table CDC
  handles as normal user APIs;
- duplicate operation or observation catalogs across projection packages;
- runtime importing host-sdk;
- client SDK importing runtime;
- durable-tools or wait-router names reappearing as supported substrate.

## Cannon Completeness Note

The companion assessment flagged
`SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` as referenced but not copied
into cannon. The current `docs/cannon/README.md` explicitly marks that SDD as
historical and superseded by the landed state plus current convergence
assessment. That is the right resolution unless a coordinator wants the old
operational plan preserved as historical evidence under `docs/cannon/research/`.


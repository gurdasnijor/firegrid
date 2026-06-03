# tf-i2y3 — DEAD production-export removal: findings

Net-negative cruft removal from the tf-uc8u (#886) **DEAD** inventory — production exports with zero production AND zero test consumers. Full `pnpm preflight` green.

## Result

- **~1,228 net lines removed** from `packages/` (28 files: 18 insertions / 1,246 deletions).
- **37 dead export declarations deleted** + the transitive dead they kept alive (now-unused imports and private helper consts/functions, removed to a lint-clean fixpoint) + **3 files that became entirely empty/orphaned** (`sources/sandbox/process-stream.ts`, `sources/sandbox/runtime-command.ts`, `events/agent-input.ts`).
- The tf-uc8u gate's **DEAD count dropped 263 → 232** (re-run `pnpm gate:test-only-exports`).

## The headline finding: 263 "DEAD" was not 263 deletable orphans

The DEAD class is "zero cross-module + zero test consumers" — but that includes symbols **used intra-module by live code, merely over-exported**. Splitting on the gate's recorded `intraModuleUse`:

- **58 are true orphans** (`intraModuleUse: false`) — nothing references them at all. Deletable.
- **205 are over-exports of live internal code** (`intraModuleUse: true`, e.g. `WaitForToolMatchSchema` is a helper of the live `WaitForToolInputSchema`). **Deleting their declarations breaks the build** — the correct cleanup for these is *de-exporting* (dropping the `export` keyword), a different change, out of scope here.

So this PR deletes from the **58 true orphans**, not all 263. (Count is not the truth — the PO's "258 pure orphan cruft" was really ~58.)

## What was deleted (37 declarations, by package)

All in internal packages (`protocol`, `runtime`), grouped:
- `protocol/launch`: the 5 `makeRuntime*RequestRow` builders, `filterRuntimeRowsForContext`, `provideRuntimeContext`, `requireLocalContext` (+ their `launch/index.ts` barrel re-exports).
- `protocol/channels`: `humanChannelRegistrations`, `dmChannel`, `notificationChannel`.
- `protocol`: `rowOtelSpanLink`, `runtimePermissionRequestObservationFromRow`.
- `runtime/channels`: `HostPlaneChannelRouterLive`, `RuntimeContextChannelRouterLive`, `channelMetadata`, `eventChannelFromCollection`, `stateChangesChannelFromCollection`, `sessionLifecycleTerminalRoute`, `VerifiedWebhookFactChannelLive`, `VerifiedWebhookFactCallerOwnedFactStreamsLive`.
- `runtime/sources`: `commandForContext`, `streamSandboxProcess`, `FiregridLocalProcessFromEnv`, `FiregridEnvBindingsFromEnv`, `SandboxStdinEmissionClaimLive`, `stdinEmissionCommandId`, `makeRawRuntimeContextByteSession`, `prepareRawRuntimeContextInput`, `runCodecRuntimeContextStderrJournal`.
- `runtime`: `runtimeIngressError`, `runtimeSubscriberId`, `runtimeAuthoritySourceName`, `runtimeIdempotencyKey`, `layerProtocolDurableStreams`, `emitPeerEvent`, `agentInputEventFromRuntimeIngressRow`.

Each deletion was verified preflight-green; the cascade of now-unused imports/helpers was removed to a `no-unused-vars` fixpoint.

## Excluded as NOT actually dead (and why)

**Detector false-positives — the export IS used; the tf-uc8u scan missed the reference** (worth a follow-up to the gate):
| export | file | why it's actually live |
| --- | --- | --- |
| `acpPermissionPolicies` | `protocol/src/acp/index.ts` | used in `runtime/src/bin/acp.ts` & `bin/firegrid.ts` (`Options.choice`, `.includes`) |
| `runtimeContextMcpPath` | `protocol/src/mcp/index.ts` | used in `runtime/.../mcp-host.ts:323` |
| `evaluateFieldEquals` | `runtime/src/transforms/field-equals.ts` | referenced (a `tables/runtime-output.ts` consumer / comment) — kept conservatively |
| `insertLocalRuntimeContext` | `protocol/src/launch/host-context-authority.ts` | referenced in `launch/schema.ts` |
| `findRuntimeContextMcpChannel`, `RuntimeContextMcpChannelCatalogLive` | `runtime/src/channels/router/live.ts` | referenced in `channels/index.ts` |

**Likely public API / entry points (preflight can't catch external breakage — excluded by judgment):**
- `RuntimeObservationStreamsLive` — re-exported through the **main** `@firegrid/runtime` index (`runtime/src/index.ts`).
- `client-sdk` (`FiregridRuntimeTables`, `firegridRuntimeTableTags`, `FiregridStandaloneLive`), `host-sdk`, `effect-durable-streams`/`effect-durable-operators` (`define`, `sseStream`, `appendWithProducer`, `useDurableLiveSuspenseQuery`), `observability` — leaf SDK / library public surfaces.
- `runtime/src/bin/*` — binary entry points.
- `tiny-firegrid/src/experiment/*` — experiment harness (intentionally standalone).

These remain in the gate's DEAD report for the PO/owner to decide; **FLAG, not force-delete**.

## Verification
- `pnpm preflight` → **exit 0** (lint, lint:dead/knip, lint:dup, lint:deps, typecheck, test, diagnostics, trace:seams all green).
- `pnpm gate:test-only-exports` → DEAD 263 → 232.

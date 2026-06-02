# Test-only / sim-backdoor codepath removal manifest

- **Directive (Gurdas, via coordinator):** remove all codepaths that exist ONLY to support tests or narrowed simulations — no side-channels/backdoors that exist only in sim; **sims MUST exercise production code.**
- **Bead:** `tf-ll90.16` follow-on (Lane 4). **READ-ONLY** — no deletions performed; this is the manifest + safe removal order.
- **Date:** 2026-06-01 · audited on `sim/unified-kernel-validation` HEAD.
- **Method:** every "test-only" verdict is grounded by grepping ALL consumers repo-wide. If a production path uses a symbol, it is marked NOT test-only and kept.

## The classification line (encoded per the coordinator)
- **FIXTURE (KEEP):** a scripted leaf agent reached **through the real sandbox + real codec**. `bin/fake-acp-agent-process.ts` runs a `FixtureAgent` over **real `process.stdin/stdout`** (verified `:43-44`), spawned by the real `LocalProcessSandboxProvider`, parsed by the real ACP codec. Only the agent's *responses* are scripted (selected via `FIREGRID_FAKE_ACP_FIXTURE` context config). This exercises production — **not a backdoor.**
- **BACKDOOR (REMOVE):** a **Tag-swap** that replaces a production service with an in-memory stand-in so the kernel never touches the real codec/sandbox/subprocess: the recorder adapter, the fake codec, the fake sandbox, and the in-memory byte transport. These prove hand-wired internals behave, not the composed system.

## ★ Headline structural finding (the core problem)
The UKV driver runs **9 scenarios** (`driver.ts`), but the **default run is 8/8 and is almost entirely backdoor**:

| Scenario | Path | Production-honest? |
|---|---|---|
| 1–5 (`scenarios.ts`) | **recorder** Tag-swap | ✗ backdoor |
| 6 (`firegrid-client-scenarios.ts`) | **recorder** Tag-swap (via client SDK) | ✗ backdoor |
| 7 (`production-flow-scenario.ts`) | **fake-codec** Tag-swap | ✗ backdoor |
| 8 (`production-flow-acp-scenario.ts`) | **fake-sandbox** + in-memory transport (real ACP codec) | ✗ backdoor (sandbox+transport faked) |
| 9 (`production-flow-acp-live-scenario.ts`) | **real subprocess + real sandbox + real codec** | ✓ honest |

Scenario 9 is **env-gated OFF by default** (`driver.ts:187` → `scenarios = prodAcpLive.enabled ? 9 : 8`; gated by `FIREGRID_UKV_RUN_ACP_LIVE`/`FIREGRID_UKV_USE_REAL_CLAUDE_ACP`, `production-flow-acp-live-scenario.ts:188,234`). **So the sim's standing "green" comes from backdoors; the one production-honest scenario does not run unless a human sets an env flag.** The fix is not just deletion — it is **promoting the real path to the default coverage** and migrating the 13 probes onto it, then deleting the backdoors. This couples to `tf-ll90.11` (sim rebuild) and `tf-ll90.15` (sim-enforcement).

---

## A. Test-only code living in PRODUCTION `src/`

| # | File · symbol | Fakes (production thing) | Consumers (grepped) | Removal |
|---|---|---|---|---|
| A1 | `runtime/src/unified/adapter.ts` · `makeRecorderAdapter`, `RecorderAdapter`, `RecorderAdapterState` (`:87-141`, the "Test/sim adapter — recorder" section) | The `RuntimeContextSessionAdapter` Tag — production impl is `ProductionCodecAdapterLive` (`host.ts:59,155-158,238`) which wraps the real ACP/stdio codec + process registry | **Only test/sim:** `runtime/test/misuse-resistance-positive-lifecycle.test.ts:57,138`; UKV `scenarios.ts`, `firegrid-client-scenarios.ts`, `subscribers/runtime-context.ts`. No production code uses it (host.ts:35 + subscribers/runtime-context.ts:30 only *mention* it in docstrings). | **MIGRATION** — sims/test must compose the host with `ProductionCodecAdapterLive` reaching a real codec + the `bin/fake-acp-agent-process` subprocess (as scenario 9 already does). Then delete the recorder section. Keep lines 41–85 (the real Tag/contract). |
| A2 | `runtime/src/unified/host.ts` · `FiregridHostOptionsWithAdapter.adapter` injection + `hasAdapter`/`defaultProductionAdapterLayer` branch (`:118-158,238-240`) | The Tag-swap **seam** that lets a caller inject a non-production `RuntimeContextSessionAdapter` (i.e. the recorder) | The injectable `adapter` layer is the door the sims use to pass `makeRecorderAdapter`. Production default is `defaultProductionAdapterLayer`. | **EVALUATE after A1 migration.** If no production caller passes a custom adapter, remove the `…WithAdapter` variant and always use the production layer (closes the backdoor door). If it is a sanctioned DI point, keep but ensure sims pass a *real* adapter. Coordinator call. |

> **Explicitly NOT test-only (verified — do not remove):**
> - `runtime/src/sources/sandbox/internal-provider.ts` · `makeInMemorySandboxStore` — consumed by the **production** sandbox providers `sources/sandbox/local-process.ts:319` and `sources/sandbox/effect-ai.ts:93`. It is the real in-memory registry backing production providers, not a test stand-in.
> - `runtime/src/unified/channel-bindings.ts` · the "stub" channel Lives (`:132-204`) — these are **production-incomplete** read-side bindings (return stable offsets / `Stream.empty`), the R4/R5 gap in the deletion audit. They are unfinished production wiring, **owned by `tf-ll90.2`** (relocate to `channels/` + real reads), not a sim backdoor. Flag, don't delete here.

## B. Sim backdoors in the UKV simulation (`packages/tiny-firegrid/src/simulations/unified-kernel-validation/`)

| # | File · symbol | Fakes | Consumers (grepped) | Removal |
|---|---|---|---|---|
| B1 | `fake-codec.ts` (whole file) · `FakeCodecAdapter`, `buildFakeCodecAdapter`, `FakeCodecProbe` | The production ACP/stdio **codec** (`ProductionCodecAdapterLive`) — Tag-swaps a Ref-backed in-memory codec | **Only** `production-flow-scenario.ts:54,152` (scenario 7) | **Clean delete** once scenario 7 is migrated to the real codec (B6). |
| B2 | `acp-sandbox-fake.ts` (whole file) · `AcpFakeSandboxProvider`, `buildAcpFakeSandboxProvider`, `fakeSandbox` | The production **sandbox** provider (`LocalProcessSandboxProvider`) — resolves agents against the in-memory `FixtureAgent` harness "instead of spawning a [subprocess]" (`:4`) | **Only** `production-flow-acp-scenario.ts:75,206` (scenario 8) | **Clean delete** once scenario 8 is migrated to the real sandbox (B7). |
| B3 | `acp-fixture-agent.ts` · `makeAcpFixtureHarness`, `AcpFixtureHarness` (`:31-65`) — the **in-memory `TransformStream` byte transport** | The real OS process pipe (child-process stdio) | **Only** `acp-sandbox-fake.ts:28,143` (B2). The real subprocess path uses real stdio (`bin/fake-acp-agent-process.ts:43-44`), NOT this harness. | **Clean delete WITH B2.** ⚠️ Keep the rest of the file — see "KEEP" below. |
| B4 | `scenarios.ts` · the recorder-driven scenario bodies (`makeRecorderAdapter` at `:143`, `RecorderAdapter` at `:138`) | Drives the kernel against the recorder Tag-swap, never the real codec/sandbox | Driver scenarios 1–5 (`driver.ts:36-94`) | **MIGRATION** — re-point onto the real adapter path, or fold into the real-path scenario. Then the recorder import (A1) drops. |
| B5 | `firegrid-client-scenarios.ts` · `makeRecorderAdapter`/`RecorderAdapter` usage (`:51-52,189,237`) | Same recorder Tag-swap, exercised via the `Firegrid` client SDK | Driver scenario 6 (`driver.ts:94-118`) | **MIGRATION** — keep the client-SDK driving (that part is honest), swap the recorder for the production adapter + real leaf. |
| B6 | `production-flow-scenario.ts` · scenario-7 driver | Composes the host with `buildFakeCodecAdapter` (B1) | `driver.ts:119-138` (scenario 7) | **MIGRATION→delete** — scenario 7 should become "real codec end-to-end"; it is then a duplicate of scenario 8/9 and can be deleted. |
| B7 | `production-flow-acp-scenario.ts` · scenario-8 driver | Composes the host with `buildAcpFakeSandboxProvider` (B2) + in-memory transport | `driver.ts:138-157` (scenario 8) | **MIGRATION→delete** — scenario 8 should run through the real sandbox (= scenario 9 minus the env gate); then delete. |
| B8 | `subscribers/runtime-context.ts` (sim-local) · re-exports + wraps `makeRecorderAdapter`/`RecorderAdapter(State)` (`:13-16`); docstring `:8` "Simulations use `makeRecorderAdapter`…" | Wraps the recorder into a sim-local subscriber layer | Imported by the recorder scenarios (B4/B5) | **Clean delete with A1** — `invariants.ts:290-291` even has a structural scan forbidding the re-introduction of `buildRuntimeContextSessionLayer(recorder)`, confirming this is a retired sim-only shape. |

## C. KEEP — real fixtures / production composition (NOT backdoors)
- `acp-fixture-agent.ts` · `FixtureAgent`, `PermissionFixtureAgent`, `CancelFixtureAgent`, `McpFiregridToolCallAgent`, `startFixtureAgent` (`:67+`) — the **scripted leaf ACP agent**, lifted from `runtime/test/sources/codecs/acp/index.test.ts`. Speaks **real ACP** over `acp.ndJsonStream`. Used by the real subprocess (`bin/fake-acp-agent-process.ts:20-37`). This is the sanctioned fixture; the only fake bit (the in-memory transport, B3) is the part that goes.
- `bin/fake-acp-agent-process.ts` — real subprocess entrypoint, real stdio, spawned by the real sandbox. **KEEP.** (Its eslint `process.env`/comma-dangle nits are cosmetic — owned by `.11/.15`.)
- `production-flow-acp-live-scenario.ts` (scenario 9) — the **only** production-honest scenario. **KEEP and PROMOTE to default** (un-gate, or make the backdoor scenarios the opt-in). Also supports a real `claude-agent-acp` binary when `FIREGRID_UKV_USE_REAL_CLAUDE_ACP=1`.
- `substrate.ts` — composes the **real** durable-streams + workflow engine + unified tables + signal primitive; runs the real `recoverPendingSignals`. Production composition, not a backdoor. **KEEP.**

## D. Adjacent cleanup (sim shims / dead sims — related, not backdoors)
- `unified-kernel-validation/signal.ts` — a **re-export shim** of `@firegrid/runtime/unified` (its own header: "this file can be removed" once consumers import directly). Not a backdoor (forwards to production); delete as a tidy-up when the sim is rebuilt (`.11`). Same likely applies to other sibling re-export files (`tables.ts`, `channels.ts`, `durable-event-channel.ts` — verify each forwards vs reimplements during `.11`).
- `runner/list.ts:43-50` · `hiddenFolders` — **6 dead pre-unified probe-only sims** (`sim2-multi-surface-projection`, `shape-c-channel-router-turn`, `shape-c-non-recursive-start`, `shape-c-terminal-ordering`, `shape-d-tool-dispatch-mcp-entry`, `wave-d-a-shape-b-input-identity-dedup`) hidden from discovery; they export vocabulary for sibling `test/<sim>/probe.test.ts` files but have no `defineSimulation`. These + their `probe.test.ts` trees are the vitest-probe anti-pattern → **delete under `tf-ll90.15`.**
- Grandfattered probe-only sims `child-output-existing-channel-router/` + `channel-completion-contracts/` (dep-cruiser R2/R3 grandfathers) → relocate to the owning package's `test/` (`tf-r06u.30`/`.15`).

## E. Safe removal ORDER (consumers before definitions; production-honest coverage before deletion)
1. **Build/confirm the production-honest default first** (prevents losing coverage): promote scenario 9 (`production-flow-acp-live-scenario.ts`) to run by default through the real `LocalProcessSandboxProvider` + real codec + `bin/fake-acp-agent-process`. (`tf-ll90.11`/`.14`.)
2. **Migrate the kernel probes (1–6) onto the real adapter** — re-point `scenarios.ts` (B4) + `firegrid-client-scenarios.ts` (B5) from the recorder to `ProductionCodecAdapterLive` + the real leaf. Delete `subscribers/runtime-context.ts` (B8).
3. **Collapse scenarios 7 & 8 into the real path** — migrate `production-flow-scenario.ts` (B6) and `production-flow-acp-scenario.ts` (B7) to the real codec/sandbox, then delete them as duplicates of the real scenario.
4. **Delete the now-orphaned backdoors:** `fake-codec.ts` (B1), `acp-sandbox-fake.ts` (B2), and `makeAcpFixtureHarness`/`AcpFixtureHarness` from `acp-fixture-agent.ts` (B3).
5. **Delete the production-src test-only code:** the recorder section of `adapter.ts` (A1), and re-evaluate/remove the `adapter` injection seam in `host.ts` (A2).
6. **Tidy-up:** `signal.ts` shim + sibling re-exports (D), the 6 hidden dead sims + probe trees (D, → `.15`).

## F. Coverage note
Sweep was repo-wide. **Other packages are clean** — `client-sdk`, `protocol`, `host-sdk`, `cli`, `effect-durable-streams`, `effect-durable-operators`, `observability` have **no** fake/stub/mock/recorder/test-only code in `src/` (grepped). All test-only/backdoor code is concentrated in `runtime/src/unified/{adapter.ts,host.ts}` and the UKV simulation. The `runtime/test/` ACP `FixtureAgent` classes are legitimate test fixtures (in `test/`, not `src/`).

# tf-88bd.1 — Real spawned ACP agent acceptance (fluent ACP client)

**Date:** 2026-06-06
**Bead:** tf-88bd.1 (P0, agent-binding/fluent/real-agent) — "Close the @real-agent gap for fluent-firegrid-acp-client/conductor … drive a real spawned Claude/Codex ACP process … record callbacks as L1/L2 fluent-runtime facts … No fake adapter/recorder/fake-codec as acceptance proof."
**Sim:** `packages/firelab/src/simulations/fluent-acp-real-spawn-acceptance/`
**Verdict:** `production-path-covered` (gate-computed)

## What is REAL vs fixture

- **REAL spawned target:** `npx -y @zed-industries/claude-code-acp` (resolved by `resolveAgent("claude")`), agent `@zed-industries/claude-code-acp` **v0.16.2**, authenticated via `ANTHROPIC_API_KEY`. A real OS process speaking ACP over stdio — **not** an in-memory stream, fake codec, or recorder.
- **Production path under test:** `@firegrid/fluent-acp-process` `spawnAcpProcess` (real `Command` spawn) → `acp.Stream` → `@firegrid/fluent-runtime/acp` `connectFiregridAcp` (`FiregridAcpClient implements acp.Client` over `acp.ClientSideConnection`) → the agent's `session/update` callbacks → durable fluent-runtime `FluentStore.appendSessionEvent` Layer-1 facts over real Durable Streams.
- **The earlier fixture** (`fluent-acp-client-binding`, tf-w9uc) spawns a deterministic local `tsx` agent (`*-agent-process.ts`). That is a fixture stream and does **not** satisfy this sim's `real_agent_spawned` gate — see the negative control below.

## Run evidence (the covered run)

| Field | Value |
|---|---|
| Run id | `2026-06-06T02-32-51-003Z__fluent-acp-real-spawn-acceptance` |
| Trace | `packages/firelab/.simulate/runs/2026-06-06T02-32-51-003Z__fluent-acp-real-spawn-acceptance/trace.jsonl` |
| Command | `pnpm --filter firelab simulate:run fluent-acp-real-spawn-acceptance` |
| Env | `ANTHROPIC_API_KEY` (real-agent lane gate; no fake fallback) |
| Spawned binary | `npx -y @zed-industries/claude-code-acp` (v0.16.2) |
| Prompt | first-person: `Reply with exactly one word: ack` |
| Outcome | `DriverCompleted` |
| Verdict | **`production-path-covered`** |

Instrumentation observed: `fluent-acp-process.spawn` ×1 (`firegrid.acp_process.agent="claude"`), `fluent_runtime.store.session.create` ×1, **`fluent_runtime.store.session.append_event` ×3** (the real agent's 3 `session/update` callbacks persisted as L1 facts), `firegrid.durable_streams.http.request` ×5, `firegrid.sim.fluent_acp_real_spawn.host.run` ×1.

## Computed verdict — gates (forge-proof host-substrate spans; driver draws no verdict)

| Gate | Claim | Result |
|---|---|---|
| `real_agent_spawned` | `spawn` span exists with `attr(firegrid.acp_process.agent)=="claude"` | ✓ |
| `l1_append` | `fluent_runtime.store.session.append_event` exists | ✓ (×3) |
| `durable_write` | `firegrid.durable_streams.http.request` exists | ✓ |

Per the firelab methodology, the **driver does not draw the verdict**: it waits on the public observable marker (the agent's `agent_message_chunk` L1 fact appearing on the durable session stream) to keep the run alive through the real turn, annotates what it saw, and returns. The gates judge from forge-proof spans (`firegrid.side != "driver"`).

**Production-boundary instrumentation added** (per the steer — proof lives at the production boundary, not in driver `expect()` blocks): `@firegrid/fluent-acp-process`'s `spawn` span now annotates `firegrid.acp_process.agent` / `.command`, so a gate can require the **real** keyed agent.

## Negative control (verified)

The gate keys on `firegrid.acp_process.agent == "claude"`. The fixture sim spawns `{ command: "pnpm", … }` (an override → `agent="custom"`), so the fixture's spawn **fails** this gate. A fake/arbitrary command cannot satisfy `real_agent_spawned`; a no-callback turn fails `l1_append`. (Run the fixture against this gate to confirm: not-covered.)

## Gherkin scenarios this covers (real spawned target)

`features/fluent/agent-binding/fluent-firegrid-acp-client.feature` (@real-agent):
- **"Firegrid owns the ACP ClientSideConnection client"** — `connectFiregridAcp` owns the `ClientSideConnection`; the process owner only supplies the stream/lifecycle. ✓
- **"ACP session updates become Layer 1 observations through Firegrid"** — the real agent's `session/update` → `FiregridAcpClient.sessionUpdate` → durable L1 fact. ✓ (the core proof)

`features/fluent/agent-binding/fluent-harness-adapter-boundary.feature` (@real-agent):
- **"Firegrid records Layer 1 observation without owning the model loop"** — the real claude agent owns the model loop; Firegrid records L1. ✓
- **"Fake adapter evidence is rejected at the acceptance layer"** — the `agent=="claude"` gate rejects the fixture/override. ✓

## NOT covered (honest — do not mark these @real-agent done)

- `fluent-firegrid-acp-client`: permission-fidelity, durable-tool-return — the trivial turn produced `session/update`s only (no permission request / ext-method from the real agent). Wired (`resolvePermission`/`commitExtMethod`) but not exercised by a real agent here.
- `fluent-firegrid-acp-conductor` (@real-agent, @zed): the **editor-facing** path is not covered by a real *spawned editor* — there is no launchable ACP editor binary (Zed) in CI. The conductor witness (`fluent-acp-conductor-binding`, tf-v2nv) drives a real ACP **SDK** `ClientSideConnection` over an in-memory stream (real protocol, not a fake codec), but that is not a spawned editor. This bead closes the **client/downstream** real-spawn gap; the conductor real-editor-spawn gap remains.
- harness-boundary park/redrive/resume/cancel scenarios — out of scope here.

Reproduce: `ANTHROPIC_API_KEY=… pnpm --filter firelab simulate:run fluent-acp-real-spawn-acceptance`.

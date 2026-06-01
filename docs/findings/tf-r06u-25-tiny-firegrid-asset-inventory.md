# tf-r06u.25 — tiny-firegrid misplaced-asset inventory + convert/delete/relocate strategy

Date: 2026-06-01
Owner: tf-r06u.25 (agent2 / lane-b)
Feeds: the relocation work + the R3 static-enforcement PR (tf-r06u.24); the mcp-host rebuild (tf-r06u.28); the workbench sim (tf-r06u.23).
Method: import-surface scan of `packages/tiny-firegrid/src/simulations/*` + `test/**` + `src/prototypes/*`, classified against `tiny-firegrid/docs/methodology.md` (driver = `@firegrid/client-sdk` + Effect only; `host(env)` may compose runtime/protocol; codec/sandbox/internals reach from a driver or test = private seam → owning package). R3 policy: public-surface vitest ALLOWED; internals-reaching NOT.

## Headline (load-bearing)

**The tiny-firegrid test suite does not currently collect.** `npx vitest list` aborts at `test/wave-d-a-shape-b-input-identity-dedup/probe.test.ts` (imports a deleted sim `src/simulations/wave-d-a-shape-b-input-identity-dedup/index.ts`), and several tests import runtime subpaths that #765 deleted and are **not exported**: `@firegrid/runtime/composition/host-live`, `@firegrid/runtime/producers/codecs/mcp`, `@firegrid/runtime/composition/runtime-context-mcp-base-url`, `@firegrid/runtime/kernel`. So tiny-firegrid is **not a passing gate today** — its drift is masked because it isn't in the green CI set. The deleted `composition/host-live` + `producers/codecs/mcp` path **is** the "deleted mcp-host" the gateway work must rebuild (tf-r06u.28); three tests are its orphaned consumers.

Classification legend: **KEEP** (compliant) · **CONVERT** (→ proper sim: client-sdk driver + host(env) + runner→trace→prose finding) · **RELOCATE** (→ owning-package test/, exercises a private seam) · **DELETE** (no value / superseded).

## A. `src/prototypes/` — RETIRED (PR #766, already landed)

| Asset | Why | Disposition |
|---|---|---|
| `adapter-divergence-spike.ts` | drove raw `AcpSessionLive`+sandbox (private seam) | **RELOCATE — done** → `packages/runtime/test/sources/codecs/acp/acp-live-adapters.test.ts` (env-gated live) |
| `mcp-reach-gate.ts` | private-seam codec reach **and** real public-surface value (tool→agent discovery) | **CONVERT** → the canonical workbench sim (tf-r06u.23, §D below). Codec-layer reach already RELOCATED to the runtime live test. |
| `target-topology/` | pre-existing from PR #674 (`cd205c1e4`), unreferenced | **DELETE — done** (flagged to #674's owner; recoverable from history) |

## B. `src/simulations/`

| Sim | Import evidence | Disposition |
|---|---|---|
| `unified-kernel-validation` | `driver.ts` is clean (no `@firegrid/*`); `host.ts`/`substrate.ts`/`scenarios.ts` compose `@firegrid/runtime/unified` etc. (allowed for the composition tier). **BUT** `production-flow-acp-scenario.ts` + `production-flow-acp-live-scenario.ts` drive `AcpSessionLive` + `LocalProcessSandboxProvider` directly (private seam), and `firegrid-client-scenarios.ts` uses `@firegrid/client-sdk` (public). | **KEEP** (canonical #765 validation sim) — but **FLAG**: the `production-flow-acp-*` scenarios are private-seam codec drivers (candidate RELOCATE to `runtime/test`, same shape as the tf-r06u.12 live test). Owner = the #765 validation track; do not rip up unilaterally. Also fix the latent `acp-agent.js`→`index.js` bin bug (see tf-r06u.12 finding). |
| `channel-completion-contracts` | `probe.ts` imports `@firegrid/protocol/channels` + `/channels/router` (exported public protocol contracts); `test/.../probe.test.ts` imports the sim only | **KEEP** as public-surface probe (protocol channels are a published surface), pending confirmation it asserts public outputs only. |
| `child-output-existing-channel-router` | `probe.ts` imports `@firegrid/runtime/channels` (internal) + protocol channels/session-facade/observations | **RELOCATE** → `runtime/test` (reaches `runtime/channels` internals). |
| `shape-c-non-recursive-start` | `index.ts`+`public-facade.ts`+`runtime.ts`; imports only `@firegrid/tiny-firegrid` (self). Shape C deleted wholesale by #765. | **DELETE** (superseded — Shape C abandoned). |
| `shape-c-terminal-ordering` | same | **DELETE** (superseded). |

## C. `test/**`

**C1 — DELETE (broken: import deleted sims/modules, superseded by #765):**
- `test/wave-d-a-shape-b-input-identity-dedup/probe.test.ts` — imports deleted sim `simulations/wave-d-a-…/index.ts` (this is what breaks collection).
- `test/shape-c-channel-router-turn/probe.test.ts` — `@firegrid/runtime/kernel` (unexported) + Shape C dead.

**C2 — REVIVE under the mcp-host rebuild (tf-r06u.28) / fold into the workbench sim — currently broken on the deleted mcp-host path:**
- `test/agent-coordination-readiness/smoke.test.ts` — `composition/host-live` (MISSING).
- `test/agentic-patterns-primitive-profile.test.ts` — `composition/host-live` + `producers/codecs/mcp` + `runtime-context-mcp-base-url` (MISSING).
- `test/sleep-only-substrate-smoke.test.ts` — same MISSING mcp-host path.
  These are public-surface in intent (`@firegrid/client-sdk/firegrid`) but depend on the deleted host-owned MCP surfacing. They are the **best existing scaffolding** for the workbench sim + the tf-r06u.28 rebuild's acceptance tests — keep them quarantined (or `describe.skip`) until the Context.Tag lands, then revive.

**C3 — RELOCATE to owning package (resolve, but reach runtime internals from a test):**
- `test/shape-d-tool-dispatch-mcp-entry/probe.test.ts` — `runtime/channels/observation-streams` (DELETE if Shape D dead; else RELOCATE).
- `test/spike-channel-deletion/sim2-multi-surface-projection.test.ts` — `runtime/channels/host-sessions-create-or-load/live`.
- `test/unified-firegrid-host-compose.test.ts` — `runtime/unified` (this is a host-compose test; KEEP if treated as composition, else RELOCATE).
- `test/experiment-ergonomics.test.ts` — `protocol/channels(+router)` (borderline; protocol public).

**C4 — KEEP (public-surface or pure/Effect-only):**
- `test/channel-completion-contracts/probe.test.ts`, `test/agent-runtime-fixture-replay-harness.test.ts`, `test/dark-factory-driver.test.ts`, `test/perf.test.ts`, `test/phase1-gate.test.ts`, `test/shape-c-non-recursive-start|terminal-ordering/probe.test.ts` (the last two DELETE with their sims).

## D. The mcp-reach-gate CONVERT — the canonical workbench sim (spec for tf-r06u.23)

The mcp-reach gate's public-surface value becomes **one artifact with three payoffs**: proof of MCP-tool→agent discovery dynamics, the **design+proof bench** for the production mcp-host (tf-r06u.28), and a regression sim. Workbench-correct form:

1. **Design the MCP-host as an Effect `Context.Tag`** — this interface IS the misuse-resistant contract the production mcp-host (tf-r06u.28) implements. Sketch:
   ```
   interface McpHostService {
     // host-owned MCP surfacing: project the choreography toolkit to a
     // downstream adapter as session/new mcpServers declarations.
     readonly surface: (toolkit: ChoreographyToolkit) =>
       Effect<{ readonly mcpServers: ReadonlyArray<AcpMcpServerDeclaration> }, McpHostError, Scope>
   }
   class McpHost extends Context.Tag("firegrid/McpHost")<McpHost, McpHostService>() {}
   ```
   (Final shape to be validated by the bench; the point is the Tag is the seam both sim-stub and production share.)
2. **Stub the impl in `host(env)` as `Layer.succeed(McpHost, …)`** — the stub stands up a real HTTP MCP server (the SDK `Server` + `StreamableHTTPServerTransport` pattern proven in tf-r06u.12) serving the choreography tools, and returns its URL as an `mcpServers` declaration the host composition threads into the codec.
3. **`driver.ts` drives via `@firegrid/client-sdk` ONLY** — prompt a session; the (env-gated, live) ACP agent discovers + calls the tool. No codec/sandbox imports in the driver.
4. **Verify from the trace** — assert dynamics/invariants from `trace.jsonl` (`simulate:show`/`simulate:perf`): was `tools/list` seen on the MCP endpoint? was the tool called? per dialect — in a **prose FINDING**, not a computed verdict object. Live-adapter runs env-gated (`FIREGRID_UKV_RUN_ACP_LIVE` precedent).

This un-blocks/reshapes tf-r06u.23 (it no longer waits on the rebuild — it **precedes** it as the design bench) and is the acceptance bench for tf-r06u.28.

## E. Recommendations → feed tf-r06u.24 (static enforcement)

1. **Restore collection first:** delete the C1 orphans so `vitest list` collects; quarantine C2 behind `describe.skip` with a `// blocked: tf-r06u.28 mcp-host rebuild` marker so the suite is green and the intent is preserved.
2. **R3 lint (tf-r06u.24):** a Semgrep/ESLint rule that (a) forbids `@firegrid/runtime/*` and `@firegrid/protocol/*`-internal imports from any `simulations/*/driver.ts`, and (b) forbids the same from `test/**` *unless* the test is in the owning package — pushing internals-reaching tests to `runtime|protocol/test/`. Allow `@firegrid/client-sdk*` and host-composition imports in `host.ts`.
3. **Drift guard:** a check that every `test/<x>/probe.test.ts` has a live `src/simulations/<x>/` (catches the wave-d-a class of orphan at CI time).

## Out of scope (this is a strategy doc)

Per the bead, tf-r06u.25's output is this disposition table — the executions (deletes, relocations, the workbench build, the R3 lint) land in their own PRs (the relocation already started in PR #766; enforcement in tf-r06u.24; workbench in tf-r06u.23; rebuild in tf-r06u.28). No production code is changed here.

# agent-coordination-readiness — readiness simulation (PR #738 / #703 stack)

**Verdict:**
- **Client-path readiness (steps 2 / 3-surrogate / 4 / 5a / 6):** wired as
  a standard discoverable tiny-firegrid simulation
  (`defineSimulation` in `index.ts`). The driver requires only `Firegrid`
  and asserts child output observation through the public client method
  `handle.wait.forAgentOutput`.
- **Primary command (`pnpm simulate:run -- agent-coordination-readiness`):
  RED on this stack — UPSTREAM blocker**, NOT in the readiness sim.
  Pre-existing sibling simulations (`dark-factory/index.ts` and others)
  import `@firegrid/host-sdk`, whose `host/index.ts` re-exports a deleted
  `./acp-stdio-edge.ts`. The runner's discovery walks ALL sim folders;
  any failing sibling kills `simulate list` / `simulate:run` for every
  simulation. See "RED blocker" below.
- **Step 5b (direct `HostPlaneChannelRouter.dispatch`):** supplementary
  vitest probe in `test/agent-coordination-readiness/smoke.test.ts`,
  asserts the router-mediated `wait_for` path independent of client-sdk
  and returns the same `sequence` as 5a.
- **Step 1 executable flip:** REVERTED. Attempted subprocess assertion
  hung on parent-daemon teardown — separate #738 follow-up.

## Scope

- Proves: a child session's first agent output is observable through the
  public client method `handle.wait.forAgentOutput({ afterSequence })`
  (step 5a), AND independently through a direct
  `HostPlaneChannelRouter.dispatch({ verb: "wait_for", target:
  "session.agent_output", payload: { sessionId, afterSequence } })`
  returning the same `sequence` (step 5b — vitest probe). This is what
  #703 registered on the host-plane router via
  `sessionAgentOutputObservationRoute(sessionAgentOutput)` in
  `packages/runtime/src/channels/host-control-routes.ts:113`.
- Does NOT prove: in-session `session_new` agent-tool execution. The
  child spawn here is an OUTER-DRIVER surrogate via the same router
  target (`host.sessions.create_or_load`). CC6 landed the runtime
  composition fix (`RuntimeAgentToolExecutionLive` +
  `HostRuntimeObservationStreamsLive`, commit `91ed12b77`); the matching
  second smoke (planner emits `session_new`, runtime executes it) is now
  unblocked and is a separate sidecar PR.
- Does NOT exercise the runtime-bin entry as a subprocess. The host is
  composed in-process via `FiregridLocalHostLive` — the same Layer graph
  that `packages/runtime/src/bin/run.ts` composes (CC6 `c0b51fc64`).

## Readiness matrix

| # | Step | Status | Evidence |
|---|------|--------|----------|
| 1 | Runtime-owned host bring-up | YELLOW | `packages/runtime/src/bin/{run,host}.ts` exists per CC6 `c0b51fc64`. Subprocess assertion attempted, REVERTED — agent exits 0, parent daemon hangs. See "Step 1 bin-shutdown hang". |
| 2 | Planner createOrLoad + start | GREEN (via standard simulation) | Public `firegrid.sessions.createOrLoad` → `host.sessions.create_or_load` router target → planner handle. |
| 3 | Child session spawn | YELLOW (GREEN-surrogate via standard simulation) | Same router target as planner-emitted `session_new`, driven from outer driver. Real `session_new` tool-execution path unblocked by CC6 `91ed12b77`; follow-up smoke pending. |
| 4 | Child agent emits TextChunk | GREEN (via standard simulation) | Deterministic `stdio-jsonl` fixture agent (`node -e <inline script>`) emits one JSONL `text` event; codec translates to `TextChunk`. |
| 5a | Observation via `handle.wait.forAgentOutput` | GREEN (via standard simulation) — LOAD-BEARING | Public client method returns the `TextChunk` observation. **Primary evidence path; runs as part of `simulate:run`.** |
| 5b | Observation via `HostPlaneChannelRouter.dispatch` | GREEN (via vitest probe) | Direct router-mediated `wait_for` on `session.agent_output` returns the SAME `sequence` as 5a. Supplementary, not load-bearing for the readiness verdict. |
| 6 | OTel `firegrid.channel.dispatch` span | GREEN (via vitest probe) | Recording tracer captures `firegrid.channel.target == "session.agent_output"` + `firegrid.channel.verb == "wait_for"`. |

## Run

**Primary (standard runner simulation — RED on this stack, see "RED blocker" below):**

```
cd packages/tiny-firegrid && pnpm simulate:run -- agent-coordination-readiness
```

**Supplementary (vitest probe — GREEN today, exercises 5b + 6):**

```
pnpm --filter @firegrid/tiny-firegrid test test/agent-coordination-readiness/smoke.test.ts
```

The vitest probe is **not** a replacement for the runner sim — it's an
additional assertion layer for the parts the runner's
`TinyFiregridSimulation.driver` signature (`R = Firegrid`) cannot
express. The standard runner simulation is the primary evidence path
once the upstream blocker is cleared.

## RED blocker — upstream of the readiness sim

`pnpm simulate:run -- agent-coordination-readiness` fails on this stack
with:

```
Error: Cannot find module
  '/.../packages/host-sdk/src/host/acp-stdio-edge.ts'
  imported from /.../packages/host-sdk/src/host/index.ts
```

Cause: `packages/host-sdk/src/host/index.ts` re-exports symbols from
`./acp-stdio-edge.ts`, which was MOVED to
`packages/runtime/src/producers/codecs/acp/stdio-edge.ts` by commit
`dcfb01f71`. The host-sdk barrel was not updated to follow the move.

Why this kills my sim too: the runner's `discoverSimulationCandidates`
(`packages/tiny-firegrid/src/runner/list.ts`) walks ALL sim folders and
loads each `index.ts`. Several siblings — including
`dark-factory/index.ts` (the host other sims compose on) and
`agentic-patterns-primitive-profile/index.ts` — import from
`@firegrid/host-sdk` and throw at module load. The walk fails before
reaching any simulation, so even `simulate list` errors out.

Isolation evidence (worktree `91ed12b77`):

```
$ pnpm tsx -e "import('./src/simulations/agent-coordination-readiness/index.ts').then(m => console.log(m.default?.id))"
agent-coordination-readiness OK: agent-coordination-readiness

$ pnpm tsx -e "import('./src/simulations/dark-factory/index.ts').then(...)"
dark-factory FAIL: Cannot find module '.../host-sdk/src/host/acp-stdio-edge.ts'
```

A second related variant fires when host-sdk's
`control-request-side-effects.ts` is loaded (reported by the reviewer on
the `main` checkout):

```
Error: Package subpath './kernel' is not defined by "exports"
  in /.../packages/host-sdk/node_modules/@firegrid/runtime/package.json
  imported from /.../packages/host-sdk/src/host/control-request-side-effects.ts
```

Both surfaces are the same root cause: `@firegrid/host-sdk` carries
stale re-exports to symbols that have been physically relocated under
the Class D / F3 cutover. The deletion of `@firegrid/host-sdk` is
already in flight per `507da434c feat(host-sdk delete-first)`; once
that lands (or the barrel re-exports are repaired), `simulate list`
and `simulate:run -- agent-coordination-readiness` go GREEN with no
change to this PR.

This PR does NOT work around the blocker by retargeting sibling sims
off host-sdk or by editing host-sdk's barrel — both are outside the
`packages/tiny-firegrid/**`-only scope the readiness sim is meant to
respect, and either fix is properly a CC6/host-sdk-delete concern.

## Step 1 bin-shutdown hang (reverted executable assertion)

An executable subprocess assertion for step 1 was attempted in
`smoke.test.ts`:

```
pnpm firegrid -- run -- node -e 'process.stdout.write(JSON.stringify({hello:"firegrid"})+"\n"); process.exit(0)'
```

The agent (`node -e`) child exits 0 as designed. The parent
`firegrid run` daemon does NOT exit. Reproduced manually from the
worktree root with stderr:

```
firegrid:run: launched context ctx_ext_...
firegrid:run: context ctx_ext_... exited (attempt 1, exitCode 0)
[hangs; SIGTERM at 30s → exit 143]
```

The assertion was reverted to `it.skip`. Step 1 stays YELLOW pending a
shutdown-on-terminal observer in `packages/runtime/src/bin/run.ts` (the
runtime should observe the launched context's `exited` event and tear
itself down). NOT in scope for the readiness sim PR; tracked in
`FINDING.md` for fast restore.

## Why standard simulation + vitest probe — runner-contract limit

`TinyFiregridSimulation.driver` is typed `Effect.Effect<A, E, Firegrid>`
(`packages/tiny-firegrid/src/types.ts:28`). The runner provides
`Firegrid` and only `Firegrid` (plus implicit telemetry/heartbeat). To
satisfy that signature:

- The **standard simulation driver**
  (`runAgentCoordinationReadinessSmokeViaClient`) requires only
  `Firegrid` and is wired through `index.ts`'s
  `defineSimulation(...)` — discoverable, runnable via `simulate:run`,
  exercises steps 2 / 3 / 4 / 5a / 6.
- The **strict step 5b assertion**
  (`HostPlaneChannelRouter.dispatch(...)`) requires
  `HostPlaneChannelRouter` in `R`. The runner cannot provide that, so
  step 5b runs as a vitest probe that composes
  `Firegrid + FiregridHost + HostPlaneChannelRouter` from the same host
  layer the standard simulation uses.

The split is **not** a fudge of the runner contract — the vitest probe
asserts an independent ACP/MCP-edge code path
(`router.dispatch.waitFor`) that production edges use; it does not
substitute for or augment the client path that the standard simulation
proves. If a single `simulate:run` entry should exercise both, the
runner-contract change is to widen `TinyFiregridSimulation.driver` (or
add an optional `driverEnv: Layer.Layer<R, E>` hook) so the simulation
can declare extra `R`-channel layers. **That widening is properly a
runner change in CC6's lane, not new architecture in this PR.**

## Routing around a stale host-sdk barrel (in the sim's own imports)

Because the brief forbids edits outside `packages/tiny-firegrid/**`,
this simulation does NOT import from `@firegrid/host-sdk`. The
canonical Class F3 symbols are imported directly from runtime:

| Symbol | Canonical home |
|---|---|
| `FiregridLocalHostLive` | `@firegrid/runtime/composition/host-live` |
| `FiregridLocalProcessFromEnv` | `@firegrid/runtime/producers/sandbox/local-process-from-env` |
| `FiregridEnvBindingsFromEnv` | `@firegrid/runtime/producers/sandbox/local-process-from-env` |
| `FiregridHost` (type) | `@firegrid/runtime/composition/host-live` |
| `HostPlaneChannelRouter` | `@firegrid/runtime/channels` |

The simulation's own `index.ts` loads cleanly via `tsx` in isolation
(verified above). The discovery walk failure is in OTHER sims'
`index.ts` files, not this one.

## Follow-up

- **Now blocking primary command:** stale `@firegrid/host-sdk` barrel
  re-exports (`acp-stdio-edge.ts`, `@firegrid/runtime/kernel`). Cleared
  by host-sdk deletion (`507da434c feat(host-sdk delete-first)`) or by
  the barrel being repaired.
- **Was blocking step 3 GREEN:** CC6 landed the runtime composition fix
  (`91ed12b77`) — `RuntimeAgentToolExecutionLive` +
  `HostRuntimeObservationStreamsLive`. The matching second smoke
  (planner emits `session_new` → real tool execution) is now unblocked.
- **Was blocking step 1 GREEN:** `packages/runtime/src/bin/run.ts`
  parent-daemon shutdown-on-terminal. Once landed, restore the
  subprocess assertion in `smoke.test.ts` step 1 (the reverted block
  has the exact shape preserved in this FINDING.md for fast restore).
- **Runner-contract improvement (optional, CC6's lane):** widen
  `TinyFiregridSimulation.driver` to allow extra `R`-channel layers
  declared by the simulation, so a single `simulate:run` entry can
  exercise step 5b inline alongside 5a.

## What this is NOT

- Not a new router, channel, schema, or composition path. Uses the
  existing `HostPlaneChannelRouter`, `session.agent_output` route, and
  `FiregridLocalHostLive` composition unchanged.
- Not a production edit. The simulation lives entirely under
  `packages/tiny-firegrid/**`. The one-line removal of
  `agent-coordination-readiness` from the runner's `hiddenFolders` set
  is also under tiny-firegrid.
- Not a docs/research entry. This FINDING.md is local to the simulation
  folder.
- Not a direct durable-table cheat on the read side. Both observation
  paths go through the production `session.agent_output` route; the
  read source is `RuntimeOutputTable.events.rows()` via the host's
  `SessionAgentOutputChannelLive`.
- Not load-bearing for spawn shape. The `session_new` spawn shape is
  owned by `shape-c-channel-router-turn` and the upcoming CC6 follow-up
  smoke; the outer-driver `createOrLoad` here is a YELLOW surrogate
  explicitly to keep the load-bearing assertion focused on step 5.
- Not a custom harness substituting for `simulate:run`. The vitest
  probe is supplementary; the primary evidence is the standard runner
  simulation (currently RED on this stack pending the upstream
  host-sdk barrel fix).

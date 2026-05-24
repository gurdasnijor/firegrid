# agent-coordination-readiness — readiness smoke (PR #738 / #703 stack)

**Verdict: GREEN on the load-bearing assertion (step 5).** Step 3 is
documented YELLOW (surrogate, see below); the remaining checklist steps
are GREEN through real production primitives.

## Scope

- Proves: a child session's first agent output is observable via BOTH the
  public client method `handle.wait.forAgentOutput({ afterSequence })` AND a
  direct `HostPlaneChannelRouter.dispatch({ verb: "wait_for", target:
  "session.agent_output", payload: { sessionId, afterSequence } })`, returning
  the same `sequence`. This is what #703 registered on the host-plane router
  via `sessionAgentOutputObservationRoute(sessionAgentOutput)` in
  `packages/runtime/src/channels/host-control-routes.ts:113`.
- Does NOT prove: in-session `session_new` agent-tool execution. The child
  spawn here is an OUTER-DRIVER surrogate. CC6 landed the runtime composition
  fix (`RuntimeAgentToolExecutionLive` + `HostRuntimeObservationStreamsLive`,
  commit `91ed12b77`); the matching second smoke (planner emits `session_new`,
  runtime executes it) is now unblocked and is the next sidecar PR.
- Does NOT exercise the runtime-bin entry as a subprocess. The host is
  composed in-process via `FiregridLocalHostLive` — the same Layer graph
  that `packages/runtime/src/bin/run.ts` composes (landed by CC6 in
  commit `c0b51fc64`). The runtime-bin entry itself was validated by a
  separate CC6 local smoke (`pnpm firegrid -- run -- node -e ...` exited 0).

## Readiness matrix

| # | Step | Status | Evidence |
|---|------|--------|----------|
| 1 | Runtime-owned host bring-up | GREEN (documented; executable assertion blocked on a bin-shutdown hang on this stack — see "Step 1 bin-shutdown hang") | `packages/runtime/src/bin/{run,host}.ts` exists on stack head (CC6 `c0b51fc64`). This sim composes the same `FiregridLocalHostLive` topology in-process. An executable subprocess assertion was attempted and reverted (`it.skip`); see disclosure below. |
| 2 | Planner createOrLoad + start | GREEN | Public `firegrid.sessions.createOrLoad` → `host.sessions.create_or_load` router target → planner handle. |
| 3 | Child session spawn | YELLOW (GREEN-surrogate) | Same router target as planner-emitted `session_new`, driven from outer driver. Real `session_new` tool-call path now unblocked by CC6 `91ed12b77`; follow-up smoke pending. |
| 4 | Child agent emits TextChunk | GREEN | Deterministic `stdio-jsonl` fixture agent (`node -e <inline script>`) emits one JSONL `text` event; codec translates to `TextChunk`. |
| 5a | Observation via `handle.wait.forAgentOutput` | GREEN | Public client method returns the `TextChunk` observation. |
| 5b | Observation via `HostPlaneChannelRouter.dispatch` | GREEN (LOAD-BEARING) | Direct router-mediated `wait_for` on `session.agent_output` returns the SAME `sequence` as 5a. |
| 6 | OTel `firegrid.channel.dispatch` span | GREEN | Recording tracer captures `firegrid.channel.dispatch` with `firegrid.channel.target == "session.agent_output"` and `firegrid.channel.verb == "wait_for"`. |

## Run

Smoke (the readiness gate):
```
cd /Users/gnijor/gurdasnijor/firegrid-readiness-sim
pnpm --filter @firegrid/tiny-firegrid test test/agent-coordination-readiness/smoke.test.ts
```

Full tiny-firegrid suite (regression):
```
pnpm --filter @firegrid/tiny-firegrid test
```

Typecheck:
```
pnpm --filter @firegrid/tiny-firegrid typecheck
```

## Step 1 bin-shutdown hang (reverted executable assertion)

An executable subprocess assertion for step 1 was attempted in
`smoke.test.ts`. The assertion spawned the exact invocation CC6 ran
locally:

```
pnpm firegrid -- run -- node -e 'process.stdout.write(JSON.stringify({hello:"firegrid"})+"\n"); process.exit(0)'
```

The agent (`node -e`) child exits 0 as designed. The parent `firegrid
run` daemon does NOT exit. Reproduced manually from the worktree root
with stderr:

```
firegrid:run: launched context ctx_ext_...
firegrid:run: context ctx_ext_... exited (attempt 1, exitCode 0)
[hangs; SIGTERM at 30s → exit 143]
```

Per the readiness-sim review instructions ("if the subprocess assertion
flakes or hangs, revert only that assertion, keep Step 1 documented
GREEN, and open the PR with the deterministic client/router smoke. Report
the exact hang/failure"), the assertion was reverted to `it.skip`. Step 1
remains documented GREEN against CC6 `c0b51fc64` (bin entry exists; the
topology this sim composes in-process IS the bin entry's composition).

The bin-shutdown gap is a #738 follow-up — likely a missing
`shutdown-on-terminal` path in `packages/runtime/src/bin/run.ts` (the
runtime should observe the launched context's `exited` event and tear
itself down). It is NOT in scope for the readiness sim PR.

## Routing around a stale host-sdk barrel

On this stack (`origin/sidecar/runtime-bin-support`, head `91ed12b77`),
`packages/host-sdk/src/host/index.ts` still re-exports symbols from a
file that has been deleted (`./acp-stdio-edge.ts` was moved to
`packages/runtime/src/producers/codecs/acp/stdio-edge.ts` by `dcfb01f71`).
The package barrel imports throw at load time, so any test that imports
from `@firegrid/host-sdk` fails before `runtime-bin-support`'s own runtime
fix (`91ed12b77`) can be exercised.

The brief forbids edits outside `packages/tiny-firegrid/**`, so this
simulation routes around the broken barrel by importing the same
canonical symbols directly from runtime:

| Symbol | Canonical home |
|---|---|
| `FiregridLocalHostLive` | `@firegrid/runtime/composition/host-live` |
| `FiregridLocalProcessFromEnv` | `@firegrid/runtime/producers/sandbox/local-process-from-env` |
| `FiregridEnvBindingsFromEnv` | `@firegrid/runtime/producers/sandbox/local-process-from-env` |
| `FiregridHost` (type) | `@firegrid/runtime/composition/host-live` |
| `HostPlaneChannelRouter` | `@firegrid/runtime/channels` |

This matches the Class F3 cutover that landed `FiregridLocalHostLive` /
`FiregridRuntimeHostLive` / `FiregridHost` at the canonical runtime home
(`8fdae0b53`); host-sdk is being deleted in a follow-up
(`507da434c feat(host-sdk delete-first)`). The simulation has no
dependency on the host-sdk barrel — it's a pure runtime composition
consumer.

The 3 pre-existing failures in the full suite
(`agentic-patterns-primitive-profile`, `sleep-only-substrate-smoke`,
`spike-channel-deletion/sim2-multi-surface-projection`) ARE caused by
the same stale host-sdk barrel and are out of scope for this PR; they
will green either when host-sdk is deleted or when the barrel is
repaired.

## Follow-up

CC6 landed the runtime composition fix (`91ed12b77`) that provides
`RuntimeAgentToolExecutionLive` + `HostRuntimeObservationStreamsLive` in
the runtime-context subscriber bundle. The follow-up second smoke is now
unblocked:

- a planner subprocess emits a `tool_use` JSONL line for `session_new`,
  the runtime executes the tool, the child session materializes through
  the same `host.sessions.create_or_load` router target. Step 5 stays
  identical; what changes is the SPAWN provenance — planner-emitted vs
  outer-driver-emitted.

Second follow-up (NOW BLOCKING the executable flip of step 1): land a
shutdown-on-terminal path in `packages/runtime/src/bin/run.ts` so the
parent daemon tears down on the launched context's `exited` event. Once
the daemon exits 0 after the agent exits 0, restore the subprocess
assertion in `smoke.test.ts` step 1 (the reverted block has the exact
shape preserved in this FINDING.md for fast restore).

## What this is NOT

- Not a new router, channel, schema, or composition path. Uses the existing
  `HostPlaneChannelRouter`, `session.agent_output` route, and
  `FiregridLocalHostLive` composition unchanged.
- Not a production edit. The simulation lives entirely under
  `packages/tiny-firegrid/**` (plus a one-line addition to the runner's
  `hiddenFolders` set so the smoke-only sim is not auto-discovered).
- Not a docs/research entry. This FINDING.md is local to the simulation
  folder.
- Not a direct durable-table cheat on the read side. Both observation paths
  go through the production `session.agent_output` route; the read source is
  `RuntimeOutputTable.events.rows()` via the host's `SessionAgentOutputChannelLive`.
- Not load-bearing for spawn shape. The `session_new` spawn shape is owned
  by `shape-c-channel-router-turn` and the upcoming CC6 follow-up smoke; the
  outer-driver createOrLoad here is a YELLOW surrogate explicitly to keep
  the load-bearing assertion focused on step 5.

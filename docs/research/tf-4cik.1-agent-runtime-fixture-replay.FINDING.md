# tf-4cik.1 Agent Runtime Fixture Replay Finding

The conformance backbone is a tiny-firegrid simulation:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run agent-runtime-fixture-replay-harness
pnpm --filter @firegrid/tiny-firegrid simulate:show <run-id>
pnpm --filter @firegrid/tiny-firegrid simulate:perf <run-id>
```

The standard run is deterministic. It replays checked-in ACP, stdio-jsonl,
fake MCP/provider, restart/disconnect, and codec double-advertisement fixtures
from `packages/tiny-firegrid/src/simulations/agent-runtime-fixture-replay-harness/corpus/`.
Live-agent canaries are declared in the matrix but skipped unless explicitly
enabled by environment; they are not the CI foundation.

## Local Artifact Run

Verified run:

```txt
run: 2026-05-21T05-07-09-285Z__agent-runtime-fixture-replay-harness
trace: packages/tiny-firegrid/.simulate/runs/2026-05-21T05-07-09-285Z__agent-runtime-fixture-replay-harness/trace.jsonl
matrix rows: 6
fuzz cases: 60
unsupported rows: live-canary-codex-acp
```

`simulate:show` summary:

```txt
spans: 71  traces: 1  errored: 0  sides: driver=69 host=1
- firegrid.simulation.run
  - firegrid.side.driver
    - firegrid.agent_runtime_fixture.replay_harness
      - firegrid.agent_runtime_fixture.replay_fixture
        - firegrid.agent_runtime_fixture.fuzz_case
```

`simulate:perf --top 8` summary:

```txt
spans: 71
window: 2026-05-21T05:07:09.291Z -> 2026-05-21T05:07:09.339Z (48.4ms)
http rolls: (none)
idle gaps: (none above threshold)
```

## Artifact Contract

- Spec-first matrix: `features/firegrid/firegrid-runtime-agent-event-pipeline.feature.yaml`
  `SOURCE_CONFORMANCE.*`.
- Matrix artifact: `docs/research/tf-4cik.1-agent-runtime-conformance-matrix.md`.
- Fixture corpus: the simulation `corpus/` directory.
- Fault classes: crash mid-action, dropped wait via missing permission response,
  codec double-advertisement, and permission-gate stall are represented as
  replay rows or fuzz classes.
- Fuzz pass: twelve byte/input-boundary classes run across every deterministic
  fixture.
- Diagnosability: each fixture and fuzz case emits spans under
  `firegrid.agent_runtime_fixture.*`; runner output prints the run directory
  and trace path.

## Sources README Implications

The harness supports the boundary in
`packages/runtime/src/agent-event-pipeline/sources/README.md`:

- sources own live byte/process/resource acquisition and source-level terminal
  evidence;
- codecs own protocol correlation, duplicate advertisement classification, and
  malformed/incomplete frame mapping;
- durable authorities own committed-row replay and dedupe evidence;
- host/config surfaces own app-facing provider configuration and credential
  policy.

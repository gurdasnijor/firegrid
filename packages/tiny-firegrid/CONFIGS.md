# tiny-firegrid configurations

Each file in `src/configurations/` is an executable architecture diagram. A
configuration should wire a whole pipeline through public Firegrid boundaries,
then tests should assert externally visible behavior from the outside.

Use a new configuration when proposing or validating an architectural shape. If
the shape compiles and runs without private production imports, that is evidence
the current public seams can express it. If it only works by reaching through
internal machinery, that is a design finding.

Configurations are intentionally inline and readable. The package is excluded
from the duplication gate because repeated wiring is documentation here; hiding
the wiring behind opaque helpers would make the model less useful.

`DurableTable.rows()` in this package replays current rows and then tails live
changes. Use `query()` for terminating snapshot reads.

## Categories

`production-consuming`: thin wrapper over `FiregridRuntimeHostLive` or other
production layer factories. Tests drive through the client SDK where possible.
Purpose: verify the toy's properties under real production composition, and
surface findings when public boundaries cannot express the configuration
cleanly.

`pedagogical`: hand-rolled in toy vocabulary: in-memory adapters and tiny
implementations of host concepts. Purpose: make a seam visible in minimal terms
for architectural reasoning. These are not targets for refactor to
production-consuming; that would defeat the purpose.

Both categories follow the configuration-as-finding discipline: drive examples
through public boundaries. A transition that has to be called directly is
treated as production-internal machinery, not a model API.

## What This Is

`CONFIGS.md` is the index for navigating the toy's configuration space: what
exists, what is queued, what each one proves, and what findings it interacts
with.

It is not:

- a replacement for `FINDINGS.md`, which remains the authoritative findings
  ledger;
- a replacement for SDDs, which document architectural decisions;
- a coverage report, since script artifacts in `tmp/toy-coverage/` remain
  authoritative.

Cross-references between `CONFIGS.md`, `FINDINGS.md`, and the coverage
artifacts are how the three stay coherent. `CONFIGS.md` is the most user-facing
of the three; `FINDINGS.md` is the most authoritative.

## Index

Coverage values use `host_surface_closure / end_to_end_closure` from
`tmp/toy-coverage/<config>/summary.md`. Rows marked `not measured` either do
not exist on the current branch yet or have not had per-config coverage
artifacts generated.

| Configuration | Category | Status | What it proves | Production surfaces exercised | Coverage | Findings surfaced | Findings consumed | Reach-pasts | Pre-conditions | Related SDDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [codex-acp-tool-call-pipeline.ts](src/configurations/codex-acp-tool-call-pipeline.ts): production host with MCP server for an ACP agent that can discover Firegrid tools. | production-consuming | landed | ACP agents can connect to the host MCP route, receive the toolkit, and surface provider-executed tool observations through durable output. | `FiregridRuntimeHostLive`, `FiregridMcpServerLayer`, `RuntimeEnvResolverPolicy`, client SDK session facade, ACP codec path, `RuntimeControlPlaneTable`, `RuntimeOutputTable` | 2.7% / 25.0%, 2026-05-18 | `TFIND-036` re-triaged cat-3, `TFIND-037` superseded by `TFIND-041`, `TFIND-038` resolved, `TFIND-039` resolved, `TFIND-040` in-progress | `TFIND-005` blocked, `TFIND-007` resolved, `TFIND-031` resolved, `TFIND-035` resolved, `TFIND-041` resolved | `src/configurations/codex-acp-tool-call-pipeline.ts:70` (`TFIND-005`); `test/codex-acp-tool-call-pipeline.test.ts:230` (`TFIND-038`); `test/codex-acp-tool-call-pipeline.test.ts:290` (`TFIND-040`); `test/codex-acp-tool-call-pipeline.test.ts:425` (`TFIND-039`) | none | [docs/proposals/SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md](../../docs/proposals/SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md), [docs/sdds/SDD_FIREGRID_HOST_SURFACE.md](../../docs/sdds/SDD_FIREGRID_HOST_SURFACE.md), [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md) |
| [durable-streams-backed-pipeline.ts](src/configurations/durable-streams-backed-pipeline.ts): production host backed by real Durable Streams and production workflow engine. | production-consuming | landed | The dispatcher-style prompt flow is substrate-portable, and replay across engine restart completes without duplicate sends. | `FiregridRuntimeHostLive`, `DurableStreamsWorkflowEngine`, `RuntimeControlPlaneTable`, `RuntimeOutputTable`, client SDK session facade, `@durable-streams/server` | 2.7% / 25.0%, 2026-05-18 | `TFIND-005` blocked, `TFIND-006` resolved, `TFIND-026` resolved, `TFIND-028` resolved, `TFIND-030` resolved | `TFIND-007` resolved, `TFIND-031` resolved, `TFIND-035` resolved | `src/configurations/durable-streams-backed-pipeline.ts:22` (`TFIND-005`) | none | [docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md](../../docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md), [docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md](../../docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md), [docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md](../../docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md) |
| [stdio-jsonl-tool-execution-pipeline.ts](src/configurations/stdio-jsonl-tool-execution-pipeline.ts): production host running a stdio-jsonl agent that emits `ToolUse` and waits for Firegrid to return `ToolResult`. | production-consuming | landed | The non-ACP tool lifecycle routes through `RuntimeToolUseExecutor` and `AgentToolHost`, then resumes the agent through the codec path. | `FiregridRuntimeHostLive`, `RuntimeToolUseExecutor`, `AgentToolHost`, stdio-jsonl codec, `RuntimeControlPlaneTable`, `RuntimeOutputTable`, client SDK session facade | 2.7% / 25.0%, 2026-05-18 | `TFIND-041` resolved; reinforces `TFIND-040` in-progress for ToolResult observation | `TFIND-005` blocked, `TFIND-031` resolved, `TFIND-038` resolved, `TFIND-039` resolved, `TFIND-041` resolved | `src/configurations/stdio-jsonl-tool-execution-pipeline.ts:21` (`TFIND-005`); `test/stdio-jsonl-tool-execution-pipeline.test.ts:217` (`TFIND-038`); `test/stdio-jsonl-tool-execution-pipeline.test.ts:330` (`TFIND-039`); `test/stdio-jsonl-tool-execution-pipeline.test.ts:374` (`TFIND-041`) | none | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md](../../docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md), [docs/proposals/SDD_ZED_ACP_STDIO_EXTERNAL_AGENT_2026-05-14.md](../../docs/proposals/SDD_ZED_ACP_STDIO_EXTERNAL_AGENT_2026-05-14.md) |
| `output-journal-pipeline.ts`: production host proving the A4 per-context output journal path and `AgentOutputAfter` wait behavior. | production-consuming | in-flight ([PR #338](https://github.com/gurdasnijor/firegrid/pull/338)) | Per-context output rows, not host-prefixed ambient output, are the durable source for output observations and `AgentOutputAfter` waits. | `FiregridRuntimeHostLive`, `RuntimeOutputTable`, `RuntimeControlPlaneTable`, `RuntimeStartCapability`, client SDK session facade, stdio-jsonl codec | 80.4% / 86.6%, 2026-05-18, from PR #338 branch | `TFIND-013` open; validates A4 residue behavior; reinforces `TFIND-040` in-progress | `TFIND-005` blocked, `TFIND-031` resolved, `TFIND-038` resolved, `TFIND-039` resolved | `src/configurations/output-journal-pipeline.ts:21` (`TFIND-005`, PR #338); `test/output-journal-pipeline.test.ts:111` (`TFIND-038`, PR #338); `test/output-journal-pipeline.test.ts:158` (`TFIND-040`, PR #338); `test/output-journal-pipeline.test.ts:170` (`TFIND-039`, PR #338) | PR #338 merge | [docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md](../../docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md), [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/research/output-path-pipeline-model.md](../../docs/research/output-path-pipeline-model.md) |
| `agent-adapter-driven-pipeline`: production host where the runtime is launched through a real `runtime/agent-adapters` path instead of a local script-shaped fixture. | production-consuming | queued | The public host surface can express an adapter-driven agent launch without reaching around the adapter boundary. | planned: `FiregridRuntimeHostLive`, `runtime/agent-adapters`, client SDK session facade, `RuntimeControlPlaneTable`, `RuntimeOutputTable` | not measured |  | `TFIND-024` open, `TFIND-005` blocked if annotations are needed |  | none; annotate any current `TFIND-005` precision reach-past | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md](../../docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md) |
| `multi-context-production-consuming-pipeline`: production host with multiple active runtime contexts under the real dispatcher and registry. | production-consuming | queued | Real host composition demuxes interleaved intents to the correct per-context engine and preserves output isolation. | planned: `FiregridRuntimeHostLive`, `RuntimeContextEngineRegistryLive`, `RuntimeInputIntentDispatcherLive`, `RuntimeControlPlaneTable`, `RuntimeOutputTable`, client SDK session facade | not measured |  | `TFIND-010` open, `TFIND-011` open, `TFIND-005` blocked if annotations are needed, `TFIND-004` unblocked by `#332`, `TFIND-008` unblocked by `#332` |  | none for host-side; client-side separate-process shape consumes `#332` | [docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md](../../docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md), [docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md](../../docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md), [docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md](../../docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md) |
| `permission-flow-pipeline`: production host exercising permission-class events during tool execution. | production-consuming | queued | Permission requests, responses, and workflow resumption are placed in the correct authority plane without codec-side hidden deferred completion. | planned: `FiregridRuntimeHostLive`, runtime codecs, `AgentToolHost`, `RuntimeToolUseExecutor`, client SDK session facade, output journal | not measured |  | `TFIND-015` open, `TFIND-041` resolved, `#332` resolved |  | `#332` and `TFIND-041` decision are landed; remaining pre-condition is final scoping of the `TFIND-015` production kernel | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md](../../docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md) |
| `agent-adapter-tool-execution-pipeline`: capstone combining the real adapter path with Firegrid-executed tools. | production-consuming | blocked (depends on `agent-adapter-driven-pipeline`) | Adapter-launched agents can use the Firegrid tool loop through the same production host surface proven by the stdio-jsonl path. | planned: `FiregridRuntimeHostLive`, `runtime/agent-adapters`, `RuntimeToolUseExecutor`, `AgentToolHost`, client SDK session facade, output journal | not measured |  | `TFIND-014` open, `TFIND-024` open, `TFIND-041` resolved, `#332` resolved |  | `agent-adapter-driven-pipeline` must land first; `#332` and `TFIND-041` are landed | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md](../../docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md) |
| [current-pipeline.ts](src/configurations/current-pipeline.ts): tiny in-memory intent to workflow to session to output path. | pedagogical | landed | The minimal four-channel model can express prompt ingress, deferred workflow wakeup, session send, sandbox output projection, and output observation persistence. | `Workflow.make`, `WorkflowEngine.layerMemory`, `DurableDeferred`, runtime event and codec contracts, toy `DurableTable` facade | 30.4% / 30.4%, 2026-05-18 | `TFIND-017` open; contributed to toy discipline findings `TFIND-018`, `TFIND-019`, `TFIND-021`, `TFIND-023` resolved | none | none | none | [docs/sdds/SDD_DURABLE_AGENT_RUNTIME_LAB.md](../../docs/sdds/SDD_DURABLE_AGENT_RUNTIME_LAB.md), [docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md](../../docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md) |
| [dispatcher-driven-pipeline.ts](src/configurations/dispatcher-driven-pipeline.ts): tiny in-memory host-wide subscriber dispatching intents through an active-engine registry. | pedagogical | landed | Dispatcher-driven delivery, rather than direct in-test deferred completion, is the architectural handoff from durable input rows to active workflow engines. | `Workflow.make`, `WorkflowEngine.layerMemory`, `DurableDeferred`, runtime ingress rows, toy registry, toy `DurableTable` facade | 30.4% / 30.4%, 2026-05-18 | `TFIND-010` open, `TFIND-011` open | none | none | none | [docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md](../../docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md), [docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md](../../docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md) |
| [multi-context-pipeline.ts](src/configurations/multi-context-pipeline.ts): tiny two-context dispatcher and registry model. | pedagogical | landed | A host-wide dispatcher can route interleaved durable intents to separate per-context engines without cross-talk, while inactive context intents remain durable. | `Workflow.make`, `WorkflowEngine.layerMemory`, `DurableDeferred`, runtime ingress rows, toy active-engine registry, toy output observations | 30.4% / 30.4%, 2026-05-18 | reinforces `TFIND-010` open and `TFIND-011` open | none | none | none | [docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md](../../docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md), [docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md](../../docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md) |
| [wait-for-output-pipeline.ts](src/configurations/wait-for-output-pipeline.ts): tiny `wait_for` model over per-context output rows. | pedagogical | landed | `AgentOutput` and `AgentOutputAfter` waits should resolve against per-context output targets, making the A4 host-prefixed drift visible by inspection. | `RuntimeWaitSource`, `evaluateFieldEquals`, runtime output observations, toy `DurableTable` facade | 25.9% / 25.9%, 2026-05-18 | `TFIND-012` open, `TFIND-025` open | none | none | none | [docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md](../../docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md), [docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md](../../docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md) |

## Maintenance

When a new configuration lands, add a row before merge. Coverage numbers can be
deferred to the next coverage-script run, but findings and reach-pasts must be
filled in at merge time.

When a finding surfaces during configuration work, the configuration's
`Findings surfaced` column is updated in the same PR that records the TFIND in
`FINDINGS.md`.

When a finding the configuration depends on changes status, such as `resolved`
or `superseded`, the configuration's row is updated. This is the toy agent's
responsibility, not the coordinator's.

When a configuration's reach-pasts change, including added, removed, or updated
annotations, the row's `Reach-pasts` column is updated in the same PR.

The `Coverage` column is refreshed after every coverage-script run on the
configuration, with the date.

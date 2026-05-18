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
| [codex-acp-tool-call-pipeline.ts](src/configurations/codex-acp-tool-call-pipeline.ts): production host with MCP server for an ACP agent that can discover Firegrid tools. | production-consuming | landed; public-surface test migration blocked on `TFIND-048` | ACP agents can connect to the host MCP route, receive the toolkit, and surface provider-executed tool observations through durable output. | `FiregridRuntimeHostLive`, `FiregridMcpServerLayer`, `RuntimeEnvResolverPolicy`, client SDK session facade, ACP codec path, `RuntimeControlPlaneTable`, `RuntimeOutputTable` | 80.4% / 86.6%, 2026-05-18 | `TFIND-036` re-triaged cat-3, `TFIND-037` superseded by `TFIND-041`, `TFIND-038` resolved, `TFIND-039` resolved, `TFIND-040` in-progress, `TFIND-048` open | `TFIND-005` blocked, `TFIND-007` resolved, `TFIND-031` resolved, `TFIND-035` resolved, `TFIND-041` resolved; `TFIND-038`/`TFIND-039` production-resolved but this test's migration is blocked on `TFIND-048` MCP-lifecycle framing | `src/configurations/codex-acp-tool-call-pipeline.ts:70` (`TFIND-005`); `test/codex-acp-tool-call-pipeline.test.ts:230` (`TFIND-038`, retained until `TFIND-048` unblock); `test/codex-acp-tool-call-pipeline.test.ts:290` (`TFIND-040`); `test/codex-acp-tool-call-pipeline.test.ts:425` (`TFIND-039`, retained until `TFIND-048` unblock) | `TFIND-048` MCP route/URL lifecycle framing before public-surface migration | [docs/proposals/SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md](../../docs/proposals/SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md), [docs/sdds/SDD_FIREGRID_HOST_SURFACE.md](../../docs/sdds/SDD_FIREGRID_HOST_SURFACE.md), [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md) |
| [durable-streams-backed-pipeline.ts](src/configurations/durable-streams-backed-pipeline.ts): production host backed by real Durable Streams and production workflow engine. | production-consuming | landed | The dispatcher-style prompt flow is substrate-portable, and replay across engine restart completes without duplicate sends. | `FiregridRuntimeHostLive`, `DurableStreamsWorkflowEngine`, `RuntimeControlPlaneTable`, `RuntimeOutputTable`, client SDK session facade, `@durable-streams/server` | 80.4% / 86.6%, 2026-05-18 | `TFIND-005` blocked, `TFIND-006` resolved, `TFIND-026` resolved, `TFIND-028` resolved, `TFIND-030` resolved | `TFIND-007` resolved, `TFIND-031` resolved, `TFIND-035` resolved | `src/configurations/durable-streams-backed-pipeline.ts:22` (`TFIND-005`) | none | [docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md](../../docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md), [docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md](../../docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md), [docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md](../../docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md) |
| [stdio-jsonl-tool-execution-pipeline.ts](src/configurations/stdio-jsonl-tool-execution-pipeline.ts): production host running a stdio-jsonl agent that emits `ToolUse` and waits for Firegrid to return `ToolResult`. | production-consuming | landed | The non-ACP tool lifecycle routes through `RuntimeToolUseExecutor` and `AgentToolHost`, then resumes the agent through the codec path. | `FiregridRuntimeHostLive`, `RuntimeToolUseExecutor`, `AgentToolHost`, stdio-jsonl codec, client SDK session facade, `FiregridRuntimeTables.ControlPlane`, `session.wait.forAgentOutput` | 80.4% / 86.6%, 2026-05-18 | `TFIND-041` resolved; validates `TFIND-038` and `TFIND-039` toy realization for stdio-jsonl | `TFIND-005` blocked, `TFIND-031` resolved, `TFIND-038` resolved, `TFIND-039` resolved, `TFIND-041` resolved | `src/configurations/stdio-jsonl-tool-execution-pipeline.ts:21` (`TFIND-005`); `test/stdio-jsonl-tool-execution-pipeline.test.ts:351` (`TFIND-041`) | none | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md](../../docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md), [docs/proposals/SDD_ZED_ACP_STDIO_EXTERNAL_AGENT_2026-05-14.md](../../docs/proposals/SDD_ZED_ACP_STDIO_EXTERNAL_AGENT_2026-05-14.md) |
| [output-journal-pipeline.ts](src/configurations/output-journal-pipeline.ts): production host proving the A4 per-context output journal path and `AgentOutputAfter` wait behavior. | production-consuming | landed | Per-context output rows are the durable source for output observations, and `AgentOutputAfter` waits advance through that public session surface. | `FiregridRuntimeHostLive`, `RuntimeOutputTable`, `RuntimeControlPlaneTable`, client SDK session facade, `FiregridRuntimeTables.ControlPlane`, stdio-jsonl codec, `session.wait.forAgentOutput` | 80.4% / 86.6%, 2026-05-18 | `TFIND-013` resolved (#338 / `960ec59b3`); validates A4 output-journal behavior through public session waits | `TFIND-005` blocked, `TFIND-031` resolved, `TFIND-038` resolved, `TFIND-039` resolved, `TFIND-040` decided | `src/configurations/output-journal-pipeline.ts:21` (`TFIND-005`) | none | [docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md](../../docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md), [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/research/output-path-pipeline-model.md](../../docs/research/output-path-pipeline-model.md) |
| `agent-adapter-driven-pipeline`: production host where the runtime is launched through a real `runtime/agent-adapters` path instead of a local script-shaped fixture. | production-consuming | blocked (`TFIND-049`) | Once Slice 4 exists, the public host surface can express an adapter-driven agent launch without reaching around the adapter boundary. | planned: `FiregridRuntimeHostLive`, `runtime/agent-adapters`, client SDK session facade, `RuntimeControlPlaneTable`, `RuntimeOutputTable` | not measured | attempted probe surfaced `TFIND-049` | `TFIND-024` open, `TFIND-049` open | none | effect-ai-native-agents Slice 4 / `TFIND-049`: `AgentAdapterRegistry` is not wired into `FiregridRuntimeHostLive`, and launch only supports `local-process` | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md](../../docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md), [docs/proposals/effect-ai-native-agents.md](../../docs/proposals/effect-ai-native-agents.md) |
| [multi-context-production-consuming-pipeline.ts](src/configurations/multi-context-production-consuming-pipeline.ts): production host with multiple active runtime contexts under the real dispatcher and registry. | production-consuming | landed | Real host composition demuxes interleaved public client intents to the correct per-context engine and preserves output isolation. | `FiregridRuntimeHostLive`, `RuntimeContextEngineRegistryLive`, `RuntimeInputIntentDispatcherLive`, `FiregridRuntimeTables.ControlPlane`, client SDK session facade, stdio-jsonl codec, `session.wait.forAgentOutput` | 80.4% / 86.6%, 2026-05-18 | validates `TFIND-004`/`TFIND-008` unblocked claim; reinforces `TFIND-010`/`TFIND-011` production path | `TFIND-005` blocked, `TFIND-004` resolved, `TFIND-008` resolved, `TFIND-010` open, `TFIND-011` open | `src/configurations/multi-context-production-consuming-pipeline.ts:21` (`TFIND-005`) | none | [docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md](../../docs/sdds/SDD_FIREGRID_PER_CONTEXT_RUNTIME_ENGINE.md), [docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md](../../docs/proposals/SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md), [docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md](../../docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md) |
| `permission-flow-pipeline`: production host exercising permission-class events during tool execution. | production-consuming | queued | Permission requests, responses, and workflow resumption are placed in the correct authority plane without codec-side hidden deferred completion. | planned: `FiregridRuntimeHostLive`, runtime codecs, `AgentToolHost`, `RuntimeToolUseExecutor`, client SDK session facade, output journal | not measured |  | `TFIND-015` open, `TFIND-041` resolved, `#332` resolved |  | `#332` and `TFIND-041` decision are landed; remaining pre-condition is final scoping of the `TFIND-015` production kernel | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md](../../docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md) |
| `agent-adapter-tool-execution-pipeline`: capstone combining the real adapter path with Firegrid-executed tools. | production-consuming | partially realized by stdio-jsonl; adapter capstone blocked (`TFIND-049`) | `#343` proves the non-adapter Firegrid-executed tool path; once Slice 4 exists, adapter-launched agents should use the same tool loop through the production host surface. | planned: `FiregridRuntimeHostLive`, `runtime/agent-adapters`, `RuntimeToolUseExecutor`, `AgentToolHost`, client SDK session facade, output journal | not measured | non-adapter tool path realized by `#343`; adapter path blocked by `TFIND-049` | `TFIND-014` resolved for non-adapter path, `TFIND-024` open, `TFIND-041` resolved, `TFIND-049` open, `#332` resolved |  | effect-ai-native-agents Slice 4 / `TFIND-049`; then `agent-adapter-driven-pipeline` must land first | [docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md](../../docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md), [docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md](../../docs/proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md), [docs/proposals/effect-ai-native-agents.md](../../docs/proposals/effect-ai-native-agents.md) |
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

The `Pre-conditions` column is a consumer claim, not a coordinator-verified
guarantee. `queued` with no listed upstream blocks is a hypothesis that still
needs a capability check before dispatch: the production capability must exist,
not merely have an open modeling TFIND. `TFIND-049` is the cautionary example:
the queue looked clear, but Effect AI native agents Slice 4 was unbuilt.

When a configuration's reach-pasts change, including added, removed, or updated
annotations, the row's `Reach-pasts` column is updated in the same PR.

The `Coverage` column is refreshed after every coverage-script run on the
configuration, with the date.

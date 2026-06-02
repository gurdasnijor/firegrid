# tf-r1gz — ACP/Zed OTel trace export: live end-to-end proof + root cause

## Verdict

GREEN. Root cause of the "live Zed path produced no `.firegrid/acp-trace.jsonl`"
symptom is localized, fixed, and proven with a real live `firegrid acp` run.

Follow-on to tf-ukvr (#601), whose smoke passed only because it used an
**absolute** trace path and an agent that **exited** (process-exit flush). The
live Zed path differs on both axes, which is why it silently produced nothing.

## Root cause

**PRIMARY — relative trace path resolved against the editor's cwd, not the repo.**
`JsonlFileSpanExporter` resolves the file with `path.resolve(filePath)` against
`process.cwd()` (`packages/observability/src/node.ts`). When Zed launches
`firegrid acp`, the agent process inherits **Zed's** working directory, not the
repo. The documented config used a relative `--otel-file .firegrid/acp-trace.jsonl`,
so the artifact was written to `<zed-cwd>/.firegrid/acp-trace.jsonl` and never
appeared in the repo where it was looked for.

**SECONDARY — file exporter batched, lossy for short/abruptly-killed sessions.**
The file destination used a `BatchSpanProcessor` (5s scheduled delay / 512-span
batches) while the console destination used a `SimpleSpanProcessor`. Periodic
flush *does* fire for a long-running process (verified: 512→1024 spans at the 5s
mark without exit), so "spans only flush on exit" is **refuted** for normal
operation — but a short session, or an abrupt SIGKILL/editor disconnect within a
batch window, dropped the most recent (<5s, <512) spans. `forceFlush()` was also
a no-op (never flushed the underlying write stream).

**Points verified HEALTHY (no change needed):**

- *stdout purity* — the live edge emitted **0** non-JSON stdout lines; the
  exporter never writes to stdout.
- *layer composition* — `FiregridOtelLive` is composed on the live `firegrid acp`
  edge; the artifact and the full Firegrid-MCP catalog were produced.

## Fix

- `packages/cli/src/bin/run.ts` — resolve a relative `--otel-file` against
  `--cwd` when supplied (the project root the documented example pairs it with),
  else the process cwd; pin the destination to an **absolute** path and announce
  it on **stderr** (`firegrid acp: writing OTEL spans to <abs>`) so the artifact
  location is never a guess. stdout stays reserved for ACP JSON-RPC frames.
- `packages/observability/src/node.ts` — file destination now uses
  `SimpleSpanProcessor` (immediate per-span write, matching the console
  destination), so a long-running ACP agent populates the JSONL artifact
  continuously and an abrupt disconnect no longer discards a pending batch.
- `.gitignore` — ignore `.firegrid/` (the documented default trace location).
- Docs: `docs/runbooks/firegrid-effect-tracing.md` + `acp --help` describe the
  `--cwd` resolution, the stderr announce, and the immediate-flush behavior.

## Live proof (real `firegrid acp` CLI over stdio, as Zed drives it)

A real `firegrid acp` process was spawned from a **non-repo** working directory
(simulating Zed's launch cwd) and driven by a real ACP client over stdio
(`initialize` → `session/new` → `session/prompt`). The spawned backing agent is
a real ACP agent that connected to the injected runtime-context MCP server and
ran the real MCP `initialize` / `tools/list` / `tools/call` round-trip.

**Before the fix** (relative `--otel-file`, launched from a foreign cwd): the
repo trace file count was `-1` (absent) in every sample across both graceful and
SIGKILL runs; the artifact materialized only under the foreign launch cwd.

**After the fix** (`--cwd <repo>`, relative `--otel-file`): the artifact landed
in `<repo>/.firegrid/acp-trace.jsonl`, spans appeared immediately (324 at t=0s,
no 5s lag), and nothing leaked to the foreign cwd. stderr announced the absolute
path. `agentText: "MCP_OBS listCount=11 callOk=true"`. 919 spans total.

### Required spans present in the live artifact

| Span | Count |
| --- | ---: |
| `firegrid.acp_stdio_edge.initialize` | 1 |
| `firegrid.acp_stdio_edge.new_session` | 1 |
| `firegrid.acp_stdio_edge.prompt` | 1 |
| `firegrid.mcp.register_toolkit` | 1 |
| `McpServer.initialize` | 1 |
| `McpServer.tools/list` | 1 |
| `McpServer.tools/call` | 1 |

`firegrid.mcp.register_toolkit` carried:

```json
{
  "firegrid.mcp.tool_count": 11,
  "firegrid.mcp.tool_names": "call,execute,schedule_me,send,session_cancel,session_close,session_new,session_prompt,sleep,wait_for,wait_for_any",
  "firegrid.mcp.tool_profile": "full"
}
```

The artifact lives under ignored `.firegrid/`; this finding records the durable
result while keeping the large machine-local trace out of git.

## tf-0awo.14 post-Fix-A replay (2026-06-02)

The black-box proof is now a regression smoke:

```bash
pnpm --filter @firegrid/runtime exec vitest run test/bin/acp-cli-smoke.test.ts
```

It spawns the real `firegrid acp` CLI from a non-repo cwd, passes
`--cwd <tmp>` and relative `--otel-file .firegrid/acp-trace.jsonl`, leaves
`DURABLE_STREAMS_BASE_URL` unset, drives the process through the real ACP
TypeScript SDK, then reaches the injected runtime-context MCP route with MCP
`initialize` / `tools/list` / `tools/call`.

The 2026-06-02 run produced 574 JSONL rows, 287 completed spans, and the same
seven completed spans exactly once:

| Span | Count |
| --- | ---: |
| `firegrid.acp_stdio_edge.initialize` | 1 |
| `firegrid.acp_stdio_edge.new_session` | 1 |
| `firegrid.acp_stdio_edge.prompt` | 1 |
| `firegrid.mcp.register_toolkit` | 1 |
| `McpServer.initialize` | 1 |
| `McpServer.tools/list` | 1 |
| `McpServer.tools/call` | 1 |

The full profile remains `tool_count=11`; after the wait-family rename, the
registered tool names are:

```json
{
  "firegrid.mcp.tool_count": 11,
  "firegrid.mcp.tool_names": "call,execute,send,session_cancel,session_close,session_new,session_prompt,sleep,wait_any,wait_for,wait_until",
  "firegrid.mcp.tool_profile": "full"
}
```

The ACP prompt turn included a real ACP `tool_call` notification from the
backing agent. The replay asserted neither
`ACP ToolResult input is out-of-band for this codec slice` nor
`codec send failed` appeared in stderr or the trace, proving the post-Fix-A
observer gate handles provider-executed ACP tool calls end-to-end. A compact
captured excerpt of the seven completed spans is checked in at
`docs/research/tf-0awo.14-zed-acp-trace.required-spans.jsonl`.

## Gates

`@firegrid/observability` test (2), `@firegrid/host-sdk` test (133), typecheck
(cli/observability/host-sdk), `lint` + `lint:dead` + `lint:dup` + `lint:deps` —
all green; Effect-diagnostics within baseline.

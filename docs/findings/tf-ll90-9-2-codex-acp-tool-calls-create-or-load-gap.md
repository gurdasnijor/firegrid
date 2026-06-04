# Codex ACP Tool-Call Proof Stops At createOrLoad

`tf-ll90.9.2` rebuilt the deleted `codex-acp-tool-calls` proof as a shaped
firelab RUN sim:

- `packages/firelab/src/simulations/codex-acp-tool-calls/index.ts`
- `packages/firelab/src/simulations/codex-acp-tool-calls/driver.ts`
- `packages/firelab/src/simulations/codex-acp-tool-calls/host.ts`

The sim has two public-client scenarios:

1. `marker_only`: faithful port of the old main sim using
   `runtimeContextMcp: { enabled: true }` only.
2. `explicit_mcp_url`: sanctioned substitution-as-config-data. The host binds
   the real `FiregridMcpServerLayer` on loopback and the driver passes an
   explicit `mcpServers` URL for the deterministic external-key context id.

The host composes the real unified `FiregridHost({ codec: "acp" })` plus
`FiregridMcpServerLayer`; the driver imports only `@firegrid/client-sdk/firegrid`
and `effect`.

## Env-Absent Blocked Trace

Run:
`2026-06-02T00-18-28-790Z__codex-acp-tool-calls`

Trace:
`packages/firelab/.simulate/runs/2026-06-02T00-18-28-790Z__codex-acp-tool-calls/trace.jsonl`

Result:

- Total spans: 35
- `firegrid.codex_acp.status=blocked`
- `firegrid.codex_acp.blocked_reason="OPENAI_API_KEY is absent"`
- `firegrid.codex_acp.openai_api_key_present=false`
- No Codex subprocess was launched.

This is the expected credential-gated behavior: absent credentials produce a
loud blocked finding, not a pass.

## Live Trace With Credentials

Run:
`2026-06-02T00-22-01-760Z__codex-acp-tool-calls`

Trace:
`packages/firelab/.simulate/runs/2026-06-02T00-22-01-760Z__codex-acp-tool-calls/trace.jsonl`

Result:

- Total spans: 45
- `firegrid.mcp.register_toolkit` completed with 11 tools:
  `call,execute,schedule_me,send,session_cancel,session_close,session_new,session_prompt,sleep,wait_for,wait_for_any`
- `marker_only` ended at `firegrid.client.session.create_or_load` with
  `AppendError`; driver attribute:
  `firegrid.codex_acp.marker_only.status=failed`
- `explicit_mcp_url` also ended at `firegrid.client.session.create_or_load`
  with `AppendError`; driver attribute:
  `firegrid.codex_acp.explicit_mcp_url.status=failed`
- No `local_process.open_byte_pipe` span was emitted.
- No `adapter.start_or_attach` span was emitted.
- No host-side MCP `tools/call` or `firegrid.mcp.runtime_context.resolve` span
  was emitted.
- No `FIREGRID_TOOL_RESULT sleep slept=true` marker was observed.

The positive scenario therefore does **not** satisfy the acceptance bar for the
real Codex proof. It proves neither host-side tool dispatch nor tool-result
return, because the run never reaches agent spawn.

## Finding

The proof is blocked earlier than the `runtimeContextMcp` marker-to-MCP-URL
gap: the public `sessions.createOrLoad` route does not materialize a
`RuntimeContext` row.

Source comparison:

- `packages/runtime/src/channels/host-control.ts:120` inserts a context row in
  `HostContextsCreateChannelLive` via `RuntimeControlPlaneTable.contexts.insertOrGet`.
- `packages/runtime/src/channels/host-control.ts:147` defines
  `HostSessionsCreateOrLoadChannelLive`, but it only returns:
  `{ sessionId, contextId }` using `session:${source}:${id}`.
- `HostSessionsCreateOrLoadChannelLive` does not insert the corresponding
  runtime context row, so the client waits for context reflection and the sim
  fails at `firegrid.client.session.create_or_load`.

This blocks the real Codex ACP MCP proof before the agent can spawn. The
runtime-context MCP marker URL auto-provisioning remains a separate deferred
gap, but this create/load materialization gap is first in the live trace.

## Follow-Up

Production ownership is intentionally not fixed in this proof PR. The follow-up
decision is whether `HostSessionsCreateOrLoadChannelLive` should materialize the
context row directly, mirroring `HostContextsCreateChannelLive`, or whether the
Codex proof should use another public materialization surface.

After the owner lands the create/load materialization fix and the
`runtimeContextMcp` marker-to-host-MCP-URL wiring fix, rerun
`codex-acp-tool-calls` and require all three positive-path signals:

- host-side MCP dispatch span;
- host-returned tool result;
- subsequent Codex output containing `FIREGRID_TOOL_RESULT sleep slept=true`.

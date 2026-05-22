# ACP live prompt matrix (tf-7008)

**Date:** 2026-05-21
**Purpose:** a reusable prompt battery to exercise every Firegrid
runtime-context MCP tool through a live editor (Zed) over the ACP stdio edge,
each paired with the trace signature that confirms it worked. Pair this with
`scripts/acp-trace-health.py` and the tool-by-tool table in
`2026-05-21-live-acp-tool-call-triage.md`.

Use it as a repeatable checklist: run a prompt → run the report → compare
against the "expected trace signature" column.

## Setup

```bash
# Zed launches the edge; capture to a fresh file per battery run:
rm -f .firegrid/acp-trace.jsonl
# (Zed agent cmd, abbreviated)
firegrid acp --agent claude-acp --agent-protocol acp \
  --secret-env ANTHROPIC_API_KEY --otel-file .firegrid/acp-trace.jsonl \
  -- npx -y @agentclientprotocol/claude-agent-acp@0.36.1
```

- **Agent:** `claude-agent-acp@0.36.1`. `codex-acp@0.14.0` is **non-enumerating**
  (ISSUE-2; `McpServer.tools/list = 0`) so it cannot drive this matrix over ACP.
- **Surface:** 11 runtime-context tools — `call, execute, schedule_me, send,
  session_cancel, session_close, session_new, session_prompt, sleep, wait_for,
  wait_for_any`.
- After each prompt: `python3 scripts/acp-trace-health.py` and read Axis 1
  (`open_tool_calls`, errors), then Axis 2 (`read_amplification`).

## Tool families (results flow differently — drives the expected signature)

| Family | Tools | Result returns via | Healthy signature |
| --- | --- | --- | --- |
| **MCP-response** | `sleep`, `execute`, `call`, `schedule_me` | the `tools/call` HTTP response (host-owned deferred resolves) | `tools/call==1`, `acp.tool_result>=1`, `open==0` |
| **Session lifecycle** | `session_new`, `session_prompt`, `session_cancel`, `session_close`, `send` | child-context creation / control-plane row | new `firegrid.context.id` (Axis 2 distinct-contexts ↑), no error span |
| **Ingress-matching** | `wait_for`, `wait_for_any` | matched against a pre-seeded/appended fact, then resolves | `tools/call==1`, completes (`wait-pre-attach` sim shows `DriverCompleted`) |

> Why families matter: the tf-7kq8 hang hit MCP-response tools (`sleep`,
> `execute`) whose terminal output flows through the agent-output read path,
> while `wait_for` (ingress-matching) completed in the sim. The matrix
> deliberately spans families to localize whether a failure is path-specific.

## The matrix

Status keys: ✅ pass · ❌ hang/error · ⬜ untested. Fill in per run.

| # | Tool | Prompt | Expected trace signature (report fields) | Status (2026-05-21) |
| --- | --- | --- | --- | --- |
| 1 | `sleep` | "Use your Firegrid `sleep` tool to sleep 100ms, then reply DONE." | `open_tool_calls==0`; `tools/call==1`; one `clock.schedule`+`clock.fire`; no timeout | ❌ tf-7kq8 (open=1, result=0) |
| 2 | `sleep` | "Use `sleep` for 3000ms, then reply DONE." | same as #1 (arg-independent) | ❌ tf-7kq8 (confirms arg-independent) |
| 3 | `execute` | "Use `execute` to run `echo hi`." | `open_tool_calls==0`; `tool_use.execute` closes | ❌ tf-7kq8 (tool-independent) |
| 4 | `call` | "Use `call` to invoke <a registered channel verb>." | `tools/call==1`; `open==0` | ⬜ |
| 5 | `schedule_me` | "Use `schedule_me` to sleep 3s then prompt yourself to say 'hi'." | tool returns BEFORE the self-prompt fires; `open==0`; a second `clock.schedule` (side=agent-tools) | ❌ deadlock-doc §6 (self-re-entry; handler started, never returned) |
| 6 | `session_new` | "Create a new Firegrid session." | distinct-contexts ↑ by 1; permission round-trip `request==response`; `open==0` | ❌ orig P0 (perm drop; fixed by §5 auto-approve quick fix) |
| 7 | `session_prompt` | "Prompt the session you just made to say 'hi'." | child context emits output; no timeout | ⬜ |
| 8 | `session_cancel` | "Cancel that session." | control-plane cancel row; no error span | ⬜ |
| 9 | `session_close` | "Close that session." | control-plane close; context terminal | ⬜ |
| 10 | `send` | "Use `send` to deliver <msg> to <target>." | `tools/call==1`; `open==0` | ⬜ |
| 11 | `wait_for` | "Use `wait_for` to await <fact>, then continue." | `tools/call==1`; completes (sim: `DriverCompleted`); `open==0` | ⬜ live (✅ in `wait-pre-attach` sim) |
| 12 | `wait_for_any` | "Use `wait_for_any` over <fact A, fact B>." | `tools/call==1`; resolves on first match; `open==0` | ⬜ |

### Q&A control (negative control — no tool, no permission)

| # | Prompt | Expected | Status |
| --- | --- | --- | --- |
| 0 | "What is 2+2? Do not use any tools." | no `tools/call`, no `permission_request`, no timeout, completes | ✅ (pure Q&A always worked; isolates tool path from transport) |

## How to read a run

1. `open_tool_calls > 0` ⇒ a tool call's result never returned (tf-7kq8 class).
2. `error_count > 0` with `reason=timeout` + high `interrupted` ⇒ the turn never
   reached `TurnComplete` (could be perm drop, read-storm, or hung handler —
   disambiguate with Axis 1 permission ratio + `tools` balance).
3. `permission_request > permission_response` ⇒ a dropped permission (orig P0).
4. `read_amplification >> 1` with a steep `after_sequence` decay ⇒ output
   read-storm regression (tf-7kq8 / tf-aseo).
5. `contexts split across traces > 1` ⇒ expected today (linkage gap, §7.4);
   track it trending toward 1 as context propagation lands.

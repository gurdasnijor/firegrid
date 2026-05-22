# FINDING — tf-uoga: `schedule_me` live ACP timeout (source-verified)

Follow-on to `docs/investigations/2026-05-21-acp-stdio-edge-permission-deadlock.md` §6,
separate from the permission deadlock (#628/tf-46i4) and the output replay storm
(#612/tf-7kq8).

## Root cause (SOURCE-VERIFIED)

`packages/runtime/src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts:219`

```ts
schedule: ({ scheduleId, delayMs, append }) =>
  DurableClock.sleep({ name: scheduleId, duration: Duration.millis(delayMs), ... }).pipe(
    Effect.zipRight(append),
    Effect.as<ScheduleMeToolOutput>({ scheduled: true, scheduleId }),
  )
```

`schedule_me` lowers (`tool-use-to-effect.ts:725` `runScheduleMeTool`) to
`execution.schedule(...)`, which is **awaited inline by the `ToolCallWorkflow`**
(`toolkit-layer.ts:58` `handleTool` runs `ToolCallWorkflow.execute` and blocks on
its result). So the tool only returns `{scheduled:true}` **after** the
`DurableClock.sleep(delayMs)` fires and the self-prompt `append` runs.

- `delayMs = max(0, input.when - now)`; `when` is **absolute wall-clock epoch ms**
  (`protocol/src/agent-tools/schema.ts:543`), computed by the LLM.
- For "schedule a prompt 3s from now", the agent must produce `now + 3000` in epoch
  ms — error-prone; any `when` that yields `delayMs > turnTimeoutMs` (30s) means the
  edge times out **before** the durable sleep fires and the tool returns.
- A "schedule a *future* prompt" tool that **blocks the calling turn until the
  future arrives** is the defect — independent of the exact `when`.

### Trace corroboration (§6 run)

`sleep` and `schedule_me` both started (`agent_tools.tool_use.execute` ×2), but only
`sleep`'s `McpServer.tools/call` completed and only `sleep`'s clock fired;
`schedule_me`'s `tools/call` span stayed open → `AcpStdioEdgeTurnOutputError{timeout}`
at ~32s. The sole code difference vs `sleep` (which works) is the inline-awaited
`DurableClock.sleep + append`. NOT permission (ratio clean 1:1:1, all from `sleep`).

## The fix is a non-blocking, replay-safe, durable schedule (a design change)

Required behavior: `schedule_me` **registers** the future prompt and returns
`{scheduled:true}` immediately; the prompt fires later as its own turn.

Shortcuts that DON'T work (rejected with reasons):

- **`Effect.forkDaemon(Clock.sleep + append)` in the lowering / execution.** Returns
  immediately, but the `ToolCallWorkflow` body re-runs on `@effect/workflow` replay,
  so a non-idempotent fork re-forks → **duplicate scheduled prompts**. This is the
  exact replay-path class hardened by tf-7kq8 (#612) and guarded by tf-e49h (#622);
  reintroducing it would be a regression.
- **Forking inside the tool-call workflow scope.** The workflow completes (returns the
  tool result) → its scope closes → the forked fiber is interrupted → the append
  never fires.
- **Host-scoped `Clock.sleep` daemon.** Non-durable (lost on restart) AND still
  re-forked on tool-call-workflow replay unless gated by idempotency.

Correct shape: a **separate durable `ScheduledPromptWorkflow`** (own `Workflow.make`,
`idempotencyKey = scheduleId`) that owns `DurableClock.sleep(when - now)` + an
idempotent `appendRuntimeIngress` (keyed by `inputId = scheduleId`). `execution.schedule`
**starts it fire-and-forget** (re-start is a no-op via workflow idempotency — replay-safe)
and returns `{scheduled:true}` immediately. The append reconstructs from the payload
(`contextId`, `prompt`, `scheduleId`) inside the workflow rather than capturing the
`append` closure. Aligns with `WORKFLOW_ADMISSION` (a real owned durable timer resource)
and the Phase-0 durable-timeline direction.

This is more than a focused patch: it adds a new durable workflow + engine
registration + host-capability provision inside the workflow body, and its
replay-safety must be proven (DurableClock dedup + idempotent append). Given the
substrate + replay-safety stakes, it should be implemented and trace-validated as its
own careful change (a deterministic sim with a future `when`, asserting: `tools/call`
returns `{scheduled:true}` immediately, the turn completes, and the scheduled prompt
fires exactly once after the delay), not rushed.

## Live Zed retest

**Not yet** — there is no behavior change in this finding. Retest after the durable
`ScheduledPromptWorkflow` lands, with the deterministic sim above as the gate.

## File index

- `runtime-agent-tool-execution.ts:219` — the inline-awaited `DurableClock.sleep + append`.
- `tool-use-to-effect.ts:725` `runScheduleMeTool` — lowering; builds `append` + `scheduleId`.
- `agent-tool-host-live.ts:352` `appendSessionPrompt` → `appendRuntimeIngress` (idempotent by `inputId`).
- `toolkit-layer.ts:58` `handleTool` — runs the tool in `ToolCallWorkflow`, blocks on result.
- `protocol/src/agent-tools/schema.ts:543` — `when` is absolute epoch ms.

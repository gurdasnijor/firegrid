# tf-e1d — permission-flow sim premise fixed: durable human-gate round-trip REAL PASS

Status authority: bead `tf-e1d`. Successor to the §413/tf-v2z keyed REAL
finding (§2). Source-verified against tf-v2z + merged #412 env-gate.

## Root cause (source-verified, sharpened vs the dispatch framing)

tf-v2z §2: with the key, `claude-code-acp` drove a real turn (4 ToolUse,
TurnComplete) but emitted **zero `session/request_permission`** because
its default ACP posture **auto-permits** the prior probe
(`echo FIREGRID_PERMISSION_PROBE`, read-only) — so the durable
PermissionRequest→Response→resume round-trip never fired and the run
timed out.

Source-check correction (flagged honestly): the Firegrid ACP codec sends
`clientCapabilities: {}` in `initialize` (`codec/index.ts:450`). ACP's
`ClientCapabilities` has **no permission capability** — `session/
request_permission` is a core agent→client request, NOT capability-gated.
So `clientCapabilities:{}` is a real latent shape worth tracking but is
**NOT** the cause here; over-claiming it would be wrong. The cause is
exactly tf-v2z's: a benign read-only op is auto-permitted; this is a
sim-premise/agent-config gap, not a Firegrid substrate defect.

## Fix (in-scope sim-premise, deterministic)

Drive a genuinely permission-GATED operation: a state-changing file
WRITE (`printf 'FIREGRID_PERMISSION_PROBE' > /tmp/firegrid_permission_
probe_<runId>`), which Claude Code's default permission mode reliably
gates behind an approval request. Absolute /tmp path → no repo/worktree
pollution. The sim's strict gate→respond(Allow)→resume→
`FIREGRID_PERMISSION_RESULT` assertion is unchanged.

## Keyed REAL-behavior PASS — fully verified end to end

Run `2026-05-19T13-51-30-257Z__permission-flow-pipeline`
(`ANTHROPIC_API_KEY` present, real `@zed-industries/claude-code-acp@0.16.2`):

- status `completed`; summary: `sawPermissionRequest:true`,
  `respondedAllow:true`, `sawPostResumeOutput:true`,
  `resultTextExcerpt:"FIREGRID_PERMISSION_RESULT done=true"`,
  `permissionRequestId:"permission_id_gj6N2KUDXKzZk8DA"`.
- Trace: `acp.permission_request` x2, `acp.permission_response` x2;
  durable `permission-response` runtime-input send x16;
  `workflow.permission_response.await` x18;
  `workflow_engine.execution.resume` x50.
- **Real side-effect proof:** `/tmp/firegrid_permission_probe_<runId>`
  exists containing exactly `FIREGRID_PERMISSION_PROBE` — the gated Bash
  write executed ONLY after the durable Allow resumed the agent,
  proving the full gate→approve→resume→execute chain through the public
  client.
- No degrade / key-missing / timeout markers.

`sawReady:false` is expected and not a defect: the driver observes from
the gate sequence onward; `Ready` precedes the gate window.

## Disposition

The §6 human-permission gate path is exercised and asserted with a real
tool-using agent through the public Firegrid client. Sim-premise fix
only; no substrate change. Secondary observation flagged for follow-up
(not blocking, not papered): `clientCapabilities:{}` is sent to ACP
agents — harmless for permission requests (not capability-gated) but
worth populating (fs/terminal) for correctness of other agent
behaviors. No self-merge.

# FINDING — permission-flow simulation (tf-ahk · join `tfind:` n/a, bead tf-ahk)

Status authority is the bead (`tf-ahk`). This file is the narrative
artifact; the live evidence is the gitignored `.simulate` run.

## What was built

`packages/tiny-firegrid/src/simulations/permission-flow-pipeline.ts` — a
self-contained tiny-firegrid simulation (own host compose; **no**
`configurations/` import, so the slated `configurations/` deletion stays
clean). It drives the factory human-gate path through the **public**
Firegrid client only (no hand orchestration of codec/workflow):

`sessions.createOrLoad` (claude-code-acp ACP runtime) → `session.prompt`
→ `session.start` → `session.wait.forPermissionRequest` →
`session.permissions.respond({_tag:"Allow"})` →
`session.wait.forAgentOutput` (strictly after the gate sequence).

Agent choice: codex-acp@0.14.0 is verified non-enumerating (never reaches a
tool-call permission request), so the signal requires a tool-ENUMERATING
ACP agent — `@zed-industries/claude-code-acp@0.16.2`.

`pnpm --filter @firegrid/tiny-firegrid typecheck` passes.

## Divergence (RED — halt-and-surface, not papered over)

Run `2026-05-19T10-37-28-891Z__permission-flow-pipeline` timed out in
Phase 1: no `PermissionRequest` was ever surfaced.

### Trace-verified ground truth (epistemic tier: SOURCE-VERIFIED from spans)

The Firegrid substrate path is sound **end to end through the ACP
boundary**. Span timeline (live-spans.jsonl):

- client `firegrid.client.session.prompt` → control plane → runtime-context
  workflow (`native.run`, `reactive_loop`, `input.handle`,
  `output.wait`) — all present.
- ACP codec / local-process: `firegrid.host.codec.start_session` →
  `source.local_process.open_byte_pipe` →
  `agent_event_pipeline.acp.initialize` →
  `agent_event_pipeline.acp.new_session` (**session_id
  `bf5cc380-…` returned**) →
  `agent_event_pipeline.acp.session_update`
  (`available_commands_update`, tag `Status`) →
  `agent_event_pipeline.acp.prompt`
  (correlation_id = our `…turn-1` input) →
  `agent_event_pipeline.acp.exit` (terminatedEvent) →
  `source.local_process.exit`.
- **Zero** `acp.permission_request`, **zero** `ToolUse`, **zero**
  `agent_message_chunk`/`TextChunk` after the prompt.

`session/new` returning a session id proves: (a) the nested-session
`CLAUDECODE` guard did **not** fire in the sim — Firegrid's
`inheritedEnvUnset` correctly wiped the orchestrator env; (b) the spawn env
was sufficient to *create* a session. The agent then exited during/after the
prompt turn with no model output.

### Manual reproduction matrix (epistemic tier: SOURCE-VERIFIED, direct stdio)

`npx -y @zed-industries/claude-code-acp@0.16.2`, ACP stdio:

| Env | `initialize` | `session/new` |
|---|---|---|
| `CLAUDECODE` set + `ANTHROPIC_API_KEY` | OK | **FAILS** — "Claude Code cannot be launched inside another Claude Code session … unset the CLAUDECODE environment variable" (`-32603`, "Query closed before response received"); no `available_commands_update` |
| `CLAUDECODE` unset + `ANTHROPIC_API_KEY` | OK | **OK** — sessionId + models + modes (incl. `bypassPermissions`, `dontAsk`) + `available_commands_update` |

`initialize` always advertises `authMethods: [{id:"claude-login",
description:"Run \`claude /login\` in the terminal"}]` — the only auth
method claude-code-acp offers is interactive Claude Code OAuth.

### Root cause (epistemic tier: INFERENCE — not yet source-verified)

The sim *did* emit `available_commands_update` (session/new succeeded), so
the blocker is **not** the CLAUDECODE guard. claude-code-acp creates a
session with `ANTHROPIC_API_KEY` present but **session creation is not
gated on credentials**; the *prompt turn's* model invocation is. In the
clean Firegrid sandbox env (parent env wiped; only baseline +
`authorizedBindings` injected) claude-code-acp has no Claude Code OAuth
credential (`~/.claude`) and `ANTHROPIC_API_KEY` alone does not drive its
turn — so the turn fails and the process exits with no output.

NOT yet verified: exact agent-internal failure text. 14 stderr lines were
journaled to the durable `logs` target but the embedded durable-streams
server is gone (timeout run; no finalized bundle). Per span-quality rules
the payload is not in attributes.

**Next verification step (owed before this is decision-grade):** capture the
spawned child's stderr (raise `TINY_FIREGRID_TIMEOUT`, `simulate:tail`, or
run claude-code-acp through a full prompt turn under the exact sandbox env)
to confirm the turn-time auth failure text.

## Triage (FINDINGS_TRIAGE_RUBRIC)

**Category 2 — real production gap, boundary/wrong-shape.** Triage-question
answer: an agent vendor integrating a packaged OAuth/credential-file ACP
agent (claude-code-acp is the canonical one) under a Firegrid host hits this
for a real purpose, not test-only. The host env surface exposes only `env:`
secret `authorizedBindings`; it has **no seam to provision an agent's own
credential material** (OAuth token / credential file) into the sandbox.
codex-acp works only because it consumes `OPENAI_API_KEY` directly; the
shape is asymmetric and silently strands credential-file agents.

**Related (non-blocking): `tf-pgn`** (`tfind:054`, cat-2 — packaged-agent
baseline-env passthrough). Same family (sandbox spawn env is too narrow for
packaged agents); this finding is the credential-provisioning facet:
even *with* the baseline passthrough, an OAuth/credential-file agent still
cannot complete a turn. Not a workaround to copy — it is the finding.

**Substrate verdict:** Firegrid substrate is NOT the divergence — the
client→host→workflow→codec→local-process→ACP path is fully traced and
correct. The gap is the agent-credential-provisioning shape at the
host/sandbox boundary. Coordinator holds the gate; no self-merge.

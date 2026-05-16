# Dark Factory Hosted Smoke

This runbook records the hosted smoke path for the Dark Factory app after the
typed wait-source cutover.

The smoke exercises the app through `apps/factory/src/bin/live-smoke.ts`. That
entrypoint composes `DarkFactoryHostLive` directly, writes app-owned durable
facts/runs, creates or loads the planner session, starts the runtime, observes
runtime output, writes a permission response when a protocol permission request
appears, and reads the final app/runtime status.

## Environment

Required:

```sh
export DURABLE_STREAMS_BASE_URL="https://api.electric-sql.cloud/v1/stream/<service>"
export FIREGRID_DURABLE_STREAMS_TOKEN="<token>"
export FIREGRID_RUNTIME_NAMESPACE="factory-smoke-$(date +%Y%m%d%H%M%S)"
```

For Claude ACP:

```sh
export ANTHROPIC_API_KEY="<key>"
```

For Codex ACP:

```sh
export OPENAI_API_KEY="<key>"
```

Do not commit generated config files with secret values. The examples below
only reference environment bindings.

## Planner Configs

Claude ACP:

```json
{
  "planner": {
    "argv": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.34.1"],
    "agent": "claude-acp",
    "agentProtocol": "acp",
    "cwd": "/path/to/firegrid",
    "envBindings": [
      { "name": "ANTHROPIC_API_KEY", "ref": "env:ANTHROPIC_API_KEY" }
    ]
  },
  "providerCapabilities": []
}
```

Codex ACP:

```json
{
  "planner": {
    "argv": ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
    "agent": "codex-acp",
    "agentProtocol": "acp",
    "cwd": "/path/to/firegrid",
    "envBindings": [
      { "name": "OPENAI_API_KEY", "ref": "env:OPENAI_API_KEY" }
    ]
  },
  "providerCapabilities": []
}
```

Trigger shape:

```json
{
  "source": "linear.oauth",
  "externalEventKey": "manual-smoke-1",
  "externalEntityKey": "issue-manual-smoke-1",
  "eventType": "linear.issue.accepted",
  "repoHint": "gurdasnijor/firegrid",
  "payload": {
    "delivery": "manual-smoke",
    "title": "Dark Factory hosted smoke"
  }
}
```

Run:

```sh
pnpm --filter @firegrid/factory smoke:hosted \
  --config ./factory.config.json \
  --trigger ./trigger.json \
  --permission-timeout-ms 180000 \
  --next-output-timeout-ms 180000
```

## Evidence From 2026-05-16

The code baseline was PR #278, merged as `7b045ba0`.

CI proof for #278:

- Lint: passed
- Semgrep: passed
- Typecheck: passed
- Effect diagnostics: passed
- Tests: passed
- Local validation reported by the implementation lane included runtime,
  protocol, client, and factory package tests.

### Claude ACP

Command class:

```sh
pnpm --filter @firegrid/factory smoke:hosted \
  --config factory.config.json \
  --trigger trigger.json
```

The hosted smoke reached:

- accepted trigger;
- durable factory run row;
- planner `RuntimeContext` / session id;
- runtime start;
- ACP `Ready` output;
- ACP command/status output;
- durable runtime error output and stderr log rows.

Observed accepted output:

```json
{
  "step": "accepted",
  "factoryRunKey": "[\"linear.oauth\",\"issue-manual-smoke-20260516090628\"]",
  "factInserted": true,
  "runInserted": true
}
```

Observed durable runtime output included:

```json
{
  "_tag": "Ready",
  "capabilities": {
    "streamingText": true,
    "tools": true,
    "permissions": true,
    "multiTurn": true
  }
}
```

The model turn did not complete because the provider rejected the request:

```txt
ACP prompt failed
Internal error: API Error: 400 You have reached your specified API usage limits.
You will regain access on 2026-06-01 at 00:00 UTC.
```

That failure happened after ACP session startup and prompt delivery. It is an
external credential/quota blocker, not a Firegrid/factory plumbing failure.

### Codex ACP

Command class:

```sh
pnpm --filter @firegrid/factory smoke:hosted \
  --config factory.codex.config.json \
  --trigger trigger.codex.json
```

Observed accepted output:

```json
{
  "step": "accepted",
  "factoryRunKey": "[\"linear.oauth\",\"issue-codex-smoke-20260516093713\"]",
  "factInserted": true,
  "runInserted": true
}
```

Durable status inspection showed the Codex ACP planner produced runtime output
through the Firegrid path and completed a turn:

```json
{
  "sequence": 619,
  "event": {
    "_tag": "TurnComplete",
    "finishReason": "stop"
  }
}
```

This proves the hosted factory path can run a real ACP planner process and
journal model output. The current `smoke:hosted` script still expects a
permission-first planner, so the command did not finish with the built-in
`permission_request` / `permission_response` assertions when Codex chose to
answer without emitting a protocol `PermissionRequest`.

### ACP Permission Fixture

To prove the full permission-resume path independent of provider policy, a
temporary ACP stdio fixture agent was used with the same `smoke:hosted`
entrypoint. The fixture emits a protocol `PermissionRequest`, waits for the
runtime `PermissionResponse`, then emits a follow-up output.

Observed output:

```json
{
  "step": "permission_request",
  "permissionRequestId": "permission_id_C31IhagBqm1FMOGP",
  "toolUseId": "smoke-permission-tool",
  "sequence": 3
}
```

```json
{
  "step": "permission_response",
  "decision": {
    "_tag": "Allow",
    "optionId": "allow"
  }
}
```

```json
{
  "step": "next_output",
  "sequence": 4,
  "facts": 2,
  "ingressInputs": 2,
  "runtimeEvents": 7,
  "agentOutputs": 7
}
```

That proves the end-to-end Firegrid/factory permission path:

```txt
trigger fact
  -> factory run row
  -> planner RuntimeContext
  -> ACP PermissionRequest
  -> session PermissionResponse
  -> resumed ACP output
  -> app/runtime status projection
```

## Current Gaps

### Permission-First Assumption

`apps/factory/src/bin/live-smoke.ts` currently asserts a permission-first
planner:

```txt
accepted -> waitForPermissionRequest -> respondToFactoryPermission -> waitForNextAgentOutput
```

That is appropriate for validating permission resume, but real planners may
produce ordinary output or terminate without requesting permission. The next
smoke improvement should support two modes:

- `--mode permission`: require `PermissionRequest` and `PermissionResponse`;
- `--mode output`: require any next normalized agent output or terminal
  evidence.

### Public `src/run.ts` Entry Path

The current factory smoke composes `DarkFactoryHostLive` directly. That is
valid for proving app-owned facts plus the runtime host, but it does not use
the public `src/run.ts` command entrypoint.

The accepted path should be explicit about the boundary:

- factory accepted work enters through app-owned durable facts and factory run
  rows;
- `src/run.ts` owns the public runtime process entrypoint for a
  `RuntimeContext`;
- the shared substrate is launch config decoding, local-host bootstrap,
  runtime-context insert, initial prompt ingress, and `startRuntime`.

The next implementation should extract that shared run/start substrate from
`src/run.ts` into an internal command module, then have both `src/run.ts` and
`apps/factory/src/bin/live-smoke.ts` call it. That keeps the product trigger
boundary in factory while proving the runtime process path through the same
accepted public entrypoint logic.

Until that exists, the closest direct CLI rehearsal is:

```sh
pnpm firegrid -- run \
  --agent codex-acp \
  --agent-protocol acp \
  --secret-env OPENAI_API_KEY \
  --prompt "Emit one short planning status update, then stop." \
  -- npx -y @zed-industries/codex-acp@0.14.0
```

That proves `src/run.ts` can launch and journal a real ACP runtime context, but
it does not prove factory app-owned trigger/run rows. The hosted factory smoke
above proves the app boundary.

Do not route factory accepted triggers through `src/run.ts` directly. That
would collapse the product trigger boundary into the generic runtime CLI.

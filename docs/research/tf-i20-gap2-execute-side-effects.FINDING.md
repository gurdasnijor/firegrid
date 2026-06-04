# DELIVERY — tf-i20 Gap 2: execute provider side-effect substrate

Status authority: bead `tf-i20`. Governing contract:
`docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`. Follow-on to the
tf-0du finding which HALTed `execute` as non-additive.

## Delivered (full CI gate green; validated through the public surface)

The tf-0du halt said `execute` could not be wired additively because
`SandboxProvider` is excluded from the `HostRuntimeContextExecutionEnv`
deferred-capture type (TFIND-031). That halt was correct *for the sprawling
PR*. With a focused bead and the Gap-1 `CallerOwnedFactStreams`
optional-capability pattern established, the contract-clean seam is now
clear and was built:

- **Execution** `packages/host-sdk/src/host/agent-tool-host-live.ts`:
  `executeSandboxTool` / `executeSessionCapability` replace
  `unsupportedAgentTool`. `SandboxProvider` is acquired as an OPTIONAL
  capability via `Effect.serviceOption(SandboxProvider)` at the
  `RuntimeHostAgentToolHostLive` **layer-build** Effect.gen — it is
  composed in the host `namespaceScopedLayer` and is in scope there. It is
  **NOT** added to `HostRuntimeContextExecutionEnv` and **NOT** re-provided
  into the deferred child-context workflow capture, so the TFIND-031
  boundary the prior halt protected stays narrow. Provider-missing,
  input-decode-failure, and provider errors all `mapError →
  toolExecutionFailed`, surfaced as a `ToolResult` failure through the
  existing runtime-substrate executor catch-all (the failure-channel
  contract the vendored `@effect/ai` `Tool`/`Toolkit` sources define).
- **Host-side command shaping**: `execute`'s protocol input is
  sandbox-neutral `Schema.Unknown`; shaping it into a `SandboxCommand`
  (`{ argv, cwd?, envVars?, stdin? }`) is a host-execution concern
  (tool-host.ts docstring). Decode failures are actionable
  ToolExecutionFailed, never defects.
- **Binding/execution split preserved**: no change to
  `bindings/tools.ts`; no Effect AI handler registered; no client-sdk
  `execute` method (correctly absent from the client catalog).
  `lint:deps` reports no boundary violation.

## Self-contained sim (no configurations/ import)

`packages/firelab/src/simulations/execute-provider-side-effect-pipeline.ts`
— deterministic, agent-free stdio-jsonl child (no LLM): it emits one
`execute` ToolUse whose sandbox-neutral input is a real provider command,
the host runs it via `LocalProcessSandboxProvider`, and the child re-emits
the provider stdout (received back over the ToolResult stdin roundtrip) as
agent text so the driver observes the side-effect strictly through the
PUBLIC Firegrid client.

Run `2026-05-19T11-35-37-210Z`, status completed, signal proven:
`sawExecuteToolUse: true`, `sawProviderStdout: true`,
`resultText: "FIREGRID_EXECUTE_OBSERVED:FIREGRID_EXECUTE_SIDE_EFFECT_OK"`.
Spans confirm a real process ran: `firegrid.host.agent_tool.execute` +
`firegrid.agent_event_pipeline.source.local_process.execute` +
`firegrid.host.runtime_substrate.tool_use.execute`. Not papered.

## Net

Gap 2 (execute provider side-effects) delivered, contract-clean, full CI
gate green, validated end-to-end through the public surface. No HALT
condition hit — the optional-capability-at-build-time seam reaches
`SandboxProvider` without widening the protected deferred-capture
boundary. Remaining: tf-0du's other halt (session_cancel/close — needs a
durable session-lifecycle intent + reconcile design) is still its own
follow-on bead. Coordinator holds the gate; no self-merge.

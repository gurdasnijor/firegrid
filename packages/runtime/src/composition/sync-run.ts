// Runtime composition home for the firegrid run-config helpers used by
// the runtime-owned bin entrypoints (`bin/run.ts`, `bin/host.ts`,
// `bin/acp.ts`). Pure functions over protocol-owned schemas; no Effect,
// no Layer, no I/O. Relocated from the deleted host-sdk path
// `host-sdk/src/host/sync-run.ts`.
//
// Why this lives under `composition/`:
//   The values produced here (the durable `runtime` intent, the initial
//   `RuntimeIngressRequest`, the `firegridRunCreatedBy` constant) feed
//   into `composition/host-public.ts` (`startRuntime`,
//   `appendRuntimeIngress`) and the public sessions-create-or-load
//   channel. They are composition-shaped inputs, not transforms, not
//   table operations, not subscriber behaviour — they belong with the
//   other host composition seams the runtime/bin module assembles.
//
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5..8 contract:
//
//   argv  ──►  RawRunConfig  ──► Schema.decodeUnknown ──►  RunConfig
//                                                          │
//   RunConfig ──► runConfigToRuntimeContextIntent → durable RuntimeContext row
//             ──► runConfigToIngressRequest       → appendRuntimeIngress before startRuntime
//             ──► runConfigRequiresInput          → forces topology input=true

import {
  decodeLaunchConfig,
  local,
  normalizeRuntimeIntent,
  type LaunchConfig,
  type RuntimeContextIntent,
  type RuntimeEnvBinding,
} from "@firegrid/protocol/launch"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"

export type RunConfig = LaunchConfig
export const decodeRunConfig = decodeLaunchConfig

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
//
// Build the RuntimeContextIntent (the durable `runtime` block) from the
// validated config. Pure; no IO. The durable row is built by the host
// channel handler, which adds contextId, createdAt, and the host binding
// from the CurrentHostSession in scope.
export const runConfigToRuntimeContextIntent = (
  config: RunConfig,
): RuntimeContextIntent =>
  normalizeRuntimeIntent(local.jsonl({
    argv: [...config.agentArgv],
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.agentProtocol === undefined ? {} : { agentProtocol: config.agentProtocol }),
    ...(config.envBindings === undefined
      ? {}
      : { envBindings: config.envBindings.map((b): RuntimeEnvBinding => ({ name: b.name, ref: b.ref })) }),
    ...(config.mcpServers === undefined ? {} : { mcpServers: [...config.mcpServers] }),
  }))

export const firegridRunCreatedBy = "firegrid-run"

// Build the initial ingress request for the --prompt value, if any.
// Returns undefined when the config carries no prompt so the caller can
// skip the appendRuntimeIngress call entirely (and the runtime host
// doesn't need to enable input).
export const runConfigToIngressRequest = (
  config: RunConfig,
  contextId: string,
): RuntimeIngressRequest | undefined =>
  config.prompt === undefined
    ? undefined
    : {
      contextId,
      kind: "message",
      authoredBy: "client",
      // Plain string payloads are accepted by the local-process stdin
      // delivery encoder (textFromPayloadValue handles typeof === "string"
      // before falling back to JSON.stringify); the child sees the prompt
      // followed by a newline.
      payload: config.prompt,
      idempotencyKey: `firegrid-run-prompt:${contextId}`,
    }

// True iff the runtime host needs `inputEnabled: true`. Currently
// equivalent to "has --prompt", but expressed in terms of the decoded
// shape so future input sources (stdio passthrough, etc.) extend here.
export const runConfigRequiresInput = (config: RunConfig): boolean =>
  config.prompt !== undefined

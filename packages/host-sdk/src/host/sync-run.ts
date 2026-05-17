// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8
//
// Synchronous Firegrid run-config: the single Schema-decoded shape the
// firegrid:run binary produces from argv and that downstream pipeline
// steps consume:
//
//   argv  ──►  RawRunConfig  ──► Schema.decodeUnknown ──►  RunConfig
//                                                          │
//   RunConfig ──► runConfigToRuntimeContext   → durable RuntimeContext row
//             ──► runConfigToIngressRequest   → appendRuntimeIngress before startRuntime
//             ──► authorizedBindings          → RuntimeEnvResolverPolicy layer
//             ──► runConfigRequiresInput      → forces topology input=true
//
// Why a Schema DTO and not just a TS interface?
//   - Drift-proofing. Adding a new run-config field is one place: the
//     schema. If the parser forgets to populate it, decode fails loudly;
//     if a downstream builder forgets to consume it, types catch it.
//   - Branded validation. agentArgv non-emptiness, env-name shape on
//     binding pairs, and cwd non-emptiness are enforced before the
//     durable row is built.
//   - Test seams. Unit tests exercise the builders against a decoded
//     RunConfig without going through argv at all.

import {
  decodeLaunchConfig,
  local,
  normalizeRuntimeIntent,
  type RuntimeContextIntent,
  type RuntimeEnvBinding,
  type LaunchConfig,
} from "@firegrid/protocol/launch"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"

export type RunConfig = LaunchConfig
export const decodeRunConfig = decodeLaunchConfig

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
//
// Build the RuntimeContextIntent (the durable `runtime` block) from
// the validated config. Pure; no IO. The durable row is built by
// `RuntimeContextInsert`, which adds contextId, createdAt, and the
// host binding from the CurrentHostSession in scope. Splitting
// this here keeps the firegrid:run binary free of host-binding
// plumbing — the intent is the thing the binary owns, the bound row
// is the thing the host owns.
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

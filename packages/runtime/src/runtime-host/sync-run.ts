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
  RuntimeEnvBindingSchema,
  local,
  normalizeRuntimeIntent,
  type RuntimeContext,
  type RuntimeEnvBinding,
} from "@firegrid/protocol/launch"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"
import { Clock, Effect, Schema } from "effect"

// POSIX-ish env-var identifier shape — same regex the resolver enforces,
// duplicated locally so schema validation doesn't require pulling
// resolver internals into the protocol/CLI boundary.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const EnvVarName = Schema.String.pipe(
  Schema.filter((value) =>
    ENV_NAME_RE.test(value)
      ? undefined
      : `not a valid env-var identifier: ${value}`),
)

// (childEnvVarName, hostEnvVarName) pair. Authorization is over the
// exact pair so a row cannot route an authorized host env into an
// unapproved child target.
export const RunAuthorizedBindingSchema = Schema.Tuple(EnvVarName, EnvVarName)
export type RunAuthorizedBinding = Schema.Schema.Type<typeof RunAuthorizedBindingSchema>

export const RunConfigSchema = Schema.Struct({
  // The agent command (everything after `--`). Non-empty.
  agentArgv: Schema.Array(Schema.String).pipe(
    Schema.filter((argv) =>
      argv.length > 0 ? undefined : "agentArgv must be non-empty"),
  ),
  // RuntimeContext.runtime.config.cwd passthrough. Optional.
  cwd: Schema.optional(Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "cwd must be a non-empty path"),
  )),
  // If present, written as an initial RuntimeIngressTable input row
  // (kind: "message", authoredBy: "client") BEFORE startRuntime fires.
  // Delivered to the child via the existing local-process stdin
  // delivery — same path long-running runtimes use for live input.
  prompt: Schema.optional(Schema.String),
  // Durable env bindings persisted on RuntimeContext.runtime.config.envBindings.
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),
  // (target, source) pairs the runtime host has authorized for this
  // invocation. Each entry corresponds to one --secret-env grant.
  authorizedBindings: Schema.optional(Schema.Array(RunAuthorizedBindingSchema)),
})
export type RunConfig = Schema.Schema.Type<typeof RunConfigSchema>

export const decodeRunConfig = Schema.decodeUnknown(RunConfigSchema)

// Build the durable RuntimeContext row from the validated config.
// Pure aside from the createdAt clock; no IO.
export const runConfigToRuntimeContext = (
  config: RunConfig,
): Effect.Effect<RuntimeContext> =>
  Effect.map(Clock.currentTimeMillis, (millis): RuntimeContext => ({
    contextId: `ctx_${crypto.randomUUID()}`,
    createdAt: new Date(millis).toISOString(),
    createdBy: "firegrid-run",
    runtime: normalizeRuntimeIntent(local.jsonl({
      argv: [...config.agentArgv],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      ...(config.envBindings === undefined
        ? {}
        : { envBindings: config.envBindings.map((b): RuntimeEnvBinding => ({ name: b.name, ref: b.ref })) }),
    })),
  }))

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

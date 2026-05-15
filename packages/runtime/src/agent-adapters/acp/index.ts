/**
 * Status: target end-state for ACP agent integration.
 *
 * `AcpAgentAdapter` exposes `@effect/ai` `LanguageModel.Service`
 * (`generateText` / `streamText`) for an ACP child process. New
 * ACP work — including runtime-host integration when it lands —
 * should consume this module. The legacy
 * `packages/runtime/src/agent-codecs/acp/` codec produces the
 * Firegrid `AgentSession` event shape and is frozen for new
 * features; pure mapping helpers shared with the codec live in
 * `agent-codecs/acp/mapping.ts`.
 *
 * The runtime workflow does not consume this adapter today —
 * `runRuntimeContext` spawns child processes via
 * `LocalProcessSandboxProvider` and streams their raw stdout
 * without performing the ACP handshake. CLI-driven ACP lowering
 * (e.g. an `--agent codex-acp` flag in `src/run.ts`) is the open
 * surface where this adapter is expected to be consumed first;
 * see `docs/contributing/architecture-map.md` § "Known CLI gaps".
 */

export {
  AcpAdapterCapabilities,
  AcpAgentAdapter,
  type AcpAgentAdapterOptions,
} from "./adapter.ts"
export {
  acpSessionUpdateToStreamParts,
  acpStopReasonToFinishReason,
  promptToAcpContent,
} from "./mapping.ts"

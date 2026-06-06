// Host-side scenario constants. The driver is airgapped and re-declares the
// product contract it observes (session id + recorded L1 fact name).

export const HOST_SESSION_ID = "fluent-acp-real-spawn-session"
export const AGENT_LABEL = "firelab-fluent-acp-real-spawn"

// The real-agent lane is gated on this env var. Acceptance requires a REAL
// spawned ACP agent (claude-code-acp); there is NO fake fallback.
export const REAL_AGENT_ENV_KEY = "ANTHROPIC_API_KEY"

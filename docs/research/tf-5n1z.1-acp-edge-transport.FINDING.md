# tf-5n1z.1 ACP Edge Transport Finding

## Verdict

GREEN, narrow viability proof.

The tiny-firegrid `acp-edge-transport` spike validates `firegrid-zed-acp-stdio-external-agent.VALIDATION.4`: an external ACP client can connect to a Firegrid host-composed ACP stdio edge, create an ACP session, send multiple prompt turns, receive ACP `sessionUpdate` output, and receive `PromptResponse.stopReason=end_turn` from Firegrid `TurnComplete` evidence without waiting for the runtime process to exit.

Run evidence:

- `pnpm --filter @firegrid/tiny-firegrid simulate:run -- acp-edge-transport`
- run id: `2026-05-21T08-06-44-403Z__acp-edge-transport`
- `simulate:show`: 364 spans, 5 traces, 0 errored, sides `host=351 subprocess=7 driver=3 codec=2`
- `simulate:perf`: 221.9ms window, no idle gaps above threshold

## What The Spike Proved

The edge is host topology, not a new privileged top-level API. The sim host configures an edge topology and composes the ordinary `FiregridLocalHostLive` with the configured ACP stdio edge layer. The edge owns only the ACP stream projection. The edge uses the ACP SDK `AgentSideConnection` mechanics with injectable streams; the driver uses `ClientSideConnection` over in-memory streams to stand in for Zed or another ACP client.

The ACP agent implementation maps inbound ACP methods to the public Firegrid client/session surface:

| ACP method | Firegrid operation |
| --- | --- |
| `initialize` | Return ACP capabilities; no substrate mutation. |
| `newSession` | `firegrid.sessions.createOrLoad(...)` over the public callable session channel. ACP session id remains adapter-local and distinct from Firegrid session/context id. |
| `loadSession` | Future: `firegrid.sessions.attach(...)` plus transcript replay once ACP load-session is enabled. Not advertised in the spike. |
| `listSessions` | Future: public session discovery/projection query when the client surface exposes one. Not advertised in the spike. |
| `resumeSession` | Future: `firegrid.sessions.attach(...)` without transcript replay once ACP resume is enabled. Not advertised in the spike. |
| `closeSession` | Future: public session lifecycle/terminate control channel. Not advertised in the spike. |
| `prompt` | `session.prompt(...)`, `session.start()` on first turn, then `session.wait.forAgentOutput(...)` until normalized `TurnComplete`. |
| `sessionUpdate` | Firegrid normalized output projection rows are translated back to ACP `agent_message_chunk` / tool-call notifications. |
| `cancel` | Accepted as the ACP surface hook; production needs a cancel channel before this can be more than no-op/interrupt wiring. |
| `authenticate` | Local edge no-op for the spike; production can layer auth before session creation. |
| Provider/config/NES/document extension methods | Do not advertise until matching public Firegrid client/channel verbs exist. They must not tunnel to runtime or host internals. |

The two-turn driver is the key signal: the ACP connection and Firegrid session stay alive after the first `TurnComplete`, and the second prompt completes through the same ACP session. The driver now asserts the observed text comes from distinct turn 1 / turn 2 outputs, so the pass cannot be explained by stale first-turn observation. That is the semantic hang fix: prompt completion follows turn completion, not child process termination.

## Production Cutover Shape

The production contract should be a configurable host edge adapter/layer, for example `FiregridAcpStdioEdgeLive`, composed into host topology from a host-plane edge config. A CLI command should be a thin preset that builds host config with that ACP stdio edge and routes process stdin/stdout into it. The CLI helper is convenience, not the semantic API.

Recommended placement: a host-edge module below the host topology surface, not runtime internals and not the client-sdk root. The adapter may consume `@firegrid/client-sdk/firegrid` and public protocol channel contracts, but must not import host internals, runtime internals, DurableTable facades, workflow handles, or kernel internals.

The production cutover should add:

- Host config schema for enabling an ACP stdio edge and selecting stdin/stdout or injected streams.
- CLI serve/run preset that starts Firegrid as the ACP agent-side process for Zed/test clients.
- A real cancel mapping once a public session cancel/control channel exists. The spike accepts the ACP hook but does not claim cancel support.
- Permission request mapping from Firegrid `PermissionRequest` output to ACP `requestPermission`, then back through `session.permissions.respond(...)`.
- Stdout discipline tests proving only ACP frames are written to stdout and diagnostics go to stderr.

## Non-Goals Kept

This spike did not change `firegrid run` production semantics, did not introduce a new public Channel/Queue/Mailbox abstraction, did not add provider-specific channels, and did not reuse the existing `agentProtocol:acp` child-agent codec as the inbound edge. The child runtime in the sim uses `stdio-jsonl` only as a backing Firegrid session so the ACP edge can prove inbound client-to-host transport independently from host-to-child-agent transport.

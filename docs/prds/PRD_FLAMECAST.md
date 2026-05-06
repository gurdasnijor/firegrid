# PRD: Flamecast v4: Agents API

## Problem

Developers building internal agents need to run across different hosted agents, self-hosted harnesses, and customer-owned execution environments. Today, each option comes with a different API, lifecycle model, event stream, billing unit, sandbox model, and credential shape.

The practical result is lock-in at the integration layer:

1. **Hosted agents expose incompatible APIs.** Devin, Cursor, Anthropic Managed Agents, Factory Droid, Jules, and OpenHands all model sessions, capabilities, permissions, state, usage, and transcripts slightly differently.
2. **Customizability bottleneck enterprise adoption. (**[Tadas](https://www.notion.so/Tadas-357a0cc76127805e8189cfbb5c1edcac?pvs=21)) Production teams already have custom Docker images, internal package mirrors, CIs, VPN-only services, build caches, and secret stores. A hosted agent that requires one fixed execution environment forces those teams to recreate their stack inside the provider's cloud rather than use their own.

Keeping up with the next model drop is exhausting ([Suman Natarajan](https://www.notion.so/Suman-Natarajan-358a0cc7612780eeb0a2fb849261ed57?pvs=21), [Nikita Shamgunov](https://www.notion.so/Nikita-Shamgunov-358a0cc76127807d9997e14b1f7d85d8?pvs=21)), and teams want to stay *ahead of the curve*. We’re at a moment in time where companies have started realizing the value of local “Claude Code”, and want to move towards creating dark factories.

## Proposal

Flamecast is OpenRouter for agent providers. The goal is to make configuring agents feel like a batteries-included experience.

An **Agent Provider** is the backing service that executes an agent session, such as Devin, Cursor, Anthropic Managed Agents, Factory Droid, Jules, OpenHands, think, or a customer-owned harness. This mirrors the model-provider concept in Vercel AI Gateway, but the routed unit is a stateful agent session instead of a single model call.

Core concepts:

- **Session** is the stateful run. It owns lifecycle, transcript, callbacks, permissions, usage, and the normalized event history.
- **Event** is the standardized output unit across providers.
- **Agent Provider** is the backing service that executes a session.
- **Capabilities** are provider-agnostic requests for what the agent needs to do. They may include shell, file operations, browser control, MCPs, skills, custom HTTP bridges, sandboxes, or sub-agents.

To use Flamecast, a developer creates a **Session**, chooses an **Agent Provider**, and binds **Capabilities**. The goal is that swapping Agent Provider is a one-line code change, similar to swapping models on Vercel AI Gateway.

For the MVP, Flamecast exposes:

- A Sessions API for starting, steering, observing, and cancelling agent work.
- An `AgentSpec` schema for provider, model, instructions, capabilities, credentials, and provider-specific options.
- A standardized event contract across providers, with webhooks for status updates and orchestration.
- A TypeScript SDK for launching sessions and implementing Agent Providers.

## GTM Strategy

- Flamecast initially launches as a free product to gain mindshare.
- Users can BYOK for the MVP; later versions can support passthrough API pricing.
- Benchmarks are a key viral growth lever. Flamecast should rank different harnesses by their performance on relevant internal-agent benchmarks and showcase usage.
- There should be an open-source component that lets users run and understand the provider contract locally. The production/cloud-ready routing, event infrastructure, and managed service can remain proprietary.
- The business may later include billing for connectors, event infrastructure, or an end-user-facing [flamecast.com](http://flamecast.com/) product. Gaining usage comes first.

## Desired Developer Experience

The main path should feel like using a model gateway:

```tsx
import {
  Flamecast,
  Bash,
  Edit,
  MCP,
  Read,
  Skill,
  agent,
} from "@flamecast/sdk"

const fc = new Flamecast({ apiKey: process.env.FLAMECAST_API_KEY })

const session = await fc.sessions.create({
  agent: agent({
    provider: "anthropic-managed",
    model: "anthropic/claude-sonnet-4-6",
    instructions: "You write provider IRs for Smithery connectors.",
    providerOptions: { environmentId: "env_ir_author" },
    capabilities: [
	    Files(provider: "mesa"),
      Bash(),
      Read(),
      Edit(),
      MCP("linear", {
        url: "<https://api.smithery.ai/connect/acme/linear/mcp>",
        token: process.env.LINEAR_TOKEN,
      }),
      Skill("ir-author"),
    ],
  }),
  input: "Build the IR for service X.",
  callbackUrl: "<https://my-app.com/webhooks/agent>",
})
```

Swapping provider should only change the provider selection and provider-specific auth/options:

```tsx
const session = await fc.sessions.create({
  agent: agent({
    provider: "factory-droid",
    providerAuth: { factory: { apiKey: process.env.FACTORY_API_KEY } },
    model: "anthropic/claude-sonnet-4-6",
    instructions: "You write provider IRs for Smithery connectors.",
    capabilities: [Bash(), Read(), Edit(), Skill("ir-author")],
  }),
  input: "Build the IR for service X.",
})
```

If the provider cannot satisfy the requested behavior, Flamecast fails before execution:

```tsx
try {
  await fc.sessions.create({
    agent: agent({
      provider: "devin",
      model: "anthropic/claude-sonnet-4-6",
      instructions: "Use exactly this system prompt.",
      capabilities: [MCP("linear", { url: "...", token: "..." })],
    }),
    input: "Create the issue.",
  })
} catch (error) {
  // CompatibilityError:
  // - agent.model: provider does not expose model selection
  // - agent.instructions: provider does not support caller-provided instructions
  // - agent.capabilities[0]: provider does not support per-session MCP resources
}
```

## Capability Resolution Behavior

Capabilities are the developer-facing composition surface. A capability describes desired agent behavior, not a specific implementation.

Examples:

- `Bash()` means the agent needs command execution.
- `Read()` and `Edit()` mean the agent needs file access.
- `MCP("linear", ...)` means the agent needs access to a specific MCP server.
- `Skill("ir-author")` means the agent needs a context bundle or skill surface.
- `Browser()` means the agent needs browser control.
- A sandbox contributor such as ComputeSDK can provide execution and filesystem behavior when the selected provider supports injecting it.

If `capabilities` is omitted, Flamecast should infer the provider's sensible default capability set from the selected provider, model, instructions, and provider options. This keeps the simple path simple: a user can create a session with just provider, model, instructions, and input. Explicit `capabilities` are only needed when the developer wants a portable contract, additional resources, or a compatibility check before paying for a run.

When capabilities are explicit, Flamecast should auto-resolve them in this order:

1. Prefer the provider's native implementation.
2. Use an approved contributor implementation when native support is missing.
3. Use an external callback/bridge when the provider supports that injection path.
4. Fail before session creation when no compatible path exists.

The user should not need to understand the provider's internal tool model. They should see clear compatibility errors:

```
agent.capabilities[0] Bash:
  factory-droid can run shell commands natively.

agent.capabilities[1] Skill("ir-author"):
  devin does not support per-session skill bundles. Use repo instructions, remove the skill, or choose a provider with skill support.

agent.capabilities[2] Browser:
  compute-sdk can provide browser control, but anthropic-managed does not accept this contributor for the selected environment.
```

Provider swapping works when the new provider can still satisfy the same requested capabilities. It fails when the requested behavior cannot be preserved.

## Sessions API

Flamecast's public API and the Provider API use the same session contract. Flamecast is the aggregated provider: applications call Flamecast, Flamecast delegates to an Agent Provider, and provider events flow back through Flamecast as normalized Events.

```
GET    /providers
GET    /providers/:id
POST   /providers/:id/check

POST   /sessions
GET    /sessions
GET    /sessions/:id
POST   /sessions/:id/events
GET    /sessions/:id/events
POST   /sessions/:id/cancel
DELETE /sessions/:id
```

The MVP excludes `/agents`. Agents are defined inline as `AgentSpec` objects in `POST /sessions`.

```tsx
type SessionCreate = {
  agent: AgentSpec
  input?: string | ContentBlock[]
  callbackUrl?: string
  callbackEvents?: Array<"session.done" | "session.error" | "permission.required">
  permissions?: {
    mode: "auto" | "callback" | "client"
    default?: "allow" | "deny"
  }
  metadata?: Record<string, string>
}

type AgentSpec = {
  provider: AgentProviderRef
  model?: string
  instructions?: string
  capabilities?: CapabilitySpec[]
  contributors?: ContributorSpec[]
  providerOptions?: unknown
  providerAuth?: ProviderAuth
  metadata?: Record<string, string>
}

type AgentProviderRef =
  | "think"
  | "anthropic-managed"
  | "cursor"
  | "devin"
  | "factory-droid"
  | "openhands"
  | "jules"
```

## Events and Webhooks

Events are standardized across providers so applications can observe sessions without caring where they run.

```tsx
type Event =
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; capability?: string; toolName: string; toolUseId: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; output: unknown }
  | { type: "step_finish"; usage?: ModelUsage; finishReason?: string }
  | { type: "turn_started"; turnId: string }
  | {
      type: "turn_complete"
      turnId: string
      status: "done" | "input_required" | "error" | "cancelled"
      lastMessage?: string
      error?: { code: string; message: string }
      usage?: ProviderUsage
    }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; cause?: unknown }
```

Not every provider can expose every event. Opaque providers may only emit `user_message`, `assistant_message`, `turn_started`, and `turn_complete`. Flamecast should make that visible in provider metadata and should not fake tool-level events.

Applications can poll event history from Flamecast, but the orchestration path is callback-first:

```json
{
  "event": "session.done",
  "sessionId": "ses_123",
  "sequence": 42,
  "status": "done",
  "lastMessage": "Opened PR #17"
}
```

```json
{
  "event": "permission.required",
  "sessionId": "ses_123",
  "sequence": 18,
  "callId": "toolu_456",
  "capability": "Bash",
  "input": { "command": "pnpm deploy" }
}
```

Flamecast signs outbound callbacks using [Standard Webhooks](https://www.standardwebhooks.com/).

## Provider API

An Agent Provider is an HTTP service that implements the Provider API. Built-in providers and self-hosted providers use the same contract; the only difference is who operates the service.

Flamecast calls the Provider API to create and steer sessions. The provider posts events back to a Flamecast callback URL, and Flamecast stores those events for the public `GET /sessions/:id/events` API. This avoids relying on long-lived SSE streams for long-running agent work.

```
GET  <https://provider.example.com/manifest>
POST <https://provider.example.com/sessions>
GET  <https://provider.example.com/sessions/:id>
POST <https://provider.example.com/sessions/:id/events>
POST <https://provider.example.com/sessions/:id/cancel>
```

Session create:

```json
{
  "sessionId": "ses_123",
  "agent": {},
  "input": "Build the IR for service X.",
  "eventCallbackUrl": "<https://api.flamecast.dev/provider-events/ses_123>",
  "eventCallbackToken": "fc_evt_..."
}
```

Provider event callback:

```
POST <https://api.flamecast.dev/provider-events/ses_123>
Authorization: Bearer fc_evt_...
Content-Type: application/json
```

```json
{
  "sequence": 12,
  "event": {
    "type": "tool_call",
    "capability": "Bash",
    "toolUseId": "toolu_123",
    "input": { "command": "pnpm test" }
  }
}
```

`POST /sessions/:id/events` is the write path for all session input after creation: user messages, steering input, and permission decisions. This keeps provider-facing control flow under the same Events noun used by the public API.

Provider API behavior:

- Providers should accept caller-supplied `sessionId` for idempotent retries.
- Providers should assign monotonically increasing `sequence` numbers to callbacks.
- Providers should support steering and permission responses through `POST /sessions/:id/events`.
- Flamecast should expose the same normalized session/event shape regardless of the underlying provider.

## Provider Metadata

Provider metadata powers docs, SDK helpers, compatibility checks, and provider comparison pages.

Provider metadata should answer:

- Which models can be selected?
- Can caller instructions be supplied?
- Which capabilities can be satisfied natively?
- Which contributors can be accepted?
- Can events expose tool-level details, token usage, and cost?
- Does the provider support steering, cancellation, and permission requests?
- What provider-specific options and auth are required?

`POST /providers/:id/check` should return either "this session can run" or precise compatibility issues. It should not require the user to learn provider-specific quirks through failed runs.

## MVP Scope

The MVP focuses on the sharp primitive: sessions over swappable agent providers.

- `think` as the Flamecast-hosted provider.
- The three most popular hosted providers to start: `anthropic-managed`, `cursor`, and `devin`.
- BYOK for providers that require provider credentials.
- Callback-driven provider events.
- A benchmark/provider comparison surface.
- ComputeSDK or equivalent sandbox contributor spike to prove customizability.

## Product Principles

- **Sessions first.** The essential value is routing an agent run across providers.
- **Provider swap should be boring.** The app should keep the same session, event, and webhook integration when the provider changes.
- **Capabilities describe desired behavior.** Flamecast resolves how that behavior is implemented, or fails before execution with a clear compatibility error.
- **Callbacks over long-lived provider streams.** Provider sessions can run for a long time; provider-to-Flamecast events should be webhook-style.
- **Vercel AI Gateway ergonomics.** Choose a provider, specify a model, pass provider-specific options, and keep the rest of the integration stable.
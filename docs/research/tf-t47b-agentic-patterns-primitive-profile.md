# tf-t47b Agentic Patterns Primitive Profile

The agentic-patterns showcase launches participants through the public client
session surface and gives the agent only the locked runtime-context MCP
primitive profile.

## Ergonomic Launch

```ts
import { Firegrid, local } from "@firegrid/client-sdk/firegrid"

const firegrid = yield* Firegrid
const session = yield* firegrid.sessions.createOrLoad({
  externalKey: { source: "agentic-patterns", id: participantId },
  createdBy: "agentic-patterns.showcase",
  runtime: local.jsonl({
    argv: [process.execPath, "agent.js"],
    agentProtocol: "stdio-jsonl",
    runtimeContextMcp: { enabled: true },
  }),
})

yield* session.prompt({
  payload: "begin the coordination round",
  idempotencyKey: `participant:${participantId}:initial`,
})
yield* session.start()
```

This is the smallest launch shape the showcase should depend on:
`@firegrid/client-sdk/firegrid` plus a host-composed runtime-context MCP route.
It does not pass `@firegrid/host-sdk`, runtime, workflow-engine, DurableTable,
or raw Durable Streams handles through the app or agent surface. There is no
explicit materialization barrier: `prompt`/`start` internally await the
reflected context (tf-1r3h #587), and the public `whenReady` ceremony was
deleted in tf-2osu.

## Locked Agent Tool Surface

The primitive profile allowlist is exact:

| Tool | Channel direction |
| --- | --- |
| `wait_for` | ingress |
| `wait_for_any` | ingress |
| `send` | egress |
| `call` | callable |

Session creation, prompting, starting, and permission responses stay on public
client/session methods. The agent-visible MCP profile therefore does not expose
`sleep`, `schedule_me`, `execute`, `spawn`, `spawn_all`, `session_new`,
`session_prompt`, `session_cancel`, or `session_close`.

The implementation is an allowlist over the existing Firegrid Effect AI tool
bindings (`FiregridPrimitiveProfileToolkit`) and the same runtime-context MCP
server. It does not add a custom JSON-RPC router, a parallel tools/list
handler, or a new substrate registry.

## Showcase Assets

- Simulation: `packages/tiny-firegrid/src/simulations/agentic-patterns-primitive-profile/`
- Smoke: `packages/tiny-firegrid/test/agentic-patterns-primitive-profile.test.ts`
- Spec: `features/firegrid/agentic-patterns-primitive-profile.feature.yaml`

import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect, Ref } from "effect"
import type * as Scope from "effect/Scope"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const promptForFactoryLoop = [
  "Drive the dark-factory section 6 loop using the Firegrid tools available in this session.",
  "The app edge has already seeded the trigger fact for this run in the darkFactory.facts CallerFact stream.",
  "Use only the available Firegrid tool surface to plan, delegate, wait for external facts, and halt honestly.",
  "When the loop reaches a terminal state, write one line beginning with DARK_FACTORY_TERMINAL.",
  "If a needed step is not expressible or cannot proceed, write one line beginning with DARK_FACTORY_FINDING and name the missing public surface.",
].join("\n")

// tf-v7t: per-session agent cwd. The codec-adapter writes the project-
// local `.mcp.json` + `.claude/settings.json` here before the agent
// process spawns (per the tf-s8y verdict / PR #444). The directory must
// (a) exist and (b) be distinct per run so configuration files don't
// leak across runs or pollute the repo root.
const makeAgentCwd = (): string => {
  const dir = join(
    globalThis.process.cwd(),
    ".simulate",
    "agent-cwd",
    `dark-factory-${Date.now()}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

// tf-v7t follow-up (post-codec-rationalization trace inspection): the
// agent's claude-agent-acp wraps every MCP tool invocation in an ACP
// `session/request_permission` gate (acp-agent.js `canUseTool`
// callback). Firegrid's codec forwards that as a PermissionRequest
// observation on the agent-output stream; the driver is the policy
// authority — it MUST respond via `session.permissions.respond` or the
// agent waits forever and §6 never progresses past tool-1.
//
// This is the §6-live-tonight unblock. For a closed-harness sim with
// only Firegrid MCP tools (no security boundary), allow-everything is
// safe. `afterSequence` is threaded forward from each match so the
// projection-wait doesn't hot-loop on already-resolved permission
// rows — same discipline that tf-85bs lifts to wait.forAgentOutput.
// Returns `Effect<..., never, Scope>` so the forked fiber attaches to
// the DRIVER'S scope (the caller's Effect.gen scope), not an inner
// freshly-opened-then-closed scope. A previous version used
// `Effect.scoped` here which immediately closed the inner scope on
// return, killing the forked fiber before any permission request
// arrived — same mistake the runner-heartbeat had at first.
const forkAutoApprovePermissions = (
  session: {
    readonly wait: {
      readonly forPermissionRequest: (
        request: { readonly afterSequence?: number; readonly timeoutMs?: number },
      ) => Effect.Effect<unknown, unknown>
    }
    readonly permissions: {
      readonly respond: (
        request: { readonly permissionRequestId: string; readonly decision: { readonly _tag: "Allow" } },
      ) => Effect.Effect<unknown, unknown>
    }
  },
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const afterSequence = yield* Ref.make<number | undefined>(undefined)
    yield* Effect.forever(Effect.gen(function*() {
      const after = yield* Ref.get(afterSequence)
      const result = (yield* session.wait.forPermissionRequest({
        ...(after === undefined ? {} : { afterSequence: after }),
        timeoutMs: 15_000,
      })) as
        | { readonly matched: true; readonly request: { readonly permissionRequestId: string; readonly sequence: number } }
        | { readonly matched: false; readonly timedOut: true }
      if (result.matched) {
        yield* Ref.set(afterSequence, result.request.sequence)
        yield* session.permissions.respond({
          permissionRequestId: result.request.permissionRequestId,
          decision: { _tag: "Allow" as const },
        })
      }
    }))
  }).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )

export const darkFactoryDriver: Effect.Effect<
  void,
  unknown,
  Firegrid
> =
  // Effect.scoped wraps the driver body so the auto-approve fork
  // (forkScoped) attaches to a scope that lasts the lifetime of this
  // gen body. The body runs forever (while(true) at the bottom) so
  // the scope only closes on cancellation (sim timeout), which is
  // exactly when we want the forked fiber to die.
  Effect.scoped(Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const cwd = makeAgentCwd()

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory",
        id: "dark-factory",
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd,
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        // tf-v7t: marker triggers the codec-adapter's MCP URL
        // materialization AND `.mcp.json` write into `cwd`. Replaces the
        // prior ACP `_meta` `-alwaysload` alias injection — tools surface
        // to the agent under natural `mcp__firegrid__<tool>` names.
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    // Wait for the host reconciler to materialize the RuntimeContext row
    // before sending the prompt (codec-adapter's URL resolution +
    // .mcp.json write happens at start, which needs the row).
    yield* session.whenReady

    // Fork the permission auto-approver BEFORE start(). The agent's first
    // tool call hits the permission gate within seconds of start; the
    // handler must already be observing the output stream by then.
    yield* forkAutoApprovePermissions(session)

    yield* firegrid.sessions.prompt({
      sessionId: session.contextId,
      prompt: promptForFactoryLoop,
      inputId: "planner-prompt",
    })
    yield* session.start()

    while (true) {
      yield* session.wait.forAgentOutput({
        timeoutMs: 15_000,
      })
    }
  }))

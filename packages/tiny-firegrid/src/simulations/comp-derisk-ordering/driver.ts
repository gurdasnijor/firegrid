import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

// Real spawn-target fixture: the official ACP TypeScript SDK example agent,
// run as a genuine subprocess (real codec + real sandbox + real per-context
// output drain). No backdoor, no API key — it emits a deterministic sequence
// of session updates per prompt.
const fixtureArgv: ReadonlyArray<string> = [
  process.execPath,
  "--import",
  "tsx",
  "src/bin/fake-acp-agent-process.ts",
]

// Bounded settle after each public action. Progress is intentionally NOT gated
// on `session.wait.forAgentOutput` / `forPermissionRequest`: in the
// `FiregridHost` composition those read the PER-CONTEXT output stream (the
// §3.1 dead read — no writer feeds it), so they would never observe the
// host-wide rows. The host-wide observer (host.ts) is the real instrument; the
// settle just gives the real drain wall-clock to append.
const settle = Effect.sleep("4 seconds")

export const compDeriskOrderingDriver = Effect.scoped(
  Effect.gen(function*() {
    const firegrid = yield* Firegrid

    const launched = yield* firegrid.launch({
      requestedBy: "tiny-firegrid:comp-derisk-ordering",
      runtime: local.jsonl({
        agent: "official-acp-typescript-sdk-example",
        argv: fixtureArgv,
        cwd: process.cwd(),
        agentProtocol: "acp",
      }),
    })
    const session = yield* firegrid.sessions.attach({
      sessionId: launched.contextId,
    })
    yield* session.start()
    // Forked, non-blocking; reads the per-context path so may never fire, which
    // is fine — output rows (incl. any PermissionRequest) still land host-wide.
    yield* Effect.forkScoped(
      session.permissions.autoApprove("allow", { timeoutMs: 3_000 }),
    )

    // Turn 1 — the real agent emits its deterministic update sequence; the
    // host-wide observer records each row's (appendIndex, attempt, sequence).
    yield* Effect.exit(
      session.prompt({
        idempotencyKey: "derisk-ordering-turn-1",
        payload: { text: "First turn — emit output." },
      }),
    )
    yield* settle

    // Turn 2 — same session, same drain: sequence should continue monotonically
    // under one sequenceRef at the single (DEFAULT_ATTEMPT) attempt.
    yield* Effect.exit(
      session.prompt({
        idempotencyKey: "derisk-ordering-turn-2",
        payload: { text: "Second turn — emit more output." },
      }),
    )
    yield* settle

    // Second-drain probe through the PUBLIC surface: close (terminal ->
    // deregister -> per-context Scope.close stops/flushes the drain) then
    // re-prompt. If this re-spawns, a second drain (fresh sequenceRef = 0)
    // appears in the host-wide journal; the trace then shows whether its
    // append order interleaves with the prior drain's tail.
    const closeExit = yield* Effect.exit(session.close())
    const rePromptExit = yield* Effect.exit(
      session.prompt({
        idempotencyKey: "derisk-ordering-turn-3-postclose",
        payload: { text: "Post-close turn." },
      }),
    )
    yield* settle

    yield* Effect.annotateCurrentSpan({
      "firegrid.sim.context_id": launched.contextId,
      "firegrid.sim.close_exit": closeExit._tag,
      "firegrid.sim.postclose_reprompt_exit": rePromptExit._tag,
    })
  }),
)

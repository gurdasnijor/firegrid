/**
 * cap-4 CROSS-AGENT DELEGATION driver — re-establishes the deleted
 * inv5-cross-agent-event-choreography shape on the unified surface, using the
 * public `session_new` agent-tool (#831 / tf-0awo.32).
 *
 * Shape: a PLANNER agent (spawned in the parent RuntimeContext) calls
 * `session_new` to delegate to a CHILD agent; the child emits observable output;
 * the child RuntimeContext is correlated to the parent (its `createdBy` is
 * `mcp:<parentContextId>`, set by the runtime's session_new dispatch). The
 * driver observes the whole choreography through the PUBLIC client surface only.
 *
 * Methodology (packages/tiny-firegrid/docs/methodology.md): the driver imports
 * ONLY `@firegrid/client-sdk` (+ Effect), draws no verdict, returns an opaque
 * observation record, and emits a span tree — the trace + prose finding are the
 * deliverables. The host (host.ts) composes the real unified FiregridRuntime; no
 * backdoor — the only fixture is the deterministic stdio-jsonl spawn target named
 * below (no API key).
 *
 * This sim is also the live acceptance that #831's session_new lowering works
 * end-to-end: parent ToolUse(session_new) -> child context created + correlated
 * -> child observable output, all visible on the public surface and the trace.
 */

import {
  Firegrid,
  local,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect } from "effect"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loops through the public client wait/snapshot surface; methodology.md keeps this shape explicit. */

const CHILD_SENTINEL = "CROSS_AGENT_DELEGATION_CHILD"
const childMarker = "CROSS_AGENT_DELEGATION_CHILD_OBSERVED"
const sessionNewToolUseId = "cross-agent-delegation-session-new"

// One role-aware inline agent program. `session_new` reuses the PARENT's argv
// for the child (only swapping `agent`), so the SAME program runs as both roles
// and self-distinguishes from the prompt it receives:
//   - parent prompt (no sentinel)  -> emit a `session_new` tool_use delegating
//     to a child whose prompt carries CHILD_SENTINEL; on the tool_result, echo
//     the child context id as observable text, then end the turn.
//   - child prompt (carries CHILD_SENTINEL) -> emit one observable text marker
//     and end the turn.
// Protocol = stdio-jsonl (packages/runtime/src/sources/codecs/stdio-jsonl):
//   stdin  {type:"prompt"|"tool_result", ...}
//   stdout {type:"text"|"tool_use"|"turn_complete", ...}
const agentProgram = [
  "const NL = String.fromCharCode(10)",
  "const emit = v => process.stdout.write(JSON.stringify(v) + NL)",
  `const SENTINEL = ${JSON.stringify(CHILD_SENTINEL)}`,
  `const CHILD_MARKER = ${JSON.stringify(childMarker)}`,
  `const SESSION_NEW_ID = ${JSON.stringify(sessionNewToolUseId)}`,
  "let buffer = ''",
  "const guard = setTimeout(() => process.exit(0), 150000)",
  "const done = () => { clearTimeout(guard); process.exit(0) }",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', chunk => {",
  "  buffer += chunk",
  "  for (;;) {",
  "    const nl = buffer.indexOf(NL)",
  "    if (nl < 0) break",
  "    const line = buffer.slice(0, nl)",
  "    buffer = buffer.slice(nl + 1)",
  "    if (line.trim().length === 0) continue",
  "    let evt",
  "    try { evt = JSON.parse(line) } catch { continue }",
  "    if (!evt) continue",
  "    if (evt.type === 'prompt') {",
  "      if (JSON.stringify(evt).includes(SENTINEL)) {",
  "        emit({ type: 'text', text: CHILD_MARKER })",
  "        emit({ type: 'turn_complete', finishReason: 'stop' })",
  "        done()",
  "      } else {",
  "        emit({ type: 'tool_use', toolUseId: SESSION_NEW_ID, name: 'session_new', input: {",
  "          agentKind: 'cross-agent-delegation-child',",
  "          prompt: SENTINEL + ': emit your observable delegation marker, then stop',",
  "          options: { metadata: { role: 'cross-agent-delegation-child', correlationId: 'cross-agent-delegation' } }",
  "        } })",
  "      }",
  "    } else if (evt.type === 'tool_result' && evt.toolUseId === SESSION_NEW_ID) {",
  "      emit({ type: 'turn_complete', finishReason: 'stop' })",
  "      done()",
  "    }",
  "  }",
  "})",
].join("\n")

const parentArgv = [globalThis.process.execPath, "-e", agentProgram] as const

interface CrossAgentDelegationResult {
  readonly parentContextId: string
  readonly childContextId: string
  readonly sawSessionNewToolUse: boolean
  readonly observedChildCreatedBy: string
  readonly childCorrelatedToParent: boolean
  readonly childObservableOutputSeen: boolean
}

const fail = (message: string): Effect.Effect<never, string> => Effect.fail(message)

const textFromAgentOutput = (output: RuntimeAgentOutputObservation): string =>
  output.event._tag === "TextChunk" ? output.event.part.delta : ""

const textFromAgentOutputs = (
  outputs: ReadonlyArray<RuntimeAgentOutputObservation>,
): string => outputs.map(textFromAgentOutput).join("")

export const driver: Effect.Effect<
  CrossAgentDelegationResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const externalKey = {
    source: "tiny-firegrid.cross-agent-delegation",
    id: crypto.randomUUID(),
  }

  // 1. Bring up the PLANNER (parent) session over the public surface.
  const parent = yield* firegrid.sessions.createOrLoad({
    externalKey,
    runtime: local.jsonl({
      argv: [...parentArgv],
      agent: "tiny-firegrid-delegation-parent",
      // NB (finding): the unified codec adapter selects the stdio-jsonl codec on
      // `agentProtocol === "raw"` (codec-adapter.ts); the enum value
      // "stdio-jsonl" falls through to the ACP codec. The deterministic
      // tool_use/session_new agent protocol therefore requires "raw" here.
      agentProtocol: "raw",
      cwd: globalThis.process.cwd(),
    }),
    createdBy: "tiny-firegrid-simulation",
  })
  const parentContextId = parent.contextId
  const expectedCreatedBy = `mcp:${parentContextId}`

  yield* parent.prompt({
    payload: "cross-agent delegation: delegate to a child and confirm its output",
    idempotencyKey: `${externalKey.id}:parent-prompt`,
  })
  yield* parent.start()

  // Bounded windows so the driver HALTS cleanly with recorded observations
  // (methodology: the trace + finding are the deliverable; never spin to a
  // harness timeout). Total budget stays well under any sim --timeout-ms.
  const deadlineMs = (yield* Clock.currentTimeMillis) + 45_000

  // 2. Observe the planner delegate over the public surface: a session_new
  //    ToolUse. Forbid the non-delegation spawn surface. (The stdio-jsonl
  //    tool_result the agent receives is a {tool,input} call-echo, not the
  //    SessionHandle output, so the child id is NOT recoverable from the
  //    agent's output — see FINDING; the driver discovers the child via the
  //    session_new externalKey instead.)
  let parentAfter: number | undefined
  let sawSessionNewToolUse = false
  const observeDeadlineMs = (yield* Clock.currentTimeMillis) + 20_000
  while (!sawSessionNewToolUse) {
    if ((yield* Clock.currentTimeMillis) >= observeDeadlineMs) {
      return yield* fail("timed out waiting for planner session_new delegation ToolUse")
    }
    const next = yield* parent.wait.forAgentOutput({
      ...(parentAfter === undefined ? {} : { afterSequence: parentAfter }),
      timeoutMs: 10_000,
    })
    if (!next.matched) continue
    parentAfter = next.output.sequence
    const event = next.output.event
    if (event._tag === "ToolUse") {
      if (event.part.name === "session_new") sawSessionNewToolUse = true
      if (event.part.name === "spawn" || event.part.name === "spawn_all") {
        return yield* fail("delegation used the forbidden spawn surface, not session_new")
      }
    }
  }

  // 3. Address the delegated child RuntimeContext over the public read surface.
  //    The session_new dispatch created it under the externalKey
  //    `{ source: "firegrid.mcp.session_new", id: "<parentContextId>:<toolUseId>" }`
  //    (runtime/unified/mcp-host/tool-dispatch.ts), and a context id is
  //    `session:<source>:<externalKey.id>` — so the child id is derivable from
  //    the parent id + the (driver-owned) session_new toolUseId. Open it
  //    READ-ONLY (no createOrLoad) so the observed `createdBy` is the dispatch's
  //    own `mcp:<parentContextId>`, not the driver's.
  const childContextId =
    `session:firegrid.mcp.session_new:${parentContextId}:${sessionNewToolUseId}`

  // 4. Parent correlation + child observable output, observed via the public
  //    snapshot surface within a bounded window. Halting without these is a
  //    legitimate finding outcome (the trace shows how far the choreography
  //    got); we record what was observed rather than computing a pass/fail.
  let observedChildCreatedBy = ""
  let childObservableOutputSeen = false
  while ((yield* Clock.currentTimeMillis) < deadlineMs) {
    const snapshot = yield* firegrid.open(childContextId).snapshot.pipe(
      Effect.map(s => s),
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
    if (snapshot !== undefined) {
      observedChildCreatedBy = snapshot.context?.createdBy ?? observedChildCreatedBy
      if (textFromAgentOutputs(snapshot.agentOutputs).includes(childMarker)) {
        childObservableOutputSeen = true
      }
    }
    if (observedChildCreatedBy === expectedCreatedBy && childObservableOutputSeen) break
    yield* Effect.sleep("1 seconds")
  }

  const result: CrossAgentDelegationResult = {
    parentContextId,
    childContextId,
    sawSessionNewToolUse,
    observedChildCreatedBy,
    childCorrelatedToParent: observedChildCreatedBy === expectedCreatedBy,
    childObservableOutputSeen,
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.cross_agent_delegation.parent_context_id": result.parentContextId,
    "firegrid.cross_agent_delegation.child_context_id": result.childContextId,
    "firegrid.cross_agent_delegation.saw_session_new": result.sawSessionNewToolUse,
    "firegrid.cross_agent_delegation.child_created_by": result.observedChildCreatedBy,
    "firegrid.cross_agent_delegation.child_correlated_to_parent": result.childCorrelatedToParent,
    "firegrid.cross_agent_delegation.child_observable_output_seen": result.childObservableOutputSeen,
  })

  return result
}).pipe(
  Effect.withSpan("firegrid.cross_agent_delegation.driver", {
    kind: "client",
    attributes: {
      "firegrid.bead": "tf-0awo.31.3",
      "firegrid.simulation.intent": "cap4-cross-agent-delegation-session-new",
    },
  }),
)

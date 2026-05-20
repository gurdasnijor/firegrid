/**
 * INV-5 driver: brings up two distinct claude-agent-acp sessions — an
 * emitter and a waiter — via `firegrid.sessions.createOrLoad`, then
 * runs them SEQUENTIALLY: emitter first, fully to completion, then the
 * waiter.
 *
 * Why sequential, not concurrent: an initial fully-concurrent fan-out
 * (both `runSession` calls `Effect.fork`'d) surfaced an empirical
 * substrate gap: the host's `RuntimeControlRequestReconciler` processes
 * `startRequests` via `Effect.forEach(…)` with default concurrency=1,
 * and `claimAndRunRuntimeContextWorkflow` blocks until the workflow
 * terminates. Two concurrent sessions therefore leave the second
 * context's engine never activated (`dispatch_intent` records
 * `runtime_context.engine.active: false`), prompts queue against an
 * inactive engine, and the second subprocess never spawns. The
 * concurrent-peer variant of Slice C.2's `event(name)` thesis needs
 * multi-context engine activation as a separate substrate prerequisite
 * — see FINDING.md.
 *
 * The sequential shape still satisfies the bead's acceptance: (a) two
 * distinct claude-agent-acp processes exist (the second is spawned
 * after the first exits, but they remain separate processes with
 * separate context ids and PID lifetimes); (b) the wait_for satisfies
 * on the durable row the emitter left behind; (c) the trace shows the
 * event flow from emitter context → durable stream → waiter context;
 * (d) the choreography MECHANISM is validated — agents discovered each
 * other indirectly via the stream, with no driver-mediated handoff of
 * the event row, and no prompt naming the other agent.
 *
 * The wait_for here exercises the same pre-attach-scan pathway that
 * `wait-pre-attach-roundtrip` validated under tf-pra/tf-ovrk; INV-5's
 * incremental contribution is the two-distinct-process emit/observe
 * shape, plus the substrate finding above.
 */

import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import {
  Clock,
  Effect,
  Ref,
  Schedule,
} from "effect"
import {
  awaitInv5EmitMcpBase,
  inv5EventStreamName,
  inv5PlanReadyEventName,
} from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface; methodology.md keeps this shape explicit. */

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const emitterResultMarker = "INV5_EMIT_DONE"
const waiterResultMarker = "INV5_WAIT_OBSERVED"

const emitterPrompt = (emitMcpUrl: string, sessionId: string): string =>
  [
    "You have access to two MCP toolsets:",
    "  - the Firegrid runtime-context MCP (provides wait_for, session_close,"
    + " ...)",
    "  - the inv5 events MCP at " + emitMcpUrl + " (provides emit_event)",
    "",
    "Do exactly two tool calls in order, then stop.",
    "",
    "1. Call `emit_event` with this argument:",
    JSON.stringify(
      {
        name: inv5PlanReadyEventName,
        payload: { note: "tf-tg8q inv5 cross-agent choreography emit" },
      },
      null,
      2,
    ),
    "",
    "2. Emit one line: " + emitterResultMarker + ":<json> (using the"
    + " emit_event tool result as <json>).",
    "",
    "3. Call `session_close` with sessionId=" + sessionId + " to release"
    + " the host runtime context. This terminates this session's workflow"
    + " so the host can dispatch the next runtime context. Then stop.",
  ].join("\n")

const waiterPrompt = (sessionId: string): string =>
  [
    "You have a Firegrid runtime-context MCP toolset available, including"
    + " `wait_for` and `session_close`.",
    "",
    "Do exactly three tool calls in order, then stop.",
    "",
    "1. Call `wait_for` with this query:",
    JSON.stringify(
      {
        waitQuery: {
          source: { _tag: "CallerFact", stream: inv5EventStreamName },
          whereFields: { name: inv5PlanReadyEventName },
        },
        timeoutMs: 60_000,
      },
      null,
      2,
    ),
    "",
    "2. Emit one line: " + waiterResultMarker + ":<json> (using the"
    + " matched row as <json>).",
    "",
    "3. Call `session_close` with sessionId=" + sessionId + " to release"
    + " this session's runtime context. Then stop.",
  ].join("\n")

interface SessionResult {
  readonly contextId: string
  readonly observedToolNames: ReadonlyArray<string>
  readonly sawTargetToolCall: boolean
  readonly sawPermissionRequest: boolean
  readonly permissionsAllowed: number
  readonly sawResultMarker: boolean
  readonly sawTurnComplete: boolean
  readonly resultText: string
}

interface Inv5DriverResult {
  readonly emitter: SessionResult
  readonly waiter: SessionResult
}

interface RunSessionOptions {
  readonly sessionLabel: "emitter" | "waiter"
  readonly externalId: string
  readonly idempotencySuffix: string
  readonly prompt: (sessionId: string) => string
  readonly targetToolName: string
  readonly resultMarker: string
  readonly mcpServers: ReadonlyArray<
    { readonly name: string; readonly server: { readonly type: "url"; readonly url: string } }
  >
  readonly deadlineMs: number
}

const runSession = (firegrid: Firegrid["Type"], options: RunSessionOptions) =>
  Effect.gen(function* () {
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.inv5",
        id: options.externalId,
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        runtimeContextMcp: { enabled: true },
        mcpServers: options.mcpServers,
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: options.prompt(session.contextId),
      idempotencyKey: `inv5:${options.idempotencySuffix}:turn-1`,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    const observedToolNames = yield* Ref.make(new Set<string>())
    const permissionsAllowed = yield* Ref.make(0)
    const sawTargetToolCall = yield* Ref.make(false)
    const sawPermissionRequest = yield* Ref.make(false)
    const sawResultMarker = yield* Ref.make(false)
    const sawTurnComplete = yield* Ref.make(false)
    const resultText = yield* Ref.make("")
    let afterSequence: number | undefined

    while (
      !(yield* Ref.get(sawResultMarker))
      && !(yield* Ref.get(sawTurnComplete))
    ) {
      if ((yield* Clock.currentTimeMillis) >= options.deadlineMs) break
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      }).pipe(
        Effect.retry(
          Schedule.intersect(
            Schedule.spaced("1000 millis"),
            Schedule.recurs(5),
          ),
        ),
      )
      if (!next.matched) continue
      const observation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "ToolUse") {
        yield* Ref.update(observedToolNames, (set) => {
          const next = new Set(set)
          next.add(event.part.name)
          return next
        })
        if (
          event.part.name === options.targetToolName
          || event.part.name.endsWith(`__${options.targetToolName}`)
        ) {
          yield* Ref.set(sawTargetToolCall, true)
        }
      }
      if (event._tag === "PermissionRequest") {
        yield* Ref.set(sawPermissionRequest, true)
        const decision = yield* session.permissions.respond({
          permissionRequestId: event.permissionRequestId,
          decision: { _tag: "Allow", optionId: "allow" },
        }).pipe(Effect.either)
        if (decision._tag === "Right") {
          yield* Ref.update(permissionsAllowed, (n) => n + 1)
        }
      }
      if (event._tag === "TextChunk") {
        const updated = yield* Ref.updateAndGet(
          resultText,
          (current) => current + event.part.delta,
        )
        if (updated.includes(options.resultMarker)) {
          yield* Ref.set(sawResultMarker, true)
        }
      }
      if (event._tag === "TurnComplete") {
        yield* Ref.set(sawTurnComplete, true)
      }
    }

    const result: SessionResult = {
      contextId: session.contextId,
      observedToolNames: [...(yield* Ref.get(observedToolNames))].sort(),
      sawTargetToolCall: yield* Ref.get(sawTargetToolCall),
      sawPermissionRequest: yield* Ref.get(sawPermissionRequest),
      permissionsAllowed: yield* Ref.get(permissionsAllowed),
      sawResultMarker: yield* Ref.get(sawResultMarker),
      sawTurnComplete: yield* Ref.get(sawTurnComplete),
      resultText: yield* Ref.get(resultText),
    }
    return result
  }).pipe(
    Effect.withSpan(`inv5.driver.session.${options.sessionLabel}`, {
      kind: "internal",
      attributes: {
        "inv5.session.label": options.sessionLabel,
        "inv5.session.external_id": options.externalId,
        "inv5.session.target_tool": options.targetToolName,
      },
    }),
  )

export const inv5ChoreographyDriver: Effect.Effect<
  Inv5DriverResult,
  unknown,
  Firegrid
> = Effect.gen(function* () {
  const firegrid = yield* Firegrid
  const emitBase = yield* awaitInv5EmitMcpBase
  const mcpServers = [
    {
      name: "inv5-events",
      server: { type: "url" as const, url: emitBase.url },
    },
  ] as const

  const perSessionBudgetMs = 120_000

  // Sequential, not concurrent — see file header for the substrate gap
  // that gates concurrent multi-context engine activation. After the
  // emitter terminates, its engine is `registry.deregister`'d (per
  // host-sdk/src/host/commands.ts:99), freeing the reconciler to
  // process the waiter's start request.
  const emitter = yield* runSession(firegrid, {
    sessionLabel: "emitter",
    externalId: "inv5-emitter",
    idempotencySuffix: "emitter",
    prompt: (sessionId) => emitterPrompt(emitBase.url, sessionId),
    targetToolName: "emit_event",
    resultMarker: emitterResultMarker,
    mcpServers,
    deadlineMs: (yield* Clock.currentTimeMillis) + perSessionBudgetMs,
  })

  const waiter = yield* runSession(firegrid, {
    sessionLabel: "waiter",
    externalId: "inv5-waiter",
    idempotencySuffix: "waiter",
    prompt: (sessionId) => waiterPrompt(sessionId),
    targetToolName: "wait_for",
    resultMarker: waiterResultMarker,
    mcpServers,
    deadlineMs: (yield* Clock.currentTimeMillis) + perSessionBudgetMs,
  })

  yield* Effect.annotateCurrentSpan({
    "inv5.emitter.context_id": emitter.contextId,
    "inv5.emitter.saw_emit_event": emitter.sawTargetToolCall,
    "inv5.emitter.saw_result_marker": emitter.sawResultMarker,
    "inv5.waiter.context_id": waiter.contextId,
    "inv5.waiter.saw_wait_for": waiter.sawTargetToolCall,
    "inv5.waiter.saw_result_marker": waiter.sawResultMarker,
  })

  return { emitter, waiter }
}).pipe(
  Effect.withSpan("inv5.driver", {
    kind: "internal",
    attributes: {
      "inv5.stream.name": inv5EventStreamName,
      "inv5.event.name": inv5PlanReadyEventName,
    },
  }),
)

/* eslint-enable local/no-fixed-polling */

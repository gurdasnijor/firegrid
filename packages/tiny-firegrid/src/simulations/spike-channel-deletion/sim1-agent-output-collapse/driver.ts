/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public channel-routed wait surface; the finding records the observed convergence. */
import {
  Firegrid,
  local,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  isSim1ExpectedEvent,
  recordSim1Observations,
  sim1EventSignature,
  sim1ExternalKey,
  sim1ObservationsSnapshot,
  sim1ObserverPaths,
  sim1SignaturesText,
  sim1Token,
  type Sim1EventSignature,
  type Sim1ObserverPath,
} from "./observation-state.ts"

interface Sim1Artifact {
  readonly verdict: "GREEN"
  readonly contextId: string
  readonly rewrittenPath: "session.wait.forAgentOutput"
  readonly observations: Record<Sim1ObserverPath, ReadonlyArray<Sim1EventSignature>>
}

const artifactRoot = path.resolve(
  fileURLToPath(
    new URL("../../../../.simulate/sim1-agent-output-collapse/", import.meta.url),
  ),
)

const promptRetry = Effect.retry(
  Schedule.intersect(Schedule.spaced("1000 millis"), Schedule.recurs(60)),
)

const deterministicAgentCode = () =>
  [
    `const token=${JSON.stringify(sim1Token)};`,
    "console.log(JSON.stringify({type:'text',text:token+':one'}));",
    "console.log(JSON.stringify({type:'text',text:token+':two'}));",
    "console.log(JSON.stringify({type:'turn_complete',finishReason:'stop'}));",
    "setTimeout(() => process.exit(0), 250);",
  ].join("")

const writeArtifact = (
  artifact: Sim1Artifact,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(artifactRoot, { recursive: true })
      await writeFile(
        path.join(artifactRoot, "latest.json"),
        JSON.stringify(artifact, null, 2) + "\n",
        "utf8",
      )
    },
    catch: cause => cause,
  })

const collectClientWaitPath = (
  session: FiregridSessionHandle,
): Effect.Effect<ReadonlyArray<Sim1EventSignature>, unknown> =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + 60_000
    const events: Array<Sim1EventSignature> = []
    let afterSequence: number | undefined

    while (events.length < 3) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.fail(new Error(
          `timed out waiting for session.wait.forAgentOutput; observed ${sim1SignaturesText(events)}`,
        ))
      }
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 10_000,
      })
      if (!next.matched) continue
      afterSequence = next.output.sequence
      if (isSim1ExpectedEvent(next.output)) {
        events.push(sim1EventSignature(next.output))
      }
    }

    return events
  })

const waitForHostObservers = (
  expected: ReadonlyArray<Sim1EventSignature>,
): Effect.Effect<Record<Sim1ObserverPath, ReadonlyArray<Sim1EventSignature>>, unknown> =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + 60_000
    const expectedText = sim1SignaturesText(expected)

    while ((yield* Clock.currentTimeMillis) < deadline) {
      const snapshot = yield* sim1ObservationsSnapshot
      const complete = sim1ObserverPaths.every(path =>
        sim1SignaturesText(snapshot.get(path) ?? []) === expectedText,
      )
      if (complete) {
        return Object.fromEntries(
          sim1ObserverPaths.map(path => [path, snapshot.get(path) ?? []]),
        ) as Record<Sim1ObserverPath, ReadonlyArray<Sim1EventSignature>>
      }
      yield* Effect.sleep("250 millis")
    }

    const snapshot = yield* sim1ObservationsSnapshot
    return yield* Effect.fail(new Error(
      `host observers did not converge to ${expectedText}; current=${
        sim1ObserverPaths
          .map(path => `${path}=${sim1SignaturesText(snapshot.get(path) ?? [])}`)
          .join(" ")
      }`,
    ))
  })

export const sim1AgentOutputCollapseDriver: Effect.Effect<
  Sim1Artifact,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: sim1ExternalKey,
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "--input-type=module",
          "-e",
          deterministicAgentCode(),
        ],
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: "sim1 agent-output collapse deterministic turn",
      idempotencyKey: "sim1-agent-output-collapse:turn-1",
    }).pipe(promptRetry)
    yield* session.start()

    const clientEvents = yield* collectClientWaitPath(session)
    yield* recordSim1Observations("session.wait.forAgentOutput", clientEvents)
    const observations = yield* waitForHostObservers(clientEvents)
    const artifact: Sim1Artifact = {
      verdict: "GREEN",
      contextId: session.contextId,
      rewrittenPath: "session.wait.forAgentOutput",
      observations,
    }

    yield* writeArtifact(artifact)
    yield* Effect.logInfo("sim1 agent-output parallel paths collapsed").pipe(
      Effect.withSpan("firegrid.simulation.sim1.agent_output_collapse.verdict", {
        kind: "internal",
        attributes: {
          "firegrid.simulation.verdict": artifact.verdict,
          "firegrid.simulation.rewritten_path": artifact.rewrittenPath,
          "firegrid.simulation.event_signatures": sim1SignaturesText(clientEvents),
          "firegrid.context.id": session.contextId,
        },
      }),
    )

    return artifact
  })

/* eslint-enable local/no-fixed-polling */

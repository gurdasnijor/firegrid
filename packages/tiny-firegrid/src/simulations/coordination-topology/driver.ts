import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Chunk, Effect, Stream } from "effect"
import { agenticPatternsExternalKey } from "../agentic-patterns-primitive-profile/profile.ts"
import {
  awaitCoordinationTopologyApi,
  coordinationTopologyItemCount,
  coordinationTopologyWorkerCount,
  type CoordinationDispatchRow,
  type CoordinationItemEventRow,
  type CoordinationReportRow,
  type CoordinationScoreRow,
  type CoordinationTopologyApi,
  type CoordinationTopologyArm,
} from "./host.ts"

interface Participant {
  readonly label: string
  readonly sessionId: string
  readonly contextId: string
}

interface ArmResult {
  readonly arm: CoordinationTopologyArm
  readonly participants: ReadonlyArray<Participant>
  readonly score: CoordinationScoreRow
}

interface CoordinationTopologyResult {
  readonly verdict: "GREEN"
  readonly itemCount: number
  readonly workerCount: number
  readonly arms: ReadonlyArray<ArmResult>
}

interface BenchItem {
  readonly itemId: string
  readonly value: number
}

const benchItems: ReadonlyArray<BenchItem> = [
  { itemId: "item-1", value: 2 },
  { itemId: "item-2", value: 3 },
  { itemId: "item-3", value: 5 },
]

const nowIso = (): string => new Date().toISOString()

const scoreId = (runId: string, arm: CoordinationTopologyArm): string =>
  `${runId}:${arm}:score`

const itemNumber = (itemId: string): number =>
  Number.parseInt(itemId.replace("item-", ""), 10)

const workerForItem = (
  itemId: string,
  workerIds: ReadonlyArray<string>,
): string =>
  workerIds[(itemNumber(itemId) - 1) % workerIds.length] ?? workerIds[0] ?? "worker-0"

const participantExternalId = (
  api: CoordinationTopologyApi,
  arm: CoordinationTopologyArm,
  label: string,
): string => `${api.runId}:${arm}:${label}`

const launchParticipant = (
  firegrid: Firegrid["Type"],
  api: CoordinationTopologyApi,
  arm: CoordinationTopologyArm,
  label: string,
): Effect.Effect<Participant, unknown> =>
  Effect.gen(function*() {
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: agenticPatternsExternalKey(
        participantExternalId(api, arm, label),
      ),
      createdBy: "tf-1fcd.coordination-topology",
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "--version",
        ],
        agentProtocol: "stdio-jsonl",
        runtimeContextMcp: { enabled: true },
      }),
    })
    yield* session.whenReady
    yield* session.prompt({
      payload: `tf-1fcd ${arm} participant ${label}`,
      idempotencyKey: `tf-1fcd:${api.runId}:${arm}:${label}:initial`,
    })
    yield* session.start()
    return {
      label,
      sessionId: session.sessionId,
      contextId: session.contextId,
    }
  }).pipe(
    Effect.withSpan("coordination_topology.participant.launch", {
      kind: "client",
      attributes: {
        "coordination.arm": arm,
        "coordination.participant": label,
      },
    }),
  )

const appendItemEvents = (
  api: CoordinationTopologyApi,
  arm: CoordinationTopologyArm,
  producedBy: string,
): Effect.Effect<ReadonlyArray<CoordinationItemEventRow>, unknown> =>
  Effect.forEach(benchItems, item => {
    const row: CoordinationItemEventRow = {
      eventId: `${api.runId}:${arm}:${item.itemId}:ready`,
      runId: api.runId,
      arm,
      itemId: item.itemId,
      value: item.value,
      producedBy,
      createdAt: nowIso(),
    }
    return api.channels.itemEvents.binding.append(row).pipe(Effect.as(row))
  })

const waitForReports = (
  api: CoordinationTopologyApi,
  arm: CoordinationTopologyArm,
  expected: number,
) =>
  api.channels.reports.binding.stream.pipe(
    Stream.filter(row => row.runId === api.runId && row.arm === arm),
    Stream.take(expected),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
    Effect.timeoutFail({
      duration: "10 seconds",
      onTimeout: () => new Error(`timed out waiting for ${arm} reports`),
    }),
  )

const waitForDispatches = (
  api: CoordinationTopologyApi,
  workerId: string,
  expected: number,
) =>
  api.channels.dispatches.binding.stream.pipe(
    Stream.filter(row => row.runId === api.runId && row.workerId === workerId),
    Stream.take(expected),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
    Effect.timeoutFail({
      duration: "10 seconds",
      onTimeout: () => new Error(`timed out waiting for dispatches: ${workerId}`),
    }),
  )

const waitForPeerItemEvents = (
  api: CoordinationTopologyApi,
  arm: CoordinationTopologyArm,
  workerId: string,
  workerIds: ReadonlyArray<string>,
) => {
  const expected = benchItems.filter(item =>
    workerForItem(item.itemId, workerIds) === workerId,
  ).length
  return api.channels.itemEvents.binding.stream.pipe(
    Stream.filter(row =>
      row.runId === api.runId
      && row.arm === arm
      && workerForItem(row.itemId, workerIds) === workerId,
    ),
    Stream.take(expected),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
    Effect.timeoutFail({
      duration: "10 seconds",
      onTimeout: () => new Error(`timed out waiting for peer events: ${workerId}`),
    }),
  )
}

const reportFromAction = (
  api: CoordinationTopologyApi,
  input: {
    readonly arm: CoordinationTopologyArm
    readonly itemId: string
    readonly value: number
    readonly workerId: string
    readonly participantId: string
    readonly path: ReadonlyArray<string>
  },
): Effect.Effect<CoordinationReportRow, unknown> =>
  Effect.gen(function*() {
    const action = yield* api.channels.workerAction.binding.call({
      arm: input.arm,
      itemId: input.itemId,
      inputValue: input.value,
      workerId: input.workerId,
      participantId: input.participantId,
    })
    const row: CoordinationReportRow = {
      reportId: `${api.runId}:${input.arm}:${input.itemId}:${input.workerId}:report`,
      runId: api.runId,
      arm: input.arm,
      itemId: input.itemId,
      workerId: input.workerId,
      resultValue: action.resultValue,
      path: [...input.path],
      createdAt: nowIso(),
    }
    yield* api.channels.reports.binding.append(row)
    return row
  })

const writeScore = (
  api: CoordinationTopologyApi,
  input: {
    readonly arm: CoordinationTopologyArm
    readonly workerCount: number
    readonly dispatchCount: number
    readonly reports: ReadonlyArray<CoordinationReportRow>
    readonly topology: string
  },
): Effect.Effect<CoordinationScoreRow, unknown> => {
  const row: CoordinationScoreRow = {
    scoreId: scoreId(api.runId, input.arm),
    runId: api.runId,
    arm: input.arm,
    itemCount: coordinationTopologyItemCount,
    workerCount: input.workerCount,
    dispatchCount: input.dispatchCount,
    reportCount: input.reports.length,
    totalResultValue: input.reports.reduce(
      (total, report) => total + report.resultValue,
      0,
    ),
    topology: input.topology,
  }
  return api.writeScore(row).pipe(
    Effect.zipRight(api.getScore(row.scoreId)),
  )
}

const runMonolithicArm = (
  firegrid: Firegrid["Type"],
  api: CoordinationTopologyApi,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    const participant = yield* launchParticipant(firegrid, api, "monolithic", "solo")
    // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.1
    // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.2
    yield* appendItemEvents(api, "monolithic", participant.contextId)
    yield* Effect.forEach(benchItems, item =>
      reportFromAction(api, {
        arm: "monolithic",
        itemId: item.itemId,
        value: item.value,
        workerId: "solo",
        participantId: participant.contextId,
        path: ["solo"],
      }))
    const reports = yield* waitForReports(api, "monolithic", benchItems.length)
    const score = yield* writeScore(api, {
      arm: "monolithic",
      workerCount: 1,
      dispatchCount: 0,
      reports,
      topology: "one participant processes the item-event channel directly",
    })
    const result: ArmResult = {
      arm: "monolithic",
      participants: [participant],
      score,
    }
    return result
  }).pipe(
    Effect.withSpan("coordination_topology.arm.monolithic", {
      kind: "internal",
      attributes: {
        "coordination.arm": "monolithic",
        "coordination.items": benchItems.length,
      },
    }),
  )

const runWorker = (
  api: CoordinationTopologyApi,
  participant: Participant,
  expected: number,
): Effect.Effect<ReadonlyArray<CoordinationReportRow>, unknown> =>
  Effect.gen(function*() {
    const dispatches = yield* waitForDispatches(api, participant.label, expected)
    return yield* Effect.forEach(dispatches, dispatch =>
      reportFromAction(api, {
        arm: "orchestrated",
        itemId: dispatch.itemId,
        value: dispatch.value,
        workerId: participant.label,
        participantId: participant.contextId,
        path: ["supervisor", participant.label],
      }))
  }).pipe(
    Effect.withSpan("coordination_topology.participant.worker", {
      kind: "internal",
      attributes: {
        "coordination.arm": "orchestrated",
        "coordination.participant": participant.label,
        "coordination.expected_dispatches": expected,
      },
    }),
  )

const runOrchestratedArm = (
  firegrid: Firegrid["Type"],
  api: CoordinationTopologyApi,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    const supervisor = yield* launchParticipant(
      firegrid,
      api,
      "orchestrated",
      "supervisor",
    )
    const workerLabels = Array.from(
      { length: coordinationTopologyWorkerCount },
      (_, index) => `worker-${index + 1}`,
    )
    const workers = yield* Effect.forEach(workerLabels, label =>
      launchParticipant(firegrid, api, "orchestrated", label))
    yield* appendItemEvents(api, "orchestrated", supervisor.contextId)
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.2
    const dispatches = yield* Effect.forEach(benchItems, item => {
      const row: CoordinationDispatchRow = {
        dispatchId: `${api.runId}:orchestrated:${item.itemId}:dispatch`,
        runId: api.runId,
        arm: "orchestrated",
        itemId: item.itemId,
        value: item.value,
        supervisorId: supervisor.contextId,
        workerId: workerForItem(item.itemId, workerLabels),
        createdAt: nowIso(),
      }
      return api.channels.dispatches.binding.append(row).pipe(Effect.as(row))
    })
    yield* Effect.forEach(workers, worker => {
      const expected = dispatches.filter(dispatch =>
        dispatch.workerId === worker.label,
      ).length
      return runWorker(api, worker, expected)
    }, { concurrency: "unbounded" })
    const reports = yield* waitForReports(api, "orchestrated", benchItems.length)
    const score = yield* writeScore(api, {
      arm: "orchestrated",
      workerCount: workers.length,
      dispatchCount: dispatches.length,
      reports,
      topology: "supervisor writes dispatch rows; workers emit reports",
    })
    const result: ArmResult = {
      arm: "orchestrated",
      participants: [supervisor, ...workers],
      score,
    }
    return result
  }).pipe(
    Effect.withSpan("coordination_topology.arm.orchestrated", {
      kind: "internal",
      attributes: {
        "coordination.arm": "orchestrated",
        "coordination.items": benchItems.length,
        "coordination.workers": coordinationTopologyWorkerCount,
      },
    }),
  )

const runPeer = (
  api: CoordinationTopologyApi,
  participant: Participant,
  workerIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<CoordinationReportRow>, unknown> =>
  Effect.gen(function*() {
    const events = yield* waitForPeerItemEvents(
      api,
      "choreographed",
      participant.label,
      workerIds,
    )
    return yield* Effect.forEach(events, event =>
      reportFromAction(api, {
        arm: "choreographed",
        itemId: event.itemId,
        value: event.value,
        workerId: participant.label,
        participantId: participant.contextId,
        path: ["shared-item-events", participant.label],
      }))
  }).pipe(
    Effect.withSpan("coordination_topology.participant.peer", {
      kind: "internal",
      attributes: {
        "coordination.arm": "choreographed",
        "coordination.participant": participant.label,
      },
    }),
  )

const runChoreographedArm = (
  firegrid: Firegrid["Type"],
  api: CoordinationTopologyApi,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    const peerLabels = Array.from(
      { length: coordinationTopologyWorkerCount },
      (_, index) => `peer-${index + 1}`,
    )
    const peers = yield* Effect.forEach(peerLabels, label =>
      launchParticipant(firegrid, api, "choreographed", label))
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.3
    yield* appendItemEvents(api, "choreographed", "shared-bench")
    yield* Effect.forEach(peers, peer => runPeer(api, peer, peerLabels), {
      concurrency: "unbounded",
    })
    const reports = yield* waitForReports(api, "choreographed", benchItems.length)
    const score = yield* writeScore(api, {
      arm: "choreographed",
      workerCount: peers.length,
      dispatchCount: 0,
      reports,
      topology: "peers partition shared item-event rows without dispatch",
    })
    const result: ArmResult = {
      arm: "choreographed",
      participants: peers,
      score,
    }
    return result
  }).pipe(
    Effect.withSpan("coordination_topology.arm.choreographed", {
      kind: "internal",
      attributes: {
        "coordination.arm": "choreographed",
        "coordination.items": benchItems.length,
        "coordination.workers": coordinationTopologyWorkerCount,
      },
    }),
  )

export const coordinationTopologyDriver: Effect.Effect<
  CoordinationTopologyResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const api = yield* awaitCoordinationTopologyApi
  const monolithic = yield* runMonolithicArm(firegrid, api)
  const orchestrated = yield* runOrchestratedArm(firegrid, api)
  const choreographed = yield* runChoreographedArm(firegrid, api)
  const arms = [monolithic, orchestrated, choreographed]

  // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.1
  // agentic-patterns-coordination-topology.OBSERVABILITY.1
  // agentic-patterns-coordination-topology.OBSERVABILITY.2
  // agentic-patterns-coordination-topology.OBSERVABILITY.3
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.1
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.2
  yield* Effect.annotateCurrentSpan({
    "coordination.verdict": "GREEN",
    "coordination.item_count": coordinationTopologyItemCount,
    "coordination.worker_count": coordinationTopologyWorkerCount,
    "coordination.score_rows": arms.length,
    "coordination.total_result_value": arms
      .map(arm => arm.score.totalResultValue)
      .join(","),
  })

  const result: CoordinationTopologyResult = {
    verdict: "GREEN",
    itemCount: coordinationTopologyItemCount,
    workerCount: coordinationTopologyWorkerCount,
    arms,
  }
  return result
}).pipe(
  Effect.withSpan("coordination_topology.driver", {
    kind: "internal",
  }),
)

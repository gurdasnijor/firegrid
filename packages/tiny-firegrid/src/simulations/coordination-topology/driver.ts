import {
  Firegrid,
  local,
  type RuntimeAgentOutputObservation,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { agenticPatternsExternalKey } from "../agentic-patterns-primitive-profile/profile.ts"
import {
  coordinationTopologyClaimsTarget,
  coordinationTopologyDispatchTarget,
  coordinationTopologyItemCount,
  coordinationTopologyItemEventsTarget,
  coordinationTopologyReportsTarget,
  coordinationTopologyScoresTarget,
  coordinationTopologyWorkerActionTarget,
  coordinationTopologyWorkerCount,
  type CoordinationScoreRow,
  type CoordinationTopologyArm,
} from "./host.ts"

interface Participant {
  readonly label: string
  readonly sessionId: string
  readonly contextId: string
  readonly marker: ParticipantMarker
  readonly toolNames: ReadonlyArray<string>
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

interface ParticipantMarker {
  readonly role: ParticipantRole
  readonly arm: CoordinationTopologyArm
  readonly participantId: string
  readonly reports: number
  readonly dispatches: number
  readonly claims: number
  readonly actions: number
  readonly scores: number
  readonly toolNames: ReadonlyArray<string>
  readonly score?: CoordinationScoreRow
}

type ParticipantRole =
  | "seed"
  | "monolithic"
  | "orchestrator-dispatch"
  | "worker"
  | "orchestrator-score"
  | "peer"
  | "peer-score"

interface ParticipantConfig {
  readonly role: ParticipantRole
  readonly runId: string
  readonly arm: CoordinationTopologyArm
  readonly participantId: string
  readonly items: ReadonlyArray<BenchItem>
  readonly workerIds: ReadonlyArray<string>
  readonly peerIds: ReadonlyArray<string>
  readonly createdBy: string
}

const benchItems: ReadonlyArray<BenchItem> = [
  { itemId: "item-1", value: 2 },
  { itemId: "item-2", value: 3 },
  { itemId: "item-3", value: 5 },
]

const channels = {
  claims: coordinationTopologyClaimsTarget,
  dispatches: coordinationTopologyDispatchTarget,
  itemEvents: coordinationTopologyItemEventsTarget,
  reports: coordinationTopologyReportsTarget,
  scores: coordinationTopologyScoresTarget,
  workerAction: coordinationTopologyWorkerActionTarget,
} as const

const markerPrefix = "COORDINATION_TOPOLOGY_DONE:"

const workerIds = Array.from(
  { length: coordinationTopologyWorkerCount },
  (_, index) => `worker-${index + 1}`,
)

const peerIds = Array.from(
  { length: coordinationTopologyWorkerCount },
  (_, index) => `peer-${index + 1}`,
)

const scoreForMarker = (
  marker: ParticipantMarker,
  arm: CoordinationTopologyArm,
): Effect.Effect<CoordinationScoreRow, Error> => {
  if (marker.score === undefined) {
    return failParticipant(
      marker.participantId,
      `participant did not emit ${arm} score`,
    )
  }
  return Effect.succeed(marker.score)
}

const participantExternalId = (
  runId: string,
  arm: CoordinationTopologyArm,
  label: string,
): string => `${runId}:${arm}:${label}`

const textDelta = (
  observation: RuntimeAgentOutputObservation,
): string | undefined =>
  observation._tag === "TextChunk" ? observation.event.part.delta : undefined

const parseMarker = (text: string): ParticipantMarker | undefined => {
  if (!text.startsWith(markerPrefix)) return undefined
  return JSON.parse(text.slice(markerPrefix.length)) as ParticipantMarker
}

const failParticipant = (
  label: string,
  message: string,
): Effect.Effect<never, Error> =>
  Effect.fail(new Error(`${label}: ${message}`))

const waitForParticipantMarker = (
  session: FiregridSessionHandle,
  label: string,
): Effect.Effect<{
  readonly marker: ParticipantMarker
  readonly toolNames: ReadonlyArray<string>
}, unknown> =>
  Effect.gen(function*() {
    const toolNames: Array<string> = []
    while (true) {
      const output = yield* session.wait.forAgentOutput({ timeoutMs: 20_000 })
      if (!output.matched) {
        return yield* failParticipant(label, "timed out waiting for done marker")
      }
      if (output.output._tag === "ToolUse" && output.output.toolName !== undefined) {
        toolNames.push(output.output.toolName)
      }
      const markerText = textDelta(output.output)
      if (markerText !== undefined) {
        const marker = parseMarker(markerText)
        if (marker !== undefined) return { marker, toolNames }
      }
    }
  })

const deterministicAgentSource = (config: ParticipantConfig): string => `
const readline = require("node:readline");
const config = ${JSON.stringify(config)};
const channels = ${JSON.stringify(channels)};
const markerPrefix = ${JSON.stringify(markerPrefix)};
let sequence = 0;
let pending = new Map();
let steps = [];
let cursor = 0;
const marker = {
  role: config.role,
  arm: config.arm,
  participantId: config.participantId,
  reports: 0,
  dispatches: 0,
  claims: 0,
  actions: 0,
  scores: 0,
  toolNames: []
};
const reports = [];
const claims = [];

const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const nowIso = () => new Date().toISOString();
const itemNumber = itemId => Number.parseInt(itemId.replace("item-", ""), 10);
const indexOf = (values, value) => values.indexOf(value);
const workerForItem = itemId => {
  const index = (itemNumber(itemId) - 1) % config.workerIds.length;
  return config.workerIds[index] || config.workerIds[0] || "worker-0";
};
const peerShouldClaim = itemId => {
  const peerIndex = indexOf(config.peerIds, config.participantId);
  if (peerIndex < 0) return false;
  return (itemNumber(itemId) - 1) % config.peerIds.length === peerIndex;
};

const finish = () => {
  marker.toolNames = Array.from(new Set(marker.toolNames));
  emit({ type: "text", text: markerPrefix + JSON.stringify(marker) });
  emit({ type: "turn_complete", finishReason: "stop" });
  setTimeout(() => process.exit(0), 500);
};
const fail = message => {
  emit({ type: "text", text: "COORDINATION_TOPOLOGY_ERROR:" + message });
  emit({ type: "turn_complete", finishReason: "error" });
  setTimeout(() => process.exit(1), 500);
};
const next = () => {
  const step = steps[cursor++];
  if (step === undefined) {
    finish();
    return;
  }
  step();
};
const tool = (name, input, onResult) => {
  const toolUseId = config.participantId + ":" + (++sequence) + ":" + name;
  marker.toolNames.push(name);
  pending.set(toolUseId, onResult);
  emit({ type: "tool_use", toolUseId, name, input });
};
const matched = (content, label) => {
  if (content && content.matched === true) return content.event;
  fail("timed out waiting for " + label);
};
const addStep = step => steps.push(step);
const waitItem = (item, onEvent) => tool("wait_for", {
  channel: channels.itemEvents,
  match: { runId: config.runId, arm: config.arm, itemId: item.itemId },
  timeoutMs: 10000
}, content => {
  onEvent(matched(content, "item " + item.itemId));
});
const sendReport = (item, workerId, resultValue, path, done) => {
  const report = {
    reportId: config.runId + ":" + config.arm + ":" + item.itemId + ":" + workerId + ":report",
    runId: config.runId,
    arm: config.arm,
    itemId: item.itemId,
    workerId,
    resultValue,
    path,
    createdAt: nowIso()
  };
  reports.push(report);
  tool("send", { channel: channels.reports, payload: report }, () => {
    marker.reports += 1;
    done();
  });
};
const runActionAndReport = (item, value, workerId, path, done) => {
  tool("call", {
    channel: channels.workerAction,
    request: {
      runId: config.runId,
      arm: config.arm,
      itemId: item.itemId,
      inputValue: value,
      workerId,
      participantId: config.participantId
    }
  }, action => {
    marker.actions += 1;
    sendReport(item, workerId, action.resultValue, path, done);
  });
};
const sendScore = (topology, workerCount, dispatchCount, claimCount, rows) => {
  const score = {
    scoreId: config.runId + ":" + config.arm + ":score",
    runId: config.runId,
    arm: config.arm,
    itemCount: config.items.length,
    workerCount,
    dispatchCount,
    claimCount,
    reportCount: rows.length,
    totalResultValue: rows.reduce((total, row) => total + row.resultValue, 0),
    topology
  };
  tool("send", { channel: channels.scores, payload: score }, () => {
    marker.scores += 1;
    marker.score = score;
    next();
  });
};
const addSeedSteps = () => {
  for (const item of config.items) {
    addStep(() => tool("send", {
      channel: channels.itemEvents,
      payload: {
        eventId: config.runId + ":" + config.arm + ":" + item.itemId + ":ready",
        runId: config.runId,
        arm: config.arm,
        itemId: item.itemId,
        value: item.value,
        producedBy: config.participantId,
        createdAt: nowIso()
      }
    }, next));
  }
};
const addMonolithicSteps = () => {
  for (const item of config.items) {
    addStep(() => waitItem(item, event => runActionAndReport(
      item,
      event.value,
      config.participantId,
      ["solo"],
      next
    )));
  }
  addStep(() => sendScore(
    "one participant consumes item events and reports every item",
    1,
    0,
    0,
    reports
  ));
};
const addOrchestratorDispatchSteps = () => {
  for (const item of config.items) {
    addStep(() => waitItem(item, event => {
      const dispatch = {
        dispatchId: config.runId + ":orchestrated:" + item.itemId + ":dispatch",
        runId: config.runId,
        arm: "orchestrated",
        itemId: item.itemId,
        value: event.value,
        supervisorId: config.participantId,
        workerId: workerForItem(item.itemId),
        createdAt: nowIso()
      };
      tool("send", { channel: channels.dispatches, payload: dispatch }, () => {
        marker.dispatches += 1;
        next();
      });
    }));
  }
};
const addWorkerSteps = () => {
  for (const item of config.items) {
    addStep(() => tool("wait_for", {
      channel: channels.dispatches,
      match: {
        runId: config.runId,
        arm: "orchestrated",
        itemId: item.itemId,
        workerId: config.participantId
      },
      timeoutMs: 250
    }, content => {
      if (!content || content.matched !== true) {
        next();
        return;
      }
      runActionAndReport(item, content.event.value, config.participantId, [
        "supervisor",
        config.participantId
      ], next);
    }));
  }
};
const addOrchestratorScoreSteps = () => {
  for (const item of config.items) {
    addStep(() => tool("wait_for", {
      channel: channels.reports,
      match: { runId: config.runId, arm: "orchestrated", itemId: item.itemId },
      timeoutMs: 10000
    }, content => {
      reports.push(matched(content, "report " + item.itemId));
      next();
    }));
  }
  addStep(() => sendScore(
    "supervisor dispatches rows; workers observe assignments and report",
    config.workerIds.length,
    config.items.length,
    0,
    reports
  ));
};
const addPeerSteps = () => {
  for (const item of config.items) {
    addStep(() => tool("wait_for_any", {
      channels: [
        {
          channel: channels.itemEvents,
          match: { runId: config.runId, arm: "choreographed", itemId: item.itemId }
        },
        {
          channel: channels.claims,
          match: {
            runId: config.runId,
            arm: "choreographed",
            itemId: item.itemId,
            decision: "claimed"
          }
        }
      ],
      timeoutMs: 10000
    }, content => {
      if (!content || content.timedOut === true) fail("timed out waiting for choreographed item " + item.itemId);
      const event = content.channel === channels.itemEvents ? content.result : undefined;
      const value = event && typeof event.value === "number" ? event.value : item.value;
      const decision = peerShouldClaim(item.itemId) ? "claimed" : "observed";
      const claim = {
        claimId: config.runId + ":choreographed:" + item.itemId + ":" + config.participantId + ":" + decision,
        runId: config.runId,
        arm: "choreographed",
        itemId: item.itemId,
        workerId: config.participantId,
        value,
        decision,
        createdAt: nowIso()
      };
      claims.push(claim);
      tool("send", { channel: channels.claims, payload: claim }, () => {
        marker.claims += decision === "claimed" ? 1 : 0;
        if (decision !== "claimed") {
          next();
          return;
        }
        runActionAndReport(item, value, config.participantId, [
          "shared-item-events",
          "claim:" + config.participantId
        ], next);
      });
    }));
  }
};
const addPeerScoreSteps = () => {
  for (const item of config.items) {
    addStep(() => tool("wait_for", {
      channel: channels.claims,
      match: {
        runId: config.runId,
        arm: "choreographed",
        itemId: item.itemId,
        decision: "claimed"
      },
      timeoutMs: 10000
    }, content => {
      claims.push(matched(content, "claim " + item.itemId));
      next();
    }));
  }
  for (const item of config.items) {
    addStep(() => tool("wait_for", {
      channel: channels.reports,
      match: { runId: config.runId, arm: "choreographed", itemId: item.itemId },
      timeoutMs: 10000
    }, content => {
      reports.push(matched(content, "report " + item.itemId));
      next();
    }));
  }
  addStep(() => sendScore(
    "peers discover item events, emit claim rows, and report local claims",
    config.peerIds.length,
    0,
    claims.length,
    reports
  ));
};
const buildSteps = () => {
  if (config.role === "seed") addSeedSteps();
  if (config.role === "monolithic") addMonolithicSteps();
  if (config.role === "orchestrator-dispatch") addOrchestratorDispatchSteps();
  if (config.role === "worker") addWorkerSteps();
  if (config.role === "orchestrator-score") addOrchestratorScoreSteps();
  if (config.role === "peer") addPeerSteps();
  if (config.role === "peer-score") addPeerScoreSteps();
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let event;
  try {
    event = JSON.parse(line);
  } catch (error) {
    fail("malformed input: " + String(error));
    return;
  }
  if (event.type === "prompt") {
    buildSteps();
    next();
    return;
  }
  if (event.type === "tool_result") {
    const handler = pending.get(event.toolUseId);
    pending.delete(event.toolUseId);
    if (event.isError) fail("tool failed: " + event.name + " " + JSON.stringify(event.content));
    if (handler === undefined) fail("unexpected tool result: " + event.toolUseId);
    handler(event.content);
  }
});
`

const launchParticipant = (
  firegrid: Firegrid["Type"],
  runId: string,
  arm: CoordinationTopologyArm,
  role: ParticipantRole,
  label: string,
): Effect.Effect<Participant, unknown> =>
  Effect.gen(function*() {
    const config: ParticipantConfig = {
      role,
      runId,
      arm,
      participantId: label,
      items: benchItems,
      workerIds,
      peerIds,
      createdBy: "tf-1fcd.coordination-topology",
    }
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: agenticPatternsExternalKey(
        participantExternalId(runId, arm, label),
      ),
      createdBy: config.createdBy,
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "-e",
          deterministicAgentSource(config),
        ],
        agentProtocol: "stdio-jsonl",
        runtimeContextMcp: { enabled: true },
      }),
    })
    yield* session.whenReady
    yield* session.prompt({
      payload: JSON.stringify({
        task: "tf-1fcd.coordination-topology",
        runId,
        arm,
        role,
        label,
      }),
      idempotencyKey: `tf-1fcd:${runId}:${arm}:${label}:initial`,
    })
    yield* session.start()
    const observed = yield* waitForParticipantMarker(session, label)

    yield* Effect.annotateCurrentSpan({
      "coordination.arm": arm,
      "coordination.participant": label,
      "coordination.role": role,
      "coordination.tool_names": observed.toolNames.join(","),
      "coordination.reports": observed.marker.reports,
      "coordination.dispatches": observed.marker.dispatches,
      "coordination.claims": observed.marker.claims,
      "coordination.actions": observed.marker.actions,
      "coordination.scores": observed.marker.scores,
    })

    return {
      label,
      sessionId: session.sessionId,
      contextId: session.contextId,
      marker: observed.marker,
      toolNames: observed.toolNames,
    }
  }).pipe(
    Effect.withSpan("coordination_topology.participant.run", {
      kind: "client",
      attributes: {
        "coordination.arm": arm,
        "coordination.participant": label,
        "coordination.role": role,
      },
    }),
  )

const seedArm = (
  firegrid: Firegrid["Type"],
  runId: string,
  arm: CoordinationTopologyArm,
): Effect.Effect<Participant, unknown> =>
  launchParticipant(firegrid, runId, arm, "seed", `${arm}-seed`)

const runMonolithicArm = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    yield* seedArm(firegrid, runId, "monolithic")
    // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.1
    // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.2
    // agentic-patterns-coordination-topology.BENCH_SUBSTRATE.3
    const solo = yield* launchParticipant(
      firegrid,
      runId,
      "monolithic",
      "monolithic",
      "solo",
    )
    const score = yield* scoreForMarker(solo.marker, "monolithic")
    return {
      arm: "monolithic" as const,
      participants: [solo],
      score,
    }
  }).pipe(
    Effect.withSpan("coordination_topology.arm.monolithic", {
      kind: "internal",
      attributes: {
        "coordination.arm": "monolithic",
        "coordination.items": benchItems.length,
      },
    }),
  )

const runOrchestratedArm = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    yield* seedArm(firegrid, runId, "orchestrated")
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.2
    const dispatcher = yield* launchParticipant(
      firegrid,
      runId,
      "orchestrated",
      "orchestrator-dispatch",
      "supervisor-dispatch",
    )
    const workers = yield* Effect.forEach(workerIds, workerId =>
      launchParticipant(firegrid, runId, "orchestrated", "worker", workerId))
    const scorer = yield* launchParticipant(
      firegrid,
      runId,
      "orchestrated",
      "orchestrator-score",
      "supervisor-score",
    )
    const score = yield* scoreForMarker(scorer.marker, "orchestrated")
    return {
      arm: "orchestrated" as const,
      participants: [dispatcher, ...workers, scorer],
      score,
    }
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

const runChoreographedArm = (
  firegrid: Firegrid["Type"],
  runId: string,
): Effect.Effect<ArmResult, unknown> =>
  Effect.gen(function*() {
    yield* seedArm(firegrid, runId, "choreographed")
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.3
    // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.4
    const peers = yield* Effect.forEach(peerIds, peerId =>
      launchParticipant(firegrid, runId, "choreographed", "peer", peerId))
    const scorer = yield* launchParticipant(
      firegrid,
      runId,
      "choreographed",
      "peer-score",
      "peer-score",
    )
    const score = yield* scoreForMarker(scorer.marker, "choreographed")
    return {
      arm: "choreographed" as const,
      participants: [...peers, scorer],
      score,
    }
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
  const runId = `coordination-topology-${crypto.randomUUID()}`
  const monolithic = yield* runMonolithicArm(firegrid, runId)
  const orchestrated = yield* runOrchestratedArm(firegrid, runId)
  const choreographed = yield* runChoreographedArm(firegrid, runId)
  const arms = [monolithic, orchestrated, choreographed]

  // agentic-patterns-coordination-topology.TOPOLOGY_ARMS.1
  // agentic-patterns-coordination-topology.OBSERVABILITY.1
  // agentic-patterns-coordination-topology.OBSERVABILITY.2
  // agentic-patterns-coordination-topology.OBSERVABILITY.3
  // agentic-patterns-coordination-topology.OBSERVABILITY.4
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.1
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.2
  // agentic-patterns-coordination-topology.PUBLIC_SURFACE.3
  yield* Effect.annotateCurrentSpan({
    "coordination.verdict": "GREEN",
    "coordination.item_count": coordinationTopologyItemCount,
    "coordination.worker_count": coordinationTopologyWorkerCount,
    "coordination.score_rows": arms.length,
    "coordination.total_result_value": arms
      .map(arm => arm.score.totalResultValue)
      .join(","),
    "coordination.participant_evidence": arms
      .flatMap(arm => arm.participants.map(participant =>
        `${participant.label}:${participant.marker.toolNames.join("+")}`))
      .join("|"),
  })

  return {
    verdict: "GREEN" as const,
    itemCount: coordinationTopologyItemCount,
    workerCount: coordinationTopologyWorkerCount,
    arms,
  }
}).pipe(
  Effect.withSpan("coordination_topology.driver", {
    kind: "internal",
  }),
)

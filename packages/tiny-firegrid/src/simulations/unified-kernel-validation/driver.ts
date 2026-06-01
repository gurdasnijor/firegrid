import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

const fixtureArgv: ReadonlyArray<string> = [
  process.execPath,
  "--import",
  "tsx",
  "src/bin/fake-acp-agent-process.ts",
]

const runExampleAgentScenario =
  Effect.scoped(Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const launched = yield* firegrid.launch({
      requestedBy: "tiny-firegrid:official-acp-example",
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
    yield* session.permissions.autoApprove("allow", { timeoutMs: 10_000 })
    yield* session.prompt({
      idempotencyKey: "tiny-firegrid-unified-kernel-validation-official-acp-example",
      payload: {
        text: "Validate the production ACP path through the official SDK example agent.",
      },
    })
    const waitResult = yield* session.wait.forAgentOutput({
      timeoutMs: 12_000,
    })
    const snapshot = yield* launched.snapshot
    return {
      contextId: launched.contextId,
      matched: waitResult.matched,
      runCount: snapshot.runs.length,
      eventCount: snapshot.events.length,
      outputCount: snapshot.agentOutputs.length,
    }
  }))

export const unifiedKernelValidationDriver = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const scenario = yield* runExampleAgentScenario

  yield* Effect.annotateCurrentSpan({
    "firegrid.ukv.client_metadata_count": firegrid.channels.metadata.length,
    "firegrid.ukv.context_id": scenario.contextId,
    "firegrid.ukv.output_matched": scenario.matched,
    "firegrid.ukv.snapshot_run_count": scenario.runCount,
    "firegrid.ukv.snapshot_event_count": scenario.eventCount,
    "firegrid.ukv.snapshot_output_count": scenario.outputCount,
    "firegrid.ukv.factory_host": true,
    "firegrid.ukv.codec": "acp",
    "firegrid.ukv.spawn_target": "src/bin/fake-acp-agent-process.ts",
    "firegrid.ukv.agent_source":
      "agentclientprotocol/typescript-sdk/src/examples/agent.ts",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.unified_kernel_validation.driver", {
    kind: "internal",
  }),
)

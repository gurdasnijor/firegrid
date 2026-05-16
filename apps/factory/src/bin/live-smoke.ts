import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, ParseResult, Schema } from "effect"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import {
  acceptAndStartFactoryTrigger,
  readFactoryRunStatus,
  respondToFactoryPermission,
  waitForNextAgentOutput,
  waitForPermissionRequest,
} from "../host.ts"
import type { PermissionDecision } from "@firegrid/protocol/agent-tools"
import { decodeFactoryConfig } from "../config.ts"
import { DarkFactoryTriggerSchema } from "../tables.ts"
import { factoryHostLayerFromConfig } from "./env.ts"

const parseJson = (raw: string, name: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new Error(`${name} must be valid JSON`, { cause })
  }
}

const readTrigger = (input: {
  readonly triggerFile?: string
  readonly triggerJson?: string
}) => {
  if (input.triggerFile !== undefined && input.triggerJson !== undefined) {
    throw new Error("pass only one of --trigger or --trigger-json")
  }
  if (input.triggerFile !== undefined) {
    return parseJson(readFileSync(input.triggerFile, "utf8"), input.triggerFile)
  }
  if (input.triggerJson !== undefined) {
    return parseJson(input.triggerJson, "--trigger-json")
  }
  throw new Error("pass --trigger <file.json> or --trigger-json '<json>'")
}

const readFactoryConfigFile = (path: string) => {
  let parsed: unknown
  try {
    parsed = parseJson(readFileSync(path, "utf8"), path)
  } catch (cause) {
    throw new Error(`failed to read factory config ${path}`, {
      cause,
    })
  }
  try {
    return decodeFactoryConfig(parsed)
  } catch (cause) {
    if (ParseResult.isParseError(cause)) {
      throw new Error(
        `invalid factory config ${path}: ${ParseResult.TreeFormatter.formatErrorSync(cause)}`,
        { cause },
      )
    }
    throw cause
  }
}

const decisionFromEnv = (
  raw: string | undefined,
  optionId: string | undefined,
): PermissionDecision => {
  if (raw === "deny") return { _tag: "Deny", reason: "Denied by smoke operator" }
  if (raw === "cancelled") return { _tag: "Cancelled" }
  return {
    _tag: "Allow",
    ...(optionId === undefined ? {} : { optionId }),
  }
}

const args = parseArgs({
  allowPositionals: false,
  options: {
    config: { type: "string" },
    trigger: { type: "string" },
    "trigger-json": { type: "string" },
    decision: { type: "string" },
    "permission-timeout-ms": { type: "string" },
    "next-output-timeout-ms": { type: "string" },
  },
})

const factoryConfig = readFactoryConfigFile(args.values.config ?? "factory.config.json")
const triggerInput = {
  ...(args.values.trigger === undefined ? {} : { triggerFile: args.values.trigger }),
  ...(args.values["trigger-json"] === undefined
    ? {}
    : { triggerJson: args.values["trigger-json"] }),
}
const trigger = Schema.decodeUnknownSync(DarkFactoryTriggerSchema)(readTrigger(triggerInput))

const program = Effect.gen(function* () {
  const accepted = yield* acceptAndStartFactoryTrigger({
    trigger,
    planner: factoryConfig.planner,
    providerCapabilities: factoryConfig.providerCapabilities ?? [],
  })
  yield* Console.log(JSON.stringify({
    step: "accepted",
    factoryRunKey: accepted.run.factoryRunKey,
    plannerContextId: accepted.run.plannerContextId,
    factInserted: accepted.factInserted,
    runInserted: accepted.runInserted,
  }, null, 2))

  const permission = yield* waitForPermissionRequest({
    factoryRunKey: accepted.run.factoryRunKey,
    timeoutMs: Number(args.values["permission-timeout-ms"] ?? "120000"),
  })
  yield* Console.log(JSON.stringify({
    step: "permission_request",
    sessionId: permission.contextId,
    permissionRequestId: permission.permissionRequestId,
    toolUseId: permission.toolUseId,
    sequence: permission.sequence,
    options: permission.options,
  }, null, 2))

  const decision = decisionFromEnv(
    args.values.decision,
    permission.options[0]?.optionId,
  )
  yield* respondToFactoryPermission({
    factoryRunKey: accepted.run.factoryRunKey,
    sessionId: permission.contextId,
    permissionRequestId: permission.permissionRequestId,
    decision,
    ...(accepted.run.correlationId === undefined
      ? {}
      : { correlationId: accepted.run.correlationId }),
  })
  yield* Console.log(JSON.stringify({
    step: "permission_response",
    decision,
  }, null, 2))

  const next = yield* waitForNextAgentOutput({
    factoryRunKey: accepted.run.factoryRunKey,
    afterSequence: permission.sequence,
    timeoutMs: Number(args.values["next-output-timeout-ms"] ?? "120000"),
  })
  const status = yield* readFactoryRunStatus(accepted.run.factoryRunKey)
  yield* Console.log(JSON.stringify({
    step: "next_output",
    factoryRunKey: accepted.run.factoryRunKey,
    sequence: next.sequence,
    output: next.event,
    facts: status.facts.length,
    ingressInputs: status.ingressInputs.length,
    runtimeEvents: status.runtimeEvents.length,
    agentOutputs: status.agentOutputs.length,
  }, null, 2))
}).pipe(
  Effect.provide(factoryHostLayerFromConfig(factoryConfig)),
)

NodeRuntime.runMain(Effect.scoped(program))

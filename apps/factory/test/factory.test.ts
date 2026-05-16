import { DurableStreamTestServer } from "@durable-streams/server"
import { RuntimeOutputTable } from "@firegrid/protocol/launch"
import { runtimeIngressInputIdForIdempotencyKey } from "@firegrid/protocol/runtime-ingress"
import {
  encodeRuntimeAgentOutputEnvelope,
  sessionContextIdForExternalKey,
  type RuntimeAgentOutputEventPayload,
} from "@firegrid/protocol/session-facade"
import { Effect, Fiber, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  authorizedBindingsFromPlanner,
  decodeFactoryConfig,
} from "../src/config.ts"
import {
  AcceptFactoryTriggerOptionsSchema,
  DarkFactoryHostLive,
  FactoryPermissionRequestSchema,
  FactoryRunStatusViewSchema,
  PermissionResponseInputSchema,
  acceptFactoryTrigger,
  readFactoryRunStatus,
  respondToFactoryPermission,
  waitForPermissionRequest,
} from "../src/host.ts"
import {
  FactoryRunKeySchema,
  PermissionResolutionKeySchema,
  factoryRunIdentityFor,
  permissionResolutionIdentityFor,
} from "../src/identity.ts"
import { buildPlannerPrompt } from "../src/prompts.ts"
import {
  waitForFactoryPermissionResolution,
  waitForFactoryPhaseProjection,
  waitForFactoryProviderEffect,
  waitForFactoryRunStatus,
} from "../src/projection-waits.ts"
import {
  DarkFactoryFactKeyEncoded,
  DarkFactoryTable,
  DarkFactoryTriggerSchema,
  type DarkFactoryFact,
  type DarkFactoryRun,
  type DarkFactoryTrigger,
} from "../src/tables.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const trigger: DarkFactoryTrigger = {
  source: "linear.oauth",
  externalEventKey: "evt-123",
  externalEntityKey: "issue-456",
  eventType: "linear.issue.accepted",
  correlationId: "corr-789",
  repoHint: "gurdasnijor/firegrid",
  linear: {
    issueId: "issue-456",
    identifier: "FG-123",
    url: "https://linear.example/FG-123",
    title: "Implement factory",
    state: "Started",
  },
  payload: { ok: true },
}

const triggerIdentity = factoryRunIdentityFor(trigger)
const triggerFactoryRunKey = triggerIdentity.factoryRunKey
const triggerPlannerContextId = sessionContextIdForExternalKey({
  source: "darkFactory.run",
  id: triggerFactoryRunKey,
})
const triggerSubscriberId = triggerIdentity.subscriberId

const hostLayer = (namespace: string) =>
  DarkFactoryHostLive({
    durableStreamsBaseUrl: baseUrl!,
    namespace,
  })

const runWithHost = <A, E>(
  namespace: string,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(Effect.provide(hostLayer(namespace))),
    ),
  )

const agentOutputRaw = (event: RuntimeAgentOutputEventPayload): string =>
  encodeRuntimeAgentOutputEnvelope(event)

describe("dark factory P0 contracts", () => {
  it("firegrid-dark-factory-app.EXTERNAL_FACTS.1 firegrid-dark-factory-app.PARENT_RUN.1 derives deterministic fact/run/context identities", () => {
    const identity = factoryRunIdentityFor(trigger)

    expect(Schema.decodeSync(FactoryRunKeySchema)(identity.factoryRunKey)).toEqual([
      "linear.oauth",
      "issue-456",
    ])
    expect(identity.subscriberId).toMatch(/^dark-factory:/)
    expect(triggerPlannerContextId).toMatch(/^ctx_ext_/)
  })

  it("firegrid-dark-factory-app.PARENT_RUN.1 canonical identities do not collide on colon or slug-like input", () => {
    const colonLeft = factoryRunIdentityFor({
      source: "a:b",
      externalEntityKey: "c",
    })
    const colonRight = factoryRunIdentityFor({
      source: "a",
      externalEntityKey: "b:c",
    })
    const slugLeft = factoryRunIdentityFor({
      source: "linear.oauth",
      externalEntityKey: "issue!456",
    })
    const slugRight = factoryRunIdentityFor({
      source: "linear.oauth",
      externalEntityKey: "issue_456",
    })

    expect(colonLeft.factoryRunKey).not.toBe(colonRight.factoryRunKey)
    expect(sessionContextIdForExternalKey({
      source: "darkFactory.run",
      id: colonLeft.factoryRunKey,
    })).not.toBe(sessionContextIdForExternalKey({
      source: "darkFactory.run",
      id: colonRight.factoryRunKey,
    }))
    expect(slugLeft.factoryRunKey).not.toBe(slugRight.factoryRunKey)
    expect(sessionContextIdForExternalKey({
      source: "darkFactory.run",
      id: slugLeft.factoryRunKey,
    })).not.toBe(sessionContextIdForExternalKey({
      source: "darkFactory.run",
      id: slugRight.factoryRunKey,
    }))
  })

  it("firegrid-dark-factory-app.EXTERNAL_FACTS.1 decodes provider-shaped trigger input and composite fact keys", () => {
    const decoded = Schema.decodeUnknownSync(DarkFactoryTriggerSchema)(trigger)
    const encodedKey = Schema.encodeSync(DarkFactoryFactKeyEncoded)([
      decoded.source,
      decoded.externalEventKey,
    ])

    expect(encodedKey).toBe(JSON.stringify(["linear.oauth", "evt-123"]))
    expect(Schema.decodeSync(DarkFactoryFactKeyEncoded)(encodedKey)).toEqual([
      "linear.oauth",
      "evt-123",
    ])
  })

  it("firegrid-factory-run-process.CHOREOGRAPHY.1 firegrid-factory-run-process.WAIT_AND_PERMISSION.1 builds a planner prompt around app projections and typed runtime waits", () => {
    const run: DarkFactoryRun = {
      factoryRunKey: triggerIdentity.factoryRunKey,
      subscriberId: triggerIdentity.subscriberId,
      source: trigger.source,
      externalEntityKey: trigger.externalEntityKey,
      plannerContextId: triggerPlannerContextId,
      acceptedFactKey: [trigger.source, trigger.externalEventKey],
      status: "accepted",
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
      correlationId: trigger.correlationId,
      repoHint: trigger.repoHint,
      linearIssueId: trigger.linear?.issueId,
      linearIdentifier: trigger.linear?.identifier,
      linearUrl: trigger.linear?.url,
    }

    const prompt = buildPlannerPrompt({
      run,
      trigger,
      providerCapabilities: [],
    })

    expect(prompt).toContain("Factory fact projections")
    expect(prompt).toContain("typed wait_for for runtime observations")
    expect(prompt).not.toContain("darkFactory.facts")
    expect(prompt).not.toContain("Runtime observation sources:")
    expect(prompt).not.toContain("firegrid.runtime.output.events")
    expect(prompt).toContain("session_new")
    expect(prompt).toContain("session_prompt")
    expect(prompt).toContain("wait_for")
    expect(prompt).toContain("schedule_me")
    expect(prompt).toContain("execute only for advertised capabilities")
    expect(prompt).toContain("No execute-backed provider capabilities")
  })

  it("firegrid-dark-factory-app.WAIT_AND_PERMISSION.2 correlates permission decisions by contextId and permissionRequestId", () => {
    const input = {
      contextId: triggerPlannerContextId,
      permissionRequestId: "permission-1",
    }

    const identity = permissionResolutionIdentityFor(input)
    expect(Schema.decodeSync(PermissionResolutionKeySchema)(identity.externalEventKey))
      .toEqual([input.contextId, input.permissionRequestId])
    expect(identity.factKey).toEqual([
      "darkFactory.permission",
      identity.externalEventKey,
    ])
    expect(identity.idempotencyKey).toMatch(/^dark-factory:permission:/)
  })

  it("firegrid-dark-factory-app.WAIT_AND_PERMISSION.2 schema-decodes permission resume and read-model contracts", () => {
    const permissionInput = Schema.decodeUnknownSync(PermissionResponseInputSchema)({
      factoryRunKey: triggerFactoryRunKey,
      sessionId: triggerPlannerContextId,
      permissionRequestId: "permission-1",
      decision: { _tag: "Allow", optionId: "allow" },
    })
    const permission = Schema.decodeUnknownSync(FactoryPermissionRequestSchema)({
      contextId: triggerPlannerContextId,
      activityAttempt: 1,
      sequence: 2,
      permissionRequestId: permissionInput.permissionRequestId,
      toolUseId: "tool-permission",
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow once" },
      ],
      event: {
        _tag: "PermissionRequest",
        permissionRequestId: permissionInput.permissionRequestId,
        toolUseId: "tool-permission",
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow once" },
        ],
      },
    })

    expect(permission.permissionRequestId).toBe("permission-1")
    expect(permission.options[0]?.optionId).toBe("allow")
  })

  it("firegrid-dark-factory-app.APP_SURFACE.1 firegrid-dark-factory-app.OBSERVATION.3 schema-decodes app input and read-model projections", () => {
    const options = Schema.decodeUnknownSync(AcceptFactoryTriggerOptionsSchema)({
      trigger,
      planner: { argv: ["node", "planner.js"], agentProtocol: "acp" },
      providerCapabilities: [],
    })
    const run: DarkFactoryRun = {
      factoryRunKey: triggerIdentity.factoryRunKey,
      subscriberId: triggerIdentity.subscriberId,
      source: trigger.source,
      externalEntityKey: trigger.externalEntityKey,
      plannerContextId: triggerPlannerContextId,
      acceptedFactKey: [trigger.source, trigger.externalEventKey],
      status: "accepted",
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    }
    const view = Schema.decodeUnknownSync(FactoryRunStatusViewSchema)({
      run,
      facts: [],
      runtimeRuns: [],
      runtimeEvents: [],
      runtimeLogs: [],
      ingressInputs: [],
      agentOutputs: [],
      permissions: [],
    })

    expect(options.planner.argv).toEqual(["node", "planner.js"])
    expect(view.run.factoryRunKey).toBe(triggerFactoryRunKey)
  })

  it("firegrid-dark-factory-app.HOSTED_SUBSTRATE.2 decodes planner config without secret values", () => {
    const config = decodeFactoryConfig({
      planner: {
        argv: ["node", "planner.js"],
        agentProtocol: "acp",
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      },
      providerCapabilities: [],
    })

    expect(config.planner.argv).toEqual(["node", "planner.js"])
    expect(authorizedBindingsFromPlanner(config.planner)).toEqual([
      ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
    ])
  })

  it("firegrid-dark-factory-app.EXTERNAL_FACTS.1 firegrid-dark-factory-app.PARENT_RUN.1 firegrid-dark-factory-app.AUTONOMOUS_RUN.1 accepts a trigger idempotently through app host functions", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `factory-accept-${crypto.randomUUID()}`

    const result = await runWithHost(
      namespace,
      Effect.gen(function* () {
        const first = yield* acceptFactoryTrigger({
          trigger,
          planner: { argv: ["node", "planner.js"], agentProtocol: "stdio-jsonl" },
          providerCapabilities: [],
        })
        const second = yield* acceptFactoryTrigger({
          trigger,
          planner: { argv: ["node", "planner.js"], agentProtocol: "stdio-jsonl" },
          providerCapabilities: [],
        })
        const status = yield* readFactoryRunStatus(first.run.factoryRunKey)
        const runProjection = yield* waitForFactoryRunStatus({
          factoryRunKey: first.run.factoryRunKey,
          status: "accepted",
          timeoutMs: 100,
        })
        return { first, second, status, runProjection }
      }),
    )

    expect(result.first.factInserted).toBe(true)
    expect(result.first.runInserted).toBe(true)
    expect(result.first.initialInputId).toBe(
      runtimeIngressInputIdForIdempotencyKey(
        triggerPlannerContextId,
        `dark-factory:planner:${triggerFactoryRunKey}:initial`,
      ),
    )
    expect(result.second.runInserted).toBe(false)
    expect(result.second.initialInputId).toBeUndefined()
    expect(result.status.run).toMatchObject({
      factoryRunKey: triggerFactoryRunKey,
      subscriberId: triggerSubscriberId,
      plannerContextId: triggerPlannerContextId,
      status: "accepted",
    })
    expect(result.runProjection).toMatchObject({
      factoryRunKey: triggerFactoryRunKey,
      status: "accepted",
    })
    expect(result.status.facts).toHaveLength(1)
    expect(result.status.ingressInputs).toHaveLength(1)
    expect(result.status.ingressInputs[0]).toMatchObject({
      contextId: triggerPlannerContextId,
      kind: "message",
      authoredBy: "client",
      idempotencyKey: `dark-factory:planner:${triggerFactoryRunKey}:initial`,
      sequence: 0,
      status: "sequenced",
    })
  })

  it("firegrid-dark-factory-app.WAIT_AND_PERMISSION.2 writes permission resolution fact and RuntimeIngress control row idempotently", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `factory-permission-${crypto.randomUUID()}`

    const result = await runWithHost(
      namespace,
      Effect.gen(function* () {
        const accepted = yield* acceptFactoryTrigger({
          trigger,
          planner: { argv: ["node", "planner.js"], agentProtocol: "stdio-jsonl" },
          providerCapabilities: [],
        })
        const input = {
          factoryRunKey: accepted.run.factoryRunKey,
          sessionId: accepted.run.plannerContextId,
          permissionRequestId: "permission-1",
          decision: { _tag: "Allow" as const, optionId: "allow" },
          correlationId: trigger.correlationId,
        }
        const first = yield* respondToFactoryPermission(input)
        const second = yield* respondToFactoryPermission(input)
        const status = yield* readFactoryRunStatus(accepted.run.factoryRunKey)
        const permissionProjection = yield* waitForFactoryPermissionResolution({
          factoryRunKey: accepted.run.factoryRunKey,
          permissionRequestId: input.permissionRequestId,
          decisions: ["Allow"],
          timeoutMs: 100,
        })
        return { first, second, status, permissionProjection }
      }),
    )

    const permissionIdentity = permissionResolutionIdentityFor({
      contextId: triggerPlannerContextId,
      permissionRequestId: "permission-1",
    })
    const inputId = runtimeIngressInputIdForIdempotencyKey(
      triggerPlannerContextId,
      permissionIdentity.idempotencyKey,
    )
    expect(result.first.input.inputId).toBe(inputId)
    expect(result.second.input.inputId).toBe(inputId)
    expect(result.status.facts.some(fact =>
      fact.source === "darkFactory.permission" &&
      fact.eventType === "permission.resolved" &&
      fact.externalEventKey === permissionIdentity.externalEventKey,
    )).toBe(true)
    expect(result.permissionProjection).toMatchObject({
      factoryRunKey: triggerFactoryRunKey,
      permissionRequestId: "permission-1",
      status: "resolved",
      decision: { _tag: "Allow", optionId: "allow" },
    })
    const controlRows = result.status.ingressInputs.filter(row =>
      row.kind === "control")
    expect(controlRows).toHaveLength(1)
    expect(controlRows[0]).toMatchObject({
      inputId,
      contextId: triggerPlannerContextId,
      authoredBy: "client",
      idempotencyKey: permissionIdentity.idempotencyKey,
      sequence: 1,
      status: "sequenced",
    })
    expect(controlRows[0]?.payload).toMatchObject({
      _tag: "PermissionResponse",
      permissionRequestId: "permission-1",
      decision: { _tag: "Allow", optionId: "allow" },
    })
    expect(result.status.run).toMatchObject({
      status: "resumed",
      lastPermissionRequestId: "permission-1",
    })
  })

  it("firegrid-dark-factory-app.OBSERVATION.3 firegrid-schema-projection-contract.CLIENT_READ_PROJECTION.5 derives permissions from normalized client agent outputs", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `factory-output-${crypto.randomUUID()}`

    const result = await runWithHost(
      namespace,
      Effect.gen(function* () {
        const accepted = yield* acceptFactoryTrigger({
          trigger,
          planner: { argv: ["node", "planner.js"], agentProtocol: "stdio-jsonl" },
          providerCapabilities: [],
        })
        const output = yield* RuntimeOutputTable
        yield* output.events.upsert({
          eventId: {
            contextId: accepted.run.plannerContextId,
            activityAttempt: 1,
            target: "events",
            sequence: 10,
          },
          contextId: accepted.run.plannerContextId,
          activityAttempt: 1,
          sequence: 10,
          source: "stdout",
          format: "jsonl",
          receivedAt: new Date().toISOString(),
          raw: agentOutputRaw({
            _tag: "PermissionRequest",
            permissionRequestId: "permission-1",
            toolUseId: "tool-permission",
            options: [
              { optionId: "allow", kind: "allow_once", name: "Allow once" },
            ],
          }),
        })
        const status = yield* readFactoryRunStatus(accepted.run.factoryRunKey)
        const permission = yield* waitForPermissionRequest({
          factoryRunKey: accepted.run.factoryRunKey,
          afterSequence: 9,
          timeoutMs: 1,
        })
        return { status, permission }
      }),
    )

    const status = result.status
    expect(status.agentOutputs).toHaveLength(1)
    expect(status.agentOutputs[0]).toMatchObject({
      contextId: triggerPlannerContextId,
      sequence: 10,
      _tag: "PermissionRequest",
    })
    expect(status.permissions).toHaveLength(1)
    expect(status.permissions[0]).toMatchObject({
      contextId: triggerPlannerContextId,
      activityAttempt: 1,
      sequence: 10,
      permissionRequestId: "permission-1",
      toolUseId: "tool-permission",
    })
    expect(status.permissions[0]?.options[0]?.optionId).toBe("allow")
    expect(result.permission).toMatchObject({
      contextId: triggerPlannerContextId,
      sequence: 10,
      permissionRequestId: "permission-1",
    })
  })

  it("firegrid-factory-run-process.EVENT_PLANE.3 firegrid-factory-run-process.WAIT_AND_PERMISSION.1 waits for app-local phase and provider-effect projections without runtime source registration", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `factory-projections-${crypto.randomUUID()}`

    const result = await runWithHost(
      namespace,
      Effect.gen(function* () {
        const accepted = yield* acceptFactoryTrigger({
          trigger,
          planner: { argv: ["node", "planner.js"], agentProtocol: "stdio-jsonl" },
          providerCapabilities: [],
        })
        const table = yield* DarkFactoryTable
        const phaseWait = yield* waitForFactoryPhaseProjection({
          factoryRunKey: accepted.run.factoryRunKey,
          phase: "planner",
          timeoutMs: 2_000,
        }).pipe(Effect.fork)
        const providerWait = yield* waitForFactoryProviderEffect({
          factoryRunKey: accepted.run.factoryRunKey,
          effectType: "linear.activity",
          status: "completed",
          timeoutMs: 2_000,
        }).pipe(Effect.fork)

        yield* Effect.sleep("50 millis")
        const createdAt = new Date().toISOString()
        const phaseFact: DarkFactoryFact = {
          factKey: ["darkFactory.phase", "planner-completed"],
          source: "darkFactory.phase",
          externalEventKey: "planner-completed",
          externalEntityKey: trigger.externalEntityKey,
          eventType: "factory.phase.completed",
          factoryRunKey: accepted.run.factoryRunKey,
          contextId: accepted.run.plannerContextId,
          createdAt,
          payload: {
            phase: "planner",
            status: "completed",
          },
        }
        const providerFact: DarkFactoryFact = {
          factKey: ["darkFactory.provider", "linear-activity-1"],
          source: "darkFactory.provider",
          externalEventKey: "linear-activity-1",
          externalEntityKey: trigger.externalEntityKey,
          eventType: "factory.provider.effect",
          factoryRunKey: accepted.run.factoryRunKey,
          contextId: accepted.run.plannerContextId,
          createdAt,
          payload: {
            effectType: "linear.activity",
            status: "completed",
            providerUrl: "https://linear.example/FG-123#activity",
          },
        }
        yield* table.facts.insertOrGet(phaseFact)
        yield* table.facts.insertOrGet(providerFact)

        const phase = yield* Fiber.join(phaseWait)
        const provider = yield* Fiber.join(providerWait)
        return { phase, provider }
      }),
    )

    expect(result.phase).toMatchObject({
      factoryRunKey: triggerFactoryRunKey,
      phase: "planner",
      status: "completed",
    })
    expect(result.provider).toMatchObject({
      factoryRunKey: triggerFactoryRunKey,
      effectType: "linear.activity",
      status: "completed",
      externalEventKey: "linear-activity-1",
    })
  })
})

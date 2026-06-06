import * as acp from "@agentclientprotocol/sdk"
import { NodeContext } from "@effect/platform-node"
import { spawnAcpProcess } from "@firegrid/fluent-acp-process"
import { FluentRuntimeLive, FluentStore } from "@firegrid/fluent-runtime"
import {
  connectFiregridAcp,
  FluentAcpClientError,
  type CommitExtMethodInput,
  type FluentAcpRuntimePortService,
  type RecordLayer1ObservationInput,
  type ResolvePermissionInput,
} from "@firegrid/fluent-runtime/acp"
import { Duration, Effect, Layer } from "effect"
import type { Context } from "effect"
import type { FirelabHost, FirelabHostEnv } from "../../types.ts"
import { AGENT_LABEL, HOST_SESSION_ID, REAL_AGENT_ENV_KEY } from "./scenario.ts"

type FluentStoreService = Context.Tag.Service<typeof FluentStore>

// A trivial first-person instruction. Real claude-code-acp refuses quoted
// "injections", so the prompt speaks directly and asks for a one-word reply to
// keep the turn cheap.
const PROMPT_TEXT = "Reply with exactly one word: ack"

const appendFact = (
  store: FluentStoreService,
  name: string,
  payload: unknown,
) =>
  store.appendSessionEvent({ sessionId: HOST_SESSION_ID, name, payload }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      new FluentAcpClientError({ op: name, message: `failed to persist ${name}`, cause }),
    ),
  )

/**
 * The fluent-runtime-facing port. Crucially, the HOST owns the session id: every
 * ACP callback is recorded under {@link HOST_SESSION_ID} (the real agent mints
 * its own session id, preserved inside the payload as `acpSessionId`). That lets
 * the airgapped driver read one known durable stream while still binding to the
 * real agent's dynamic session.
 */
const makeRuntimePort = (store: FluentStoreService): FluentAcpRuntimePortService => ({
  recordLayer1Observation: (input: RecordLayer1ObservationInput) =>
    appendFact(store, input.kind, {
      acpSessionId: input.sessionId,
      observation: input.payload,
    }),
  resolvePermission: (input: ResolvePermissionInput) => {
    // Auto-approve the plan-mode / tool gate so the real turn can proceed.
    const firstOption = input.request.options[0]
    const response: acp.RequestPermissionResponse = firstOption === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: firstOption.optionId } }
    return appendFact(store, "acp.permission_result", {
      acpSessionId: input.sessionId,
      request: input.request,
      response,
    }).pipe(Effect.as(response))
  },
  commitExtMethod: (input: CommitExtMethodInput) =>
    // A real claude-code-acp turn is not expected to call Firegrid ext methods;
    // record + acknowledge defensively if it ever does.
    appendFact(store, "acp.session_update", {
      acpSessionId: input.sessionId,
      extMethod: input.method,
    }).pipe(Effect.as({ committed: true, method: input.method })),
})

const driveRealAgent = (apiKey: string) =>
  Effect.gen(function*() {
    const store = yield* FluentStore
    yield* store.createSession({ sessionId: HOST_SESSION_ID, agent: AGENT_LABEL })

    // Spawn the REAL claude-code-acp agent (resolveAgent "claude"). No fake.
    const handle = yield* spawnAcpProcess({
      agent: "claude",
      cwd: process.cwd(),
      env: { [REAL_AGENT_ENV_KEY]: apiKey },
    })
    yield* Effect.addFinalizer(() => handle.kill)

    const connection = yield* connectFiregridAcp({
      stream: handle.stream,
      runtime: makeRuntimePort(store),
    })

    // `Effect.tryPromise` (not `Effect.promise`) so a rejecting ACP call surfaces
    // as a typed error and is logged to stderr (off the ACP stdout) rather than
    // swallowed as a defect — real-agent launch/auth failures must be visible.
    const acpCall = <A>(op: string, run: () => Promise<A>, timeout: Duration.Duration) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new FluentAcpClientError({ op, message: `real ACP ${op} failed`, cause }),
      }).pipe(
        Effect.timeout(timeout),
        Effect.tapError((cause) => Effect.logError(`fluent-acp-real-spawn ${op}`, cause)),
      )

    yield* acpCall(
      "initialize",
      () =>
        connection.agent.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      Duration.seconds(90),
    )

    const session = yield* acpCall(
      "newSession",
      () => connection.agent.newSession({ cwd: process.cwd(), mcpServers: [] }),
      Duration.seconds(90),
    )

    // Drive a real prompt turn. The real agent streams session/update
    // notifications (agent_message_chunk) back through FiregridAcpClient, which
    // records them as durable L1 facts.
    yield* acpCall(
      "prompt",
      () =>
        connection.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: PROMPT_TEXT }],
        }),
      Duration.seconds(150),
    )
  }).pipe(
    Effect.scoped,
    Effect.withSpan("firegrid.sim.fluent_acp_real_spawn.host.run"),
  )

export const host = (
  env: FirelabHostEnv,
): Layer.Layer<FirelabHost, unknown> => {
  const apiKey = env.processEnv[REAL_AGENT_ENV_KEY]
  // No fake fallback: a real spawned agent is the only acceptance path (F-A10).
  const run = apiKey === undefined || apiKey === ""
    ? Effect.fail(
      new Error(
        `fluent-acp-real-spawn-acceptance is the REAL-agent lane and requires ${REAL_AGENT_ENV_KEY}. ` +
          "Refusing to run a fake agent — set the key to run the acceptance witness.",
      ),
    )
    : driveRealAgent(apiKey)

  return Layer.scopedDiscard(
    run.pipe(
      Effect.provide(FluentRuntimeLive({
        durableStreamsBaseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      })),
      Effect.provide(NodeContext.layer),
    ),
  )
}

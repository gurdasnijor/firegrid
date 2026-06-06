import {
  ackAfterDurableProductOutcome,
  DurableConsumerClient,
  DurableConsumerClientLive,
  FluentRuntimeLive,
  FluentSources,
  FluentStore,
  type AcquiredConsumer,
  type DurableConsumerClientService,
  type StateChangeMessage,
} from "@firegrid/fluent-runtime"
import { Effect, Layer } from "effect"
import type { Context } from "effect"
import type {
  FirelabHost,
  FirelabHostEnv,
} from "../../types.ts"
import {
  agentName,
  consumerId,
  factNames,
  mainTurnId,
  mainWaitId,
  reviewTurnId,
  reviewWaitId,
  sessionId,
  wakeRoute,
  workerId,
  workRoute,
  type DurableWaitFactName,
} from "./scenario.ts"

type StoreService = Context.Tag.Service<typeof FluentStore>
type SourcesService = Context.Tag.Service<typeof FluentSources>

interface ProviderEventInput {
  readonly deliveryId: string
  readonly turnId: string
  readonly type: string
  readonly key: string
  readonly value: unknown
}

interface SessionWake {
  readonly deliveryId: string
  readonly turnId: string
  readonly workOffset: string
  readonly eventOffset: string
  readonly event: StateChangeMessage
}

interface PostClaimSessionActor {
  readonly handleSessionWake: (
    wake: SessionWake,
  ) => Effect.Effect<void, unknown>
}

const reviewPredicate = "event.type == 'review.posted'"
const prPredicate =
  "event.type == 'github.pr' && event.value.state == 'merged' && event.value.repo == self.repo && event.value.issueId == self.issueId"

const appendFact = (
  store: StoreService,
  name: DurableWaitFactName,
  payload: unknown,
) =>
  store.appendSessionEvent({ sessionId, name, payload }).pipe(Effect.asVoid)

const claimOffset = (
  claim: AcquiredConsumer,
  path: string,
): string => claim.streams.find(stream => stream.path === path)?.offset ?? "-1"

const createWakeConsumer = (
  input: {
    readonly client: DurableConsumerClientService
    readonly namespace: string
    readonly workStream: string
    readonly wakeStream: string
  },
) =>
  Effect.gen(function*() {
    yield* input.client.createStream(input.workStream)
    yield* input.client.createStream(input.wakeStream)
    yield* input.client.registerConsumer({
      consumerId,
      namespace: input.namespace,
      streams: [input.workStream],
    })
    yield* input.client.configurePullWake({
      consumerId,
      wakeStream: input.wakeStream,
    })
  })

const providerEventIngress = (
  input: {
    readonly store: StoreService
    readonly client: DurableConsumerClientService
    readonly workStream: string
    readonly event: ProviderEventInput
  },
): Effect.Effect<SessionWake, unknown> =>
  Effect.gen(function*() {
    const change: StateChangeMessage = {
      type: input.event.type,
      key: input.event.key,
      value: input.event.value,
      headers: {
        operation: "provider-event",
        delivery_id: input.event.deliveryId,
        source: "firelab-provider",
      },
    }
    const write = yield* input.store.appendStateChangeFenced({
      sessionId,
      change,
      fence: {
        producerId: `fluent-durable-wait/provider/${encodeURIComponent(input.event.deliveryId)}`,
        epoch: 0,
        seq: 0,
      },
    })
    const notification = yield* input.client.appendStream({
      routePath: input.workStream,
      event: {
        kind: "session-wake",
        sessionId,
        turnId: input.event.turnId,
        eventOffset: write.write.offset,
        event: change,
      },
    })
    return {
      deliveryId: input.event.deliveryId,
      turnId: input.event.turnId,
      workOffset: notification.offset,
      eventOffset: write.write.offset,
      event: change,
    }
  }).pipe(
    Effect.withSpan("firegrid.sim.fluent_durable_wait.provider_event_ingress"),
  )

const makePostClaimSessionActor = (
  input: {
    readonly store: StoreService
    readonly sources: SourcesService
    readonly client: DurableConsumerClientService
    readonly workStream: string
  },
): PostClaimSessionActor => ({
  handleSessionWake: (wake) =>
    Effect.gen(function*() {
      const claim = yield* input.client.acquireConsumer({ consumerId, worker: workerId })
      const sessionFacts = yield* input.store.collectSession(sessionId)
      const result = yield* input.sources.matchPendingTurnWaits({
        sessionId,
        turnId: wake.turnId,
        matchedOffset: wake.eventOffset,
        event: wake.event,
      })
      yield* ackAfterDurableProductOutcome(
        input.client,
        {
          consumerId,
          token: claim.token,
          offsets: [{ path: input.workStream, offset: wake.workOffset }],
        },
        appendFact(input.store, factNames.wakeOutcome, {
          deliveryId: wake.deliveryId,
          turnId: wake.turnId,
          claimEpoch: claim.epoch,
          claimOffset: claimOffset(claim, input.workStream),
          workOffset: wake.workOffset,
          eventOffset: wake.eventOffset,
          eventKey: wake.event.key,
          eventType: wake.event.type,
          materializedSessionFacts: sessionFacts.length,
          matched: result.matched.map(wait => wait.waitId),
          notMatched: result.notMatched.map(wait => wait.waitId),
          alreadyMatched: result.alreadyMatched,
        }),
      )
      yield* input.client.releaseConsumer({
        consumerId,
        token: claim.token,
      })
    }).pipe(
      Effect.withSpan("firegrid.sim.fluent_durable_wait.session_authority.handle_wake"),
    ),
})

const recordReviewWaitBeforePark = (
  store: StoreService,
) =>
  Effect.gen(function*() {
    yield* store.startTurn({
      sessionId,
      turnId: reviewTurnId,
      prompt: "handler wait_for(review.posted)",
    })
    yield* store.registerTurnWait({
      sessionId,
      turnId: reviewTurnId,
      waitId: reviewWaitId,
      predicate: reviewPredicate,
      afterOffset: "-1",
      self: { repo: "firegrid", issueId: "42" },
    })
  })

const recordPrWaitBeforePark = (
  input: {
    readonly store: StoreService
    readonly afterOffset: string
  },
) =>
  Effect.gen(function*() {
    yield* input.store.startTurn({
      sessionId,
      turnId: mainTurnId,
      prompt: "handler wait_for(github.pr merged)",
    })
    yield* input.store.registerTurnWait({
      sessionId,
      turnId: mainTurnId,
      waitId: mainWaitId,
      predicate: prPredicate,
      afterOffset: input.afterOffset,
      self: { repo: "firegrid", issueId: "42" },
    })
    yield* appendFact(input.store, factNames.turnParked, {
      turnId: mainTurnId,
      waitId: mainWaitId,
      afterOffset: input.afterOffset,
      parkReason: "wait_for",
    })
    yield* appendFact(input.store, factNames.liveProjectionChanged, {
      turnId: mainTurnId,
      liveSelf: { repo: "other", issueId: "42" },
    })
  })

const runDurableWait = (
  env: FirelabHostEnv,
) =>
  Effect.gen(function*() {
    const store = yield* FluentStore
    const sources = yield* FluentSources
    const client = yield* DurableConsumerClient
    if (env.namespace === undefined) {
      return yield* Effect.fail(new Error("fluent-durable-wait requires namespace"))
    }

    const workStream = workRoute(env.namespace)
    yield* createWakeConsumer({
      client,
      namespace: env.namespace,
      workStream,
      wakeStream: wakeRoute(env.namespace),
    })
    const actor = makePostClaimSessionActor({ store, sources, client, workStream })

    yield* store.createSession({ sessionId, agent: agentName })
    yield* appendFact(store, factNames.correlationSnapshot, {
      repo: "firegrid",
      issueId: "42",
    })

    yield* recordReviewWaitBeforePark(store)
    const reviewWake = yield* providerEventIngress({
      store,
      client,
      workStream,
      event: {
        deliveryId: "review-e-catchup",
        turnId: reviewTurnId,
        type: "review.posted",
        key: "review/e-catchup",
        value: { state: "posted", repo: "firegrid", issueId: "42" },
      },
    })
    yield* appendFact(store, factNames.turnParked, {
      turnId: reviewTurnId,
      waitId: reviewWaitId,
      afterOffset: "-1",
      appendedBeforeParkOffset: reviewWake.eventOffset,
      parkReason: "wait_for",
    })
    yield* actor.handleSessionWake(reviewWake)

    yield* recordPrWaitBeforePark({
      store,
      afterOffset: reviewWake.eventOffset,
    })
    const issueWake = yield* providerEventIngress({
      store,
      client,
      workStream,
      event: {
        deliveryId: "issue-e-nonmatch",
        turnId: mainTurnId,
        type: "github.issue",
        key: "issue/e-nonmatch",
        value: { repo: "firegrid", state: "opened", issueId: "42" },
      },
    })
    yield* actor.handleSessionWake(issueWake)

    const mergedWake = yield* providerEventIngress({
      store,
      client,
      workStream,
      event: {
        deliveryId: "pr-e1",
        turnId: mainTurnId,
        type: "github.pr",
        key: "pr/e1",
        value: { repo: "firegrid", state: "merged", issueId: "42" },
      },
    })
    yield* actor.handleSessionWake(mergedWake)

    const replayWake = yield* providerEventIngress({
      store,
      client,
      workStream,
      event: {
        deliveryId: "pr-e2",
        turnId: mainTurnId,
        type: "github.pr",
        key: "pr/e2",
        value: { repo: "firegrid", state: "merged", issueId: "42" },
      },
    })
    yield* actor.handleSessionWake(replayWake)
  }).pipe(
    Effect.withSpan("firegrid.sim.fluent_durable_wait.host"),
  )

export const host = (
  env: FirelabHostEnv,
): Layer.Layer<FirelabHost, unknown> =>
  Layer.scopedDiscard(
    runDurableWait(env).pipe(
      Effect.provide(Layer.mergeAll(
        FluentRuntimeLive({
          durableStreamsBaseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
        }),
        DurableConsumerClientLive({
          durableStreamsBaseUrl: env.durableStreamsBaseUrl,
        }),
      )),
    ),
  )


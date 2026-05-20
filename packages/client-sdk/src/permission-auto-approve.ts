import {
  type PermissionDecision,
  type RuntimePermissionRequestObservation,
  type SessionPermissionRequestWaitInput,
  type SessionPermissionRequestWaitOutput,
  type SessionPermissionRespondInput,
} from "@firegrid/protocol/session-facade"
import { Effect, Ref } from "effect"
import type * as Scope from "effect/Scope"

export type PermissionAutoApprovePolicy<E = never, R = never> =
  | "allow"
  | "deny"
  | ((
    request: RuntimePermissionRequestObservation,
  ) => Effect.Effect<PermissionDecision, E, R>)

export interface PermissionAutoApproveOptions {
  readonly timeoutMs?: number
}

export interface PermissionAutoApproveSession {
  readonly wait: {
    readonly forPermissionRequest: (
      request?: SessionPermissionRequestWaitInput,
    ) => Effect.Effect<SessionPermissionRequestWaitOutput, unknown, never>
  }
  readonly permissions: {
    readonly respond: (
      request: SessionPermissionRespondInput,
    ) => Effect.Effect<unknown, unknown, never>
  }
}

const defaultTimeoutMs = 15_000

const decisionForPolicy = <E, R>(
  policy: PermissionAutoApprovePolicy<E, R>,
  request: RuntimePermissionRequestObservation,
): Effect.Effect<PermissionDecision, E, R> => {
  if (policy === "allow") return Effect.succeed({ _tag: "Allow" })
  if (policy === "deny") return Effect.succeed({ _tag: "Deny" })
  return policy(request)
}

export const autoApproveSessionPermissions = <E = never, R = never>(
  session: PermissionAutoApproveSession,
  policy: PermissionAutoApprovePolicy<E, R>,
  options: PermissionAutoApproveOptions = {},
): Effect.Effect<void, never, Scope.Scope | R> =>
  Effect.gen(function*() {
    const afterSequence = yield* Ref.make<number | undefined>(undefined)
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    return yield* Effect.forever(Effect.gen(function*() {
      const after = yield* Ref.get(afterSequence)
      const result = yield* session.wait.forPermissionRequest({
        ...(after === undefined ? {} : { afterSequence: after }),
        timeoutMs,
      })
      if (result.matched) {
        yield* Ref.set(afterSequence, result.request.sequence)
        const decision = yield* decisionForPolicy(policy, result.request)
        yield* session.permissions.respond({
          permissionRequestId: result.request.permissionRequestId,
          decision,
        })
      }
    }))
  }).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )

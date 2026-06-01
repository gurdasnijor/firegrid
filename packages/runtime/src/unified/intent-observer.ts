/**
 * IntentObserver — the host-side bridge for a poll-only edge's inbound intents
 * (tf-r06u.42, Brookhaven consumer-contract §3.1/§3.4/§7.1, solution-map B-4).
 *
 * A poll-only edge (Roblox) cannot call `FiregridClientOperations` in-process;
 * it APPENDS intent records to its opaque intent handle. edge-auth (tf-r06u.33)
 * authorizes + forwards those appends verbatim to the session's per-context
 * intent stream (`runtimeContextIntentStreamName`). This observer tails that
 * stream and translates each record into the existing in-process channels:
 *
 *   {kind:"prompt"}     -> SessionPromptChannel.forSession(sid).append   (§3.1)
 *   {kind:"permission"} -> SessionPermissionChannel.call                 (§3.4)
 *
 * It is the inbound sibling of `JournalObserverLive` (which is outbound:
 * journal rows -> sibling-workflow triggers). The single writer of
 * runtime-owned rows stays the host — the edge only ever appends INTENT.
 *
 * SCOPE (tf-r06u.42, "build standalone, defer wiring"): this ships the
 * per-context observer + dispatch as a composable unit, validated against an
 * in-memory stream + fake channels. DEFERRED (named follow-up): the host
 * composition wiring (one observer per live session) into `host.ts`, read-
 * cursor persistence for resume, and the intent-stream topology decision
 * (per-context streams vs a single host-wide ingress the proxy stamps with
 * contextId) — see the tf-r06u.42 bead. Re-dispatch on replay is SAFE today
 * regardless: createOrLoad + prompt idempotencyKey + permission idempotencyKey
 * are all idempotent, so a from-start re-read cannot double-run.
 */
import {
  SessionPermissionChannel,
  SessionPromptChannel,
} from "@firegrid/protocol/channels"
import { Effect, Either, Schema, Stream } from "effect"

/**
 * The edge -> host intent record. The poll-only edge appends these as JSON to
 * its opaque intent handle; edge-auth forwards them verbatim. Discriminated by
 * `kind` (the contract's wire shape), not `_tag`.
 */
export const IntentRecordSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("prompt"),
    requestId: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
    playerId: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("permission"),
    permissionRequestId: Schema.NonEmptyString,
    optionId: Schema.NonEmptyString,
  }),
).annotations({ identifier: "firegrid.intentObserver.intentRecord" })
export type IntentRecord = Schema.Schema.Type<typeof IntentRecordSchema>

const decodeIntentRecord = Schema.decodeUnknownEither(IntentRecordSchema)

/**
 * Dispatch one decoded intent into the in-process channels.
 *
 * - prompt: `idempotencyKey = requestId`, so a double-tap that slipped past the
 *   durable-streams producer-fence is still idempotent at the runtime (the
 *   triple-keyed idempotency of consumer-contract §3.1).
 * - permission: mapped to `Allow{optionId}` — selecting an option IS the
 *   decision; the option's own kind (allow-once / reject-once / etc.) encodes
 *   allow-vs-reject (§3.4). `idempotencyKey = permissionRequestId` dedups a
 *   re-sent answer.
 */
export const dispatchIntent = (
  sessionId: string,
  record: IntentRecord,
): Effect.Effect<void, unknown, SessionPromptChannel | SessionPermissionChannel> =>
  record.kind === "prompt"
    ? Effect.flatMap(SessionPromptChannel, (channel) =>
      channel.forSession(sessionId).binding.append({
        payload: { text: record.text },
        idempotencyKey: record.requestId,
      })).pipe(Effect.asVoid)
    : Effect.flatMap(SessionPermissionChannel, (channel) =>
      channel.binding.call({
        permissionRequestId: record.permissionRequestId,
        decision: { _tag: "Allow", optionId: record.optionId },
        idempotencyKey: record.permissionRequestId,
      })).pipe(Effect.asVoid)

/**
 * Consume a stream of raw intent payloads, decoding + dispatching each. A
 * record that fails to decode is SKIPPED (logged), never fatal — one malformed
 * append must not stall the bridge for a session. Runs until the stream ends
 * (or forever, for a live stream); fork it per session.
 */
export const runIntentObserver = (options: {
  readonly sessionId: string
  readonly intents: Stream.Stream<unknown, never, never>
}): Effect.Effect<void, never, SessionPromptChannel | SessionPermissionChannel> =>
  options.intents.pipe(
    Stream.mapEffect((raw) =>
      Either.match(decodeIntentRecord(raw), {
        onLeft: (error) =>
          Effect.logWarning("intent-observer: skipping malformed intent record").pipe(
            Effect.annotateLogs({
              sessionId: options.sessionId,
              reason: String(error),
            }),
          ),
        onRight: (record) =>
          dispatchIntent(options.sessionId, record).pipe(
            // A dispatch failure for one record is isolated + logged; the
            // bridge keeps consuming subsequent intents.
            Effect.catchAll((cause) =>
              Effect.logError("intent-observer: dispatch failed").pipe(
                Effect.annotateLogs({
                  sessionId: options.sessionId,
                  kind: record.kind,
                  reason: String(cause),
                }),
              )),
          ),
      })),
    Stream.runDrain,
  )

// The production stream SOURCE — a per-context durable-streams reader over
// `runtimeContextIntentStreamName({prefix, contextId})`, read as
// `Schema.Unknown` so a malformed append surfaces at the observer's skip path
// rather than killing the daemon — is intentionally NOT built here. The
// observer is source-agnostic (it consumes any `Stream<unknown>`), which keeps
// `@firegrid/runtime` off a direct `effect-durable-streams` dependency (the
// runtime accesses durable streams through `DurableTable`, not the raw Reader).
// Wiring the source + forking one observer per live session is the deferred
// composition step (tf-r06u.42 bead), where the intent-stream topology
// (per-context streams vs a single host-wide ingress) is also decided.

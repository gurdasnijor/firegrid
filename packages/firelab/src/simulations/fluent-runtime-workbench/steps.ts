/**
 * Cucumber step definitions for the fluent-runtime acceptance sim — the binder.
 *
 * Real features are domain-phrased ("a session ... for agent ...",
 * "turn ... schedules sleep ..."), not literal HTTP. So each step is a
 * cucumber-expression mapped to a TYPED handler that calls the typed
 * `FluentRuntimeApi` client directly (`client.Sessions.sleep({...})`) — fully
 * type-checked, no path matching, no OpenAPI reflection. A scenario carries a
 * `World` (the client + named entities + last response); handlers thread it.
 */
import { CucumberExpression, ParameterTypeRegistry } from "@cucumber/cucumber-expressions"
import { HttpApiClient } from "@effect/platform"
import { FluentRuntimeApi } from "@firegrid/fluent-runtime"
import { Effect } from "effect"
import { WORKBENCH_PORT } from "./port.ts"

export const makeClient = HttpApiClient.make(FluentRuntimeApi, {
  baseUrl: `http://127.0.0.1:${WORKBENCH_PORT}`,
})
type Client = Effect.Effect.Success<typeof makeClient>

export interface World {
  readonly client: Client
  /** scenario-unique prefix so scenarios sharing logical ids stay isolated. */
  readonly ns: string
  readonly vars: Map<string, string>
  last: unknown
}

const sid = (w: World): string => w.vars.get("session")!
const tid = (w: World): string => w.vars.get("turn")!
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
const rows = (value: unknown, key: string): ReadonlyArray<Record<string, unknown>> => {
  const v = field(value, key)
  return Array.isArray(v) ? (v as ReadonlyArray<Record<string, unknown>>) : []
}

const ok = (cond: boolean, msg: string): Effect.Effect<void, Error> =>
  cond ? Effect.void : Effect.fail(new Error(msg))

type StepRun = (world: World, args: ReadonlyArray<unknown>) => Effect.Effect<void, unknown>
interface StepDef {
  readonly expression: CucumberExpression
  readonly run: StepRun
}

const registry = new ParameterTypeRegistry()
const step = (text: string, run: StepRun): StepDef => ({
  expression: new CucumberExpression(text, registry),
  run,
})

const steps: ReadonlyArray<StepDef> = [
  // ── setup ────────────────────────────────────────────────────────────────
  step("a session {string} for agent {string}", (w, [sessionId, agent]) =>
    Effect.gen(function*() {
      const id = `${w.ns}-${String(sessionId)}`
      const r = yield* w.client.Sessions.create({ payload: { sessionId: id, agent: String(agent) } })
      w.vars.set("session", r.sessionId)
    })),
  step("turn {string} is open with prompt {string}", (w, [turnId, prompt]) =>
    Effect.gen(function*() {
      const r = yield* w.client.Sessions.prompt({
        path: { sessionId: sid(w) },
        payload: { turnId: String(turnId), prompt: String(prompt) },
      })
      w.vars.set("turn", r.turnId)
    })),

  // ── timers ───────────────────────────────────────────────────────────────
  step("turn schedules sleep {string} due at {int}", (w, [timerId, due]) =>
    Effect.gen(function*() {
      w.last = yield* w.client.Sessions.sleep({
        path: { sessionId: sid(w), turnId: tid(w) },
        payload: { timerId: String(timerId), fireAtEpochMs: Number(due) },
      })
    })),
  step("the sleep is registered pending", (w) =>
    ok(field(w.last, "status") === "pending", `expected sleep pending, got ${JSON.stringify(w.last)}`)),
  step("due timers fire at {int}", (w, [now]) =>
    Effect.gen(function*() {
      w.last = yield* w.client.Sessions.fireDueTimers({
        path: { sessionId: sid(w), turnId: tid(w) },
        payload: { nowEpochMs: Number(now) },
      })
    })),
  step("timer {string} is reported fired", (w, [timerId]) =>
    ok(
      rows(w.last, "fired").some((f) => f["timerId"] === String(timerId)),
      `timer ${String(timerId)} not fired: ${JSON.stringify(w.last)}`,
    )),

  // ── durable waits ──────────────────────────────────────────────────────────
  step("turn registers wait {string} with predicate {string}", (w, [waitId, predicate]) =>
    Effect.gen(function*() {
      w.last = yield* w.client.Sessions.wait({
        path: { sessionId: sid(w), turnId: tid(w) },
        payload: { waitId: String(waitId), predicate: String(predicate), afterOffset: "-1" },
      })
    })),
  step("the wait is registered pending", (w) =>
    ok(field(w.last, "status") === "pending", `expected wait pending, got ${JSON.stringify(w.last)}`)),
  step("a candidate event {string} is offered to pending waits", (w, [eventType]) =>
    Effect.gen(function*() {
      w.last = yield* w.client.Sessions.matchPendingWaits({
        path: { sessionId: sid(w), turnId: tid(w) },
        payload: { matchedOffset: "1", event: { type: String(eventType) } },
      })
    })),
  step("wait {string} stays not matched", (w, [waitId]) =>
    ok(
      rows(w.last, "notMatched").some((x) => x["waitId"] === String(waitId)),
      `wait ${String(waitId)} should be notMatched: ${JSON.stringify(w.last)}`,
    )),
  step("wait {string} is matched", (w, [waitId]) =>
    ok(
      rows(w.last, "matched").some((x) => x["waitId"] === String(waitId)),
      `wait ${String(waitId)} should be matched: ${JSON.stringify(w.last)}`,
    )),

  // ── replay / read-back ─────────────────────────────────────────────────────
  step("reading the turn shows event {string}", (w, [eventType]) =>
    Effect.gen(function*() {
      const read = yield* w.client.Sessions.turn({ path: { sessionId: sid(w), turnId: tid(w) } })
      const types = read.events.map((e) => e.type)
      yield* ok(types.some((t) => t === String(eventType)), `event ${String(eventType)} not in [${types.join(", ")}]`)
    })),
]

export const matchStep = (
  text: string,
): { readonly def: StepDef; readonly args: ReadonlyArray<unknown> } | undefined => {
  const hit = steps
    .map((def) => ({ def, args: def.expression.match(text) }))
    .find((x) => x.args !== null)
  return hit === undefined || hit.args === null
    ? undefined
    : { def: hit.def, args: hit.args.map((a) => a.getValue(null)) }
}

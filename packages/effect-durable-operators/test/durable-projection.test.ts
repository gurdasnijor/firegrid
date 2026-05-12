/**
 * Verifies:
 *  - effect-durable-operators.PROJECTION.1 — raw fact stream → State Protocol
 *    change-event stream consumed by DurableTable
 *  - effect-durable-operators.PROJECTION.2 — v0 emits change events directly
 *  - effect-durable-operators.PROJECTION.3 — projection state allocated
 *    inside Effect via Ref.modify, derived deterministically from facts
 *  - effect-durable-operators.PROJECTION.4 — outputs surfaced as Effect Stream
 *  - effect-durable-operators.TRACER_017.2 — non-Firegrid projection + table
 *    test using an account-balance scenario.
 */

import { DurableStream } from "effect-durable-streams"
import { Effect, HashMap, Option, Ref, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableProjection, DurableTable } from "../src/index.ts"
import { runtime, TestStreamServer } from "./harness.ts"

const server = new TestStreamServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const DebitCredit = Schema.Struct({
  accountId: Schema.String,
  delta: Schema.Number,
})
type DebitCredit = Schema.Schema.Type<typeof DebitCredit>

const AccountBalance = Schema.Struct({
  accountId: Schema.String,
  balance: Schema.Number,
})

const balanceCollections = DurableTable.collections({
  accountBalances: DurableTable.collection({
    type: "example.account_balance",
    primaryKey: "accountId",
    schema: AccountBalance,
  }),
})

describe("DurableProjection", () => {
  it("projects debit/credit facts into account-balance upserts queryable through DurableTable", async () => {
    const factsUrl = server.url("facts")
    const balancesUrl = server.url("balances")

    await runtime(
      Effect.gen(function* () {
        // Pre-create both streams.
        yield* DurableStream.define({
          endpoint: { url: factsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        yield* DurableStream.define({
          endpoint: { url: balancesUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        // Producer for raw debit/credit facts.
        const factsBound = DurableStream.define({
          endpoint: { url: factsUrl },
          schema: DebitCredit,
        })
        for (const fact of [
          { accountId: "a-1", delta: 100 },
          { accountId: "a-2", delta: 50 },
          { accountId: "a-1", delta: -30 },
          { accountId: "a-2", delta: 25 },
        ] satisfies ReadonlyArray<DebitCredit>) {
          yield* factsBound.append(fact)
        }

        // Wire-shape bound for change events. Schema.Any so we don't have to
        // model the full State Protocol envelope inline.
        const balancesBound = DurableStream.define({
          endpoint: { url: balancesUrl },
          schema: Schema.Any,
        })

        const AccountBalanceProjection = DurableProjection.define<
          Ref.Ref<HashMap.HashMap<string, number>>,
          DebitCredit,
          ReturnType<typeof balanceCollections.collections.accountBalances.upsert>
        >({
          name: "account-balance",
          initialState: Ref.make(HashMap.empty<string, number>()),
          project: (stateRef, fact) =>
            Stream.fromEffect(
              Ref.modify(stateRef, (state) => {
                const prev = Option.getOrElse(
                  HashMap.get(state, fact.accountId),
                  () => 0,
                )
                const balance = prev + fact.delta
                const next = HashMap.set(state, fact.accountId, balance)
                const event = balanceCollections.collections.accountBalances.upsert({
                  accountId: fact.accountId,
                  balance,
                })
                return [event, next]
              }),
            ),
        })

        // Run the projection in catch-up mode (live: false). It drains and
        // returns once the source stream marks up-to-date.
        yield* DurableProjection.run({
          source: factsBound,
          target: balancesBound,
          definition: AccountBalanceProjection,
          live: false,
        })

        // Materialize the balances table and query.
        const table = yield* DurableTable.materialize({
          streamOptions: { url: balancesUrl, contentType: "application/json" },
          collections: balanceCollections,
        })
        yield* Effect.sleep("200 millis")

        const a1 = yield* table.get("accountBalances", "a-1")
        const a2 = yield* table.get("accountBalances", "a-2")
        expect(Option.isSome(a1)).toBe(true)
        expect(Option.isSome(a2)).toBe(true)
        if (Option.isSome(a1)) expect(a1.value.balance).toBe(70)
        if (Option.isSome(a2)) expect(a2.value.balance).toBe(75)
      }),
    )
  })

  it("re-runs deterministically from retained facts after fresh boundary (PROJECTION.3 cold-start replay)", async () => {
    const factsUrl = server.url("facts-replay")
    const balancesUrl = server.url("balances-replay")

    // Seed facts retained on the source stream.
    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url: factsUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        yield* DurableStream.define({
          endpoint: { url: balancesUrl },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const factsBound = DurableStream.define({
          endpoint: { url: factsUrl },
          schema: DebitCredit,
        })
        for (const f of [
          { accountId: "x", delta: 10 },
          { accountId: "x", delta: -3 },
          { accountId: "y", delta: 5 },
        ] satisfies ReadonlyArray<DebitCredit>) {
          yield* factsBound.append(f)
        }
      }),
    )

    const mkProjection = () =>
      DurableProjection.define<
        Ref.Ref<HashMap.HashMap<string, number>>,
        DebitCredit,
        ReturnType<typeof balanceCollections.collections.accountBalances.upsert>
      >({
        name: "account-balance-replay",
        // initialState is re-evaluated every run; cold-start replay therefore
        // begins from an empty HashMap (PROJECTION.3 invariant).
        initialState: Ref.make(HashMap.empty<string, number>()),
        project: (stateRef, fact) =>
          Stream.fromEffect(
            Ref.modify(stateRef, (s) => {
              const prev = Option.getOrElse(HashMap.get(s, fact.accountId), () => 0)
              const balance = prev + fact.delta
              const next = HashMap.set(s, fact.accountId, balance)
              const event = balanceCollections.collections.accountBalances.upsert({
                accountId: fact.accountId,
                balance,
              })
              return [event, next]
            }),
          ),
      })

    // Run #1: catch-up only.
    await runtime(
      DurableProjection.run({
        source: DurableStream.define({
          endpoint: { url: factsUrl },
          schema: DebitCredit,
        }),
        target: DurableStream.define({
          endpoint: { url: balancesUrl },
          schema: Schema.Any,
        }),
        definition: mkProjection(),
        live: false,
      }),
    )

    // Fresh boundary: brand-new projection scope on the same retained facts.
    // The projection state resets; replaying the same facts MUST produce the
    // same final balances. The balances stream now holds the union of run #1
    // and run #2 upserts; the table's last-write-wins resolves correctly.
    await runtime(
      DurableProjection.run({
        source: DurableStream.define({
          endpoint: { url: factsUrl },
          schema: DebitCredit,
        }),
        target: DurableStream.define({
          endpoint: { url: balancesUrl },
          schema: Schema.Any,
        }),
        definition: mkProjection(),
        live: false,
      }),
    )

    // Materialize the balances table on a fresh scope and confirm correct
    // final state from retained change events alone (no live projection).
    await runtime(
      Effect.gen(function* () {
        const table = yield* DurableTable.materialize({
          streamOptions: { url: balancesUrl, contentType: "application/json" },
          collections: balanceCollections,
        })
        yield* Effect.sleep("250 millis")
        const x = yield* table.get("accountBalances", "x")
        const y = yield* table.get("accountBalances", "y")
        expect(Option.isSome(x)).toBe(true)
        expect(Option.isSome(y)).toBe(true)
        if (Option.isSome(x)) expect(x.value.balance).toBe(7)
        if (Option.isSome(y)) expect(y.value.balance).toBe(5)
      }),
    )
  })
})

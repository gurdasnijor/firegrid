import { afterAll, beforeAll, bench, describe } from "vitest"
import {
  all,
  execute,
  gen,
  race,
  run,
  spawn,
  type ExecutionContext,
  type Future,
  type Operation,
} from "../src/index.ts"
import {
  BENCH_OPTS,
  BENCH_SIZES,
  makeEffectRuntime,
  makeMemoryDurableStreamsFetch,
  runScoped,
  streamUrl,
  type EffectRuntime,
} from "./_helpers.ts"

let runtime: EffectRuntime
const replayUrls = new Map<string, string>()

const invocation = (url: string): ExecutionContext => ({
  journal: { endpoint: { url } },
})

const replayKey = (name: string, size: number): string => `${name}:${size}`

const expectedSum = (size: number): number => ((size - 1) * size) / 2

const allOperation = (
  size: number,
  action: (index: number) => number,
): Operation<number> =>
  gen(function* () {
    const futures = new Array<Future<number>>(size)
    for (let index = 0; index < size; index += 1) {
      futures[index] = run(() => action(index), { name: `all-${index}` })
    }
    const values = yield* all(futures)
    let total = 0
    for (let index = 0; index < values.length; index += 1) {
      total += values[index] ?? 0
    }
    return total
  })

const raceOperation = (
  size: number,
  action: (index: number) => number,
): Operation<number> =>
  gen(function* () {
    const first = run(() => action(0), { name: "race-0" })
    const futures: [Future<number>, ...Array<Future<number>>] = [first]
    for (let index = 1; index < size; index += 1) {
      futures.push(run(() => action(index), { name: `race-${index}` }))
    }
    return yield* race(futures)
  })

const spawnOperation = (
  size: number,
  action: (index: number) => number,
): Operation<number> =>
  gen(function* () {
    const futures = new Array<Future<number>>(size)
    for (let index = 0; index < size; index += 1) {
      futures[index] = spawn(
        gen(function* () {
          return yield* run(() => action(index), { name: `spawn-${index}` })
        }),
      )
    }
    const values = yield* all(futures)
    let total = 0
    for (let index = 0; index < values.length; index += 1) {
      total += values[index] ?? 0
    }
    return total
  })

const seedReplay = async (
  name: string,
  size: number,
  operation: Operation<number>,
  validate: (value: number) => void,
) => {
  const url = streamUrl(`${name}-replay-${size}`)
  const value = await runScoped(runtime, execute(invocation(url), operation))
  validate(value)
  replayUrls.set(replayKey(name, size), url)
}

beforeAll(async () => {
  runtime = makeEffectRuntime(makeMemoryDurableStreamsFetch())
  for (const size of BENCH_SIZES) {
    await seedReplay("all", size, allOperation(size, (index) => index), (value) => {
      if (value !== expectedSum(size)) {
        throw new Error(`unexpected all total for ${size}: ${value}`)
      }
    })
    await seedReplay("race", size, raceOperation(size, (index) => index), (value) => {
      if (value < 0 || value >= size) {
        throw new Error(`unexpected race winner for ${size}: ${value}`)
      }
    })
    await seedReplay("spawn", size, spawnOperation(size, (index) => index), (value) => {
      if (value !== expectedSum(size)) {
        throw new Error(`unexpected spawn total for ${size}: ${value}`)
      }
    })
  }
}, 30_000)

afterAll(async () => {
  await runtime.dispose()
})

// fluent-firegrid-keystone.BENCHMARK.3
for (const size of BENCH_SIZES) {
  describe(`fluent-firegrid public all(${size}) replay`, () => {
    bench(
      `execute + all(${size}x run Future) replay`,
      async () => {
        const url = replayUrls.get(replayKey("all", size))
        if (url === undefined) throw new Error(`missing all replay journal for ${size}`)
        const total = await runScoped(
          runtime,
          execute(
            invocation(url),
            allOperation(size, () => {
              throw new Error("all replay action should not execute")
            }),
          ),
        )
        if (total !== expectedSum(size)) {
          throw new Error(`unexpected all replay total for ${size}: ${total}`)
        }
      },
      BENCH_OPTS,
    )
  })

  describe(`fluent-firegrid public race(${size}) replay`, () => {
    bench(
      `execute + race(${size}x run Future) replay`,
      async () => {
        const url = replayUrls.get(replayKey("race", size))
        if (url === undefined) throw new Error(`missing race replay journal for ${size}`)
        const winner = await runScoped(
          runtime,
          execute(
            invocation(url),
            raceOperation(size, () => {
              throw new Error("race replay action should not execute")
            }),
          ),
        )
        if (winner < 0 || winner >= size) {
          throw new Error(`unexpected race replay winner for ${size}: ${winner}`)
        }
      },
      BENCH_OPTS,
    )
  })

  describe(`fluent-firegrid public spawn(${size}) replay`, () => {
    bench(
      `execute + spawn(${size}) + all replay`,
      async () => {
        const url = replayUrls.get(replayKey("spawn", size))
        if (url === undefined) throw new Error(`missing spawn replay journal for ${size}`)
        const total = await runScoped(
          runtime,
          execute(
            invocation(url),
            spawnOperation(size, () => {
              throw new Error("spawn replay action should not execute")
            }),
          ),
        )
        if (total !== expectedSum(size)) {
          throw new Error(`unexpected spawn replay total for ${size}: ${total}`)
        }
      },
      BENCH_OPTS,
    )
  })
}

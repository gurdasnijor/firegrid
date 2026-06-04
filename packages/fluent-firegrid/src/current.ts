import type { Scheduler } from "./scheduler.ts"

// sdk-gen-style synchronous current-fiber slot; not durable replay state.
// fluent-firegrid-keystone.ENGINE.3
// eslint-disable-next-line local/no-module-durable-cache
let currentScheduler: Scheduler | undefined

export const withCurrentScheduler = <T>(
  scheduler: Scheduler,
  body: () => T,
): T => {
  const previous = currentScheduler
  currentScheduler = scheduler
  try {
    return body()
  } finally {
    currentScheduler = previous
  }
}

export const getCurrentScheduler = (): Scheduler | undefined => currentScheduler

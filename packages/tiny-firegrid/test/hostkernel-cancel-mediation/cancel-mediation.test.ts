// tf-r06u.46 — HostKernel cancel-mediation spike (workbench proof).
//
// De-risks tf-r06u.35/R2 (cancel/close control plane + HostKernelWorkflow) and
// carries forward tf-c8cy's validation goal on the unified substrate. Proves
// the MEDIATION shape: a HostKernelWorkflow-mediated control plane drives a
// per-context RuntimeContextSessionWorkflow to TERMINAL on a cancel signal,
// via the EXISTING terminal input path (not a new terminal).
//
// CLAIMS:
//   1. mediation: a cancel intent dispatched to the kernel (router = thin)
//      drives the per-context session workflow to TERMINAL (reachedTerminal),
//      with exclusive ownership — the kernel emits the terminal; the session
//      does not self-terminate.
//   2. exactly-once across a replay boundary: rebuilding the engine + tables
//      over the same durable streams (a fresh process) and re-dispatching the
//      same cancel yields the SAME terminal exactly once (inputsConsumed
//      unchanged) — durable signal identity (insertOrGet keyed), the DUAL of
//      the .44 emitter durability finding.
//
// The test imports only the sim scenario (src/) + library — runtime internals
// stay behind the scenario (R3-clean).

import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cancelMediationScenario,
  type CancelMediationIds,
  type CancelMediationUrls,
} from "../../src/simulations/hostkernel-cancel-mediation/scenario.ts"

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

const urlsFor = (tag: string): CancelMediationUrls => {
  const run = `${tag}-${crypto.randomUUID()}`
  return {
    unifiedTableStreamUrl: `${baseUrl}/v1/stream/unified-${run}`,
    signalTableStreamUrl: `${baseUrl}/v1/stream/signal-${run}`,
    outputTableStreamUrl: `${baseUrl}/v1/stream/output-${run}`,
    engineStreamUrl: `${baseUrl}/v1/stream/engine-${run}`,
  }
}

describe("hostkernel cancel mediation (tf-r06u.46 spike)", () => {
  it("claim 1: a kernel-dispatched cancel drives the per-context session workflow to TERMINAL", async () => {
    const ids: CancelMediationIds = {
      contextId: "ctx-cancel-1",
      attempt: 1,
      kernelId: "kernel-A",
      requestId: "cancel-req-1",
    }
    const result = await Effect.runPromise(cancelMediationScenario(urlsFor("mediation"), ids))
    expect(result.reachedTerminal).toBe(true)
    // Exactly the kernel-emitted terminal was consumed (no other inputs).
    expect(result.inputsConsumed).toBe(1)
  })

  it("claim 2: re-running over the same durable streams (replay) reaches TERMINAL exactly once", async () => {
    const urls = urlsFor("replay")
    const ids: CancelMediationIds = {
      contextId: "ctx-cancel-2",
      attempt: 1,
      kernelId: "kernel-B",
      requestId: "cancel-req-2",
    }

    // Process A.
    const first = await Effect.runPromise(cancelMediationScenario(urls, ids))
    expect(first.reachedTerminal).toBe(true)
    expect(first.inputsConsumed).toBe(1)

    // Process B (replay boundary): fresh engine + tables over the SAME durable
    // streams, same ids, same cancel. Durable signal identity (insertOrGet
    // keyed on (executionId, name)) means the cancel intent and the emitted
    // terminal both dedup — exactly-once.
    const second = await Effect.runPromise(cancelMediationScenario(urls, ids))
    expect(second.reachedTerminal).toBe(true)
    expect(second.inputsConsumed).toBe(1) // unchanged — no second terminal
    expect(second).toEqual(first)
  })
})

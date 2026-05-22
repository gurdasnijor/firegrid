// In-memory duplex stream pair wiring the ACP client (driver) to the Firegrid
// stdio edge (host) without a subprocess — same pattern as
// `acp-edge-transport`. The edge reads `edgeInput` / writes `edgeOutput`; the
// client reads `clientInput` / writes `clientOutput`.
interface InMemoryAcpEdgeHarness {
  readonly edgeInput: ReadableStream<Uint8Array>
  readonly edgeOutput: WritableStream<Uint8Array>
  readonly clientInput: ReadableStream<Uint8Array>
  readonly clientOutput: WritableStream<Uint8Array>
}

const makeInMemoryAcpEdgeHarness = (): InMemoryAcpEdgeHarness => {
  const clientToEdge = new TransformStream<Uint8Array, Uint8Array>()
  const edgeToClient = new TransformStream<Uint8Array, Uint8Array>()
  return {
    edgeInput: clientToEdge.readable,
    edgeOutput: edgeToClient.writable,
    clientInput: edgeToClient.readable,
    clientOutput: clientToEdge.writable,
  }
}

// Module-level singleton: host.ts and driver.ts import the same instance so the
// edge and the ACP client share one duplex.
export const elicitationHarness = makeInMemoryAcpEdgeHarness()

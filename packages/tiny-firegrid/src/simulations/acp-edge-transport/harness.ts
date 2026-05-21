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

export const inMemoryAcpEdgeHarness = makeInMemoryAcpEdgeHarness()

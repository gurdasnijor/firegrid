/**
 * Duplex byte stream interface that agent codecs consume.
 *
 * The shape is intentionally web-stream-based so codecs can use it
 * without binding to a specific transport. `LocalProcessSandboxProvider`
 * adapts a child process's stdin/stdout/stderr (Node duplex streams) to
 * this shape; remote-sandbox providers may wrap a websocket or HTTP-bidi
 * connection without changing the codec API.
 */

export interface AgentByteStream {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

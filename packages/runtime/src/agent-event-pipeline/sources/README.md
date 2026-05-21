# Runtime Sources

`sources/` owns live process, byte stream, and resource acquisition. Sources
turn the outside world into streams or process handles that codecs and pipeline
composition can consume.

## Pipeline Fit

Sources are the first live edge of the event pipeline:

```txt
sources -> codecs
```

Examples include sandbox process byte streams and raw local-process stdin
delivery. A source may have live process concerns, but it should not own
durable table providers or normalized protocol semantics.

Source shape is live data acquisition:

```ts
export interface AgentByteStream {
  readonly stdin: Sink.Sink<void, Uint8Array, never, E>
  readonly stdout: Stream.Stream<Uint8Array, E, R>
  readonly stderr: Stream.Stream<Uint8Array, E, R>
}
```

Raw local-process delivery is still source-owned because it writes bytes to a
process stdin. The durable row selection it shares with codec delivery belongs
in `transforms/`; the claim/complete ledger belongs behind authority
capabilities.

## Boundary Rules

- Keep byte/process acquisition and live resource policy here.
- Keep protocol normalization in `codecs/`.
- Keep pure row selection or ordering in `transforms/`.
- Keep durable writes behind `authorities/` capability tags.
- Public app-facing configuration should move to host/config surfaces rather
  than leaking sandbox internals.

## Fixture-Replay Implications

`tf-4cik.1` adds a tiny-firegrid replay/fuzz harness for the runtime-agent
source boundary. Its matrix keeps these source guarantees narrow:

- chunk splitting, frame coalescing, stdout/stderr interleaving, early process
  exit, and stdin close/EPIPE are source-edge concerns;
- malformed/incomplete JSON, duplicate capability advertisement, tool-id
  correlation, and permission request/response matching are codec or bridge
  concerns;
- restart/replay around committed output rows belongs behind durable authority
  and replay guarantees, not source state;
- provider credentials and app-facing provider policy belong in host/config
  surfaces and must not appear as replay payloads.

The harness deliberately keeps live-agent canaries env-gated. Deterministic
fixture replay is the conformance floor; live canaries are compatibility
signals for real agent commands when credentials are available.

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

## Boundary Rules

- Keep byte/process acquisition and live resource policy here.
- Keep protocol normalization in `codecs/`.
- Keep pure row selection or ordering in `transforms/`.
- Keep durable writes behind `authorities/` capability tags.
- Public app-facing configuration should move to host/config surfaces rather
  than leaking sandbox internals.

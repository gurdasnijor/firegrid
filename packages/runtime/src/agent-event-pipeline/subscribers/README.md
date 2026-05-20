# Runtime Subscribers

`subscribers/` contains host-scoped drivers over durable runtime observations.
Subscribers consume `Stream` capability tags and perform side effects through
narrow durable write capabilities or active codec/session capabilities.

## Pipeline Fit

Subscribers react after durable observations exist:

```txt
authorities -> subscribers -> authorities/codecs
```

The legacy ingress-delivery, tool-router, and stderr-journal subscribers were
deleted by the live-owner cutover. New runtime-context prompt/tool routing lives
in the host workflow/session owner rather than in runtime subscriber fibers.

Subscriber shape:

```ts
Layer.Layer<never, DriverError,
  RuntimeAgentOutputEvents | RuntimeRunAppendAndGet
>
```

The important part is the requirement channel: a subscriber can read its
declared observations and write through narrow capabilities, but it cannot
mutate unrelated tables, deliver stdin, or access table facades. Composition
supplies the capabilities.

Long-running drivers that provide no public service can also be modeled as
scoped layers:

```ts
Layer.Layer<never, DriverError,
  RuntimeAgentOutputEvents | RuntimeRunAppendAndGet
>
```

That shape means "start this driver for its scope." It does not create a
service other code should call.

## Boundary Rules

- Depend on `Stream` capability tags, not table facades.
- Write through narrow capability tags.
- Keep protocol-specific send behavior in codecs or active session
  capabilities.
- Keep generic wait routing in `waits/`; it is subscriber-shaped but wait-owned
  because its vocabulary is wait rows and source handles, not agent events.

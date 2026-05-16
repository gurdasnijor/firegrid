# Runtime Subscribers

`subscribers/` contains host-scoped drivers over durable runtime observations.
Subscribers consume `Stream` capability tags and perform side effects through
narrow durable write capabilities or active codec/session capabilities.

## Pipeline Fit

Subscribers react after durable observations exist:

```txt
authorities -> subscribers -> authorities/codecs
```

Examples include ingress delivery, tool routing, and stderr journaling. They
are scoped fibers in runtime host composition; they are not public operator
APIs and they do not provide durable table layers.

Subscriber shape:

```ts
export const runToolRouter = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly toolUseMode: AgentToolUseMode
}): Effect.Effect<
  void,
  RuntimeContextError,
  RuntimeAgentOutputEvents | RuntimeIngressAppendAndGet
>
```

The important part is the requirement channel: the router can read agent output
observations and append ingress rows, but it cannot mutate output tables,
deliver stdin, or access table facades. Composition supplies the capabilities.

Long-running drivers that provide no public service can also be modeled as
scoped layers:

```ts
Layer.Layer<never, WaitRouterError,
  SourceCollections | DurableWaitIntentRows | DurableWaitCompletionUpsert
>
```

That shape means "start this driver for its scope." It does not create a
service other code should call.

## Boundary Rules

- Depend on `Stream` capability tags, not table facades.
- Write through authority capability tags.
- Keep protocol-specific send behavior in codecs or active session
  capabilities.
- Keep generic wait routing in `waits/`; it is subscriber-shaped but wait-owned
  because its vocabulary is wait rows and source handles, not agent events.

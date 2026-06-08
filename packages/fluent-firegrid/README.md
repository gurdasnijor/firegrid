# @firegrid/fluent-firegrid

Effect-native Firegrid authoring primitives with named durable steps over a
provided durable step journal.

The package is intentionally substrate-free above the handler edge. Application
authors define typed product behavior, durable step names, and replay schemas.
An external runner, test harness, or later deployment binding provides the
durable capabilities. Generic durable mechanics should live in
`packages/durable-streams`, not in this package.

```ts
export const basics = service({
  name: "basics",
  handlers: {
    *hello(name: string): Operation<string> {
      return yield* run(() => `Hello, ${name}!`, { name: "compose" })
    },

    *parallel(): Operation<string> {
      const a = run(() => fetchA(), { name: "a" })
      const b = run(() => fetchB(), { name: "b" })
      const [av, bv] = yield* all([a, b])
      return `${av}+${bv}`
    },
  },
})
```

`run(action, { name })` lowers to a named journal step, and `execute(ctx,
effect)` remains available as the lower-level handler-edge API. The package
does not expose a bespoke `Future` scheduler or module-global current scheduler
slot; composition delegates to Effect.

Definitions carry public handler descriptors (`_handlers`) for later binding.
`client` and `sendClient` derive typed call/send clients from those descriptors
over an injected ingress. Hosting, entity control, Durable Streams consumers,
wake delivery, leases, timers, and predicate subscriptions remain outside this
package.

Architecture contract: [fluent-firegrid-design.md](../../docs/cannon/architecture/fluent/fluent-firegrid-design.md).
